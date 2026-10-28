import { mutationDiagnostic } from "../plugins/remote-debug-agent/mutation-diagnostic.js";
import { EXECUTION_RISK_SCRIPT } from "./mongodb-execution-risk-runtime.js";
import { IMPORT_CONTROL_SCRIPT } from "./mongodb-import-control-runtime.js";
import { importBatchIdentity, prepareRequestDigest } from "../plugins/remote-debug-agent/prepare-protocol.js";
import { MONGODB_CODEC_SCRIPT } from "./mongodb-codec.js";
import { MONGODB_TECHNICAL_RECEIPTS_COLLECTION, MONGODB_TTL_POLICY_SCRIPT } from "./mongodb-ttl-policy.js";
import { isPrepareTicket, SAFE_MUTATION_ID_PATTERN } from "../plugins/remote-debug-agent/prepare-protocol.js";
import { normalizeMongoBulkStorage, DEFAULT_SANDBOX_DATABASE } from "./mongodb-bulk.js";
import { createHash, randomUUID } from "node:crypto";
import posixPath from "node:path/posix";
import {
  MONGODB_REMOTE_COMMAND,
  MONGODB_RESULT_MARKER,
  normalizeMongoConfig,
  redactMongoSecrets,
} from "./mongodb.js";
import {
  operationError,
  operationErrorForSignal,
} from "./operation.js";

export const MONGODB_MUTATION_SCHEMA_VERSION = 1;
export const MONGODB_MUTATION_OPERATIONS = Object.freeze([
  "insertOne",
  "updateOne",
  "updateMany",
  "softDeleteOne",
]);
export const MONGODB_INDEX_OPERATIONS = Object.freeze(["createIndex", "dropIndex"]);
export const MONGODB_MUTATION_CONFIRMATION = "确认执行";
export const MONGODB_ROLLBACK_CONFIRMATION = "确认回滚";
export const DEFAULT_MONGODB_MUTATION_ROLLBACK_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_MONGODB_MUTATION_ROLLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MONGODB_MUTATION_MAX_AFFECTED = 100;
export const MAX_MONGODB_MUTATION_MAX_AFFECTED = 1_000;
export const MAX_MONGODB_MUTATION_DOCUMENT_BYTES = 256 * 1024;
export const MAX_MONGODB_MUTATION_RESULT_BYTES = 512 * 1024;
export const MAX_MONGODB_MUTATION_JOURNAL_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MONGODB_MUTATION_JOURNAL_ROOT = "/tmp/remote-debug-agent/mutations";
export const MAX_MONGODB_MUTATION_LIST_ITEMS = 100;
export const MAX_MONGODB_TRANSACTION_OPERATIONS = 20;
export const MAX_MONGODB_IMPORT_BATCH_DOCUMENTS = 2_000;
export const MAX_MONGODB_IMPORT_DOCUMENTS = 10_000;
export const MAX_MONGODB_IMPORT_BYTES = 4 * 1024 * 1024;
export const MAX_MONGODB_IMPORT_BATCH_BYTES = 512 * 1024;
export const MAX_MONGODB_MUTATION_LOCK_AGE_MS = 15 * 60 * 1000;

const SAFE_DATABASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_COLLECTION_PATTERN = /^[A-Za-z0-9_.$-]{1,128}$/;
const SAFE_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
// 数组下标只接受规范十进制，禁止位置通配符和超大下标。
const SAFE_MUTATION_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9][0-9]{0,4}))*$/;
const SAFE_INDEX_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const SAFE_INDEX_DIRECTIONS = new Set([-1, 1]);
const ALLOWED_UPDATE_OPERATORS = new Set(["$set", "$unset", "$inc"]);
const ALLOWED_EJSON_KEYS = new Set([
  "$binary",
  "$date",
  "$numberDecimal",
  "$numberInt",
  "$numberLong",
  "$numberDouble",
  "$oid",
  "$regularExpression",
  "$timestamp",
]);
const BLOCKED_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "$accumulator",
  "$currentOp",
  "$function",
  "$merge",
  "$out",
  "$planCacheStats",
  "$where",
]);

function riskForDocumentOperation(operation) {
  if (operation === "updateMany") return "high";
  if (operation === "softDeleteOne") return "high";
  return "medium";
}

function riskForIndexOperation(operation, options = {}) {
  return operation === "dropIndex" || options.unique === true ? "high" : "medium";
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function clampText(value, maxChars = 2_000) {
  const text = redactMongoSecrets(value, maxChars);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function mutationError(message, code, statusCode = 400, details = {}) {
  const error = operationError(message, {
    code,
    statusCode,
    layer: "mongodb-mutation",
    phase: "validation",
    retriable: false,
  });
  error.details = details;
  return error;
}

function assertPlainObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw mutationError(`${fieldName} must be an object`, "INVALID_MONGODB_MUTATION");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw mutationError(`${fieldName} must be a plain object`, "INVALID_MONGODB_MUTATION");
  }
}

function assertSafeJson(value, fieldName = "$", depth = 0, allowNin = false) {
  if (depth > 12) {
    throw mutationError(`${fieldName} is too deeply nested`, "INVALID_MONGODB_MUTATION");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw mutationError(`${fieldName} contains a non-finite number`, "INVALID_MONGODB_MUTATION");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeJson(item, `${fieldName}[${index}]`, depth + 1, allowNin));
    return;
  }
  if (typeof value !== "object") {
    throw mutationError(`${fieldName} contains an unsupported value`, "INVALID_MONGODB_MUTATION");
  }
  for (const [key, child] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(key)) {
      throw mutationError(`${fieldName} contains a forbidden key`, "MONGODB_OPERATOR_REJECTED");
    }
    if (
      key.startsWith("$") &&
      !ALLOWED_EJSON_KEYS.has(key) &&
      !ALLOWED_UPDATE_OPERATORS.has(key) &&
      key !== "$in" && !(allowNin && key === "$nin")
    ) {
      throw mutationError(`${key} is not allowed by the MongoDB mutation tool`, "MONGODB_OPERATOR_REJECTED");
    }
    if (key === "$nin" && (!Array.isArray(child) || child.length === 0 || child.length > 1000)) {
      throw mutationError("$nin requires between 1 and 1000 values", "MONGODB_FILTER_REJECTED");
    }
    assertSafeJson(child, `${fieldName}.${key}`, depth + 1, allowNin);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeName(value, fieldName, pattern) {
  if (typeof value !== "string" || !pattern.test(value.trim())) {
    throw mutationError(`${fieldName} has an invalid format`, "INVALID_MONGODB_MUTATION");
  }
  return value.trim();
}

function normalizePositiveInt(value, fieldName, fallback, max) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw mutationError(`${fieldName} must be a positive integer`, "INVALID_MONGODB_MUTATION");
  }
  return Math.min(value, max);
}

function normalizeAllowedNames(value, fieldName, pattern, fallback = []) {
  if (value === undefined || value === null) {
    return [...fallback];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw mutationError(`${fieldName} must be a non-empty array`, "INVALID_MONGODB_MUTATION_CONFIG");
  }
  return [...new Set(value.map((item) => normalizeName(item, `${fieldName} item`, pattern)))];
}

function normalizeJournalRoot(value) {
  const raw = typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_MONGODB_MUTATION_JOURNAL_ROOT;
  const normalized = posixPath.normalize(raw);
  if (
    !normalized.startsWith("/tmp/remote-debug-agent/") ||
    normalized === "/tmp" ||
    normalized === "/tmp/" ||
    normalized.includes("\0")
  ) {
    throw mutationError(
      "mongodb mutation journal root must be a dedicated directory under /tmp",
      "MONGODB_JOURNAL_ROOT_INVALID",
    );
  }
  return normalized.replace(/\/$/, "");
}

export function normalizeMongoMutationConfig(config = {}) {
  const base = normalizeMongoConfig(config);
  if (config.writeEnabled !== true && config.mutationsEnabled !== true) {
    throw mutationError(
      "MongoDB mutations are disabled; set mongodb.writeEnabled=true explicitly",
      "MONGODB_MUTATIONS_DISABLED",
      403,
    );
  }

  const allowedDatabases = normalizeAllowedNames(
    config.allowedDatabases,
    "mongodb.allowedDatabases",
    SAFE_DATABASE_PATTERN,
    base.database ? [base.database] : [],
  );
  const allowedCollections = normalizeAllowedNames(
    config.allowedCollections,
    "mongodb.allowedCollections",
    SAFE_COLLECTION_PATTERN,
  );
  if (allowedDatabases.length === 0) {
    throw mutationError(
      "mongodb.allowedDatabases must contain at least one database",
      "MONGODB_DATABASE_ALLOWLIST_EMPTY",
      503,
    );
  }
  if (allowedCollections.length === 0) {
    throw mutationError(
      "mongodb.allowedCollections must contain at least one collection",
      "MONGODB_COLLECTION_ALLOWLIST_EMPTY",
      503,
    );
  }

  return {
    ...base,
    writeEnabled: true,
    rollbackRoot: normalizeJournalRoot(config.rollbackRoot),
    rollbackTtlMs: normalizePositiveInt(
      config.rollbackTtlMs,
      "mongodb.rollbackTtlMs",
      DEFAULT_MONGODB_MUTATION_ROLLBACK_TTL_MS,
      MAX_MONGODB_MUTATION_ROLLBACK_TTL_MS,
    ),
    maxAffectedDocuments: normalizePositiveInt(
      config.maxAffectedDocuments,
      "mongodb.maxAffectedDocuments",
      DEFAULT_MONGODB_MUTATION_MAX_AFFECTED,
      MAX_MONGODB_MUTATION_MAX_AFFECTED,
    ),
    maxImportBatchDocuments: normalizePositiveInt(
      config.maxImportBatchDocuments,
      "mongodb.maxImportBatchDocuments",
      MAX_MONGODB_IMPORT_BATCH_DOCUMENTS,
      MAX_MONGODB_IMPORT_BATCH_DOCUMENTS,
    ),
    bulkEnabled: config.bulkEnabled === true,
    bulkRoot: config.bulkRoot || "/var/lib/remote-debug-agent/bulk-jobs",
    sandboxDatabase: normalizeName(config.sandboxDatabase || DEFAULT_SANDBOX_DATABASE, "sandboxDatabase", SAFE_DATABASE_PATTERN),
    bulkReceiptsCollection: config.bulkReceiptsCollection || "__remote_debug_bulk_receipts",
    allowedDatabases,
    allowedCollections,
  };
}

function assertDatabaseAllowed(database, config) {
  const normalized = normalizeName(database, "database", SAFE_DATABASE_PATTERN);
  if (normalized === config.sandboxDatabase) throw mutationError("sandbox database is reserved for plugin management", "SANDBOX_DATABASE_RESERVED", 403);
  if (!config.allowedDatabases.includes(normalized)) {
    throw mutationError(
      `database is not allowed for mutations: ${normalized}`,
      "MONGODB_DATABASE_NOT_ALLOWED",
      403,
    );
  }
  return normalized;
}

function assertCollectionAllowed(collection, config) {
  const normalized = normalizeName(collection, "collection", SAFE_COLLECTION_PATTERN);
  if (!config.allowedCollections.includes(normalized)) {
    throw mutationError(
      `collection is not allowed for mutations: ${normalized}`,
      "MONGODB_COLLECTION_NOT_ALLOWED",
      403,
    );
  }
  return normalized;
}

function normalizeDocument(value, fieldName = "document") {
  assertPlainObject(value, fieldName);
  assertSafeJson(value, fieldName);
  if (!Object.prototype.hasOwnProperty.call(value, "_id") || value._id === null) {
    throw mutationError(`${fieldName} must contain an explicit _id`, "MONGODB_MUTATION_ID_REQUIRED");
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith("$") || key.includes("\0") || key.includes(".")) {
      throw mutationError(`${fieldName} contains an unsafe field name`, "MONGODB_FIELD_REJECTED");
    }
  }
  const normalized = cloneJson(value);
  if (byteLength(JSON.stringify(normalized)) > MAX_MONGODB_MUTATION_DOCUMENT_BYTES) {
    throw mutationError(`${fieldName} is too large`, "MONGODB_MUTATION_DOCUMENT_TOO_LARGE", 413);
  }
  return normalized;
}

function normalizeFilter(value, fieldName = "filter") {
  assertPlainObject(value, fieldName);
  assertSafeJson(value, fieldName, 0, true);
  const keys = Object.keys(value);
  if (keys.length === 0) {
    throw mutationError(`${fieldName} must not be empty`, "MONGODB_EMPTY_FILTER");
  }
  for (const key of keys) {
    if (key.startsWith("$")) {
      throw mutationError(`${fieldName} cannot use logical operators`, "MONGODB_FILTER_REJECTED");
    }
    if (!isSafeMutationPath(key) || key.startsWith("_id.")) {
      throw mutationError(`${fieldName} contains an unsafe field`, "MONGODB_FILTER_REJECTED");
    }
  }
  const normalized = cloneJson(value);
  if (byteLength(JSON.stringify(normalized)) > MAX_MONGODB_MUTATION_DOCUMENT_BYTES) {
    throw mutationError(`${fieldName} is too large`, "MONGODB_MUTATION_DOCUMENT_TOO_LARGE", 413);
  }
  return normalized;
}

function assertScopedFilter(filter, operation) {
  if (!Object.prototype.hasOwnProperty.call(filter, "_id")) {
    throw mutationError(
      operation === "updateMany"
        ? "updateMany requires filter._id.$in with an explicit bounded id list"
        : `${operation} requires an _id-scoped filter`,
      operation === "updateMany" ? "MONGODB_BATCH_SCOPE_REQUIRED" : "MONGODB_FILTER_SCOPE_REQUIRED",
    );
  }
  if (operation !== "updateMany") {
    if (filter._id && typeof filter._id === "object" && Object.prototype.hasOwnProperty.call(filter._id, "$nin")) {
      throw mutationError("document _id scope cannot use an exclusion filter", "MONGODB_FILTER_SCOPE_REQUIRED");
    }
    return;
  }
  const id = filter._id;
  if (!id || typeof id !== "object" || Array.isArray(id) || Object.keys(id).length !== 1 || !Array.isArray(id.$in)) {
    throw mutationError(
      "updateMany requires filter._id.$in with an explicit bounded id list",
      "MONGODB_BATCH_SCOPE_REQUIRED",
    );
  }
}

function normalizeUpdate(value, fieldName = "update") {
  assertPlainObject(value, fieldName);
  assertSafeJson(value, fieldName);
  const operators = Object.keys(value);
  if (operators.length === 0) {
    throw mutationError(`${fieldName} must not be empty`, "MONGODB_UPDATE_EMPTY");
  }
  for (const operator of operators) {
    if (!ALLOWED_UPDATE_OPERATORS.has(operator)) {
      throw mutationError(
        `${operator} is not allowed by the MongoDB mutation tool`,
        "MONGODB_UPDATE_OPERATOR_REJECTED",
      );
    }
    assertPlainObject(value[operator], `${fieldName}.${operator}`);
    for (const field of Object.keys(value[operator])) {
      if (!isSafeMutationPath(field) || field === "_id" || field.startsWith("_id.")) {
        throw mutationError(
          `${fieldName}.${operator} contains an unsafe or immutable field`,
          "MONGODB_FIELD_REJECTED",
        );
      }
      if (operator === "$inc" && (typeof value[operator][field] !== "number" || !Number.isFinite(value[operator][field]))) {
        throw mutationError(
          `${fieldName}.$inc values must be finite numbers`,
          "MONGODB_UPDATE_VALUE_REJECTED",
        );
      }
    }
  }
  const normalized = cloneJson(value);
  if (byteLength(JSON.stringify(normalized)) > MAX_MONGODB_MUTATION_DOCUMENT_BYTES) {
    throw mutationError(`${fieldName} is too large`, "MONGODB_MUTATION_DOCUMENT_TOO_LARGE", 413);
  }
  return normalized;
}

