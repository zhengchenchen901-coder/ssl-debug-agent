import { createHash, randomUUID } from "node:crypto";
import posixPath from "node:path/posix";
import { MONGODB_CODEC_SCRIPT } from "./mongodb-codec.js";
import { MONGODB_BULK_RUNTIME } from "./mongodb-bulk-runtime.js";
import {
  MONGODB_REMOTE_COMMAND,
  MONGODB_RESULT_MARKER,
  redactMongoSecrets,
} from "./mongodb.js";
import { operationError } from "./operation.js";

export const MONGODB_BULK_CONFIRMATION = "确认执行";
export const MONGODB_BULK_ROLLBACK_CONFIRMATION = "确认回滚";
export const DEFAULT_MONGODB_BULK_ROOT = "/var/lib/remote-debug-agent/bulk-jobs";
export const DEFAULT_MONGODB_BULK_BATCH_DOCUMENTS = 500;
export const MAX_MONGODB_BULK_BATCH_DOCUMENTS = 2_000;
export const MAX_MONGODB_BULK_UNIT_OPERATIONS = 20;
export const MAX_MONGODB_BULK_CHUNK_OPERATIONS = 10_000;
export const MAX_MONGODB_BULK_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_MONGODB_BULK_JOB_OPERATIONS = 100_000;
export const MAX_MONGODB_BULK_JOB_BYTES = 40 * 1024 * 1024;
export const MAX_MONGODB_BULK_BATCH_INPUT_BYTES = 512 * 1024;
export const MAX_MONGODB_BULK_BATCH_JOURNAL_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MONGODB_BULK_ROLLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_MONGODB_BULK_ROLLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DATABASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const COLLECTION_PATTERN = /^[A-Za-z0-9_.$-]{1,128}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
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
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
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
  const allowedCollections = Array.isArray(config.allowedCollections) ? config.allowedCollections : [];
  const receiptsCollection = String(config.bulkReceiptsCollection || "__remote_debug_bulk_receipts").trim();
  if (!COLLECTION_PATTERN.test(receiptsCollection) || !allowedCollections.includes(receiptsCollection)) {
    throw bulkError(`the technical collection ${receiptsCollection} must be included in mongodb.allowedCollections`, "MONGODB_BULK_RECEIPTS_NOT_ALLOWED", 403);
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
      if (!FIELD_PATTERN.test(field) || field === "_id" || field.startsWith("_id.") || field.startsWith("$") || field.includes("\0")) {
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

function normalizeExpected(value, changedPaths) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw bulkError("updateOne requires original values in expected", "MONGODB_BULK_EXPECTED_REQUIRED");
  }
  const expected = {};
  for (const [field, condition] of Object.entries(value)) {
    if (!FIELD_PATTERN.test(field) || !condition || typeof condition !== "object" || Array.isArray(condition)) {
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
    return { collection, operation: "insertOne", document: normalizeDocument(value.document, `unit ${unitId} operation ${index}.document`) };
  }
  if (value.operation !== "updateOne") throw bulkError("bulk V1 supports only insertOne and updateOne", "MONGODB_BULK_OPERATION_UNSUPPORTED");
  const updatePlan = normalizeUpdate(value.update);
  return {
    collection,
    operation: "updateOne",
    id: normalizeId(value.id, `unit ${unitId} operation ${index}.id`),
    expected: normalizeExpected(value.expected, updatePlan.paths),
    update: updatePlan.update,
  };
}

function normalizeUnit(value, config, database) {
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
    collection: policy.bulkReceiptsCollection,
    storageRoot: policy.bulkRoot,
    rollbackTtlMs: policy.bulkRollbackTtlMs,
    riskLevel: "high",
  };
}

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
    `const __config = ${safeLiteral({ configPath: policy.configPath, driverPath: policy.driverPath, configProfile: policy.configProfile, uriKey: policy.uriKey, database: policy.database, allowedDatabases: policy.allowedDatabases, allowedCollections: policy.allowedCollections, bulkRoot: policy.bulkRoot, receiptsCollection: policy.bulkReceiptsCollection, batchDocuments: policy.bulkBatchDocuments, concurrency: Math.min(policy.bulkConcurrency, 4) })};`,
    `const __marker = ${safeLiteral(`${MONGODB_RESULT_MARKER}BULK:`)};`,
    'let __bson; try { __bson = require(require.resolve("bson", { paths: [__config.driverPath] })); } catch (_error) { __bson = null; }',
    MONGODB_CODEC_SCRIPT,
    MONGODB_BULK_RUNTIME,
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
  const recoveryAction = input.action === "get" || input.action === "list" || input.action === "heartbeat" ||
    input.action === "pause" || input.action === "rollbackStart" || input.action === "rollbackBatch" ||
    input.action === "control" && input.command === "pause" ||
    input.action === "dispatch" && input.phase === "rollback" ||
    input.action === "finish" && input.mode === "rollback";
  const config = normalizeMongoBulkConfig(rawConfig, { requireBulkEnabled: !recoveryAction });
  const request = normalizeActionRequest(input, config);
  if (typeof options.runSSH !== "function") throw bulkError("MongoDB SSH runner is not configured", "MONGODB_RUNNER_UNAVAILABLE", 500);
  let remoteResult;
  try {
    remoteResult = await options.runSSH(MONGODB_REMOTE_COMMAND, {
      config: options.config,
      operation: options.operation,
      timeoutMs: options.timeoutMs || 600_000,
      priority: options.priority || "interactive",
      stdin: buildMongoBulkScript(request, config, { requireBulkEnabled: !recoveryAction }),
    });
  } catch (error) {
    throw operationError(redactMongoSecrets(error.message || "MongoDB bulk helper could not be executed"), {
      code: error.code || "MONGODB_BULK_FAILED",
      statusCode: error.statusCode || 502,
      operationId: options.operation && options.operation.operationId,
      layer: "mongodb-bulk",
      phase: request.action,
      retriable: error.retriable === true,
      cause: error,
    });
  }
  if (remoteResult && remoteResult.stdoutTruncated || byteLength(remoteResult && remoteResult.stdout || "") > MAX_BULK_RESULT_BYTES) {
    throw bulkError("MongoDB bulk result exceeded the response limit", "MONGODB_BULK_RESULT_TOO_LARGE", 413);
  }
  const payload = parseMarker(remoteResult && remoteResult.stdout);
  if (!payload) throw bulkError("MongoDB bulk helper returned no structured response", "MONGODB_BULK_INVALID_RESPONSE", 502);
  if (payload.ok !== true || remoteResult && remoteResult.exitCode !== 0 || remoteResult && remoteResult.timedOut) {
    const error = operationError(redactMongoSecrets(payload.error && payload.error.message || remoteResult && remoteResult.stderr || "MongoDB bulk request failed"), {
      code: remoteResult && remoteResult.timedOut ? "MONGODB_BULK_TIMEOUT" : payload.error && payload.error.code || "MONGODB_BULK_FAILED",
      statusCode: remoteResult && remoteResult.timedOut ? 408 : 409,
      operationId: options.operation && options.operation.operationId,
      layer: "mongodb-bulk",
      phase: request.action,
      retriable: remoteResult && remoteResult.timedOut === true,
    });
    error.details = payload.error && payload.error.details;
    throw error;
  }
  return { ...(payload.data || {}), timing: remoteResult && remoteResult.timing };
}

