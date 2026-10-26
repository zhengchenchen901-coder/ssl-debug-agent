import { createHash, randomUUID } from "node:crypto";
import posixPath from "node:path/posix";
import { MONGODB_CODEC_SCRIPT } from "./mongodb-codec.js";
import { MONGODB_JOB_RETIREMENT_RUNTIME } from "./mongodb-job-retirement-runtime.js";
import { MONGODB_BULK_RUNTIME } from "./mongodb-bulk-runtime.js";
import { MONGODB_TECHNICAL_RECEIPTS_COLLECTION, MONGODB_TTL_POLICY_SCRIPT } from "./mongodb-ttl-policy.js";
import { MONGODB_SANDBOX_RUNTIME } from "./mongodb-sandbox-runtime.js";
import {
  MONGODB_REMOTE_COMMAND,
  MONGODB_RESULT_MARKER,
} from "./mongodb.js";
import { operationError, normalizeOperationEnvelope } from "./operation.js";
import { publicBulkFailure } from "./mongodb-bulk-error.js";

export const MONGODB_BULK_CONFIRMATION = "确认执行";
export const MONGODB_BULK_ROLLBACK_CONFIRMATION = "确认回滚";
export const DEFAULT_MONGODB_BULK_ROOT = "/var/lib/remote-debug-agent/bulk-jobs";
export const DEFAULT_SANDBOX_DATABASE = "remote_debug_agent";
export const DEFAULT_MONGODB_BULK_BATCH_DOCUMENTS = 500;
export const MAX_MONGODB_BULK_BATCH_DOCUMENTS = 2_000;
export const MAX_MONGODB_BULK_UNIT_OPERATIONS = 20;
export const MAX_MONGODB_BULK_CHUNK_OPERATIONS = 10_000;
export const MAX_MONGODB_BULK_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_MONGODB_BULK_JOB_OPERATIONS = 100_000;
export const MAX_MONGODB_BULK_JOB_BYTES = 40 * 1024 * 1024;
export const SANDBOX_STORAGE_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024 * 1024, controlReserveBytes: 64 * 1024 * 1024, maxJobs: 200, maxFiles: 20000, controlReserveFiles: 1024, maxJobFiles: 1950, maxEventBytes: 8 * 1024 * 1024 });
export const MAX_MONGODB_BULK_BATCH_INPUT_BYTES = 512 * 1024;
export const MAX_MONGODB_BULK_BATCH_JOURNAL_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MONGODB_BULK_ROLLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_MONGODB_BULK_ROLLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DATABASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const COLLECTION_PATTERN = /^[A-Za-z0-9_.$-]{1,128}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9][0-9]{0,4}))*$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UPDATE_OPERATORS = new Set(["$set", "$unset", "$inc"]);
const EJSON_KEYS = new Set([
  "$oid", "$date", "$numberInt", "$numberLong", "$numberDouble", "$numberDecimal",
  "$binary", "$regularExpression", "$timestamp", "$minKey", "$maxKey", "$undefined",
]);
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor", "$where", "$function", "$accumulator", "$out", "$merge", "$currentOp"]);
const MAX_BULK_RESULT_BYTES = 512 * 1024;