function isSafeMutationPath(field) {
  return SAFE_MUTATION_PATH_PATTERN.test(field) &&
    field.split(".").every((part) => !BLOCKED_KEYS.has(part));
}

function assertIndexedMutationGuards(filter, update) {
  for (const fields of Object.values(update)) {
    for (const field of Object.keys(fields)) {
      const parts = field.split(".");
      for (let index = 0; index < parts.length; index += 1) {
        if (!/^[0-9]+$/.test(parts[index])) continue;
        const prefix = parts.slice(0, index + 1).join(".");
        if (!Object.keys(filter).some((key) => key === prefix || key.startsWith(`${prefix}.`))) {
          throw mutationError("indexed updates require a filter guard for each array element", "MONGODB_ARRAY_GUARD_REQUIRED");
        }
      }
    }
  }
}

// 同一实现嵌入远程固定 helper；保持兼容远程 Node 12，不依赖外部变量。
export function assertIndexedMutationDocument(request, document) {
  for (const operator of Object.keys(request.update || {})) {
    for (const field of Object.keys(request.update[operator])) {
      const parts = field.split(".");
      let value = document;
      for (let position = 0; position < parts.length; position += 1) {
        const part = parts[position];
        if (/^[0-9]+$/.test(part)) {
          const index = Number(part);
          const append = Array.isArray(value) && index === value.length &&
            position === parts.length - 1 && operator === "$set";
          if (!Array.isArray(value) || index > value.length || (index === value.length && !append)) {
            const error = new Error("indexed mutation must target an existing array element or set its immediate tail");
            error.code = "MONGODB_ARRAY_INDEX_INVALID";
            throw error;
          }
        }
        value = value == null ? undefined : value[part];
      }
    }
  }
}

function normalizeCommonMutation(input, config, operationId, kind = "document") {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw mutationError("MongoDB mutation must be an object", "INVALID_MONGODB_MUTATION");
  }
  const database = assertDatabaseAllowed(
    input.database || config.database,
    config,
  );
  const collection = assertCollectionAllowed(input.collection, config);
  if (collection === MONGODB_TECHNICAL_RECEIPTS_COLLECTION && kind !== "bulk_storage") {
    throw mutationError("the technical receipt collection is reserved for internal bulk storage operations", "MONGODB_BULK_RESERVED_COLLECTION", 403);
  }
  const rollbackTtlMs = normalizePositiveInt(
    input.rollbackTtlMs,
    "rollbackTtlMs",
    config.rollbackTtlMs,
    MAX_MONGODB_MUTATION_ROLLBACK_TTL_MS,
  );
  return {
    kind,
    operationId: typeof operationId === "string" && operationId.trim()
      ? operationId.trim().slice(0, 128)
      : randomUUID(),
    purpose: typeof input.purpose === "string" ? clampText(input.purpose.trim(), 500) : undefined,
    database,
    collection,
    rollbackTtlMs,
  };
}

export function normalizeMongoMutation(input = {}, config = {}, options = {}) {
  const normalizedConfig = normalizeMongoMutationConfig(config);
  const operation = input.operation;
  if (!MONGODB_MUTATION_OPERATIONS.includes(operation)) {
    throw mutationError(
      `operation must be one of ${MONGODB_MUTATION_OPERATIONS.join(", ")}`,
      "INVALID_MONGODB_MUTATION_OPERATION",
    );
  }
  const common = normalizeCommonMutation(input, normalizedConfig, options.operationId);
  const maxAffected = normalizePositiveInt(
    input.maxAffected,
    "maxAffected",
    normalizedConfig.maxAffectedDocuments,
    normalizedConfig.maxAffectedDocuments,
  );
  if (operation === "insertOne") {
    return {
      ...common,
      operation,
      document: normalizeDocument(input.document),
      maxAffected: 1,
      riskLevel: riskForDocumentOperation(operation),
    };
  }

  const filter = normalizeFilter(input.filter);
  assertScopedFilter(filter, operation);
  if (
    operation === "updateMany" &&
    (filter._id.$in.length === 0 || filter._id.$in.length > maxAffected)
  ) {
    throw mutationError(
      "updateMany filter._id.$in must contain between 1 and maxAffected ids",
      "MONGODB_BATCH_SCOPE_INVALID",
    );
  }
  const update = operation === "softDeleteOne"
    ? {
        $set: {
          [normalizeName(input.deletedField || "deletedAt", "deletedField", SAFE_FIELD_PATTERN)]:
            typeof input.deletedValue === "string" && input.deletedValue.trim()
              ? input.deletedValue.trim().slice(0, 128)
              : new Date().toISOString(),
        },
      }
    : normalizeUpdate(input.update);
  assertIndexedMutationGuards(filter, update);
  const expectedCount = input.expectedCount === undefined
    ? undefined
    : normalizePositiveInt(input.expectedCount, "expectedCount", 1, maxAffected);
  return {
    ...common,
    operation,
    filter,
    update,
    maxAffected: operation === "updateOne" || operation === "softDeleteOne" ? 1 : maxAffected,
    expectedCount,
    riskLevel: riskForDocumentOperation(operation),
  };
}

// Import limits are separate from the ordinary document/transaction limits.
export function normalizeMongoImport(input = {}, config = {}, options = {}) {
  const policy = normalizeMongoMutationConfig(config);
  const common = normalizeCommonMutation(input, policy, options.operationId, "import");
  const importId = normalizeName(input.importId, "importId", options.historicalReviewOnly === true ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ : /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  if (!Array.isArray(input.documents) || !input.documents.length || input.documents.length > MAX_MONGODB_IMPORT_DOCUMENTS) {
    throw mutationError("documents must contain between 1 and 10000 documents", "MONGODB_IMPORT_COUNT_LIMIT");
  }
  if (byteLength(JSON.stringify(input.documents)) > MAX_MONGODB_IMPORT_BYTES) {
    throw mutationError("import documents exceed 4 MiB; send smaller input chunks", "MONGODB_IMPORT_SIZE_LIMIT", 413);
  }
  const batchSize = normalizePositiveInt(input.batchSize, "batchSize", policy.maxImportBatchDocuments, policy.maxImportBatchDocuments);
  const batches = [];
  const seen = new Set();
  let documents = [];
  let bytes = 2;
  const flush = () => {
    if (!documents.length) return;
    const batch = { ...common, operation: "insertMany", importId, batchIndex: batches.length,
      source: { configPath: policy.configPath, configProfile: policy.configProfile, uriKey: policy.uriKey, driverPath: policy.driverPath },
      documents, maxAffected: documents.length, riskLevel: "high" };
    // Same exact input reuses journals even when the MCP operation id changes.
    const { operationId: _operationId, ...identity } = batch;
    batch.mutationId = "import-" + createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    batches.push(batch);
    documents = [];
    bytes = 2;
  };
  for (const value of input.documents) {
    const document = normalizeDocument(value);
    const id = document._id;
    const oid = id && typeof id === "object" && Object.keys(id).length === 1 && typeof id.$oid === "string" && /^[a-f0-9]{24}$/i.test(id.$oid);
    if (!(typeof id === "string" && id.length > 0 && id.length <= 256) && !Number.isSafeInteger(id) && !oid) {
      throw mutationError("import _id must be a non-empty string (up to 256 characters), safe integer or $oid", "MONGODB_IMPORT_ID_INVALID");
    }
    if (oid) document._id.$oid = id.$oid.toLowerCase();
    const key = JSON.stringify(document._id);
    if (seen.has(key)) throw mutationError("import contains duplicate _id values", "MONGODB_IMPORT_DUPLICATE_ID");
    seen.add(key);
    const size = byteLength(JSON.stringify(document)) + 1;
    if (documents.length >= batchSize || bytes + size > MAX_MONGODB_IMPORT_BATCH_BYTES) flush();
    documents.push(document);
    bytes += size;
  }
  flush();
  if (batches.length > 100) throw mutationError("import exceeds 100 batches; send smaller input chunks", "MONGODB_IMPORT_BATCH_LIMIT");
  return { kind: "import_plan", importId, database: common.database, collection: common.collection,
    operationId: common.operationId, affectedCount: input.documents.length, batches };
}

export function normalizeMongoTransaction(input = {}, config = {}, options = {}) {
  const normalizedConfig = normalizeMongoMutationConfig(config);
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw mutationError(
      "operations must be a non-empty array",
      "INVALID_MONGODB_TRANSACTION",
    );
  }
  if (input.operations.length > MAX_MONGODB_TRANSACTION_OPERATIONS) {
    throw mutationError(
      `transactions cannot contain more than ${MAX_MONGODB_TRANSACTION_OPERATIONS} operations`,
      "MONGODB_TRANSACTION_TOO_LARGE",
    );
  }
  const operationId = typeof options.operationId === "string" && options.operationId.trim()
    ? options.operationId.trim().slice(0, 128)
    : randomUUID();
  const database = input.database || input.operations[0]?.database || normalizedConfig.database;
  const operations = input.operations.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.kind === "index") {
      throw mutationError(`transaction operation at index ${index} must be a document mutation`, "INVALID_MONGODB_TRANSACTION");
    }
    const normalized = normalizeMongoMutation(
      { ...item, database },
      normalizedConfig,
      { operationId: `${operationId}:${index}` },
    );
    if (normalized.database !== database) {
      throw mutationError("all transaction operations must use the same database", "MONGODB_TRANSACTION_DATABASE_MISMATCH");
    }
    return normalized;
  });
  const totalMaxAffected = operations.reduce((total, item) => total + item.maxAffected, 0);
  if (totalMaxAffected > normalizedConfig.maxAffectedDocuments) {
    throw mutationError(
      "transaction operations exceed the instance affected-document limit",
      "MONGODB_TRANSACTION_AFFECTED_LIMIT",
    );
  }
  return {
    kind: "transaction",
    operation: "transaction",
    operationId,
    purpose: typeof input.purpose === "string" ? clampText(input.purpose.trim(), 500) : undefined,
    database,
    collections: [...new Set(operations.map((item) => item.collection))],
    operations,
    rollbackTtlMs: normalizePositiveInt(
      input.rollbackTtlMs,
      "rollbackTtlMs",
      normalizedConfig.rollbackTtlMs,
      MAX_MONGODB_MUTATION_ROLLBACK_TTL_MS,
    ),
    maxAffected: normalizedConfig.maxAffectedDocuments,
    riskLevel: operations.some((item) => item.riskLevel === "high") || operations.length > 1
      ? "high"
      : "medium",
  };
}

function normalizeIndexKey(value) {
  assertPlainObject(value, "key");
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > 8) {
    throw mutationError("index key must contain between 1 and 8 fields", "INVALID_MONGODB_INDEX");
  }
  const normalized = {};
  for (const field of keys) {
    if (!SAFE_FIELD_PATTERN.test(field) || field.startsWith("_id.")) {
      throw mutationError(`index key contains an unsafe field: ${field}`, "MONGODB_INDEX_FIELD_REJECTED");
    }
    if (!SAFE_INDEX_DIRECTIONS.has(value[field])) {
      throw mutationError("index key directions must be 1 or -1", "MONGODB_INDEX_KEY_REJECTED");
    }
    normalized[field] = value[field];
  }
  return normalized;
}

function normalizeIndexOptions(value = {}) {
  assertPlainObject(value, "options");
  if (Object.prototype.hasOwnProperty.call(value, "expireAfterSeconds")) {
    throw mutationError("business TTL indexes are not supported: index rollback cannot recover automatically deleted documents", "MONGODB_TTL_INDEX_REJECTED", 403);
  }
  const allowed = new Set(["unique", "sparse"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw mutationError(`index option is not allowed: ${key}`, "MONGODB_INDEX_OPTION_REJECTED");
    }
  }
  const options = {};
  if (value.unique !== undefined) {
    if (typeof value.unique !== "boolean") throw mutationError("options.unique must be boolean", "INVALID_MONGODB_INDEX");
    options.unique = value.unique;
  }
  if (value.sparse !== undefined) {
    if (typeof value.sparse !== "boolean") throw mutationError("options.sparse must be boolean", "INVALID_MONGODB_INDEX");
    options.sparse = value.sparse;
  }
  return options;
}

export function normalizeMongoCollectionCreate(input = {}, config = {}, options = {}) {
  if (input.operation !== undefined && input.operation !== "createCollection") throw mutationError("only createCollection is supported", "INVALID_MONGODB_COLLECTION_OPERATION");
  if (input.options !== undefined) throw mutationError("collection options are not supported", "INVALID_MONGODB_COLLECTION_OPTIONS");
  return { ...normalizeCommonMutation(input, normalizeMongoMutationConfig(config), options.operationId, "collection"), operation: "createCollection", riskLevel: "high" };
}

export function normalizeMongoIndexChange(input = {}, config = {}, options = {}) {
  const normalizedConfig = normalizeMongoMutationConfig(config);
  const indexOptions = normalizeIndexOptions(input.options);
  if (!MONGODB_INDEX_OPERATIONS.includes(input.operation)) {
    throw mutationError(
      `operation must be one of ${MONGODB_INDEX_OPERATIONS.join(", ")}`,
      "INVALID_MONGODB_INDEX_OPERATION",
    );
  }
  const common = normalizeCommonMutation(input, normalizedConfig, options.operationId, "index");
  const name = normalizeName(input.name, "name", SAFE_INDEX_NAME_PATTERN);
  if (name === "_id_") {
    throw mutationError("the _id_ index cannot be changed", "MONGODB_INDEX_IMMUTABLE");
  }
  return {
    ...common,
    operation: input.operation,
    name,
    ...(input.operation === "createIndex"
      ? {
          key: normalizeIndexKey(input.key),
          options: indexOptions,
        }
      : {}),
    riskLevel: riskForIndexOperation(input.operation, input.options),
  };
}