export class MongoBulkJobRunner {
  constructor(options = {}) {
    this.run = options.runMongoBulk;
    this.config = normalizeMongoBulkConfig(options.config && options.config.mongodb ? options.config.mongodb : options.config || {}, { requireBulkEnabled: false });
    this.effectiveConcurrency = Math.min(this.config.bulkConcurrency, 4);
    this.active = null;
    this.tasks = new Map();
  }

  async start(input, mode = "execute") {
    if (mode !== "rollback" && this.config.bulkEnabled !== true) {
      throw bulkError("MongoDB bulk changes are disabled; enable mongodb.bulkEnabled explicitly", "MONGODB_BULK_DISABLED", 403);
    }
    if (this.active) throw bulkError("another bulk job is already running for this instance", "MONGODB_BULK_INSTANCE_BUSY", 409, { jobId: this.active.jobId });
    const action = mode === "rollback" ? "rollbackStart" : "executeStart";
    const leaseId = createHash("sha256").update(randomUUID()).digest("hex");
    const accepted = await this.run({ ...input, action, leaseId }, { priority: "control", timeoutMs: 60_000 });
    this.active = { jobId: input.jobId, planHash: input.planHash, leaseId, mode };
    const promise = this.#runLoop(this.active).finally(() => {
      if (this.active && this.active.leaseId === leaseId) this.active = null;
      this.tasks.delete(input.jobId);
    });
    this.tasks.set(input.jobId, promise);
    promise.catch(() => {});
    return { ...accepted, accepted: true, background: true, effectiveConcurrency: this.effectiveConcurrency };
  }

  async control(input) {
    if (input.command === "resume" && this.config.bulkEnabled !== true) {
      throw bulkError("MongoDB bulk changes are disabled; enable mongodb.bulkEnabled explicitly before resuming", "MONGODB_BULK_DISABLED", 403);
    }
    if (input.command === "resume" && this.active && this.active.jobId !== input.jobId) {
      throw bulkError("another bulk job is active for this instance", "MONGODB_BULK_INSTANCE_BUSY", 409, { jobId: this.active.jobId });
    }
    const result = await this.run({ action: "control", ...input }, { priority: "control", timeoutMs: 60_000 });
    if (input.command === "resume" && !(this.active && this.active.jobId === input.jobId)) {
      const leaseId = createHash("sha256").update(randomUUID()).digest("hex");
      const accepted = await this.run({ action: "resume", jobId: input.jobId, planHash: input.planHash, leaseId }, { priority: "control", timeoutMs: 60_000 });
      this.active = { jobId: input.jobId, planHash: input.planHash, leaseId, mode: accepted.mode || "execute" };
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

  async #runLoop(job) {
    try {
      while (true) {
        const state = await this.run({ action: "get", jobId: job.jobId, includePlan: true }, { priority: "control", timeoutMs: 60_000 });
        if (state.desiredState === "pause" || state.status === "pause_requested" || state.status === "recovery_required" || state.status === "paused" && state.desiredState !== "running") {
          try { await this.run({ action: "pause", jobId: job.jobId, planHash: job.planHash, leaseId: job.leaseId, reason: "pause_requested" }, { priority: "control", timeoutMs: 30_000 }); } catch {}
          return;
        }
        if (job.mode === "rollback" || state.mode === "rollback") {
          if (state.nextRollbackBatch === null || state.nextRollbackBatch === undefined) break;
          await this.#runBatchWave(job, "rollback", "rollbackBatch", [state.nextRollbackBatch]);
          continue;
        }
        if (state.nextBatch < state.batchCount) {
          const indexes = Array.from(
            { length: Math.min(this.effectiveConcurrency, state.batchCount - state.nextBatch) },
            (_value, offset) => state.nextBatch + offset,
          );
          await this.#runBatchWave(job, "execute", "executeBatch", indexes);
          continue;
        }
        if (state.nextVerifyBatch < state.batchCount) {
          const indexes = Array.from(
            { length: Math.min(this.effectiveConcurrency, state.batchCount - state.nextVerifyBatch) },
            (_value, offset) => state.nextVerifyBatch + offset,
          );
          await this.#runBatchWave(job, "verify", "verifyBatch", indexes);
          continue;
        }
        break;
      }
      await this.run({ action: "finish", jobId: job.jobId, planHash: job.planHash, leaseId: job.leaseId, mode: job.mode }, { priority: "control", timeoutMs: 60_000 });
    } catch (error) {
      try {
        await this.run({ action: "pause", jobId: job.jobId, planHash: job.planHash, leaseId: job.leaseId, reason: error.code || "MONGODB_BULK_FAILED" }, { priority: "control", timeoutMs: 30_000 });
      } catch {
        // The last persisted batch receipt remains the recovery source of truth.
      }
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
    await this.run({ action: "dispatch", jobId: job.jobId, planHash: job.planHash, leaseId: job.leaseId, phase, batchIndexes: indexes }, {
      priority: "control", timeoutMs: 30_000,
    });
    let failure;
    try {
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