function bulkError(message, code, statusCode = 400, details = {}) {
  const error = operationError(message, {
    code,
    statusCode,
    layer: "mongodb-bulk",
    phase: "validation",
    retriable: false,
  });
  error.details = details;
  return error;
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function assertKnownFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bulkError(`${label} must be an object`, "MONGODB_BULK_INPUT_INVALID");
  if (Object.keys(value).some((key) => !fields.includes(key))) throw bulkError(`${label} contains unsupported fields`, "MONGODB_BULK_UNKNOWN_FIELD");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    Object.defineProperty(result, key, {
      value: stableValue(value[key]), enumerable: true, writable: true, configurable: true,
    });
    return result;
  }, {});
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function assertWireValue(value, fieldName = "$", depth = 0) {
  if (depth > 16) throw bulkError(`${fieldName} is too deeply nested`, "MONGODB_BULK_VALUE_INVALID");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw bulkError(`${fieldName} contains a non-finite number`, "MONGODB_BULK_VALUE_INVALID");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertWireValue(item, `${fieldName}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw bulkError(`${fieldName} contains an unsupported value`, "MONGODB_BULK_VALUE_INVALID");
  }
  const keys = Object.keys(value);
  const taggedKeys = keys.filter((key) => key.startsWith("$"));
  if (taggedKeys.length > 0) {
    if (keys.length !== 1 || !EJSON_KEYS.has(keys[0])) {
      throw bulkError(`${fieldName} contains an unsupported Extended JSON value`, "MONGODB_BULK_VALUE_INVALID");
    }
    const key = keys[0];
    const child = value[key];
    if (key === "$oid" && (typeof child !== "string" || !/^[a-f0-9]{24}$/i.test(child))) {
      throw bulkError(`${fieldName} contains an invalid ObjectId`, "MONGODB_BULK_VALUE_INVALID");
    }
    if (["$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"].includes(key) && typeof child !== "string") {
      throw bulkError(`${fieldName} contains an invalid BSON number`, "MONGODB_BULK_VALUE_INVALID");
    }
    assertWireValue(child, `${fieldName}.${key}`, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(key) || key.includes("\0")) {
      throw bulkError(`${fieldName} contains a forbidden key`, "MONGODB_BULK_VALUE_INVALID");
    }
    assertWireValue(child, `${fieldName}.${key}`, depth + 1);
  }
}

function normalizeId(value, fieldName) {
  assertWireValue(value, fieldName);
  if (typeof value === "string" && value.length > 0 && value.length <= 256) return value;
  if (Number.isSafeInteger(value)) return value;
  if (value && typeof value === "object" && Object.keys(value).length === 1 &&
      (typeof value.$oid === "string" || typeof value.$numberLong === "string")) return value;
  throw bulkError(`${fieldName} must be a string, safe integer, ObjectId, or Long`, "MONGODB_BULK_ID_INVALID");
}

function normalizeDocument(value, fieldName) {
  // The output guard deliberately returns null-prototype JSON dictionaries.
  // Match assertWireValue's supported prototypes, retaining all key/id bounds.
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw bulkError(`${fieldName} must be a plain object`, "MONGODB_BULK_DOCUMENT_INVALID");
  }
  assertWireValue(value, fieldName);
  if (!Object.prototype.hasOwnProperty.call(value, "_id")) {
    throw bulkError(`${fieldName} must contain an explicit _id`, "MONGODB_BULK_ID_REQUIRED");
  }
  const document = { ...value, _id: normalizeId(value._id, `${fieldName}._id`) };
  for (const key of Object.keys(document)) {
    if (key.startsWith("$") || key.includes(".") || key.includes("\0")) {
      throw bulkError(`${fieldName} contains an unsafe field name`, "MONGODB_BULK_FIELD_REJECTED");
    }
  }
  if (byteLength(JSON.stringify(document)) > 256 * 1024) {
    throw bulkError(`${fieldName} exceeds 256 KiB`, "MONGODB_BULK_DOCUMENT_TOO_LARGE", 413);
  }
  return document;
}

export function normalizeMongoBulkConfig(config = {}, options = {}) {
  if (!config || options.requireBulkEnabled !== false && config.bulkEnabled !== true) {
    throw bulkError("MongoDB bulk changes are disabled; enable mongodb.bulkEnabled explicitly", "MONGODB_BULK_DISABLED", 403);
  }
  const writeEnabled = config.writeEnabled === true || config.mutationsEnabled === true;
  if (!writeEnabled) throw bulkError("MongoDB mutations are disabled", "MONGODB_MUTATIONS_DISABLED", 403);
  const database = String(config.database || "").trim();
  if (!DATABASE_PATTERN.test(database)) throw bulkError("a valid default MongoDB database is required", "MONGODB_BULK_DATABASE_REQUIRED");
  const allowedDatabases = Array.isArray(config.allowedDatabases) ? config.allowedDatabases : [database];
  if (!allowedDatabases.includes(database)) throw bulkError("bulk jobs must use an allowlisted database", "MONGODB_DATABASE_NOT_ALLOWED", 403);
  const sandboxDatabase = String(config.sandboxDatabase || DEFAULT_SANDBOX_DATABASE).trim();
  if (!DATABASE_PATTERN.test(sandboxDatabase) || ["admin", "local", "config", database].includes(sandboxDatabase) || allowedDatabases.includes(sandboxDatabase)) {
    throw bulkError("sandboxDatabase must be a dedicated database outside the business allowlist", "SANDBOX_DATABASE_INVALID", 403);
  }
  const allowedCollections = Array.isArray(config.allowedCollections) ? config.allowedCollections : [];
  const receiptsCollection = String(config.bulkReceiptsCollection || "__remote_debug_bulk_receipts").trim();
  if (receiptsCollection !== MONGODB_TECHNICAL_RECEIPTS_COLLECTION) {
    throw bulkError("TTL cleanup is restricted to the reserved __remote_debug_bulk_receipts collection", "MONGODB_BULK_RECEIPTS_RESERVED", 403);
  }
  const rawRoot = String(config.bulkRoot || DEFAULT_MONGODB_BULK_ROOT).trim();
  const root = posixPath.normalize(rawRoot);
  if (!root.startsWith("/") || root === "/" || root.includes("\0") || root.split("/").includes("..")) {
    throw bulkError("mongodb.bulkRoot must be a dedicated absolute directory", "MONGODB_BULK_ROOT_INVALID");
  }
  const batchDocuments = Number(config.bulkBatchDocuments || DEFAULT_MONGODB_BULK_BATCH_DOCUMENTS);
  if (!Number.isInteger(batchDocuments) || batchDocuments < 1 || batchDocuments > MAX_MONGODB_BULK_BATCH_DOCUMENTS) {
    throw bulkError(`mongodb.bulkBatchDocuments must be from 1 to ${MAX_MONGODB_BULK_BATCH_DOCUMENTS}`, "MONGODB_BULK_LIMIT_INVALID");
  }
  const concurrency = Number(config.bulkConcurrency || 2);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw bulkError("mongodb.bulkConcurrency must be from 1 to 4", "MONGODB_BULK_LIMIT_INVALID");
  }
  const rollbackTtlMs = Number(config.bulkRollbackTtlMs || DEFAULT_MONGODB_BULK_ROLLBACK_TTL_MS);
  if (!Number.isInteger(rollbackTtlMs) || rollbackTtlMs < 1 || rollbackTtlMs > MAX_MONGODB_BULK_ROLLBACK_TTL_MS) {
    throw bulkError("mongodb.bulkRollbackTtlMs must be from 1 to 7 days", "MONGODB_BULK_LIMIT_INVALID");
  }
  return {
    ...config,
    database,
    sandboxDatabase,
    allowedDatabases: [...allowedDatabases],
    allowedCollections: [...allowedCollections],
    bulkRoot: root.replace(/\/$/, ""),
    bulkReceiptsCollection: receiptsCollection,
    bulkBatchDocuments: batchDocuments,
    bulkConcurrency: concurrency,
    bulkRollbackTtlMs: rollbackTtlMs,
  };
}

function normalizeUpdate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw bulkError("update must be a non-empty operator object", "MONGODB_BULK_UPDATE_INVALID");
  }
  const output = {};
  const paths = [];
  for (const [operator, fields] of Object.entries(value)) {
    if (!UPDATE_OPERATORS.has(operator) || !fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).length === 0) {
      throw bulkError("update may use only $set, $unset, and $inc with non-empty objects", "MONGODB_BULK_UPDATE_INVALID");
    }
    output[operator] = {};
    for (const [field, fieldValue] of Object.entries(fields)) {
      if (!safeBulkPath(field) || field === "_id" || field.startsWith("_id.")) {
        throw bulkError(`update contains an unsafe or immutable field: ${field}`, "MONGODB_BULK_FIELD_REJECTED");
      }
      if (paths.some((path) => path === field || path.startsWith(`${field}.`) || field.startsWith(`${path}.`))) {
        throw bulkError(`update paths overlap at ${field}`, "MONGODB_BULK_UPDATE_INVALID");
      }
      if (operator === "$inc" && (typeof fieldValue !== "number" || !Number.isFinite(fieldValue))) {
        throw bulkError("$inc values must be finite numbers", "MONGODB_BULK_UPDATE_INVALID");
      }
      if (operator === "$unset" && fieldValue !== 1 && fieldValue !== true && fieldValue !== "") {
        throw bulkError("$unset values must be 1, true, or an empty string", "MONGODB_BULK_UPDATE_INVALID");
      }
      assertWireValue(fieldValue, `update.${operator}.${field}`);
      output[operator][field] = fieldValue;
      paths.push(field);
    }
  }
  return { update: output, paths };
}

function safeBulkPath(field) {
  return FIELD_PATTERN.test(field) && field.split(".").every((part) => !BLOCKED_KEYS.has(part));
}

function overlaps(left, right) {
  return left === right || left.startsWith(right + ".") || right.startsWith(left + ".");
}

function bulkIdentity(value) {
  return typeof value === "string" && value.length > 0 || Number.isSafeInteger(value) ||
    value && typeof value === "object" && Object.keys(value).length === 1 && (typeof value.$oid === "string" || typeof value.$numberLong === "string");
}

// A value precondition is not an element identity. Indexed edits require an
// unchanged, non-null identity sibling; missing full-element $set is checked
// against the actual immediate tail by the remote preimage verifier.
function assertArrayGuards(expected, update, paths) {
  for (const [operator, fields] of Object.entries(update)) for (const field of Object.keys(fields)) {
    const parts = field.split(".");
    for (let i = 0; i < parts.length; i++) {
      if (!/^[0-9]+$/.test(parts[i])) continue;
      const prefix = parts.slice(0, i + 1).join(".");
      if (i === parts.length - 1 && operator === "$set" && expected[field]?.exists === false &&
          fields[field] && typeof fields[field] === "object" && !Array.isArray(fields[field]) &&
          !Object.keys(fields[field]).some((key) => key.startsWith("$")) &&
          bulkIdentity(Object.prototype.hasOwnProperty.call(fields[field], "_id") ? fields[field]._id : fields[field].id)) continue;
      const guard = Object.entries(expected).some(([key, condition]) => {
        const suffix = key.slice(prefix.length + 1);
        return key.startsWith(prefix + ".") && /^(?:_id|id|[A-Za-z_][A-Za-z0-9_]*_id)$/.test(suffix) &&
          condition.exists === true && bulkIdentity(condition.value) && !paths.some((path) => overlaps(path, key));
      });
      if (!guard || i === parts.length - 1) throw bulkError("indexed edits require an unchanged element identity; only a missing full-element $set may append", "MONGODB_BULK_ARRAY_GUARD_REQUIRED");
    }
  }
}

function normalizeExpected(value, changedPaths) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw bulkError("updateOne requires original values in expected", "MONGODB_BULK_EXPECTED_REQUIRED");
  }
  const expected = {};
  for (const [field, condition] of Object.entries(value)) {
    if (!safeBulkPath(field) || !condition || typeof condition !== "object" || Array.isArray(condition) ||
        Object.keys(expected).some((path) => overlaps(path, field))) {
      throw bulkError("expected must map safe field paths to existence/value conditions", "MONGODB_BULK_EXPECTED_INVALID");
    }
    const exists = condition.exists;
    if (exists === false) {
      if (Object.keys(condition).length !== 1) throw bulkError(`expected.${field} must omit value when exists is false`, "MONGODB_BULK_EXPECTED_INVALID");
      expected[field] = { exists: false };
    } else if (exists === true && Object.prototype.hasOwnProperty.call(condition, "value")) {
      if (Object.keys(condition).some((key) => key !== "exists" && key !== "value")) throw bulkError(`expected.${field} has unsupported keys`, "MONGODB_BULK_EXPECTED_INVALID");
      assertWireValue(condition.value, `expected.${field}.value`);
      expected[field] = { exists: true, value: condition.value };
    } else {
      throw bulkError(`expected.${field} must specify exists and, when present, value`, "MONGODB_BULK_EXPECTED_INVALID");
    }
  }
  for (const field of changedPaths) {
    if (!Object.prototype.hasOwnProperty.call(expected, field)) {
      throw bulkError(`expected must include the original value for every changed field; missing ${field}`, "MONGODB_BULK_EXPECTED_INCOMPLETE");
    }
  }
  return expected;
}

function normalizeOperation(value, config, database, unitId, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bulkError(`unit ${unitId} operation ${index} must be an object`, "MONGODB_BULK_OPERATION_INVALID");
  const collection = String(value.collection || "").trim();
  if (!COLLECTION_PATTERN.test(collection) || !config.allowedCollections.includes(collection)) {
    throw bulkError(`collection is not allowlisted: ${collection || "(empty)"}`, "MONGODB_COLLECTION_NOT_ALLOWED", 403);
  }
  if (collection === config.bulkReceiptsCollection) throw bulkError("business operations cannot target the technical receipt collection", "MONGODB_BULK_RESERVED_COLLECTION", 403);
  if (value.operation === "insertOne") {
    assertKnownFields(value, ["operation", "collection", "document"], "insertOne");
    return { collection, operation: "insertOne", document: normalizeDocument(value.document, `unit ${unitId} operation ${index}.document`) };
  }
  if (value.operation !== "updateOne") throw bulkError("bulk V1 supports only insertOne and updateOne", "MONGODB_BULK_OPERATION_UNSUPPORTED");
  assertKnownFields(value, ["operation", "collection", "id", "expected", "update"], "updateOne");
  const updatePlan = normalizeUpdate(value.update);
  const expected = normalizeExpected(value.expected, updatePlan.paths);
  assertArrayGuards(expected, updatePlan.update, updatePlan.paths);
  return {
    collection,
    operation: "updateOne",
    id: normalizeId(value.id, `unit ${unitId} operation ${index}.id`),
    expected,
    update: updatePlan.update,
  };
}

function normalizeUnit(value, config, database) {
  assertKnownFields(value, ["unitId", "operations"], "unit");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bulkError("each business unit must be an object", "MONGODB_BULK_UNIT_INVALID");
  const unitId = String(value.unitId || "").trim();
  if (!UNIT_ID_PATTERN.test(unitId)) throw bulkError("unitId must be a stable identifier of 1-64 safe characters", "MONGODB_BULK_UNIT_ID_INVALID");
  if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > MAX_MONGODB_BULK_UNIT_OPERATIONS) {
    throw bulkError(`unit ${unitId} must contain between 1 and ${MAX_MONGODB_BULK_UNIT_OPERATIONS} operations`, "MONGODB_BULK_UNIT_SIZE_INVALID");
  }
  const operations = value.operations.map((item, index) => normalizeOperation(item, config, database, unitId, index));
  return { unitId, operations };
}

export function normalizeMongoBulkChunk(input = {}, config = {}) {
  assertKnownFields(input, ["action", "jobId", "database", "chunkIndex", "purpose", "rollbackTtlMs", "units", "chunkHash", "endOfUpload", "operationId", "timeoutMs", "deadlineAt"], "bulk chunk");
  const policy = normalizeMongoBulkConfig(config);
  const jobId = String(input.jobId || "").trim();
  if (!JOB_ID_PATTERN.test(jobId)) throw bulkError("jobId must use 1-64 letters, numbers, dots, dashes, or underscores", "MONGODB_BULK_JOB_ID_INVALID");
  const database = String(input.database || policy.database).trim();
  if (database !== policy.database || !policy.allowedDatabases.includes(database)) {
    throw bulkError("one bulk job may target only its configured, allowlisted database", "MONGODB_DATABASE_NOT_ALLOWED", 403);
  }
  if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0 || input.chunkIndex > 9_999) {
    throw bulkError("chunkIndex must be a non-negative integer", "MONGODB_BULK_CHUNK_INDEX_INVALID");
  }
  const units = input.units === undefined ? [] : input.units;
  if (!Array.isArray(units)) throw bulkError("units must be an array", "MONGODB_BULK_UNITS_INVALID");
  const purpose = typeof input.purpose === "string" ? input.purpose.trim().slice(0, 500) : "";
  const rollbackTtlMs = input.rollbackTtlMs === undefined ? policy.bulkRollbackTtlMs : Number(input.rollbackTtlMs);
  if (!Number.isInteger(rollbackTtlMs) || rollbackTtlMs < 1 || rollbackTtlMs > policy.bulkRollbackTtlMs) {
    throw bulkError("rollbackTtlMs must be a positive duration no greater than the instance rollback window", "MONGODB_BULK_TTL_INVALID");
  }
  const normalizedUnits = units.map((unit) => normalizeUnit(unit, policy, database));
  const body = { jobId, database, chunkIndex: input.chunkIndex, purpose, rollbackTtlMs, units: normalizedUnits };
  const inputBytes = byteLength(stableStringify({ units: normalizedUnits }));
  const operationCount = normalizedUnits.reduce((count, unit) => count + unit.operations.length, 0);
  if (operationCount > MAX_MONGODB_BULK_CHUNK_OPERATIONS || inputBytes > MAX_MONGODB_BULK_CHUNK_BYTES) {
    throw bulkError("one upload chunk is limited to 10000 operations and 4 MiB", "MONGODB_BULK_CHUNK_SIZE_LIMIT", 413);
  }
  const chunkHash = createHash("sha256").update(stableStringify(body)).digest("hex");
  if (input.chunkHash !== undefined && input.chunkHash !== chunkHash) {
    throw bulkError("chunkHash does not match the normalized chunk contents", "MONGODB_BULK_CHUNK_HASH_MISMATCH");
  }
  if (input.endOfUpload === true && normalizedUnits.length > 0) {
    throw bulkError("send the explicit end-of-upload marker in an empty chunk", "MONGODB_BULK_END_MARKER_INVALID");
  }
  return { ...body, chunkHash, endOfUpload: input.endOfUpload === true, inputBytes, operationCount };
}

export function normalizeMongoBulkStorage(input = {}, config = {}, options = {}) {
  const policy = normalizeMongoBulkConfig(config);
  return {
    kind: "bulk_storage",
    operation: "initializeBulkStorage",
    operationId: typeof options.operationId === "string" && options.operationId.trim() ? options.operationId.trim().slice(0, 128) : randomUUID(),
    purpose: typeof input.purpose === "string" ? input.purpose.trim().slice(0, 500) : "Initialize MongoDB bulk job storage",
    database: policy.database,
    receiptsDatabase: policy.sandboxDatabase,
    collection: policy.bulkReceiptsCollection,
    storageRoot: policy.bulkRoot,
    rollbackTtlMs: policy.bulkRollbackTtlMs,
    riskLevel: "high",
  };
}

// Only source-owned literal messages are eligible for verbatim publication.
const bulkMessages = [...new Set([...[MONGODB_BULK_RUNTIME, MONGODB_JOB_RETIREMENT_RUNTIME, MONGODB_SANDBOX_RUNTIME, MONGODB_TTL_POLICY_SCRIPT].join("\n").matchAll(/__bulkFail\("[A-Z0-9_]+", "([^"\n]*)"/g)].map(match => match[1]).concat([
  "transaction outcome is uncertain; retry only this exact batch after receipt inspection",
  "MongoDB bulk helper timed out",
]))];
const failureContext = (input, operation, extra = {}) => ({ phase: input.action, batchIndex: input.batchIndex,
  operationId: operation?.operationId, fingerprint: value => createHash("sha256").update(value).digest("hex"), ...extra });

function safeLiteral(value) {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function buildMongoBulkScript(request, config, normalizationOptions = {}) {
  const policy = normalizeMongoBulkConfig(config, normalizationOptions);
  const script = [
    '"use strict";',
    'const __fs = require("fs");',
    'const __path = require("path");',
    'const __crypto = require("crypto");',
    `const __request = ${safeLiteral(request)};`,
    `const __config = ${safeLiteral({ configPath: policy.configPath, driverPath: policy.driverPath, configProfile: policy.configProfile, uriKey: policy.uriKey, database: policy.database, sandboxDatabase: policy.sandboxDatabase, allowedDatabases: policy.allowedDatabases, allowedCollections: policy.allowedCollections, bulkRoot: policy.bulkRoot, receiptsCollection: policy.bulkReceiptsCollection, batchDocuments: policy.bulkBatchDocuments, concurrency: Math.min(policy.bulkConcurrency, 4), sandboxManagementProfile: policy.sandboxManagementProfile, sandboxManagementUriKey: policy.sandboxManagementUriKey || "url" })};`,
    `const __marker = ${safeLiteral(`${MONGODB_RESULT_MARKER}BULK:`)};`,
    `const __storageLimits = ${safeLiteral(SANDBOX_STORAGE_LIMITS)};`,
    'const __driverPath = __config.driverPath;',
    'let __bson; try { __bson = require(require.resolve("bson", { paths: [__driverPath] })); } catch (_error) { __bson = null; }',
    `const __bulkPublicFailure = ${publicBulkFailure.toString()};`,
    `const __bulkMessages = ${safeLiteral(bulkMessages)};`,
    MONGODB_CODEC_SCRIPT,
    MONGODB_BULK_RUNTIME,
    MONGODB_JOB_RETIREMENT_RUNTIME,
    "var __ttlFail = __bulkFail;",
    MONGODB_TTL_POLICY_SCRIPT,
    MONGODB_SANDBOX_RUNTIME,
    "__bulkMain();",
  ].join("\n");
  const limit = request.action === "upload" ? MAX_MONGODB_BULK_CHUNK_BYTES + 1024 * 1024 : MAX_BULK_RESULT_BYTES * 2;
  if (byteLength(script) > limit) throw bulkError("MongoDB bulk helper exceeds its bounded transport size", "MONGODB_BULK_SCRIPT_TOO_LARGE", 413);
  return script;
}

function parseMarker(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith(`${MONGODB_RESULT_MARKER}BULK:`)) continue;
    try {
      return JSON.parse(lines[index].slice(`${MONGODB_RESULT_MARKER}BULK:`.length));
    } catch {
      throw bulkError("MongoDB bulk helper returned invalid JSON", "MONGODB_BULK_INVALID_RESPONSE", 502);
    }
  }
  return null;
}

function normalizeActionRequest(input, config) {
  const action = input.action;
  const fields = {
    retire: ["jobId", "replacementJobId", "riskPlanId", "dispositionId", "originalRequestDigest", "replacementRequestDigest", "approvalAuditId"],
    recoverUpload: ["jobId", "database", "chunkIndex", "chunkHash", "endOfUpload"],
    sandboxStatus: ["offset", "limit"], sandboxExport: ["jobId", "limit"], sandboxPrepareCleanup: ["jobId"], sandboxCleanup: ["jobId", "cleanupHash", "confirmation"],
    upload: input.chunk ? ["chunk"] : ["jobId", "database", "chunkIndex", "purpose", "rollbackTtlMs", "units", "chunkHash", "endOfUpload"],
    get: ["jobId", "includePlan", "includeDifferences", "offset", "limit", "query"], list: ["offset", "limit"],
    start: ["jobId", "planHash", "leaseId", "mode"], finish: ["jobId", "planHash", "leaseId", "mode"], pause: ["jobId", "planHash", "leaseId", "reason", "failure"], resume: ["jobId", "planHash", "leaseId"],
    executeBatch: ["jobId", "planHash", "leaseId", "batchIndex"], rollbackBatch: ["jobId", "planHash", "leaseId", "batchIndex"], verifyBatch: ["jobId", "planHash", "leaseId", "batchIndex"],
    dispatch: ["jobId", "planHash", "leaseId", "phase", "batchIndexes"], control: ["jobId", "planHash", "command"], heartbeat: ["jobId", "planHash", "leaseId"],
    rollbackStart: ["jobId", "planHash", "leaseId", "confirmation"], executeStart: ["jobId", "planHash", "leaseId", "confirmation"],
  };
  if (fields[action]) assertKnownFields(input, ["action", "operationId", "timeoutMs", "deadlineAt", ...fields[action]], "bulk action");
  if (action === "retire") {
    if (![input.jobId, input.replacementJobId].every(x => typeof x === "string" && JOB_ID_PATTERN.test(x)) || input.jobId === input.replacementJobId ||
        ![input.riskPlanId, input.dispositionId, input.originalRequestDigest, input.replacementRequestDigest, input.approvalAuditId].every(x => typeof x === "string" && HASH_PATTERN.test(x))) throw bulkError("invalid exact reviewed retirement identity", "MONGODB_BULK_RETIREMENT_INVALID");
    return { ...input, action };
  }
  if (action === "recoverUpload") {
    if (!JOB_ID_PATTERN.test(input.jobId || "") || input.database !== config.database || !Number.isInteger(input.chunkIndex) ||
        input.chunkIndex < 0 || input.chunkIndex > 9999 || !HASH_PATTERN.test(input.chunkHash || "") || typeof input.endOfUpload !== "boolean") {
      throw bulkError("exact bulk chunk recovery identity is required", "MONGODB_BULK_RECOVERY_IDENTITY_INVALID");
    }
    return { ...input };
  }
  if (action === "get" && input.query) assertKnownFields(input.query, ["includeDifferences", "offset", "limit"], "bulk query");
  if (["sandboxStatus", "sandboxExport", "sandboxPrepareCleanup", "sandboxCleanup"].includes(action)) {
    const jobId = input.jobId;
    if (action !== "sandboxStatus" && (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId))) throw bulkError("sandbox jobId is invalid", "SANDBOX_JOB_INVALID");
    if (action === "sandboxCleanup" && (!HASH_PATTERN.test(input.cleanupHash || "") || input.confirmation !== "确认清理")) throw bulkError("cleanup requires the prepared hash and 确认清理", "SANDBOX_CONFIRMATION_REQUIRED");
    return { action, jobId, cleanupHash: input.cleanupHash, confirmation: input.confirmation, offset: Math.max(0, Math.min(100000, Number.isInteger(input.offset) ? input.offset : 0)), limit: Math.max(1, Math.min(100, Number.isInteger(input.limit) ? input.limit : 20)) };
  }
  if (action === "upload") return { action, chunk: normalizeMongoBulkChunk(input.chunk || input, config) };
  if (action === "get" || action === "start" || action === "finish" || action === "pause" || action === "resume") {
    const jobId = String(input.jobId || "").trim();
    if (!JOB_ID_PATTERN.test(jobId)) throw bulkError("jobId has an invalid format", "MONGODB_BULK_JOB_ID_INVALID");
    if (action !== "get" && action !== "pause" && action !== "resume") {
      if (!HASH_PATTERN.test(String(input.planHash || ""))) throw bulkError("planHash must be a SHA-256 digest", "MONGODB_BULK_PLAN_HASH_INVALID");
    }
    return {
      ...input,
      action,
      jobId,
      failure: action === "pause" && input.failure ? publicBulkFailure(input.failure, { ...input.failure, phase: input.failure.phase, fingerprint: undefined }, bulkMessages) : undefined,
      query: action === "get" ? {
        includeDifferences: input.includeDifferences === true,
        offset: input.offset,
        limit: input.limit,
      } : input.query,
    };
  }
  if (action === "list") {
    return { action, offset: Math.max(0, Math.min(100_000, Number.isInteger(input.offset) ? input.offset : 0)), limit: Math.max(1, Math.min(100, Number.isInteger(input.limit) ? input.limit : 20)) };
  }
  if (["executeBatch", "rollbackBatch", "verifyBatch"].includes(action)) {
    const jobId = String(input.jobId || "").trim();
    if (!JOB_ID_PATTERN.test(jobId) || !HASH_PATTERN.test(String(input.planHash || "")) || !HASH_PATTERN.test(String(input.leaseId || "")) || !Number.isInteger(input.batchIndex) || input.batchIndex < 0) {
      throw bulkError("bulk batch identity is invalid", "MONGODB_BULK_BATCH_ID_INVALID");
    }
    return { ...input, action, jobId };
  }
  if (action === "dispatch") {
    const jobId = String(input.jobId || "").trim();
    if (!JOB_ID_PATTERN.test(jobId) || !HASH_PATTERN.test(String(input.planHash || "")) || !HASH_PATTERN.test(String(input.leaseId || "")) ||
        !["execute", "verify", "rollback"].includes(input.phase) || !Array.isArray(input.batchIndexes) || input.batchIndexes.length > 4 ||
        input.batchIndexes.some((index) => !Number.isInteger(index) || index < 0) || new Set(input.batchIndexes).size !== input.batchIndexes.length) {
      throw bulkError("bulk dispatch identity is invalid", "MONGODB_BULK_BATCH_ID_INVALID");
    }
    return { action, jobId, planHash: input.planHash, leaseId: input.leaseId, phase: input.phase, batchIndexes: input.batchIndexes };
  }
  if (action === "control") {
    const jobId = String(input.jobId || "").trim();
    if (!JOB_ID_PATTERN.test(jobId) || !["pause", "resume"].includes(input.command)) throw bulkError("bulk control request is invalid", "MONGODB_BULK_CONTROL_INVALID");
    if (input.planHash !== undefined && !HASH_PATTERN.test(String(input.planHash))) throw bulkError("planHash must be a SHA-256 digest", "MONGODB_BULK_PLAN_HASH_INVALID");
    return { action, jobId, command: input.command, planHash: input.planHash };
  }
  if (action === "heartbeat") {
    const jobId = String(input.jobId || "").trim();
    if (!JOB_ID_PATTERN.test(jobId) || !HASH_PATTERN.test(String(input.planHash || "")) || !HASH_PATTERN.test(String(input.leaseId || ""))) {
      throw bulkError("bulk heartbeat identity is invalid", "MONGODB_BULK_BATCH_ID_INVALID");
    }
    return { action, jobId, planHash: input.planHash, leaseId: input.leaseId };
  }
  if (action === "rollbackStart") {
    const jobId = String(input.jobId || "").trim();
    if (!JOB_ID_PATTERN.test(jobId) || !HASH_PATTERN.test(String(input.planHash || ""))) throw bulkError("bulk rollback identity is invalid", "MONGODB_BULK_PLAN_HASH_INVALID");
    if (input.confirmation !== MONGODB_BULK_ROLLBACK_CONFIRMATION) throw bulkError(`confirmation must exactly equal ${MONGODB_BULK_ROLLBACK_CONFIRMATION}`, "MONGODB_BULK_ROLLBACK_CONFIRMATION_REQUIRED");
    return { ...input, action: "rollbackStart", jobId };
  }
  if (action === "executeStart") {
    const jobId = String(input.jobId || "").trim();
    if (!JOB_ID_PATTERN.test(jobId) || !HASH_PATTERN.test(String(input.planHash || ""))) throw bulkError("bulk execution identity is invalid", "MONGODB_BULK_PLAN_HASH_INVALID");
    if (input.confirmation !== MONGODB_BULK_CONFIRMATION) throw bulkError(`confirmation must exactly equal ${MONGODB_BULK_CONFIRMATION}`, "MONGODB_BULK_CONFIRMATION_REQUIRED");
    return { ...input, action: "executeStart", jobId, leaseId: input.leaseId || createHash("sha256").update(randomUUID()).digest("hex") };
  }
  throw bulkError("unsupported MongoDB bulk action", "MONGODB_BULK_ACTION_INVALID");
}

export async function runMongoBulk(input = {}, options = {}) {
  const rawConfig = options.config && options.config.mongodb ? options.config.mongodb : options.config || {};
  const recoveryAction = input.action === "retire" || input.action === "recoverUpload" || input.action === "get" || input.action === "list" || input.action === "heartbeat" ||
    input.action === "pause" || input.action === "rollbackStart" || input.action === "rollbackBatch" ||
    input.action === "control" && input.command === "pause" ||
    input.action === "dispatch" && input.phase === "rollback" ||
    input.action === "finish" && input.mode === "rollback";
  const management = typeof input.action === "string" && input.action.startsWith("sandbox");
  if (management && rawConfig.enabled === false) throw bulkError("MongoDB sandbox access is disabled for this instance", "SANDBOX_MANAGEMENT_NOT_CONFIGURED", 403);
  let config, request, script;
  try {
    config = normalizeMongoBulkConfig(management ? { ...rawConfig, writeEnabled: true } : rawConfig, { requireBulkEnabled: !recoveryAction && !management });
    request = normalizeActionRequest(input, config);
    if (typeof options.runSSH !== "function") throw bulkError("MongoDB SSH runner is not configured", "MONGODB_RUNNER_UNAVAILABLE", 500);
  } catch (error) {
    if (input.action === "upload") error.dispatchState = "not_dispatched";
    throw error;
  }
  const operation = options.operation || normalizeOperationEnvelope({ operationId: input.operationId, timeoutMs: options.timeoutMs }, { defaultMs: 600_000, maxMs: 600_000 });
  request.operationId = operation.operationId;
  script = buildMongoBulkScript(request, config, { requireBulkEnabled: !recoveryAction && !management });
  let remoteResult;
  try {
    remoteResult = await options.runSSH(MONGODB_REMOTE_COMMAND, {
      config: options.config,
      operation,
      timeoutMs: options.timeoutMs || 600_000,
      priority: options.priority || "interactive",
      resourceTaskId: options.resourceTaskId,
      taskType: options.priority === "control" ? "control" : "mongo_read",
      stdin: script,
    });
  } catch (error) {
    const failure = publicBulkFailure(error, failureContext(request, operation, { layer: error.layer || "mongodb-bulk", phase: error.phase || request.action }), bulkMessages);
    const wrapped = operationError(failure.message, {
      code: failure.code,
      statusCode: error.statusCode || 502,
      operationId: operation.operationId,
      layer: "mongodb-bulk",
      phase: request.action,
      retriable: error.retriable === true,
      cause: failure.cause,
    });
    wrapped.failure = failure;
    throw wrapped;
  }
  if (remoteResult && remoteResult.stdoutTruncated || byteLength(remoteResult && remoteResult.stdout || "") > MAX_BULK_RESULT_BYTES) {
    throw bulkError("MongoDB bulk result exceeded the response limit", "MONGODB_BULK_RESULT_TOO_LARGE", 413);
  }
  const payload = parseMarker(remoteResult && remoteResult.stdout);
  if (!payload) throw bulkError("MongoDB bulk helper returned no structured response", "MONGODB_BULK_INVALID_RESPONSE", 502);
  if (payload.ok !== true || remoteResult && remoteResult.exitCode !== 0 || remoteResult && remoteResult.timedOut) {
    const error = operationError("MongoDB bulk request failed", {
      code: remoteResult && remoteResult.timedOut ? "MONGODB_BULK_TIMEOUT" : payload.error && payload.error.code || "MONGODB_BULK_FAILED",
      statusCode: remoteResult && remoteResult.timedOut ? 408 : 409,
      operationId: operation.operationId,
      layer: "mongodb-bulk",
      phase: request.action,
      retriable: remoteResult && remoteResult.timedOut === true,
    });
    const diagnostic = remoteResult?.timedOut ? { code: "MONGODB_BULK_TIMEOUT", message: "MongoDB bulk helper timed out", cause: payload.error } : payload.error;
    error.failure = publicBulkFailure(diagnostic, failureContext(request, operation, {
      ...diagnostic,
      layer: payload.error?.layer || "mongodb-helper", phase: payload.error?.phase || request.action,
      outcome: remoteResult?.timedOut ? "unknown" : payload.error?.outcome,
    }), bulkMessages);

    error.message = error.failure.message;
    throw error;
  }
  return { ...(payload.data || {}), timing: remoteResult && remoteResult.timing };
}

export class MongoBulkJobRunner {
  constructor(options = {}) {
    this.resourceClient = options.resourceClient;
    this.run = async (input, settings = {}) => {
      const operation = normalizeOperationEnvelope({ timeoutMs: settings.timeoutMs }, { defaultMs: 600_000, maxMs: 600_000 });
      try { return await options.runMongoBulk({ ...input, operationId: operation.operationId }, { ...settings, operation, resourceTaskId: this.active?.resourceTaskId }); }
      catch (error) {
        error.failure = error.failure ? publicBulkFailure(error.failure, { ...error.failure, parentOperationId: this.active?.operationId }, bulkMessages)
          : publicBulkFailure(error, failureContext(input, operation, { parentOperationId: this.active?.operationId }), bulkMessages);
        if (this.active?.operationId) error.failure.parentOperationId = this.active.operationId;
        throw error;
      }
    };
    this.onFailure = options.onFailure;
    this.config = normalizeMongoBulkConfig(options.config && options.config.mongodb ? options.config.mongodb : options.config || {}, { requireBulkEnabled: false });
    this.effectiveConcurrency = Math.min(this.config.bulkConcurrency, 4);
    this.active = null;
    this.tasks = new Map();
  }

  async start(input, mode = "execute", metadata = {}) {
    if (mode !== "rollback" && this.config.bulkEnabled !== true) {
      throw bulkError("MongoDB bulk changes are disabled; enable mongodb.bulkEnabled explicitly", "MONGODB_BULK_DISABLED", 403);
    }
    if (this.active) throw bulkError("another bulk job is already running for this instance", "MONGODB_BULK_INSTANCE_BUSY", 409, { jobId: this.active.jobId });
    const action = mode === "rollback" ? "rollbackStart" : "executeStart";
    const leaseId = createHash("sha256").update(randomUUID()).digest("hex");
    const accepted = await this.run({ ...input, action, leaseId }, { priority: "control", timeoutMs: 60_000 });
    this.active = { jobId: input.jobId, planHash: input.planHash, leaseId, mode, source: metadata.source, operationId: metadata.operationId };
    this.attachResourceTask(this.active);
    const promise = this.#runLoop(this.active).finally(() => {
      if (this.active && this.active.leaseId === leaseId) this.active = null;
      this.tasks.delete(input.jobId);
    });
    this.tasks.set(input.jobId, promise);
    promise.catch(() => {});
    return { ...accepted, accepted: true, background: true, effectiveConcurrency: this.effectiveConcurrency };
  }

  async control(input, metadata = {}) {
    if (input.command === "resume" && this.config.bulkEnabled !== true) {
      throw bulkError("MongoDB bulk changes are disabled; enable mongodb.bulkEnabled explicitly before resuming", "MONGODB_BULK_DISABLED", 403);
    }
    if (input.command === "resume" && this.active && this.active.jobId !== input.jobId) {
      throw bulkError("another bulk job is active for this instance", "MONGODB_BULK_INSTANCE_BUSY", 409, { jobId: this.active.jobId });
    }
    const result = await this.run({ action: "control", ...input }, { priority: "control", timeoutMs: 60_000 });
    if (input.command === "pause" && this.active?.resourceTaskId) {
      this.resourceClient.update(this.active.resourceTaskId, { status: "stopping", phase: "pausing" });
      this.active.resourceWaitController.abort(Object.assign(new Error("pause_requested"), { code: "pause_requested" }));
    }
    if (input.command === "resume" && !(this.active && this.active.jobId === input.jobId)) {
      const leaseId = createHash("sha256").update(randomUUID()).digest("hex");
      const accepted = await this.run({ action: "resume", jobId: input.jobId, planHash: input.planHash, leaseId }, { priority: "control", timeoutMs: 60_000 });
      this.active = { jobId: input.jobId, planHash: input.planHash, leaseId, mode: accepted.mode || "execute", operationId: metadata.operationId };
      this.attachResourceTask(this.active);
      const promise = this.#runLoop(this.active).finally(() => {
        if (this.active && this.active.leaseId === leaseId) this.active = null;
        this.tasks.delete(input.jobId);
      });
      this.tasks.set(input.jobId, promise);
      promise.catch(() => {});
      return { ...result, ...accepted, accepted: true, background: true, effectiveConcurrency: this.effectiveConcurrency };
    }
    return result;
  }

  attachResourceTask(job) {
    if (!this.resourceClient) return;
    for (const task of this.resourceClient.registry.tasks.values()) if (task.referenceId === job.jobId && task.type === "mongo_bulk" && task.status === "paused") this.resourceClient.update(task.taskId, { status: "stopped", phase: "resumed_as_new_execution" });
    job.resourceWaitController = new AbortController();
    job.resourceTaskId = this.resourceClient.register({ type: "mongo_bulk", referenceId: job.jobId,
      label: job.mode === "rollback" ? "数据库批量回滚" : "数据库批量修改",
      source: job.source,
      capabilities: ["pause", "resume", "detail"], requested: { cpuMilliCores: this.effectiveConcurrency * 200,
        rssLimitBytes: this.effectiveConcurrency * 128 * 1048576, parallelism: this.effectiveConcurrency } },
      { control: (command) => this.control({ jobId: job.jobId, planHash: job.planHash, command }),
        onBudget: async (budget) => {
          if (job.waveInFlight && budget.cpuMilliCores < (job.appliedBudget?.cpuMilliCores || 0)) await new Promise((resolve) => { (job.budgetWaiters ||= []).push(resolve); });
          job.appliedBudget = budget;
        } });
    this.resourceClient.update(job.resourceTaskId, { status: "starting", phase: "waiting_resources" });
  }

  async #runLoop(job) {
    let heartbeatBusy = false;
    const heartbeatTimer = this.resourceClient ? setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      this.run({ action: "heartbeat", jobId: job.jobId, planHash: job.planHash, leaseId: job.leaseId }, { priority: "control", timeoutMs: 20000 })
        .catch(() => {}).finally(() => { heartbeatBusy = false; });
    }, 20000) : null;
    heartbeatTimer?.unref?.();
    try {
      while (true) {
        const state = await this.run({ action: "get", jobId: job.jobId, includePlan: true }, { priority: "control", timeoutMs: 60_000 });
        if (state.status === "terminated_unknown") {
          if (job.resourceTaskId) this.resourceClient.update(job.resourceTaskId, { status: "stopped", phase: "terminated_unknown", inFlight: false });
          return;
        }
        if (job.resourceTaskId) this.resourceClient.update(job.resourceTaskId, { status: "running", phase: state.nextBatch < state.batchCount ? "executing" : "verifying",
          progress: Object.fromEntries(["batchCount", "nextBatch", "nextVerifyBatch", "committedBatchCount", "verifiedBatchCount", "operationCount"].filter((key) => Number.isFinite(state[key])).map((key) => [key, state[key]])) });
        if (state.desiredState === "pause" || state.status === "pause_requested" || state.status === "recovery_required" || state.status === "paused" && state.desiredState !== "running") {
          try { await this.run({ action: "pause", jobId: job.jobId, planHash: job.planHash, leaseId: job.leaseId, reason: "pause_requested" }, { priority: "control", timeoutMs: 30_000 }); } catch {}
          if (job.resourceTaskId) this.resourceClient.update(job.resourceTaskId, { status: "paused", phase: "paused", inFlight: false });
          return;
        }
        let concurrency = this.effectiveConcurrency;
        if (job.resourceTaskId) {
          job.diagnosticPhase = "resource_wait";
          await this.resourceClient.synchronize(job.resourceTaskId);
          await this.resourceClient.settled(job.resourceTaskId);
          const budget = await this.resourceClient.wait(job.resourceTaskId, job.resourceWaitController.signal);
          concurrency = Math.min(concurrency, budget.parallelism);
          if (budget.dispatchDelayMs) await new Promise((resolve) => setTimeout(resolve, budget.dispatchDelayMs));
        }
        if (job.mode === "rollback" || state.mode === "rollback") {
          if (state.nextRollbackBatch === null || state.nextRollbackBatch === undefined) break;
          await this.#runBatchWave(job, "rollback", "rollbackBatch", [state.nextRollbackBatch]);
          continue;
        }
        if (state.nextBatch < state.batchCount) {
          const indexes = Array.from(
            { length: Math.min(concurrency, state.batchCount - state.nextBatch) },
            (_value, offset) => state.nextBatch + offset,
          );
          await this.#runBatchWave(job, "execute", "executeBatch", indexes);
          continue;
        }
        if (state.nextVerifyBatch < state.batchCount) {
          const indexes = Array.from(
            { length: Math.min(concurrency, state.batchCount - state.nextVerifyBatch) },
            (_value, offset) => state.nextVerifyBatch + offset,
          );
          await this.#runBatchWave(job, "verify", "verifyBatch", indexes);
          continue;
        }
        break;
      }
      await this.run({ action: "finish", jobId: job.jobId, planHash: job.planHash, leaseId: job.leaseId, mode: job.mode }, { priority: "control", timeoutMs: 60_000 });
      if (job.resourceTaskId) this.resourceClient.update(job.resourceTaskId, { status: "completed", phase: "finished", inFlight: false });
    } catch (error) {
      error.failure ||= publicBulkFailure(error, { layer: job.diagnosticPhase === "resource_wait" ? "resource" : "mongodb-bulk", phase: job.diagnosticPhase || "runner", parentOperationId: job.operationId,
        fingerprint: value => createHash("sha256").update(value).digest("hex") }, bulkMessages);
      // A helper can acknowledge pause by releasing its lease before dispatch
      // cleanup runs. Preserve that intent, while keeping genuine conflicts.
      const reason = job.resourceWaitController?.signal.aborted && ["pause_requested", "MONGODB_BULK_LEASE_LOST"].includes(error.code)
        ? "pause_requested" : error.code || "MONGODB_BULK_FAILED";
      try {
        await this.run({ action: "pause", jobId: job.jobId, planHash: job.planHash, leaseId: job.leaseId, reason, failure: error.failure }, { priority: "control", timeoutMs: 30_000 });
      } catch (pauseError) {
        // Audit still exposes why remote diagnostic persistence was unavailable.
        error.failure.persistenceFailure = pauseError.failure || publicBulkFailure(pauseError, { phase: "pause" }, bulkMessages);
      }
      try { await this.onFailure?.({ jobId: job.jobId, planHash: job.planHash, pauseReason: reason, failure: error.failure }); } catch { /* manifest/events remain primary diagnostics */ }
      if (job.resourceTaskId) this.resourceClient.update(job.resourceTaskId, { status: "paused", phase: "paused", inFlight: false });
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  async #withHeartbeat(job, work) {
    let heartbeat = null;
    let inFlight = false;
    const interval = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      this.run({ action: "heartbeat", jobId: job.jobId, planHash: job.planHash, leaseId: job.leaseId }, { priority: "control", timeoutMs: 20_000 })
        .catch(() => {})
        .finally(() => { inFlight = false; });
    }, 20_000);
    interval.unref?.();
    try {
      heartbeat = await work();
      return heartbeat;
    } finally {
      clearInterval(interval);
    }
  }

  async #runBatchWave(job, phase, action, indexes) {
    job.waveInFlight = true;
    if (job.resourceTaskId) this.resourceClient.update(job.resourceTaskId, { inFlight: true, phase });
    let failure;
    try {
      await this.run({ action: "dispatch", jobId: job.jobId, planHash: job.planHash, leaseId: job.leaseId, phase, batchIndexes: indexes }, {
        priority: "control", timeoutMs: 30_000,
      });
      await this.#withHeartbeat(job, async () => {
        const results = await Promise.allSettled(indexes.map((batchIndex) => this.run({
          action, jobId: job.jobId, planHash: job.planHash, leaseId: job.leaseId, batchIndex,
        }, { priority: "bulk", timeoutMs: 600_000 })));
        const rejected = results.find((result) => result.status === "rejected");
        if (rejected) throw rejected.reason;
      });
    } catch (error) {
      failure = error;
    }
    try {
      await this.run({ action: "dispatch", jobId: job.jobId, planHash: job.planHash, leaseId: job.leaseId, phase, batchIndexes: [] }, {
        priority: "control", timeoutMs: 30_000,
      });
    } catch (error) {
      if (!failure) failure = error;
    }
    job.waveInFlight = false;
    for (const resolve of job.budgetWaiters || []) resolve(); job.budgetWaiters = [];
    if (job.resourceTaskId) this.resourceClient.update(job.resourceTaskId, { inFlight: false });
    if (failure) throw failure;
  }

  async pauseForShutdown() {
    const active = this.active;
    if (!active) return;
    try {
      await this.run({ action: "control", jobId: active.jobId, planHash: active.planHash, command: "pause" }, { priority: "control", timeoutMs: 10_000 });
    } catch {
      // A stale lease is detected and requires explicit recovery after restart.
    }
  }
}