export function summarizeMongoMutation(input = {}) {
  const updateFields = input.update && typeof input.update === "object"
    ? Object.values(input.update).flatMap((value) => value && typeof value === "object" ? Object.keys(value) : [])
    : [];
  return {
    kind: input.kind,
    operation: typeof input.operation === "string" ? input.operation.slice(0, 64) : undefined,
    database: typeof input.database === "string" ? input.database.slice(0, 128) : undefined,
    collection: typeof input.collection === "string" ? input.collection.slice(0, 128) : undefined,
    name: typeof input.name === "string" ? input.name.slice(0, 128) : undefined,
    filterKeys: input.filter && typeof input.filter === "object" && !Array.isArray(input.filter)
      ? Object.keys(input.filter).slice(0, 20)
      : [],
    documentKeys: input.document && typeof input.document === "object" && !Array.isArray(input.document)
      ? Object.keys(input.document).slice(0, 50)
      : [],
    updateFields: [...new Set(updateFields)].slice(0, 50),
    riskLevel: input.riskLevel,
    requiresConfirmation: input.requiresConfirmation !== false,
    maxAffected: input.maxAffected,
    expectedCount: input.expectedCount,
    importId: typeof input.importId === "string" ? input.importId.slice(0, 64) : undefined,
    documentCount: Array.isArray(input.documents) ? input.documents.length : undefined,
  };
}

function safeLiteral(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildMongoMutationScript(request, config) {
  const normalizedConfig = normalizeMongoMutationConfig(config);
  // This string runs on the remote server's Node.js, independently of the
  // local Node 22 bundle. Keep it free of optional chaining/nullish coalescing.
  const script = `
const __fs = require("fs");
const __path = require("path");
const { createHash: __createHash, randomBytes: __randomBytes } = require("crypto");
const __configPath = ${safeLiteral(normalizedConfig.configPath)};
const __driverPath = ${safeLiteral(normalizedConfig.driverPath)};
const __profileName = ${safeLiteral(normalizedConfig.configProfile)};
const __uriKey = ${safeLiteral(normalizedConfig.uriKey)};
const __journalRoot = ${safeLiteral(normalizedConfig.rollbackRoot)};
const __allowedDatabases = ${safeLiteral(normalizedConfig.allowedDatabases)};
const __allowedCollections = ${safeLiteral(normalizedConfig.allowedCollections)};
const __bulkEnabled = ${safeLiteral(config.bulkEnabled === true)};
const __bulkRoot = ${safeLiteral(config.bulkRoot || "/var/lib/remote-debug-agent/bulk-jobs")};
const __sandboxDatabase = ${safeLiteral(config.sandboxDatabase || DEFAULT_SANDBOX_DATABASE)};
const __bulkReceiptsCollection = ${safeLiteral(config.bulkReceiptsCollection || "__remote_debug_bulk_receipts")};
const __importBatchLimit = ${normalizedConfig.maxImportBatchDocuments};
const __request = ${safeLiteral(request)};
const __marker = ${safeLiteral(MONGODB_RESULT_MARKER)};
const __schemaVersion = ${MONGODB_MUTATION_SCHEMA_VERSION};
const __maxTimeMs = 15000;
let __diagnosticPhase = "validation";
let __serverWireVersion;
let __driverVersion;
function __diagnostic(error) {
  const number = Number.isSafeInteger(error.code) ? error.code : undefined;
  const category = error.writeConcernError || error.name === "MongoWriteConcernError" || [64, 79, 100].includes(number) ? "write_concern"
    : number === 13 ? "permission" : number === 11000 ? "duplicate_key"
    : [26, 48].includes(number) ? "namespace" : [20, 263, 303].includes(number) ? "transaction_support"
    : ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED"].includes(error.code) || ["MongoNetworkError", "MongoNetworkTimeoutError", "MongoServerSelectionError"].includes(error.name) ? "network"
    : number !== undefined ? "server" : "client_or_control";
  return { phase: __diagnosticPhase, category, databaseCode: number,
    filesystemCode: ["EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ELOOP", "EINVAL", "EMFILE", "ENFILE", "ENOTDIR"].includes(error.code) ? error.code : undefined,
    serverMaxWireVersion: __serverWireVersion, driverVersion: __driverVersion };
}
let __bson;
try {
  __bson = require(require.resolve("bson", { paths: [__driverPath] }));
} catch (_error) {
  __bson = null;
}

function __fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

const __ttlFail = __fail;
${MONGODB_TTL_POLICY_SCRIPT}

function __stable(value) {
  if (Array.isArray(value)) return value.map(__stable);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = __stable(value[key]);
      return result;
    }, {});
  }
  return value;
}

function __hash(value) {
  return __createHash("sha256").update(JSON.stringify(__stable(value))).digest("hex");
}

${IMPORT_CONTROL_SCRIPT}
${EXECUTION_RISK_SCRIPT}

${MONGODB_CODEC_SCRIPT}

const __assertIndexedMutationDocument = ${assertIndexedMutationDocument.toString()};

function __documentHash(value) {
  return __hash(__encode(value));
}

function __documentHashes(documents) {
  return (documents || []).map((document) => ({
    id: __encode(document._id),
    hash: __documentHash(document),
  }));
}

function __journalDir() {
  if (!__request.mutationId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(__request.mutationId)) {
    __fail("MONGODB_MUTATION_ID_INVALID", "mutationId has an invalid format");
  }
  return __path.join(__journalRoot, __request.mutationId);
}

function __ensureJournalDir() {
  const directory = __journalDir();
  if (__fs.existsSync(__journalRoot) && __fs.lstatSync(__journalRoot).isSymbolicLink()) {
    __fail("MONGODB_JOURNAL_SYMLINK_REJECTED", "mutation journal root cannot be a symbolic link");
  }
  __fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const rootStat = __fs.lstatSync(__journalRoot);
  const directoryStat = __fs.lstatSync(directory);
  if (rootStat.isSymbolicLink() || directoryStat.isSymbolicLink()) {
    __fail("MONGODB_JOURNAL_SYMLINK_REJECTED", "mutation journal path cannot be a symbolic link");
  }
  try { __fs.chmodSync(__journalRoot, 0o700); } catch (_error) {}
  try { __fs.chmodSync(directory, 0o700); } catch (_error) {}
  return directory;
}

function __writeJsonAtomic(fileName, value) {
  const directory = __ensureJournalDir();
  const filePath = __path.join(directory, fileName);
  const temporaryPath = filePath + "." + process.pid + "." + __randomBytes(16).toString("hex") + ".tmp";
  const body = JSON.stringify(value, null, 2) + "\\n";
  if (Buffer.byteLength(body, "utf8") > ${MAX_MONGODB_MUTATION_JOURNAL_BYTES}) {
    __fail("MONGODB_JOURNAL_TOO_LARGE", "mutation journal exceeds the size limit");
  }
  const fd = __fs.openSync(temporaryPath, "w", 0o600);
  try {
    __fs.writeFileSync(fd, body, "utf8");
    __fs.fsyncSync(fd);
  } finally {
    __fs.closeSync(fd);
  }
  __fs.renameSync(temporaryPath, filePath);
  try { __fs.chmodSync(filePath, 0o600); } catch (_error) {}
  const parentFd = __fs.openSync(directory, "r");
  try { __fs.fsyncSync(parentFd); } finally { __fs.closeSync(parentFd); }
}

function __appendJournal(event, details = {}) {
  const directory = __ensureJournalDir();
  const filePath = __path.join(directory, "journal.jsonl");
  if (__fs.existsSync(filePath) && __fs.lstatSync(filePath).isSymbolicLink()) {
    __fail("MONGODB_JOURNAL_SYMLINK_REJECTED", "mutation journal cannot be a symbolic link");
  }
  const fd = __fs.openSync(filePath, __fs.constants.O_CREAT | __fs.constants.O_APPEND | __fs.constants.O_WRONLY, 0o600);
  try {
    __fs.writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), event, ...details }) + "\\n", "utf8");
    __fs.fsyncSync(fd);
  } finally {
    __fs.closeSync(fd);
  }
}

function __loadManifest() {
  const filePath = __path.join(__journalDir(), "manifest.json");
  if (!__fs.existsSync(filePath)) __fail("MONGODB_MUTATION_NOT_FOUND", "mutation manifest was not found");
  if (__fs.lstatSync(filePath).isSymbolicLink()) __fail("MONGODB_JOURNAL_SYMLINK_REJECTED", "mutation manifest cannot be a symbolic link");
  let manifest;
  try {
    manifest = JSON.parse(__fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    __fail("MONGODB_MUTATION_MANIFEST_INVALID", "mutation manifest is invalid");
  }
  if (!manifest || manifest.schemaVersion !== __schemaVersion || manifest.mutationId !== __request.mutationId) {
    __fail("MONGODB_MUTATION_MANIFEST_INVALID", "mutation manifest does not match the request");
  }
  if (manifest.planHash !== __request.planHash) {
    __fail("MONGODB_MUTATION_PLAN_HASH_MISMATCH", "mutation plan hash does not match the manifest");
  }
  if (__planHash(manifest) !== manifest.planHash) {
    __fail("MONGODB_MUTATION_MANIFEST_TAMPERED", "mutation manifest integrity check failed");
  }
  __assertManifestScope(manifest);
  return manifest;
}

function __acquireMutationLock(reclaimStale = true) {
  const directory = __ensureJournalDir();
  const lockPath = __path.join(directory, ".lock");
  let fd;
  try {
    fd = __fs.openSync(lockPath, "wx", 0o600);
    __fs.writeFileSync(fd, String(process.pid), "utf8");
    __fs.fsyncSync(fd);
    __fs.closeSync(fd);
  } catch (error) {
    try { if (fd !== undefined) __fs.closeSync(fd); } catch (_closeError) {}
    if (error.code === "EEXIST") {
      try {
        const lockStat = __fs.statSync(lockPath);
        if (reclaimStale && Date.now() - lockStat.mtimeMs > ${MAX_MONGODB_MUTATION_LOCK_AGE_MS}) {
          __fs.unlinkSync(lockPath);
          return __acquireMutationLock(reclaimStale);
        }
      } catch (_lockError) {}
      __fail("MONGODB_MUTATION_BUSY", "another mutation operation is using this journal");
    }
    throw error;
  }
  return () => {
    try { __fs.unlinkSync(lockPath); } catch (_error) {}
  };
}

function __summary(manifest) {
  const isTransaction = manifest.kind === "transaction";
  return {
    mutationId: manifest.mutationId,
    operationId: manifest.operationId,
    kind: manifest.kind,
    operation: isTransaction ? "transaction" : manifest.request.operation,
    database: manifest.request.database,
    collection: isTransaction ? undefined : manifest.request.collection,
    collections: isTransaction ? manifest.request.collections : undefined,
    name: manifest.request.name,
    status: manifest.status,
    rollbackMode: manifest.rollbackMode,
    riskLevel: manifest.riskLevel,
    requiresConfirmation: manifest.requiresConfirmation !== false,
    purpose: manifest.request.purpose,
    createdAt: manifest.createdAt,
    committedAt: manifest.committedAt,
    rolledBackAt: manifest.rolledBackAt,
    rollbackExpiresAt: manifest.rollbackExpiresAt,
    planHash: manifest.planHash,
    affectedCount: manifest.affectedCount,
    changedFields: manifest.changedFields,
    affectedIds: manifest.affectedIds,
    storageRoot: manifest.request.storageRoot,
    ...(manifest.kind === "bulk_storage" ? { receiptsDatabase: manifest.request.receiptsDatabase || manifest.request.database } : {}),
    storageStatus: manifest.storageStatus,
    execution: manifest.execution,
    indexRecovery: manifest.indexRecovery,
    importExecution: manifest.importExecution,
    diagnostic: manifest.diagnostic,
    collectionReceipt: manifest.collectionReceipt,
    ...(manifest.kind === "index" ? { rollbackRestoresDocuments: false } : {}),
    ...(manifest.kind === "import" ? {
      importId: manifest.request.importId,
      batchIndex: manifest.request.batchIndex,
      retryable: ["commit_retryable", "rollback_retryable"].includes(manifest.status) && !!manifest.importExecution && manifest.importExecution.stage === "safe_terminal",
    } : {}),
    journalPath: __path.join(__journalRoot, manifest.mutationId),
  };
}

function __assertManifestScope(manifest) {
  if (manifest.prepare && __hash(manifest.prepareSource) !== __hash({ configPath: __configPath, driverPath: __driverPath, profile: __profileName, uriKey: __uriKey })) {
    __fail("MONGODB_MUTATION_POLICY_CHANGED", "preparation belongs to a different connection profile");
  }
  if (manifest.kind === "import" && manifest.request.documents.length > __importBatchLimit) {
    __fail("MONGODB_MUTATION_POLICY_CHANGED", "import batch exceeds the current instance limit");
  }
  if (manifest.kind === "import" && __hash(manifest.request.source) !== __hash({
    configPath: __configPath, configProfile: __profileName, uriKey: __uriKey, driverPath: __driverPath,
  })) {
    __fail("MONGODB_MUTATION_POLICY_CHANGED", "import belongs to a different database connection profile");
  }
  const requests = manifest.kind === "transaction"
    ? (manifest.request.operations || [])
    : [manifest.request];
  for (const request of requests) {
    if (!__allowedDatabases.includes(request.database) || manifest.kind !== "bulk_storage" && !__allowedCollections.includes(request.collection)) {
      __fail("MONGODB_MUTATION_POLICY_CHANGED", "the mutation is no longer within the current database policy");
    }
    if (manifest.kind !== "bulk_storage" && request.collection === ${safeLiteral(MONGODB_TECHNICAL_RECEIPTS_COLLECTION)}) {
      __fail("MONGODB_BULK_RESERVED_COLLECTION", "the technical receipt collection is reserved for internal bulk storage operations");
    }
    if (manifest.kind !== "bulk_storage" && request.database === __sandboxDatabase) __fail("SANDBOX_DATABASE_RESERVED", "sandbox database is reserved for plugin management");
  }
  if (manifest.kind === "index") {
    if (__request.mode === "commit" && manifest.request.operation === "createIndex") __ttlRejectBusinessIndex(manifest.request.options);
    if (__request.mode === "rollback" && manifest.request.operation === "dropIndex") __ttlRejectBusinessIndex(manifest.beforeIndex);
  }
  if (manifest.kind === "bulk_storage") {
    __ttlAssertReceiptName(manifest.request.collection);
    if (manifest.request.receiptsDatabase && manifest.request.receiptsDatabase !== __sandboxDatabase) __fail("SANDBOX_DATABASE_CHANGED", "the prepared sandbox database no longer matches configuration");
  }
  if (manifest.kind === "bulk_storage" && (!manifest.request.storageRoot || !manifest.request.storageRoot.startsWith("/"))) {
    __fail("MONGODB_MUTATION_POLICY_CHANGED", "bulk storage root is missing from the prepared plan");
  }
}

function __idSummary(value) {
  const encoded = __encode(value);
  if (typeof encoded === "string") return encoded.slice(0, 256);
  return encoded;
}

function __changedFields(update) {
  return [...new Set(Object.values(update || {}).flatMap((value) => value && typeof value === "object" ? Object.keys(value) : []))].slice(0, 100);
}

// Driver cleanup can return void, reject, or throw synchronously. It must never
// replace the transaction outcome or prevent saving rollback metadata.
async function __cleanup(action) {
  try { await action(); } catch (_cleanupError) {}
}

async function __loadClient() {
  const fileConfig = JSON.parse(__fs.readFileSync(__configPath, "utf8"));
  const profile = fileConfig && fileConfig[__profileName];
  if (!profile || typeof profile !== "object") __fail("MONGODB_PROFILE_NOT_FOUND", "MongoDB config profile was not found");
  const getPath = (value, keyPath) => keyPath.split(".").reduce((current, key) => current == null ? undefined : current[key], value);
  const uri = getPath(profile, __uriKey);
  if (typeof uri !== "string" || !uri) __fail("MONGODB_URI_NOT_FOUND", "MongoDB URI was not found in the configured profile");
  __diagnosticPhase = "connect";
  const driver = require(__driverPath);
  try { const v = require(__path.join(__driverPath, "package.json")).version;
    if (/^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$/.test(v)) __driverVersion = v;
  } catch (_versionError) {}
  const MongoClient = driver.MongoClient || (driver.default && driver.default.MongoClient);
  if (!MongoClient) __fail("MONGODB_DRIVER_INVALID", "MongoDB driver does not export MongoClient");
  const client = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    monitorCommands: true,
    readPreference: "primary",
    serverSelectionTimeoutMS: __maxTimeMs,
  });
  try {
    await client.connect();
  } catch (error) {
    await __cleanup(() => client.close());
    throw error;
  }
  return { client };
}

// Server handshake facts, never a local mongosh or driver version. Require an
// existing ordinary collection on every supported server, including 4.4+.
async function __importPreconditions(client, request) {
  __diagnosticPhase = "transaction_preflight";
  const hello = await client.db(request.database).command({ isMaster: 1, maxTimeMS: __maxTimeMs }, { readPreference: "primary" });
  __serverWireVersion = Number.isSafeInteger(hello.maxWireVersion) ? hello.maxWireVersion : undefined;
  const sharded = hello.msg === "isdbgrid";
  if (!Number.isSafeInteger(__serverWireVersion) || __serverWireVersion < (sharded ? 8 : 7) ||
      (!sharded && !hello.setName) || !Number.isFinite(hello.logicalSessionTimeoutMinutes)) {
    __fail("MONGODB_TRANSACTIONS_UNSUPPORTED", "server does not advertise the required transaction topology and sessions");
  }
  __diagnosticPhase = "collection_preflight";
  const entries = await client.db(request.database).listCollections({ name: request.collection }, { nameOnly: false, maxTimeMS: __maxTimeMs }).toArray();
  if (!entries.length) __fail("MONGODB_COLLECTION_REQUIRED", "prepare an explicit collection creation separately before import");
  if (entries.length !== 1 || entries[0].type !== "collection" || entries[0].options &&
      (entries[0].options.capped || entries[0].options.timeseries)) __fail("MONGODB_COLLECTION_UNSUPPORTED", "import requires an ordinary non-capped collection");
  const uuid = entries[0].info && entries[0].info.uuid;
  if (!uuid) __fail("MONGODB_COLLECTION_IDENTITY_REQUIRED", "collection UUID must be observable before import");
  return __encode(uuid);
}
// Driver abortTransaction may deliberately swallow server/network failures.
// Observe only command metadata for this exact session/transaction; never retain
// command documents, errmsg or raw reply/error objects in receipts or logs.
function __transactionAcknowledgements(client, session) {
  if (typeof client.on !== "function" || typeof client.removeListener !== "function" || !session.id)
    __fail("MONGODB_TRANSACTION_ACK_UNAVAILABLE", "driver command acknowledgements are required");
  let transaction;
  const pending = new Map();
  const proof = { abort: false, commit: false };
  const started = function(event) {
    const cmd = event.command;
    if (!cmd || !cmd.lsid || cmd.txnNumber === undefined || __hash(__encode(cmd.lsid)) !== __hash(__encode(session.id))) return;
    const number = __hash(__encode(cmd.txnNumber));
    if (!transaction) transaction = number;
    if (number !== transaction || !["abortTransaction", "commitTransaction"].includes(event.commandName)) return;
    pending.set(event.requestId, event.commandName);
  };
  const succeeded = function(event) {
    const kind = pending.get(event.requestId); pending.delete(event.requestId);
    if (kind !== event.commandName || !event.reply || Number(event.reply.ok) !== 1 || event.reply.writeConcernError ||
        event.reply.writeConcernErrors && event.reply.writeConcernErrors.length) return;
    const evidence = { kind: kind === "abortTransaction" ? "abort_acknowledged" : "commit_acknowledged",
      sessionDigest: __hash(__encode(session.id)), transactionDigest: transaction, requestId: event.requestId };
    if (kind === "abortTransaction") { proof.abort = true; proof.abortEvidence = evidence; }
    if (kind === "commitTransaction") { proof.commit = true; proof.commitEvidence = evidence; }
  };
  const failed = function(event) {
    const kind = pending.get(event.requestId); pending.delete(event.requestId);
    // Positive server NoSuchTransaction before any commit was sent proves the
    // exact transaction was terminated, even when the driver suppresses it.
    if (kind === "abortTransaction" && event.commandName === kind && event.failure &&
        ["MongoServerError", "MongoError"].includes(event.failure.name) && event.failure.code === 251 && !event.failure.writeConcernError) {
      proof.abort = true; proof.abortEvidence = { kind: "server_no_such_transaction", sessionDigest: __hash(__encode(session.id)), transactionDigest: transaction, requestId: event.requestId };
    }
  };
  client.on("commandStarted", started); client.on("commandSucceeded", succeeded); client.on("commandFailed", failed);
  proof.close = function() { client.removeListener("commandStarted", started); client.removeListener("commandSucceeded", succeeded); client.removeListener("commandFailed", failed); };
  return proof;
}
function __importReceiptBound(manifest, receipt, ticket) {
  return receipt && receipt.version === 2 && receipt.mutationId === manifest.mutationId && receipt.planHash === manifest.planHash &&
    receipt.database === manifest.request.database && receipt.collection === manifest.request.collection &&
    __hash(receipt.source) === __hash({ configPath: __configPath, driverPath: __driverPath, profile: __profileName, uriKey: __uriKey }) &&
    __hash(receipt.execution) === __hash(ticket);
}
function __beginImportExecution(manifest, rollback) {
  const ticket = __request.execution;
  if (manifest.executionContinuation && (!ticket || ticket.version !== 2)) __fail("MONGODB_EXECUTION_IDENTITY_INVALID", "continuations require modern protected execution");
  let previous = manifest.importExecution;
  if (previous && (!ticket || ticket.version !== 2)) __fail("MONGODB_EXECUTION_IDENTITY_INVALID", "modern execution identity required for this journal");
  if (previous && rollback && manifest.status === "committed" && previous.mode === "commit" && previous.stage === "acknowledged") {
    __writeJsonAtomic("execution-" + previous.execution.intentId + "-" + previous.execution.attempt + ".json", manifest);
    previous = null;
  }
  // Raw/legacy callers retain normal success behavior, but cannot acquire a
  // modern recovery proof. Legacy retryable journals are deliberately fenced.
  if (["commit_retryable", "rollback_retryable"].includes(manifest.status) && !previous) __fail("MONGODB_EXECUTION_EVIDENCE_REQUIRED", "legacy retryable state has no terminal receipt");
  if (previous) {
    if (__hash(previous.execution) === __hash(ticket)) __fail("MONGODB_EXECUTION_ATTEMPT_CLOSED", "an execution attempt is never dispatched twice");
    if (!ticket || ticket.version !== 2 || !__importReceiptBound(manifest, previous, previous.execution) ||
        previous.stage !== "safe_terminal" || ticket.intentId !== previous.execution.intentId || ticket.attempt !== previous.execution.attempt + 1 ||
        previous.mode !== (rollback ? "rollback" : "commit")) __fail("MONGODB_EXECUTION_EVIDENCE_REQUIRED", "exact prior safe termination is required");
    __writeJsonAtomic("execution-" + previous.execution.intentId + "-" + previous.execution.attempt + ".json", manifest);
  }
  if (!ticket || ticket.version !== 2) return;
  if (ticket.mutationId !== manifest.mutationId || ticket.planHash !== manifest.planHash || !previous && ticket.attempt !== 1)
    __fail("MONGODB_EXECUTION_IDENTITY_INVALID", "execution ticket does not bind this plan");
  manifest.importExecution = { version: 2, execution: ticket, mutationId: manifest.mutationId, planHash: manifest.planHash,
    database: manifest.request.database, collection: manifest.request.collection, mode: rollback ? "rollback" : "commit",
    source: { configPath: __configPath, driverPath: __driverPath, profile: __profileName, uriKey: __uriKey },
    confirmation: rollback ? "确认回滚" : "确认执行", stage: "started", at: new Date().toISOString() };
}
function __importStage(manifest, stage, evidence) {
  if (manifest.importExecution) { manifest.importExecution.stage = stage; manifest.importExecution.at = new Date().toISOString();
    if (evidence) manifest.importExecution.outcomeEvidence = evidence;
  }
  __writeJsonAtomic("manifest.json", manifest);
}
function __importFailure(manifest, rollback, safe, error, evidence = { kind: "before_transaction" }) {
  manifest.status = safe ? (rollback ? "rollback_retryable" : "commit_retryable") : (rollback ? "rollback_unknown" : "commit_unknown");
  manifest.diagnostic = __diagnostic(error);
  // A known commit acknowledgement survives any later journal/log failure.
  if (manifest.importExecution && manifest.importExecution.stage !== "acknowledged") {
    manifest.importExecution.stage = safe ? "safe_terminal" : "unknown";
    if (safe) manifest.importExecution.outcomeEvidence = evidence;
  }
  __writeJsonAtomic("manifest.json", manifest);
}

function __findOptions(session) {
  return session ? { session } : {};
}

async function __findDocs(collection, filter, limit, session) {
  const cursor = collection.find(__decode(filter), __findOptions(session)).limit(limit);
  if (typeof cursor.maxTimeMS === "function") cursor.maxTimeMS(__maxTimeMs);
  return cursor.toArray();
}

async function __findByIds(collection, documents, session) {
  const result = [];
  for (const document of documents) {
    const current = await collection.findOne({ _id: document._id }, __findOptions(session));
    if (current) result.push(current);
  }
  return result;
}

function __indexComparable(index) {
  const result = { name: index.name, key: index.key };
  for (const field of ["unique", "sparse", "expireAfterSeconds", "partialFilterExpression", "collation"]) {
    if (index[field] !== undefined) result[field] = index[field];
  }
  return result;
}

function __indexHash(index) {
  const comparable = __indexComparable(index);
  comparable.unique = Boolean(comparable.unique);
  comparable.sparse = Boolean(comparable.sparse);
  // Compound index field order is semantic; __stable would otherwise sort it.
  comparable.key = Object.entries(comparable.key || {});
  return __hash(__encode(comparable));
}

function __indexMatches(index, expected) {
  return __indexHash(index) === __indexHash(expected);
}

function __indexByName(indexes, name) {
  return indexes.find((index) => index.name === name);
}

async function __readIndexes(collection) {
  return collection.listIndexes({ readPreference: "primary", maxTimeMS: __maxTimeMs }).toArray();
}

async function __verifyIndex(manifest, collection, dropped, original) {
  const expected = original || { name: manifest.request.name, key: __decode(manifest.request.key), ...__decode(manifest.request.options) };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const current = __indexByName(await __readIndexes(collection), manifest.request.name);
      if (dropped ? !current : current && __indexMatches(current, expected)) return current || null;
      if (!dropped && current) __fail("MONGODB_INDEX_DEFINITION_CONFLICT", "index name exists with a different definition");
    } catch (error) {
      if (error.code === "MONGODB_INDEX_DEFINITION_CONFLICT") throw error;
      if (attempt === 2) throw error;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  __fail("MONGODB_INDEX_COMMIT_UNKNOWN", "index command outcome could not be verified on primary");
}

function __planHash(manifest) {
  return __hash({
    schemaVersion: manifest.schemaVersion,
    mutationId: manifest.mutationId,
    operationId: manifest.operationId,
    kind: manifest.kind,
    request: manifest.request,
    before: manifest.before,
    beforeIndex: manifest.beforeIndex,
    beforeOperations: manifest.beforeOperations,
    ...(manifest.collectionIdentity ? { collectionIdentity: manifest.collectionIdentity } : {}),
    ...(manifest.executionContinuation ? { executionContinuation: manifest.executionContinuation } : {}),
    ...(manifest.riskLineage ? { riskLineage: manifest.riskLineage, orderedRequest: JSON.stringify(manifest.request) } : {}),
    ...(manifest.prepare ? { prepare: manifest.prepare, prepareSource: manifest.prepareSource, orderedRequest: JSON.stringify(manifest.request) } : {}),
  });
}

async function __prepareDocumentRequest(request, collection) {
  if (request.operation === "insertOne") {
    const document = __decode(request.document);
    const existing = await collection.findOne({ _id: document._id });
    if (existing) __fail("MONGODB_MUTATION_TARGET_EXISTS", "a document with the requested _id already exists");
    return {
      before: [],
      affectedCount: 1,
      affectedIds: [__idSummary(document._id)],
      changedFields: Object.keys(request.document),
    };
  }

  const limit = request.operation === "updateMany" ? request.maxAffected + 1 : 2;
  const documents = await __findDocs(collection, request.filter, limit);
  if (documents.length === 0) __fail("MONGODB_MUTATION_TARGET_NOT_FOUND", "no document matched the mutation filter");
  if (documents.length > request.maxAffected) __fail("MONGODB_MUTATION_AFFECTED_LIMIT", "mutation matched more documents than allowed");
  if (request.operation !== "updateMany" && documents.length !== 1) __fail("MONGODB_MUTATION_TARGET_AMBIGUOUS", "mutation filter did not identify exactly one document");
  if (request.expectedCount !== undefined && documents.length !== request.expectedCount) __fail("MONGODB_EXPECTED_COUNT_MISMATCH", "mutation matched a different number of documents than expected");
  documents.forEach((document) => __assertIndexedMutationDocument(request, document));
  return {
    before: __encode(documents),
    affectedCount: documents.length,
    affectedIds: documents.map((document) => __idSummary(document._id)),
    changedFields: __changedFields(request.update),
  };
}

async function __prepare() {
  const { client } = await __loadClient();
  try {
    const request = __request.mutation;
    if (__request.kind !== "bulk_storage" && request.collection === ${safeLiteral(MONGODB_TECHNICAL_RECEIPTS_COLLECTION)}) {
      __fail("MONGODB_BULK_RESERVED_COLLECTION", "the technical receipt collection is reserved for internal bulk storage operations");
    }
    const database = request.database;
    const collection = request.collection
      ? client.db(__request.kind === "bulk_storage" ? request.receiptsDatabase || database : database).collection(request.collection)
      : null;
    const now = Date.now();
    const manifest = {
      ...(__request.importLineage ? { riskLineage: __request.importLineage } : {}),
      schemaVersion: __schemaVersion,
      mutationId: __request.mutationId,
      ...(__request.prepare ? { prepare: __request.prepare, prepareSource: { configPath: __configPath, driverPath: __driverPath, profile: __profileName, uriKey: __uriKey } } : {}),
      operationId: __request.operationId,
      kind: __request.kind,
      request,
      status: "planned",
      rollbackMode: __request.kind === "collection" ? "retained_non_rollbackable" : __request.kind === "index"
        ? "compensating"
        : __request.kind === "bulk_storage"
          ? "retained_non_rollbackable"
          : "transactional",
      riskLevel: request.riskLevel || (__request.kind === "index" ? "medium" : "high"),
      requiresConfirmation: true,
      createdAt: new Date(now).toISOString(),
      rollbackExpiresAt: new Date(now + request.rollbackTtlMs).toISOString(),
      before: [],
      beforeIndex: null,
      beforeOperations: [],
      afterHashes: [],
      afterOperations: [],
      afterIndex: null,
      affectedCount: 0,
      affectedIds: [],
      changedFields: [],
    };

    if (__request.kind === "collection") {
      await __collectionPreconditions(client, request);
      manifest.affectedCount = 1;
    } else if (__request.kind === "index") {
      const indexes = await __readIndexes(collection);
      const existing = __indexByName(indexes, request.name);
      if (request.operation === "createIndex") {
        __ttlRejectBusinessIndex(request.options);
        if (existing) __fail("MONGODB_INDEX_ALREADY_EXISTS", "the requested index already exists");
        const equivalent = indexes.find((index) => {
          const candidate = { name: request.name, key: __decode(request.key), ...__decode(request.options) };
          const existingShape = __indexComparable(index);
          const candidateShape = __indexComparable(candidate);
          delete existingShape.name;
          delete candidateShape.name;
          return __hash(existingShape) === __hash(candidateShape);
        });
        if (equivalent) __fail("MONGODB_EQUIVALENT_INDEX_EXISTS", "an equivalent index already exists");
        manifest.afterIndex = { name: request.name, key: request.key, ...request.options };
        manifest.affectedCount = 1;
        manifest.changedFields = Object.keys(request.key);
      } else {
        if (request.name === "_id_") __fail("MONGODB_INDEX_IMMUTABLE", "the _id_ index cannot be changed");
        if (!existing) __fail("MONGODB_INDEX_NOT_FOUND", "the requested index was not found");
        __ttlRejectBusinessIndex(existing);
        manifest.beforeIndex = __encode(__indexComparable(existing));
        manifest.affectedCount = 1;
        manifest.changedFields = Object.keys(existing.key || {});
      }
    } else if (__request.kind === "bulk_storage") {
      __ttlAssertReceiptName(request.collection);
      if (!__bulkEnabled || request.storageRoot !== __bulkRoot || request.collection !== __bulkReceiptsCollection) {
        __fail("MONGODB_BULK_DISABLED", "bulk storage settings changed or are disabled");
      }
      const databaseObject = client.db(request.receiptsDatabase || database);
      const namespaces = await databaseObject.listCollections({ name: request.collection }, { nameOnly: true }).toArray();
      let expiryIndex = null;
      if (namespaces.length) {
        const indexes = await __readIndexes(collection);
        expiryIndex = indexes.find((index) => index.name === "remote_debug_bulk_receipt_expiry") || null;
      }
      let rootState = "missing";
      let rootMode;
      try {
        const stat = __fs.lstatSync(request.storageRoot);
        rootState = stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "invalid";
        rootMode = stat.mode & 0o777;
      } catch (_error) {}
      manifest.storageStatus = { rootState, rootMode, collectionExists: namespaces.length > 0, expiryIndexExists: Boolean(expiryIndex) };
      manifest.affectedCount = 1;
      manifest.changedFields = ["expiresAt"];
    } else if (__request.kind === "import") {
      manifest.collectionIdentity = await __importPreconditions(client, request);
      const documents = __decode(request.documents);
      const existing = await __findDocs(collection, { _id: { $in: request.documents.map((item) => item._id) } }, 1);
      if (existing.length) __fail("MONGODB_MUTATION_TARGET_EXISTS", "an import _id already exists; existing data will not be overwritten");
      manifest.affectedCount = documents.length;
      manifest.affectedIds = documents.slice(0, 10).map((item) => __idSummary(item._id));
      manifest.changedFields = [...new Set(request.documents.flatMap((item) => Object.keys(item)))].slice(0, 20).map((key) => key.slice(0, 128));
    } else if (__request.kind === "transaction") {
      const operationPlans = [];
      for (const childRequest of request.operations) {
        const childCollection = client.db(childRequest.database).collection(childRequest.collection);
        operationPlans.push({
          request: childRequest,
          ...(await __prepareDocumentRequest(childRequest, childCollection)),
        });
      }
      manifest.beforeOperations = operationPlans;
      manifest.affectedCount = operationPlans.reduce((total, item) => total + item.affectedCount, 0);
      manifest.affectedIds = operationPlans.flatMap((item) => item.affectedIds).slice(0, 100);
      manifest.changedFields = [...new Set(operationPlans.flatMap((item) => item.changedFields))].slice(0, 100);
    } else {
      Object.assign(manifest, await __prepareDocumentRequest(request, collection));
    }

    manifest.planHash = __planHash(manifest);
    if (__request.prepare) {
      const control = JSON.parse(__fs.readFileSync(__path.join(__journalDir(), "prepare.json"), "utf8"));
      // Reserve the plan durably before its manifest can be observed/executed.
      // A subsequently missing manifest is loss of recovery state, not absence.
      control.stage = "plan_reserved";
      __writeJsonAtomic("prepare.json", control);
    }
    __writeJsonAtomic("manifest.json", manifest);
    __appendJournal("planned", {
      operationId: manifest.operationId,
      kind: manifest.kind,
      operation: request.operation,
      planHash: manifest.planHash,
      affectedCount: manifest.affectedCount,
    });
    return {
      ...__summary(manifest),
      preview: {
        affectedCount: manifest.affectedCount,
        affectedIds: manifest.affectedIds,
        changedFields: manifest.changedFields,
        rollbackMode: manifest.rollbackMode,
      },
    };
  } finally {
    await __cleanup(() => client.close());
  }
}

async function __prepareImportPlan() {
  if (!__bson || !__bson.EJSON || !__bson.EJSON.parse || !__bson.EJSON.stringify) __fail("MONGODB_IMPORT_BSON_REQUIRED", "bulk import requires BSON EJSON support from the configured driver");
  const plan = __request.mutation;
  __assertImportLive(plan);
  const results = [];
  for (const batch of plan.batches) {
    __assertImportLive(batch, batch.mutationId);
    __request.mutationId = batch.mutationId;
    __request.mutation = batch;
    __request.kind = "import";
    const releaseLock = __acquireMutationLock(false);
    try {
      const filePath = __path.join(__journalDir(), "manifest.json");
      if (__fs.existsSync(filePath)) {
        if (__fs.lstatSync(filePath).isSymbolicLink()) __fail("MONGODB_JOURNAL_SYMLINK_REJECTED", "mutation manifest cannot be a symbolic link");
        __request.planHash = JSON.parse(__fs.readFileSync(filePath, "utf8")).planHash;
        const manifest = __loadManifest();
        const identity = (value) => { const { operationId, ...rest } = value; return rest; };
        if (__hash(identity(manifest.request)) !== __hash(identity(batch))) __fail("MONGODB_IMPORT_PLAN_CONFLICT", "import journal belongs to a different request");
        __assertNotExpired(manifest);
        results.push(__summary(manifest));
      } else {
        results.push(await __prepare());
      }
    } catch (error) {
      if (!results.length) throw error;
      return { kind: "import_plan", importId: plan.importId, database: plan.database,
        collection: plan.collection, affectedCount: plan.affectedCount, batchCount: plan.batches.length,
        atomicity: "per_batch", status: "prepare_partial", batches: results, requiresConfirmation: true,
        failedBatch: { batchIndex: batch.batchIndex, mutationId: batch.mutationId,
          code: typeof error.code === "string" && /^MONGODB_[A-Z0-9_]{1,70}$/.test(error.code) ? error.code : "MONGODB_IMPORT_PREPARE_FAILED", diagnostic: __diagnostic(error) } };
    } finally {
      releaseLock();
    }
  }
  return { kind: "import_plan", importId: plan.importId, database: plan.database,
    collection: plan.collection, affectedCount: plan.affectedCount, batchCount: results.length,
    atomicity: "per_batch", status: "prepared", batches: results, requiresConfirmation: true };
}

function __assertNotExpired(manifest) {
  if (Date.parse(manifest.rollbackExpiresAt) <= Date.now()) __fail("MONGODB_ROLLBACK_EXPIRED", "mutation rollback window has expired");
}

async function __commitDocumentRequest(request, beforeValue, collection, session) {
  const before = __decode(beforeValue || []);
  if (request.operation === "insertOne") {
    const document = __decode(request.document);
    const existing = await collection.findOne({ _id: document._id }, { session });
    if (existing) __fail("MONGODB_MUTATION_TARGET_EXISTS", "a document with the requested _id already exists");
    await collection.insertOne(document, { session });
    const inserted = await collection.findOne({ _id: document._id }, { session });
    if (!inserted) __fail("MONGODB_MUTATION_COMMIT_UNKNOWN", "inserted document could not be verified in the transaction");
    return [inserted];
  }

  const current = await __findByIds(collection, before, session);
  if (current.length !== before.length || current.some((document) => {
    const expected = before.find((item) => __hash(__encode(item._id)) === __hash(__encode(document._id)));
    return !expected || __documentHash(expected) !== __documentHash(document);
  })) {
    __fail("MONGODB_MUTATION_CONFLICT", "mutation target changed after the plan was created");
  }
  const result = request.operation === "updateMany"
    ? await collection.updateMany(__decode(request.filter), __decode(request.update), { session })
    : await collection.updateOne(__decode(request.filter), __decode(request.update), { session });
  const matchedCount = result.matchedCount != null ? result.matchedCount : result.n;
  if (matchedCount !== before.length) __fail("MONGODB_MUTATION_CONFLICT", "mutation matched a different number of documents at commit time");
  const after = await __findByIds(collection, before, session);
  if (after.length !== before.length) __fail("MONGODB_MUTATION_CONFLICT", "a mutation target disappeared during commit");
  return after;
}

async function __commitDocument(manifest, client, collection) {
  const session = client.startSession();
  let after;
  try {
    await session.withTransaction(async () => {
      after = await __commitDocumentRequest(manifest.request, manifest.before, collection, session);
    }, { readPreference: "primary" });
  } finally {
    await __cleanup(() => session.endSession());
  }
  manifest.afterHashes = __documentHashes(after || []);
  manifest.status = "committed";
  manifest.committedAt = new Date().toISOString();
  __writeJsonAtomic("manifest.json", manifest);
  __appendJournal("committed", { planHash: manifest.planHash, affectedCount: manifest.affectedCount });
}

// A batch is one transaction. Never infer ownership from matching documents after
// an uncertain commit: stop for inspection instead of risking an unsafe rollback.
async function __runImportTransaction(manifest, client, collection, rollback) {
  if (!__bson || !__bson.EJSON || !__bson.EJSON.parse || !__bson.EJSON.stringify) __fail("MONGODB_IMPORT_BSON_REQUIRED", "bulk import requires BSON EJSON support from the configured driver");
  let session, acknowledgements, started = false, committing = false;
  try {
    const collectionIdentity = await __importPreconditions(client, manifest.request);
    if (!manifest.collectionIdentity || __hash(collectionIdentity) !== __hash(manifest.collectionIdentity)) __fail("MONGODB_COLLECTION_IDENTITY_CHANGED", "collection identity differs from the prepared plan");
    __diagnosticPhase = "transaction_start";
    session = client.startSession();
    acknowledgements = __transactionAcknowledgements(client, session);
    session.startTransaction({ readPreference: "primary" });
    started = true;
    __diagnosticPhase = rollback ? "transaction_rollback" : "transaction_write";
    const documents = __decode(manifest.request.documents);
    const filter = { _id: { $in: documents.map((item) => item._id) } };
    const encodedFilter = { _id: { $in: manifest.request.documents.map((item) => item._id) } };
    if (rollback) {
      const current = await __findDocs(collection, encodedFilter, documents.length + 1, session);
      const currentIdentity = await __importPreconditions(client, manifest.request);
      if (__hash(currentIdentity) !== __hash(manifest.collectionIdentity)) __fail("MONGODB_COLLECTION_IDENTITY_CHANGED", "collection changed before rollback acquired its read lock");
      __diagnosticPhase = "transaction_rollback";
      const expected = new Map((manifest.afterHashes || []).map((item) => [__hash(item.id), item.hash]));
      if (current.length !== documents.length || current.some((item) => expected.get(__hash(__encode(item._id))) !== __documentHash(item))) {
        __fail("MONGODB_ROLLBACK_CONFLICT", "import targets changed after commit");
      }
      const result = await collection.deleteMany(filter, { session });
      if ((result.deletedCount != null ? result.deletedCount : result.n) !== documents.length) __fail("MONGODB_ROLLBACK_CONFLICT", "import targets could not all be removed");
    } else {
      const existing = await __findDocs(collection, encodedFilter, 1, session);
      const currentIdentity = await __importPreconditions(client, manifest.request);
      if (__hash(currentIdentity) !== __hash(manifest.collectionIdentity)) __fail("MONGODB_COLLECTION_IDENTITY_CHANGED", "collection changed before transaction acquired its read lock");
      __diagnosticPhase = "transaction_write";
      if (existing.length) __fail("MONGODB_MUTATION_TARGET_EXISTS", "an import _id already exists; existing data will not be overwritten");
      await collection.insertMany(documents, { session, ordered: true });
      const inserted = await __findDocs(collection, encodedFilter, documents.length + 1, session);
      if (inserted.length !== documents.length) __fail("MONGODB_MUTATION_COMMIT_UNKNOWN", "import document count could not be verified");
      manifest.afterHashes = __documentHashes(inserted);
      // Reserve journal capacity and durably save rollback hashes BEFORE commit.
      __writeJsonAtomic("manifest.json", manifest);
    }
    __assertImportLive(manifest.request, manifest.mutationId);
    __diagnosticPhase = "transaction_commit";
    __importStage(manifest, "commit_sent");
    committing = true;
    await session.commitTransaction();
    if (!acknowledgements.commit) __fail("MONGODB_IMPORT_COMMIT_UNKNOWN", "exact commit command acknowledgement required");
    __importStage(manifest, "acknowledged", acknowledgements.commitEvidence);
    manifest.status = rollback ? "rolled_back" : "committed";
    manifest[rollback ? "rolledBackAt" : "committedAt"] = new Date().toISOString();
    __writeJsonAtomic("manifest.json", manifest);
    __appendJournal(manifest.status, { planHash: manifest.planHash, affectedCount: manifest.affectedCount });
  } catch (error) {
    let aborted = false;
    if (session && started && !committing) {
      try { await session.abortTransaction(); } catch (_abortError) { __diagnosticPhase = "transaction_abort"; }
      aborted = acknowledgements && acknowledgements.abort === true;
      if (!aborted) __diagnosticPhase = "transaction_abort";
    }
    // commit_sent and failed abort remain unknown, regardless of error labels,
    // code/text, current document counts or whether a later abort succeeds.
    try { __importFailure(manifest, rollback, !committing && (!started || aborted), error, started && acknowledgements ? acknowledgements.abortEvidence : { kind: "before_transaction" }); } catch (_writeError) {}
    throw error;
  } finally {
    if (acknowledgements) acknowledgements.close();
    if (session) await __cleanup(() => session.endSession());
  }
}

async function __commitTransaction(manifest, client) {
  const session = client.startSession();
  const afterOperations = [];
  try {
    await session.withTransaction(async () => {
      afterOperations.length = 0;
      for (const item of manifest.beforeOperations || []) {
        const collection = client.db(item.request.database).collection(item.request.collection);
        const after = await __commitDocumentRequest(item.request, item.before, collection, session);
        afterOperations.push({ request: item.request, before: item.before, afterHashes: __documentHashes(after) });
      }
    }, { readPreference: "primary" });
  } finally {
    await __cleanup(() => session.endSession());
  }
  manifest.afterOperations = afterOperations;
  manifest.status = "committed";
  manifest.committedAt = new Date().toISOString();
  __writeJsonAtomic("manifest.json", manifest);
  __appendJournal("committed", { planHash: manifest.planHash, affectedCount: manifest.affectedCount });
}

// DDL is never replayed after dispatch. Keep the command acknowledgement before
// metadata verification, so reconciliation can finish without issuing DDL again.
async function __commitIndex(manifest, collection, database) {
  const request = manifest.request;
  const current = __indexByName(await __readIndexes(collection), request.name);
  const creating = request.operation === "createIndex";
  if (creating) {
    __ttlRejectBusinessIndex(request.options);
    if (current) __fail("MONGODB_INDEX_CONFLICT", "index state changed after the plan was created");
  } else {
    __ttlRejectBusinessIndex(current);
    if (!current || !manifest.beforeIndex || !__indexMatches(current, __decode(manifest.beforeIndex))) {
      __fail("MONGODB_INDEX_CONFLICT", "index state changed after the plan was created");
    }
  }
  manifest.indexReceipt = { version: 1, mutationId: manifest.mutationId, planHash: manifest.planHash,
    execution: manifest.execution, database: request.database, collection: request.collection,
    operation: request.operation, stage: "dispatching", owned: false,
    source: { configPath: __configPath, driverPath: __driverPath, profile: __profileName, uriKey: __uriKey } };
  __writeJsonAtomic("manifest.json", manifest);
  try {
    const command = creating
      ? { createIndexes: request.collection, indexes: [{ key: __decode(request.key), name: request.name, ...__decode(request.options) }] }
      : { dropIndexes: request.collection, index: request.name };
    const reply = await database.command({ ...command, maxTimeMS: __maxTimeMs,
      writeConcern: { w: "majority", wtimeout: __maxTimeMs } }, { readPreference: "primary" });
    if (Number(reply.ok) !== 1 || reply.writeConcernError) __fail("MONGODB_INDEX_COMMIT_UNKNOWN", "index command did not acknowledge durable completion");
    // createIndex's string return discards the server's no-op evidence. A same
    // name/spec created concurrently must not become this mutation's rollback.
    manifest.indexReceipt.stage = "acknowledged";
    manifest.indexReceipt.numIndexesBefore = Number(reply.numIndexesBefore);
    manifest.indexReceipt.numIndexesAfter = Number(reply.numIndexesAfter);
    manifest.indexReceipt.noOp = Boolean(reply.note);
    manifest.indexReceipt.owned = creating
      ? Number.isFinite(Number(reply.numIndexesBefore)) && Number(reply.numIndexesAfter) === Number(reply.numIndexesBefore) + 1 && !reply.note
      : true;
    manifest.indexReceipt.acknowledgedAt = new Date().toISOString();
    __writeJsonAtomic("manifest.json", manifest);
  } catch (error) {
    // Only definite server rejections prove that DDL did not commit. Network,
    // timeout, write-concern and journal failures all remain ambiguous.
    const rejected = error.name === "MongoServerError" || error.name === "MongoError";
    if (rejected && [2, 13, 67, 72, 85, 86, 11000, 197].includes(Number(error.code)) && !error.writeConcernError) {
      manifest.indexReceipt.stage = "rejected";
    }
    throw error;
  }
  if (!manifest.indexReceipt.owned) __fail("MONGODB_INDEX_OWNERSHIP_UNKNOWN", "index acknowledgement does not prove this operation created the index");
  const after = await __verifyIndex(manifest, collection, !creating);
  if (creating) manifest.afterIndex = __encode(__indexComparable(after));
  manifest.status = "committed";
  manifest.committedAt = manifest.indexReceipt.acknowledgedAt;
  __writeJsonAtomic("manifest.json", manifest);
  __appendJournal("committed", { planHash: manifest.planHash, affectedCount: 1 });
}

async function __recoverExecution() {
  // No lock age reclamation, business writes, or ownership inference from the
  // live catalog. Historical helpers did not persist acknowledgements.
  const release = __acquireMutationLock(false);
  try {
    const manifest = __loadManifest();
    const ticket = __request.execution;
    if (!ticket || !manifest.execution || __hash(ticket) !== __hash(manifest.execution)) {
      return { ...__summary(manifest), indexRecovery: { reason: "legacy_execution_evidence_required" } };
    }
    if (manifest.request.database !== __request.database) __fail("MONGODB_MUTATION_SCOPE_MISMATCH", "recovery database does not match the original plan");
    if (manifest.kind === "collection") {
      const receipt = manifest.collectionReceipt;
      if (!receipt || receipt.stage !== "acknowledged" || receipt.mutationId !== manifest.mutationId || receipt.planHash !== manifest.planHash ||
          receipt.database !== manifest.request.database || receipt.collection !== manifest.request.collection || __hash(receipt.execution) !== __hash(ticket))
        return { ...__summary(manifest), indexRecovery: { reason: "execution_acknowledgement_required" } };
      manifest.status = "committed"; manifest.committedAt = receipt.acknowledgedAt;
      __writeJsonAtomic("manifest.json", manifest);
      return __summary(manifest);
    }
    if (manifest.kind === "import") {
      const receipt = manifest.importExecution;
      if (!ticket || ticket.version !== 2 || !__importReceiptBound(manifest, receipt, ticket) ||
          receipt.confirmation !== (receipt.mode === "commit" ? "确认执行" : "确认回滚")) return { ...__summary(manifest), indexRecovery: { reason: "legacy_execution_evidence_required" } };
      const evidence = receipt.outcomeEvidence || {};
      const commandEvidence = /^[a-f0-9]{64}$/.test(evidence.sessionDigest || "") && /^[a-f0-9]{64}$/.test(evidence.transactionDigest || "") && Number.isSafeInteger(evidence.requestId);
      if (receipt.stage === "safe_terminal" && !(evidence.kind === "before_transaction" || commandEvidence && ["abort_acknowledged", "server_no_such_transaction"].includes(evidence.kind)) ||
          receipt.stage === "acknowledged" && !(commandEvidence && evidence.kind === "commit_acknowledged"))
        return { ...__summary(manifest), indexRecovery: { reason: "execution_acknowledgement_required" } };
      if (receipt.stage === "acknowledged") {
        manifest.status = receipt.mode === "commit" ? "committed" : "rolled_back";
        __writeJsonAtomic("manifest.json", manifest);
      }
      return { ...__summary(manifest), indexRecovery: { reason: receipt.stage === "safe_terminal" ? "exact_safe_terminal_receipt" : receipt.stage === "acknowledged" ? "exact_commit_acknowledgement" : "execution_acknowledgement_required" } };
    }
    if (manifest.status === "committed" || manifest.status === "rolled_back") return __summary(manifest);
    const rollback = manifest.status.indexOf("rollback_") === 0;
    const receipt = rollback ? manifest.rollbackReceipt : manifest.indexReceipt;
    if (manifest.kind !== "index" || !receipt || receipt.version !== 1 || receipt.mutationId !== manifest.mutationId ||
        receipt.planHash !== manifest.planHash || receipt.database !== manifest.request.database || receipt.collection !== manifest.request.collection ||
        receipt.operation !== manifest.request.operation ||
        __hash(receipt.source) !== __hash({ configPath: __configPath, driverPath: __driverPath, profile: __profileName, uriKey: __uriKey }) ||
        __hash(receipt.execution) !== __hash(ticket) || receipt.stage !== "acknowledged" || !receipt.owned ||
        !(rollback ? ["rollback_started", "rollback_unknown"] : ["commit_started", "commit_unknown"]).includes(manifest.status)) {
      return { ...__summary(manifest), indexRecovery: { reason: "execution_acknowledgement_required" } };
    }
    const { client } = await __loadClient();
    try {
      const collection = client.db(manifest.request.database).collection(manifest.request.collection);
      const after = await __verifyIndex(manifest, collection,
        rollback ? manifest.request.operation === "createIndex" : manifest.request.operation === "dropIndex",
        rollback ? __decode(manifest.beforeIndex) : null);
      if (after && !rollback) manifest.afterIndex = __encode(__indexComparable(after));
      manifest.status = rollback ? "rolled_back" : "committed";
      manifest[rollback ? "rolledBackAt" : "committedAt"] = receipt.acknowledgedAt;
      manifest.indexRecovery = { reason: "acknowledgement_and_primary_catalog_verified" };
      __writeJsonAtomic("manifest.json", manifest);
      __appendJournal(rollback ? "rollback_reconciled" : "commit_reconciled", { planHash: manifest.planHash, intentId: ticket.intentId });
      return __summary(manifest);
    } finally { await __cleanup(() => client.close()); }
  } finally { release(); }
}

// Dedicated empty collection creation. No business indexes/options and no drop
// compensation: even an empty check cannot authorize deleting later data.
async function __collectionPreconditions(client, request) {
  __diagnosticPhase = "collection_preflight";
  const db = client.db(request.database);
  const existing = await db.listCollections({ name: request.collection }, { nameOnly: false, maxTimeMS: __maxTimeMs }).toArray();
  if (existing.length) __fail("MONGODB_COLLECTION_ALREADY_EXISTS", "a namespace already exists; it will not be adopted");
  const auth = await db.command({ connectionStatus: 1, showPrivileges: true }, { readPreference: "primary" });
  const privileges = auth.authInfo && auth.authInfo.authenticatedUserPrivileges;
  const permitted = Array.isArray(privileges) && privileges.some(function(p) {
    const r = p.resource || {};
    return Array.isArray(p.actions) && (p.actions.includes("createCollection") || p.actions.includes("anyAction")) &&
      (r.anyResource === true || r.db === request.database && (r.collection === "" || r.collection === request.collection) || r.db === "" && r.collection === "");
  });
  if (!permitted) __fail("MONGODB_COLLECTION_PERMISSION_REQUIRED", "authenticated createCollection privilege must be explicitly observable");
}
async function __commitCollection(manifest, client) {
  await __collectionPreconditions(client, manifest.request);
  const request = manifest.request;
  manifest.collectionReceipt = { version: 1, mutationId: manifest.mutationId, planHash: manifest.planHash, execution: manifest.execution,
    database: request.database, collection: request.collection, stage: "command_started", rollbackMode: "retained_non_rollbackable" };
  __writeJsonAtomic("manifest.json", manifest);
  __diagnosticPhase = "collection_create";
  const reply = await client.db(request.database).command({ create: request.collection, maxTimeMS: __maxTimeMs,
    writeConcern: { w: "majority", wtimeout: __maxTimeMs } }, { readPreference: "primary" });
  if (Number(reply.ok) !== 1 || reply.writeConcernError) __fail("MONGODB_COLLECTION_COMMIT_UNKNOWN", "collection creation has no durable acknowledgement");
  // This acknowledges this command only. A later same-name namespace is never
  // ownership proof, and is never eligible for automatic deletion.
  manifest.collectionReceipt.stage = "acknowledged";
  manifest.collectionReceipt.acknowledgedAt = new Date().toISOString();
  __writeJsonAtomic("manifest.json", manifest);
  const entries = await client.db(request.database).listCollections({ name: request.collection }, { nameOnly: false, maxTimeMS: __maxTimeMs }).toArray();
  if (entries.length !== 1 || entries[0].type !== "collection") __fail("MONGODB_COLLECTION_COMMIT_UNKNOWN", "acknowledged collection is not currently observable");
  manifest.status = "committed";
  manifest.committedAt = manifest.collectionReceipt.acknowledgedAt;
  __writeJsonAtomic("manifest.json", manifest);
}

async function __commitBulkStorage(manifest, client) {
  const request = manifest.request;
  __ttlAssertReceiptName(request.collection);
  if (!__bulkEnabled || request.storageRoot !== __bulkRoot || request.collection !== __bulkReceiptsCollection) {
    __fail("MONGODB_BULK_DISABLED", "bulk storage settings changed or are disabled");
  }
  try {
    if (!__fs.existsSync(request.storageRoot)) __fs.mkdirSync(request.storageRoot, { recursive: true, mode: 0o700 });
    const rootStat = __fs.lstatSync(request.storageRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) __fail("MONGODB_BULK_STORAGE_INVALID", "bulk storage root must be a real directory");
    __fs.chmodSync(request.storageRoot, 0o700);
    const probePath = __path.join(request.storageRoot, ".write-probe-" + process.pid + "-" + __randomBytes(8).toString("hex"));
    const probeFd = __fs.openSync(probePath, "wx", 0o600);
    try {
      __fs.writeFileSync(probeFd, "ready", "utf8");
      __fs.fsyncSync(probeFd);
    } finally { __fs.closeSync(probeFd); }
    __fs.unlinkSync(probePath);
    const directoryFd = __fs.openSync(request.storageRoot, "r");
    try { __fs.fsyncSync(directoryFd); } finally { __fs.closeSync(directoryFd); }
  } catch (error) {
    if (error && error.code && error.code.indexOf("MONGODB_") === 0) throw error;
    __fail("MONGODB_BULK_STORAGE_DURABILITY_UNAVAILABLE", "bulk storage could not complete a durable owner-only write probe");
  }

  await __ttlInitializeReceiptCollection(client, request.receiptsDatabase || request.database, request.collection);
  const storageMarker = {
    schemaVersion: 1,
    database: request.database,
    receiptsCollection: request.collection,
    receiptsDatabase: request.receiptsDatabase || request.database,
    initializedAt: new Date().toISOString(),
  };
  const markerPath = __path.join(request.storageRoot, ".storage-v1.json");
  if (__fs.existsSync(markerPath)) {
    const existingStat = __fs.lstatSync(markerPath);
    if (existingStat.isSymbolicLink() || !existingStat.isFile() || (existingStat.mode & 0o777) !== 0o600) {
      __fail("MONGODB_BULK_STORAGE_CONFLICT", "storage initialization record must be a regular 0600 file");
    }
    let existingStorageMarker;
    try { existingStorageMarker = JSON.parse(__fs.readFileSync(markerPath, "utf8")); }
    catch (_error) { __fail("MONGODB_BULK_STORAGE_CONFLICT", "storage initialization record is damaged"); }
    if (!existingStorageMarker || existingStorageMarker.schemaVersion !== 1 || existingStorageMarker.database !== request.database || existingStorageMarker.receiptsCollection !== request.collection) {
      __fail("MONGODB_BULK_STORAGE_CONFLICT", "storage initialization record belongs to a different configuration");
    }
    storageMarker.initializedAt = existingStorageMarker.initializedAt;
  }
  const markerText = JSON.stringify(storageMarker, null, 2) + "\\n";
  const temporaryPath = markerPath + "." + process.pid + "." + __randomBytes(8).toString("hex") + ".tmp";
  const markerFd = __fs.openSync(temporaryPath, "w", 0o600);
  try {
    __fs.writeFileSync(markerFd, markerText, "utf8");
    __fs.fsyncSync(markerFd);
  } finally { __fs.closeSync(markerFd); }
  __fs.renameSync(temporaryPath, markerPath);
  __fs.chmodSync(markerPath, 0o600);
  const markerDirectoryFd = __fs.openSync(request.storageRoot, "r");
  try { __fs.fsyncSync(markerDirectoryFd); } finally { __fs.closeSync(markerDirectoryFd); }
  manifest.storageStatus = { rootState: "directory", rootMode: 0o700, collectionExists: true, expiryIndexExists: true };
  manifest.status = "committed";
  manifest.committedAt = new Date().toISOString();
  __writeJsonAtomic("manifest.json", manifest);
  __appendJournal("committed", { planHash: manifest.planHash, affectedCount: 1, kind: "bulk_storage" });
}

async function __loadMutationClient(manifest, rollback) {
  try {
    return await __loadClient();
  } catch (error) {
    if (manifest.kind === "import") {
      try { __importFailure(manifest, rollback, true, error); } catch (_writeError) {}
    }
    throw error;
  }
}

async function __commit() {
  const releaseLock = __acquireMutationLock(false);
  try {
    const manifest = __loadManifest();
    if (manifest.kind === "import") __assertImportLive(manifest.request, manifest.mutationId);
    if (manifest.status === "committed") return __summary(manifest);
    if (manifest.status === "rolled_back") __fail("MONGODB_MUTATION_ALREADY_ROLLED_BACK", "mutation was already rolled back");
    if (manifest.status !== "planned" && !(manifest.kind === "import" && manifest.status === "commit_retryable") && !(manifest.kind === "bulk_storage" && manifest.status === "commit_retryable")) __fail("MONGODB_MUTATION_STATE_INVALID", "mutation is not ready to commit; inspect uncertain outcomes before retrying");
    __assertNotExpired(manifest);
    if (manifest.kind === "import") __beginImportExecution(manifest, false);
    __appendJournal("commit_started", { planHash: manifest.planHash });
    manifest.status = "commit_started";
    manifest.execution = __request.execution;
    __writeJsonAtomic("manifest.json", manifest);
    const { client } = await __loadMutationClient(manifest, false);
    try {
      const collection = manifest.request.collection
        ? client.db(manifest.request.database).collection(manifest.request.collection)
        : null;
      if (manifest.kind === "import") await __runImportTransaction(manifest, client, collection, false);
      else if (manifest.kind === "collection") await __commitCollection(manifest, client);
      else if (manifest.kind === "index") await __commitIndex(manifest, collection, client.db(manifest.request.database));
      else if (manifest.kind === "bulk_storage") await __commitBulkStorage(manifest, client);
      else if (manifest.kind === "transaction") await __commitTransaction(manifest, client);
      else await __commitDocument(manifest, client, collection);
      return __summary(manifest);
    } catch (error) {
      if (manifest.status !== "committed" && manifest.kind !== "import") {
        manifest.status = manifest.kind === "bulk_storage" ? "commit_retryable"
          : manifest.kind === "collection" ? "commit_unknown" : manifest.kind === "index" && manifest.indexReceipt && manifest.indexReceipt.stage !== "rejected" ? "commit_unknown" : "commit_failed";
        try { __writeJsonAtomic("manifest.json", manifest); } catch (_writeError) {}
        try { __appendJournal(manifest.status, { code: error.code || "MONGODB_MUTATION_COMMIT_FAILED" }); } catch (_journalError) {}
      }
      throw error;
    } finally {
      await __cleanup(() => client.close());
    }
  } finally {
    releaseLock();
  }
}

async function __rollbackDocument(manifest, client, collection) {
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await __rollbackDocumentRequest(manifest.request, manifest.before, manifest.afterHashes, collection, session);
    }, { readPreference: "primary" });
  } finally {
    await __cleanup(() => session.endSession());
  }
}

async function __rollbackDocumentRequest(request, beforeValue, afterHashesValue, collection, session) {
  const before = __decode(beforeValue || []);
  const afterHashes = afterHashesValue || [];
  const idDocuments = request.operation === "insertOne"
    ? [{ _id: __decode(request.document._id) }]
    : before;
  const current = await __findByIds(collection, idDocuments, session);
  if (current.length !== idDocuments.length || current.some((document) => {
    const expected = afterHashes.find((item) => __hash(item.id) === __hash(__encode(document._id)));
    return !expected || expected.hash !== __documentHash(document);
  })) {
    __fail("MONGODB_ROLLBACK_CONFLICT", "mutation target changed after the commit");
  }
  if (request.operation === "insertOne") {
    const result = await collection.deleteOne({ _id: __decode(request.document._id) }, { session });
    const deletedCount = result.deletedCount != null ? result.deletedCount : result.n;
    if (deletedCount !== 1) __fail("MONGODB_ROLLBACK_CONFLICT", "inserted document could not be removed safely");
    return;
  }
  for (const document of before) {
    const result = await collection.replaceOne(
      { _id: document._id },
      document,
      { session, upsert: false },
    );
    const matchedCount = result.matchedCount != null ? result.matchedCount : result.n;
    if (matchedCount !== 1) __fail("MONGODB_ROLLBACK_CONFLICT", "original document could not be restored safely");
  }
}

async function __rollbackTransaction(manifest, client) {
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const operations = manifest.afterOperations || [];
      for (let index = operations.length - 1; index >= 0; index -= 1) {
        const item = operations[index];
        const collection = client.db(item.request.database).collection(item.request.collection);
        await __rollbackDocumentRequest(item.request, item.before, item.afterHashes, collection, session);
      }
    }, { readPreference: "primary" });
  } finally {
    await __cleanup(() => session.endSession());
  }
}

async function __rollbackIndex(manifest, collection, database) {
  const request = manifest.request;
  const current = __indexByName(await __readIndexes(collection), request.name);
  const dropping = request.operation === "createIndex";
  if (dropping) {
    if (!current || !manifest.afterIndex || !__indexMatches(current, __decode(manifest.afterIndex))) {
      __fail("MONGODB_ROLLBACK_CONFLICT", "created index is missing or has changed");
    }
  } else {
    if (current) __fail("MONGODB_ROLLBACK_CONFLICT", "dropped index was recreated by another operation");
    if (!manifest.beforeIndex) __fail("MONGODB_ROLLBACK_MANIFEST_INVALID", "original index definition is missing");
    __ttlRejectBusinessIndex(__decode(manifest.beforeIndex));
  }
  const original = __decode(manifest.beforeIndex);
  manifest.rollbackReceipt = { version: 1, mutationId: manifest.mutationId, planHash: manifest.planHash,
    execution: manifest.execution, database: request.database, collection: request.collection,
    operation: request.operation, stage: "dispatching", owned: false,
    source: { configPath: __configPath, driverPath: __driverPath, profile: __profileName, uriKey: __uriKey } };
  __writeJsonAtomic("manifest.json", manifest);
  const command = dropping ? { dropIndexes: request.collection, index: request.name }
    : { createIndexes: request.collection, indexes: [original] };
  const reply = await database.command({ ...command, maxTimeMS: __maxTimeMs,
    writeConcern: { w: "majority", wtimeout: __maxTimeMs } }, { readPreference: "primary" });
  if (Number(reply.ok) !== 1 || reply.writeConcernError) __fail("MONGODB_INDEX_COMMIT_UNKNOWN", "rollback index command did not acknowledge durable completion");
  manifest.rollbackReceipt.stage = "acknowledged";
  manifest.rollbackReceipt.numIndexesBefore = Number(reply.numIndexesBefore);
  manifest.rollbackReceipt.numIndexesAfter = Number(reply.numIndexesAfter);
  manifest.rollbackReceipt.noOp = Boolean(reply.note);
  manifest.rollbackReceipt.owned = dropping || Number.isFinite(Number(reply.numIndexesBefore)) && Number(reply.numIndexesAfter) === Number(reply.numIndexesBefore) + 1 && !reply.note;
  manifest.rollbackReceipt.acknowledgedAt = new Date().toISOString();
  __writeJsonAtomic("manifest.json", manifest);
  if (!manifest.rollbackReceipt.owned) __fail("MONGODB_INDEX_OWNERSHIP_UNKNOWN", "rollback command did not prove an index change");
  await __verifyIndex(manifest, collection, dropping, original);
}

async function __rollback() {
  const releaseLock = __acquireMutationLock(false);
  try {
    const manifest = __loadManifest();
    if (manifest.kind === "import") __assertImportLive(manifest.request, manifest.mutationId);
    if (manifest.status === "rolled_back") return __summary(manifest);
    if (manifest.kind === "collection") __fail("MONGODB_COLLECTION_NOT_ROLLBACKABLE", "created collections are retained; automatic drop could delete later business data");
    if (manifest.kind === "bulk_storage") __fail("MONGODB_BULK_STORAGE_NOT_ROLLBACKABLE", "bulk storage initialization is retained; disable bulk capability instead of deleting its records");
    if (manifest.status !== "committed" && !(manifest.kind === "import" && manifest.status === "rollback_retryable")) __fail("MONGODB_MUTATION_NOT_COMMITTED", "only a committed mutation can be rolled back");
    __assertNotExpired(manifest);
    if (manifest.kind === "import") __beginImportExecution(manifest, true);
    __appendJournal("rollback_started", { planHash: manifest.planHash });
    manifest.status = "rollback_started";
    manifest.execution = __request.execution;
    __writeJsonAtomic("manifest.json", manifest);
    const { client } = await __loadMutationClient(manifest, true);
    try {
      const collection = manifest.request.collection
        ? client.db(manifest.request.database).collection(manifest.request.collection)
        : null;
      if (manifest.kind === "import") {
        __assertImportLive(manifest.request, manifest.mutationId);
        await __runImportTransaction(manifest, client, collection, true);
        return __summary(manifest);
      } else if (manifest.kind === "index") {
        await __rollbackIndex(manifest, collection, client.db(manifest.request.database));
      } else if (manifest.kind === "transaction") {
        await __rollbackTransaction(manifest, client);
      } else {
        await __rollbackDocument(manifest, client, collection);
      }
      manifest.status = "rolled_back";
      manifest.rolledBackAt = new Date().toISOString();
      __writeJsonAtomic("manifest.json", manifest);
      __appendJournal("rolled_back", { planHash: manifest.planHash });
      return __summary(manifest);
    } catch (error) {
      if (manifest.kind !== "import") manifest.status = manifest.kind === "index" && manifest.rollbackReceipt ? "rollback_unknown" : "rollback_failed";
      try { __writeJsonAtomic("manifest.json", manifest); } catch (_writeError) {}
      try { __appendJournal(manifest.status, { code: error.code || "MONGODB_ROLLBACK_FAILED" }); } catch (_journalError) {}
      throw error;
    } finally {
      await __cleanup(() => client.close());
    }
  } finally {
    releaseLock();
  }
}

function __list() {
  if (!__fs.existsSync(__journalRoot)) return { entries: [] };
  if (__fs.lstatSync(__journalRoot).isSymbolicLink()) __fail("MONGODB_JOURNAL_SYMLINK_REJECTED", "mutation journal root cannot be a symbolic link");
  const entries = [];
  for (const name of __fs.readdirSync(__journalRoot)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name)) continue;
    const filePath = __path.join(__journalRoot, name, "manifest.json");
    try {
      if (!__fs.existsSync(filePath) || __fs.lstatSync(filePath).isSymbolicLink()) continue;
      const manifest = JSON.parse(__fs.readFileSync(filePath, "utf8"));
      if (manifest.schemaVersion !== __schemaVersion) continue;
      if (__request.status && manifest.status !== __request.status) continue;
      entries.push(__summary(manifest));
    } catch (_error) {
      // Ignore incomplete or expired directories in a listing.
    }
  }
  entries.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  return { entries: entries.slice(0, ${MAX_MONGODB_MUTATION_LIST_ITEMS}) };
}

// A recovery fence and preparation share the same lock. Never age out this lock:
// elapsed time cannot prove that a remote process has stopped using the journal.
async function __guardedPrepare(recover) {
  const release = __acquireMutationLock(false);
  try {
    const ticket = __request.prepare;
    const controlPath = __path.join(__journalDir(), "prepare.json");
    const manifestPath = __path.join(__journalDir(), "manifest.json");
    const source = { configPath: __configPath, driverPath: __driverPath, profile: __profileName, uriKey: __uriKey };
    let control;
    if (__fs.existsSync(controlPath)) {
      if (__fs.lstatSync(controlPath).isSymbolicLink()) __fail("MONGODB_JOURNAL_SYMLINK_REJECTED", "prepare receipt cannot be a symbolic link");
      try { control = JSON.parse(__fs.readFileSync(controlPath, "utf8")); }
      catch (_error) { __fail("MONGODB_PREPARE_RECEIPT_INVALID", "prepare receipt is invalid"); }
      if (control.schemaVersion !== 1 || control.binding !== ticket.binding || control.requestDigest !== ticket.requestDigest ||
          control.database !== __request.database || __hash(control.source) !== __hash(source) ||
          !Number.isSafeInteger(control.fencedThrough) || control.fencedThrough < 0 || !["preparing", "plan_reserved"].includes(control.stage)) {
        __fail("MONGODB_PREPARE_RECEIPT_CONFLICT", "prepare identity or target does not match");
      }
    } else {
      // Missing remote state may have been deleted or lost. It cannot prove that
      // an earlier helper never ran, even when a mutation listing is empty.
      if (recover || __fs.existsSync(manifestPath)) __fail("MONGODB_PREPARE_RECEIPT_INVALID", "prepare receipt is missing");
      control = { schemaVersion: 1, binding: ticket.binding, requestDigest: ticket.requestDigest, database: __request.database, source, fencedThrough: 0, stage: "preparing" };
      __writeJsonAtomic("prepare.json", control);
    }
    if (__fs.existsSync(manifestPath)) {
      if (__fs.lstatSync(manifestPath).isSymbolicLink()) __fail("MONGODB_JOURNAL_SYMLINK_REJECTED", "mutation manifest cannot be a symbolic link");
      let manifest;
      try { manifest = JSON.parse(__fs.readFileSync(manifestPath, "utf8")); }
      catch (_error) { __fail("MONGODB_MUTATION_MANIFEST_INVALID", "mutation manifest is invalid"); }
      if (manifest.mutationId !== ticket.mutationId || __hash(manifest.prepare) !== __hash(ticket) ||
          manifest.schemaVersion !== __schemaVersion || __planHash(manifest) !== manifest.planHash) {
        __fail("MONGODB_PREPARE_RECEIPT_CONFLICT", "manifest does not match this preparation attempt");
      }
      __assertManifestScope(manifest);
      return { ...__summary(manifest), prepare: ticket, recovery: "prepared" };
    }
    if (recover) {
      if (control.stage !== "preparing") __fail("MONGODB_PREPARE_RECEIPT_INVALID", "reserved plan manifest is missing");
      control.fencedThrough = Math.max(control.fencedThrough, ticket.attempt);
      __writeJsonAtomic("prepare.json", control);
      return { prepare: ticket, recovery: "fenced" };
    }
    if (control.stage !== "preparing") __fail("MONGODB_PREPARE_RECEIPT_INVALID", "reserved plan manifest is missing");
    if (ticket.attempt <= control.fencedThrough) __fail("MONGODB_PREPARE_FENCED", "this preparation attempt was fenced by recovery");
    return await __prepare();
  } finally { release(); }
}

(async () => {
  let client;
  try {
    let data;
    if (["execution_risk_review", "execution_risk_continue"].includes(__request.mode)) {
      data = await __executionRisk(__request.mode === "execution_risk_continue");
    } else if (__request.mode === "import_review") {
      data = { importId: __request.importId, database: __request.database, batches: __reviewImportBatches(__request), historicalOutcome: "unknown" };
    } else if (__request.mode === "import_retire") {
      data = __retireImport(__request);
    } else if (__request.mode === "import_recover") {
      data = await __guardedImportPrepare(true);
    } else if (__request.mode === "list") {
      data = __list();
    } else if (__request.mode === "recover_execution") {
      data = await __recoverExecution();
    } else if (__request.mode === "get") {
      data = __summary(__loadManifest());
    } else if (__request.mode === "recover_prepare") {
      data = await __guardedPrepare(true);
    } else if (__request.mode === "prepare") {
      data = __request.prepare ? await __guardedPrepare(false) : __request.kind === "import_plan" ? await __guardedImportPrepare(false) : await __prepare();
    } else if (__request.mode === "commit") {
      data = await __commit();
    } else if (__request.mode === "rollback") {
      data = await __rollback();
    } else {
      __fail("MONGODB_MUTATION_MODE_INVALID", "unsupported mutation mode");
    }
    process.stdout.write(__marker + JSON.stringify({ ok: true, data }) + "\\n");
  } catch (error) {
    process.stdout.write(__marker + JSON.stringify({
      ok: false,
      error: {
        code: typeof error.code === "string" && /^MONGODB_[A-Z0-9_]{1,70}$/.test(error.code) ? error.code : "MONGODB_OPERATION_FAILED",
        message: "Structured MongoDB mutation failed",
        diagnostic: __diagnostic(error),
      },
    }) + "\\n");
    process.exitCode = 1;
  } finally {
    if (client) await __cleanup(() => client.close());
  }
})();
`;

  const scriptLimit = request.kind === "import_plan" ? MAX_MONGODB_IMPORT_BYTES + 1024 * 1024 : MAX_MONGODB_MUTATION_RESULT_BYTES * 2;
  if (byteLength(script) > scriptLimit) {
    throw mutationError("MongoDB mutation helper script is too large", "MONGODB_MUTATION_SCRIPT_TOO_LARGE", 413);
  }
  return script;
}

function markerPayload(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith(MONGODB_RESULT_MARKER)) continue;
    try {
      return JSON.parse(lines[index].slice(MONGODB_RESULT_MARKER.length));
    } catch {
      throw mutationError("MongoDB mutation helper returned invalid JSON", "MONGODB_MUTATION_INVALID_RESPONSE", 502);
    }
  }
  return null;
}

function normalizeMutationId(value) {
  return normalizeName(value, "mutationId", SAFE_MUTATION_ID_PATTERN);
}

function normalizePlanHash(value) {
  return normalizeName(value, "planHash", /^[a-f0-9]{64}$/);
}

export async function runMongoMutation(input = {}, options = {}) {
  const rawConfig = options.config?.mongodb || options.config || {};
  const mode = input.mode || "prepare";
  let request, config, script;
  try {
    config = normalizeMongoMutationConfig(rawConfig);
    const execution = input._businessExecution;
    if (execution !== undefined && (!execution || !/^[a-f0-9]{64}$/.test(execution.intentId || "") ||
        typeof execution.operationId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(execution.operationId) ||
        Object.keys(execution).some((key) => !["intentId", "operationId", "version", "attempt", "mutationId", "planHash"].includes(key)) ||
        execution.version !== undefined && (execution.version !== 2 || !Number.isSafeInteger(execution.attempt) || execution.attempt < 1 ||
          !SAFE_MUTATION_ID_PATTERN.test(execution.mutationId || "") || !/^[a-f0-9]{64}$/.test(execution.planHash || "")))) {
      throw mutationError("invalid execution identity", "MONGODB_EXECUTION_IDENTITY_INVALID");
    }
    const importReceipt = input._businessImport || input.importReceipt;
    if (importReceipt !== undefined && (!importReceipt || !["binding", "requestDigest", "batchesDigest"].every(field => /^[a-f0-9]{64}$/.test(importReceipt[field] || "")) ||
        (!Number.isSafeInteger(importReceipt.attempt) || importReceipt.attempt < 1) || Object.keys(importReceipt).some(field => !["binding", "requestDigest", "batchesDigest", "attempt", "riskPlanId"].includes(field)) ||
        importReceipt.riskPlanId !== undefined && !/^[a-f0-9]{64}$/.test(importReceipt.riskPlanId))) throw mutationError("invalid import prepare receipt", "MONGODB_IMPORT_RECEIPT_INVALID");
    const ticket = input._businessPrepare;
    if (ticket !== undefined && !isPrepareTicket(ticket)) throw mutationError("invalid prepare identity", "MONGODB_PREPARE_IDENTITY_INVALID");

    if (mode === "prepare") {
      const kind = input.kind === "import_plan"
        ? "import_plan"
        : input.kind === "bulk_storage"
          ? "bulk_storage"
        : input.kind === "collection" ? "collection"
        : input.kind === "index"
        ? "index"
        : input.kind === "transaction"
          ? "transaction"
          : "document";
      const mutation = kind === "import_plan"
        ? normalizeMongoImport(input, config, { operationId: options.operation?.operationId })
        : kind === "bulk_storage"
          ? normalizeMongoBulkStorage(input, rawConfig, { operationId: options.operation?.operationId })
        : kind === "collection" ? normalizeMongoCollectionCreate(input, config, { operationId: options.operation?.operationId })
        : kind === "index"
        ? normalizeMongoIndexChange(input, config, { operationId: options.operation?.operationId })
        : kind === "transaction"
          ? normalizeMongoTransaction(input, config, { operationId: options.operation?.operationId })
        : normalizeMongoMutation(input, config, { operationId: options.operation?.operationId });
      request = {
        mode: "prepare",
        kind,
        operationId: options.operation?.operationId || mutation.operationId,
        mutationId: ticket?.mutationId || randomUUID(),
        ...(ticket ? { prepare: ticket, database: mutation.database } : {}),
        mutation,
        ...(kind === "import_plan" && input._businessImport ? { importReceipt: input._businessImport } : {}),
      };
      if (ticket && ["import_plan", "bulk_storage"].includes(kind)) throw mutationError("unsupported prepare identity kind", "MONGODB_PREPARE_IDENTITY_INVALID");
    } else if (["import_review", "import_retire", "import_recover"].includes(mode)) {
      const database = assertDatabaseAllowed(input.database, config);
      const importId = normalizeName(input.importId, "importId", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
      const validateBatches = batches => {
        if (!Array.isArray(batches) || !batches.length || batches.length > 100 || batches.some((b, i) =>
          !/^import-[a-f0-9]{64}$/.test(b.mutationId || "") || b.batchIndex !== i || !Number.isSafeInteger(b.documentCount) || b.documentCount < 1 || b.documentCount > 2000 || !/^[a-f0-9]{64}$/.test(b.requestDigest || ""))) throw mutationError("invalid import batch identity", "MONGODB_IMPORT_RECEIPT_INVALID");
        return batches;
      };
      request = { mode, database, importId };
      if (mode === "import_review") request.batches = validateBatches(input.batches);
      if (mode === "import_recover") request.importReceipt = input.importReceipt;
      if (mode === "import_retire") {
        request.replacementImportId = normalizeName(input.replacementImportId, "replacementImportId", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
        if (request.replacementImportId === importId) throw mutationError("distinct import identity required", "MONGODB_IMPORT_RECEIPT_INVALID");
        for (const field of ["riskPlanId", "dispositionId", "originalRequestDigest", "replacementRequestDigest", "approvalAuditId"]) {
          if (!/^[a-f0-9]{64}$/.test(input[field] || "")) throw mutationError("invalid import review identity", "MONGODB_IMPORT_RECEIPT_INVALID");
          request[field] = input[field];
        }
        request.originalBatches = validateBatches(input.originalBatches);
        request.replacementBatches = validateBatches(input.replacementBatches);
      }
    } else if (["execution_risk_review", "execution_risk_continue"].includes(mode)) {
      const b = input.binding;
      const hashes = ["reviewId", "riskPlanId", "intentId", "planHash", "batchRequestDigest", "originalPrepareIntentId", "replacementPrepareIntentId"];
      if (!b || hashes.some(f => !/^[a-f0-9]{64}$/.test(b[f] || "")) || !execution ||
          JSON.stringify(execution) !== JSON.stringify(b.execution) || !Number.isSafeInteger(b.expiresAt) ||
          !/^[A-Za-z0-9._-]{1,64}$/.test(b.importId || "") || typeof b.contextId !== "string" ||
          Object.keys(b).some(f => ![...hashes, "contextId", "instanceId", "database", "collection", "importId", "execution", "attempt", "executionProtocol", "mutationId", "expiresAt"].includes(f)))
        throw mutationError("exact execution review binding required", "MONGODB_EXECUTION_REVIEW_CONFLICT");
      const database = assertDatabaseAllowed(b.database, config);
      assertCollectionAllowed(b.collection, config);
      request = { mode, binding: b, execution, database, mutationId: normalizeMutationId(b.mutationId), planHash: normalizePlanHash(b.planHash) };
      if (mode === "execution_risk_continue") {
        if (![input.proposalDigest, input.approvalAuditId].every(v => /^[a-f0-9]{64}$/.test(v || "")))
          throw mutationError("approved proposal required", "MONGODB_EXECUTION_REVIEW_CONFLICT");
        request.proposalDigest = input.proposalDigest; request.approvalAuditId = input.approvalAuditId;
      }
    } else if (mode === "recover_prepare") {
      if (!isPrepareTicket(ticket)) throw mutationError("prepare identity required", "MONGODB_PREPARE_IDENTITY_INVALID");
      request = { mode, mutationId: ticket.mutationId, prepare: ticket, database: assertDatabaseAllowed(input.database, config) };
    } else if (mode === "recover_execution") {
      request = { mode, mutationId: normalizeMutationId(input.mutationId), planHash: normalizePlanHash(input.planHash),
        database: assertDatabaseAllowed(input.database, config), execution };
    } else if (mode === "get") {
      request = { mode, mutationId: normalizeMutationId(input.mutationId), planHash: normalizePlanHash(input.planHash) };
    } else if (mode === "commit" || mode === "rollback") {
      request = {
        mode,
        execution,
        mutationId: normalizeMutationId(input.mutationId),
        planHash: normalizePlanHash(input.planHash),
        operationId: options.operation?.operationId || randomUUID(),
      };
      const expectedConfirmation = mode === "commit"
        ? MONGODB_MUTATION_CONFIRMATION
        : MONGODB_ROLLBACK_CONFIRMATION;
      if (input.confirmation !== expectedConfirmation) {
        throw mutationError(
          `confirmation must exactly equal ${expectedConfirmation}`,
          mode === "commit" ? "MONGODB_MUTATION_CONFIRMATION_REQUIRED" : "MONGODB_ROLLBACK_CONFIRMATION_REQUIRED",
          400,
        );
      }
    } else if (mode === "list") {
      request = {
        mode: "list",
        status: typeof input.status === "string" ? input.status.trim().slice(0, 64) : undefined,
        mutationId: randomUUID(),
        operationId: options.operation?.operationId || randomUUID(),
      };
    } else {
      throw mutationError("unsupported MongoDB mutation mode", "MONGODB_MUTATION_MODE_INVALID");
    }

    if (typeof options.runSSH !== "function") {
      throw mutationError("MongoDB SSH runner is not configured", "MONGODB_RUNNER_UNAVAILABLE", 500);
    }
    script = buildMongoMutationScript(request, config);
  } catch (error) {
    // Only this synchronous preflight can attest that no SSH helper was started.
    if (mode === "prepare") error.dispatchState = "not_dispatched";
    throw error;
  }

  let remoteResult;
  try {
    remoteResult = await options.runSSH(MONGODB_REMOTE_COMMAND, {
      config: options.config,
      operation: options.operation,
      stdin: script,
      taskType: "mongo_write",
    });
  } catch (error) {
    if (options.operation?.signal?.aborted) {
      throw operationErrorForSignal(options.operation.signal, options.operation, {
        layer: "mongodb-mutation",
        phase: mode,
      });
    }
    throw operationError(redactMongoSecrets(error.message || "MongoDB mutation helper could not be executed"), {
      code: error.code || "MONGODB_MUTATION_FAILED",
      statusCode: error.statusCode || 502,
      operationId: options.operation?.operationId,
      layer: "mongodb-mutation",
      phase: mode,
      retriable: !["commit", "rollback"].includes(mode) && error.retriable === true,
      cause: error,
    });
  }

  if (remoteResult?.stdoutTruncated || byteLength(remoteResult?.stdout || "") > MAX_MONGODB_MUTATION_RESULT_BYTES) {
    throw operationError("MongoDB mutation result exceeded the response limit", {
      code: "MONGODB_MUTATION_RESULT_TOO_LARGE",
      statusCode: 413,
      operationId: options.operation?.operationId,
      layer: "mongodb-mutation",
      phase: "response-size",
      retriable: false,
    });
  }
  const payload = markerPayload(remoteResult?.stdout);
  if (!payload) {
    throw operationError("MongoDB mutation helper returned no structured response", {
      code: "MONGODB_MUTATION_INVALID_RESPONSE",
      statusCode: 502,
      operationId: options.operation?.operationId,
      layer: "mongodb-mutation",
      phase: "response-parse",
      retriable: false,
      cause: redactMongoSecrets(remoteResult?.stderr),
    });
  }
  if (payload.ok !== true || remoteResult?.exitCode !== 0 || remoteResult?.timedOut) {
    const failure = operationError("Structured MongoDB mutation failed", {
      code: remoteResult?.timedOut ? "MONGODB_MUTATION_TIMEOUT" : payload.error?.code || "MONGODB_MUTATION_FAILED",
      statusCode: remoteResult?.timedOut ? 408 : 400,
      operationId: options.operation?.operationId,
      layer: "mongodb-mutation",
      phase: mode,
      retriable: !["commit", "rollback"].includes(mode) && remoteResult?.timedOut === true,
      cause: undefined,
    });
    failure.diagnostic = mutationDiagnostic(payload.error?.diagnostic);
    throw failure;
  }

  return {
    ...(payload.data || {}),
    timing: remoteResult.timing,
  };
}

export function mutationJournalPath(config, mutationId) {
  const normalizedConfig = normalizeMongoMutationConfig(config);
  const id = normalizeMutationId(mutationId);
  return posixPath.join(normalizedConfig.rollbackRoot, id);
}
