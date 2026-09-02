import posixPath from "node:path/posix";
import {
  operationError,
  operationErrorForSignal,
} from "./operation.js";

export const MONGODB_QUERY_OPERATIONS = Object.freeze([
  "ping",
  "listDatabases",
  "listCollections",
  "find",
  "findOne",
  "countDocuments",
  "aggregate",
]);

export const MONGODB_REMOTE_COMMAND = "node";
export const MONGODB_CONFIG_ROOTS = Object.freeze(["/home/app", "/home/github"]);
export const DEFAULT_MONGODB_LIMIT = 50;
export const MAX_MONGODB_LIMIT = 500;
export const MAX_MONGODB_SKIP = 100_000;
export const MAX_MONGODB_PIPELINE_STAGES = 20;
export const MAX_MONGODB_QUERY_BYTES = 64 * 1024;
export const MAX_MONGODB_SCRIPT_BYTES = 128 * 1024;
export const MAX_MONGODB_RESULT_BYTES = 512 * 1024;
export const MAX_MONGODB_ERROR_BYTES = 4096;
export const MONGODB_RESULT_MARKER = "__REMOTE_DEBUG_MONGODB_RESULT__";

const SAFE_CONFIG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const SAFE_DATABASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_COLLECTION_PATTERN = /^[A-Za-z0-9_.$-]{1,128}$/;
const BLOCKED_OPERATORS = new Set([
  "$where",
  "$function",
  "$accumulator",
  "$out",
  "$merge",
  "$planCacheStats",
  "$currentOp",
]);

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function mongoError(message, code, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.layer = "mongodb";
  error.phase = "validation";
  error.retriable = false;
  Object.assign(error, details);
  return error;
}

function normalizeString(value, fieldName, options = {}) {
  if (typeof value !== "string") {
    throw mongoError(`${fieldName} must be a string`, "INVALID_MONGODB_CONFIG");
  }

  const normalized = value.trim();
  if (!normalized && options.allowEmpty !== true) {
    throw mongoError(`${fieldName} must not be empty`, "INVALID_MONGODB_CONFIG");
  }
  if (normalized.length > (options.maxLength || 4096)) {
    throw mongoError(`${fieldName} is too long`, "INVALID_MONGODB_CONFIG");
  }
  if (options.pattern && !options.pattern.test(normalized)) {
    throw mongoError(`${fieldName} has an invalid format`, "INVALID_MONGODB_CONFIG");
  }
  return normalized;
}

function normalizeRemoteConfigPath(value, fieldName) {
  const normalized = posixPath.normalize(normalizeString(value, fieldName));
  if (!normalized.startsWith("/")) {
    throw mongoError(`${fieldName} must be an absolute path`, "INVALID_MONGODB_CONFIG");
  }

  const allowed = MONGODB_CONFIG_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
  if (!allowed) {
    throw mongoError(
      `${fieldName} must be under ${MONGODB_CONFIG_ROOTS.join(", ")}`,
      "MONGODB_CONFIG_PATH_NOT_ALLOWED",
      400,
    );
  }

  return normalized;
}

export function normalizeMongoConfig(value = {}) {
  if (!value || value.enabled === false) {
    throw mongoError(
      "MongoDB access is not enabled for this instance",
      "MONGODB_NOT_CONFIGURED",
      503,
    );
  }

  const configPath = normalizeRemoteConfigPath(value.configPath, "mongodb.configPath");
  const driverPath = normalizeRemoteConfigPath(value.driverPath, "mongodb.driverPath");
  const configProfile = normalizeString(value.configProfile, "mongodb.configProfile", {
    maxLength: 128,
    pattern: SAFE_CONFIG_KEY_PATTERN,
  });
  const uriKey = normalizeString(value.uriKey || "url", "mongodb.uriKey", {
    maxLength: 128,
    pattern: SAFE_CONFIG_KEY_PATTERN,
  });
  const database = value.database === undefined || value.database === ""
    ? ""
    : normalizeString(value.database, "mongodb.database", {
        maxLength: 128,
        pattern: SAFE_DATABASE_PATTERN,
      });

  return {
    enabled: true,
    configPath,
    driverPath,
    configProfile,
    uriKey,
    database,
  };
}

function assertPlainObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw mongoError(`${fieldName} must be an object`, "INVALID_MONGODB_QUERY");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw mongoError(`${fieldName} must be a plain object`, "INVALID_MONGODB_QUERY");
  }
}

function assertSafeJson(value, fieldName = "$", depth = 0) {
  if (depth > 12) {
    throw mongoError(`${fieldName} is too deeply nested`, "INVALID_MONGODB_QUERY");
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw mongoError(`${fieldName} contains a non-finite number`, "INVALID_MONGODB_QUERY");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeJson(item, `${fieldName}[${index}]`, depth + 1));
    return;
  }
  if (typeof value !== "object") {
    throw mongoError(`${fieldName} contains an unsupported value`, "INVALID_MONGODB_QUERY");
  }

  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      throw mongoError(`${fieldName} contains a forbidden key`, "INVALID_MONGODB_QUERY");
    }
    if (BLOCKED_OPERATORS.has(key)) {
      throw mongoError(`${key} is not allowed by the read-only MongoDB tool`, "MONGODB_OPERATOR_REJECTED");
    }
    assertSafeJson(child, `${fieldName}.${key}`, depth + 1);
  }
}

function normalizeQueryObject(value, fieldName, fallback = {}) {
  const normalized = value === undefined ? fallback : value;
  assertPlainObject(normalized, fieldName);
  assertSafeJson(normalized, fieldName);
  if (byteLength(JSON.stringify(normalized)) > MAX_MONGODB_QUERY_BYTES) {
    throw mongoError(`${fieldName} is too large`, "MONGODB_QUERY_TOO_LARGE", 413);
  }
  return normalized;
}

function normalizeLimit(value) {
  if (value === undefined || value === null) {
    return DEFAULT_MONGODB_LIMIT;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw mongoError("limit must be a positive integer", "INVALID_MONGODB_QUERY");
  }
  return Math.min(value, MAX_MONGODB_LIMIT);
}

function normalizeSkip(value) {
  if (value === undefined || value === null) {
    return 0;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw mongoError("skip must be a non-negative integer", "INVALID_MONGODB_QUERY");
  }
  return Math.min(value, MAX_MONGODB_SKIP);
}

function normalizeDatabase(value, fallback) {
  const database = value === undefined || value === "" ? fallback || "" : value;
  if (!database) {
    return "";
  }
  if (typeof database !== "string" || !SAFE_DATABASE_PATTERN.test(database)) {
    throw mongoError("database has an invalid format", "INVALID_MONGODB_QUERY");
  }
  return database;
}

function normalizeCollection(value) {
  if (typeof value !== "string" || !SAFE_COLLECTION_PATTERN.test(value)) {
    throw mongoError(
      "collection must use letters, numbers, underscore, dot, dollar, or dash",
      "INVALID_MONGODB_QUERY",
    );
  }
  return value;
}

export function normalizeMongoQuery(input = {}, config = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw mongoError("MongoDB query must be an object", "INVALID_MONGODB_QUERY");
  }

  const mongodb = normalizeMongoConfig(config);
  const operation = input.operation;
  if (!MONGODB_QUERY_OPERATIONS.includes(operation)) {
    throw mongoError(
      `operation must be one of ${MONGODB_QUERY_OPERATIONS.join(", ")}`,
      "INVALID_MONGODB_OPERATION",
    );
  }

  const database = normalizeDatabase(input.database, mongodb.database);
  const requiresDatabase = ["listCollections", "find", "findOne", "countDocuments", "aggregate"];
  if (requiresDatabase.includes(operation) && !database) {
    throw mongoError(
      "database is required or must be configured for this instance",
      "MONGODB_DATABASE_REQUIRED",
    );
  }

  const requiresCollection = ["find", "findOne", "countDocuments", "aggregate"];
  const collection = requiresCollection.includes(operation)
    ? normalizeCollection(input.collection)
    : input.collection === undefined || input.collection === ""
      ? ""
      : normalizeCollection(input.collection);

  const filter = requiresCollection.includes(operation)
    ? normalizeQueryObject(input.filter, "filter")
    : {};
  const projection = input.projection === undefined
    ? undefined
    : normalizeQueryObject(input.projection, "projection");
  const sort = input.sort === undefined
    ? undefined
    : normalizeQueryObject(input.sort, "sort");
  const pipeline = input.pipeline === undefined ? [] : input.pipeline;
  if (!Array.isArray(pipeline)) {
    throw mongoError("pipeline must be an array", "INVALID_MONGODB_QUERY");
  }
  if (pipeline.length > MAX_MONGODB_PIPELINE_STAGES) {
    throw mongoError(
      `pipeline cannot contain more than ${MAX_MONGODB_PIPELINE_STAGES} stages`,
      "MONGODB_PIPELINE_TOO_LARGE",
    );
  }
  assertSafeJson(pipeline, "pipeline");
  if (byteLength(JSON.stringify(pipeline)) > MAX_MONGODB_QUERY_BYTES) {
    throw mongoError("pipeline is too large", "MONGODB_QUERY_TOO_LARGE", 413);
  }

  if (operation === "aggregate" && pipeline.some((stage) => {
    const limit = stage && typeof stage === "object" ? stage.$limit : undefined;
    return limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_MONGODB_LIMIT);
  })) {
    throw mongoError(
      `aggregate $limit must be between 1 and ${MAX_MONGODB_LIMIT}`,
      "MONGODB_LIMIT_REJECTED",
    );
  }

  return {
    operation,
    database,
    collection,
    filter,
    projection,
    sort,
    pipeline,
    limit: normalizeLimit(input.limit),
    skip: normalizeSkip(input.skip),
  };
}

export function summarizeMongoQuery(query = {}) {
  const keyList = (value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).slice(0, 50)
    : [];

  return {
    operation: typeof query.operation === "string" ? query.operation.slice(0, 64) : undefined,
    database: typeof query.database === "string" ? query.database.slice(0, 128) : undefined,
    collection: typeof query.collection === "string" ? query.collection.slice(0, 128) : undefined,
    filterKeys: keyList(query.filter),
    projectionKeys: keyList(query.projection),
    sortKeys: keyList(query.sort),
    pipelineLength: Array.isArray(query.pipeline) ? query.pipeline.length : 0,
    limit: query.limit,
    skip: query.skip,
  };
}

function safeLiteral(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildMongoScript(query, config) {
  const normalizedConfig = normalizeMongoConfig(config);
  const normalizedQuery = normalizeMongoQuery(query, normalizedConfig);
  const script = `
const __fs = require("fs");
const __configPath = ${safeLiteral(normalizedConfig.configPath)};
const __driverPath = ${safeLiteral(normalizedConfig.driverPath)};
const __profileName = ${safeLiteral(normalizedConfig.configProfile)};
const __uriKey = ${safeLiteral(normalizedConfig.uriKey)};
const __request = ${safeLiteral(normalizedQuery)};
const __marker = ${safeLiteral(MONGODB_RESULT_MARKER)};
const __maxTimeMs = 15000;
let __bson;
try {
  __bson = require(require.resolve("bson", { paths: [__driverPath] }));
} catch (_error) {
  __bson = null;
}

function __fallbackReplacer(_key, value) {
  if (value && typeof value === "object" && value._bsontype === "ObjectID" && typeof value.toHexString === "function") {
    return { $oid: value.toHexString() };
  }
  if (value && typeof value === "object" && value._bsontype === "Long" && typeof value.toString === "function") {
    return { $numberLong: value.toString() };
  }
  if (value && typeof value === "object" && value._bsontype === "Decimal128" && typeof value.toString === "function") {
    return { $numberDecimal: value.toString() };
  }
  if (Buffer.isBuffer(value)) {
    return { $binary: { base64: value.toString("base64"), subType: "00" } };
  }
  return value;
}

function __decode(value) {
  if (value === undefined || !__bson || !__bson.EJSON || !__bson.EJSON.parse) {
    return value;
  }
  return __bson.EJSON.parse(JSON.stringify(value));
}

function __encode(value) {
  if (__bson && __bson.EJSON && __bson.EJSON.stringify) {
    return JSON.parse(__bson.EJSON.stringify(value));
  }
  return JSON.parse(JSON.stringify(value, __fallbackReplacer));
}

function __getPath(value, keyPath) {
  return keyPath.split(".").reduce((current, key) => current == null ? undefined : current[key], value);
}

function __emit(payload) {
  process.stdout.write(__marker + JSON.stringify(payload) + "\\n");
}

function __errorPayload(error) {
  return {
    name: (error && error.name) || "Error",
    message: String((error && error.message) || error).slice(0, 2000),
  };
}

(async () => {
  let __client;
  try {
    const __fileConfig = JSON.parse(__fs.readFileSync(__configPath, "utf8"));
    const __profile = __fileConfig && __fileConfig[__profileName];
    if (!__profile || typeof __profile !== "object") {
      throw new Error("MongoDB config profile was not found");
    }
    const __uri = __getPath(__profile, __uriKey);
    const __database = __request.database || __profile.database || __profile.databaseName || "";
    if (typeof __uri !== "string" || !__uri) {
      throw new Error("MongoDB URI was not found in the configured profile");
    }
    if (["listCollections", "find", "findOne", "countDocuments", "aggregate"].includes(__request.operation) && !__database) {
      throw new Error("MongoDB database is not configured");
    }

    const __driver = require(__driverPath);
    const __MongoClient = __driver.MongoClient || (__driver.default && __driver.default.MongoClient);
    if (!__MongoClient) {
      throw new Error("MongoDB driver does not export MongoClient");
    }
    __client = new __MongoClient(__uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: __maxTimeMs,
    });
    await __client.connect();

    let __data;
    if (__request.operation === "ping") {
      __data = await __client.db("admin").command({ ping: 1 });
    } else if (__request.operation === "listDatabases") {
      const __listed = await __client.db("admin").admin().listDatabases({ nameOnly: true });
      __data = {
        databases: (__listed.databases || []).slice(0, __request.limit).map((item) => ({ name: item.name })),
      };
    } else if (__request.operation === "listCollections") {
      const __db = __client.db(__database);
      __data = (await __db.listCollections({}, { nameOnly: true }).toArray())
        .slice(0, __request.limit)
        .map((item) => ({ name: item.name, type: item.type }));
    } else {
      const __collection = __client.db(__database).collection(__request.collection);
      const __filter = __decode(__request.filter || {});
      const __projection = __request.projection ? __decode(__request.projection) : undefined;
      if (__request.operation === "find") {
        const __options = __projection ? { projection: __projection } : {};
        let __cursor = __collection.find(__filter, __options);
        if (__request.sort) __cursor = __cursor.sort(__decode(__request.sort));
        if (__request.skip) __cursor = __cursor.skip(__request.skip);
        __cursor = __cursor.limit(__request.limit);
        if (typeof __cursor.maxTimeMS === "function") __cursor.maxTimeMS(__maxTimeMs);
        __data = await __cursor.toArray();
      } else if (__request.operation === "findOne") {
        const __options = { maxTimeMS: __maxTimeMs };
        if (__projection) __options.projection = __projection;
        __data = await __collection.findOne(__filter, __options);
      } else if (__request.operation === "countDocuments") {
        __data = await __collection.countDocuments(__filter, { maxTimeMS: __maxTimeMs });
      } else if (__request.operation === "aggregate") {
        const __pipeline = __decode(__request.pipeline || []).slice();
        __pipeline.push({ $limit: __request.limit });
        const __cursor = __collection.aggregate(__pipeline, { allowDiskUse: false });
        if (typeof __cursor.maxTimeMS === "function") __cursor.maxTimeMS(__maxTimeMs);
        __data = await __cursor.toArray();
      }
    }

    __emit({
      ok: true,
      operation: __request.operation,
      database: __database || null,
      collection: __request.collection || null,
      data: __encode(__data),
    });
  } catch (error) {
    __emit({
      ok: false,
      operation: __request.operation,
      error: __errorPayload(error),
    });
    process.exitCode = 1;
  } finally {
    if (__client) {
      await __client.close().catch(() => {});
    }
  }
})();
`;

if (byteLength(script) > MAX_MONGODB_SCRIPT_BYTES) {
  throw mongoError("MongoDB query script is too large", "MONGODB_QUERY_TOO_LARGE", 413);
}

return script;
}

export function redactMongoSecrets(value, maxLength = MAX_MONGODB_ERROR_BYTES) {
  const redacted = String(value || "")
    .replace(/(mongodb(?:\+srv)?:\/\/)([^@\s]+)@/gi, "$1[REDACTED]@")
    .replace(/((?:password|passwd|pwd|secret|token)=)[^&\s]+/gi, "$1[REDACTED]");
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, maxLength)}\n...[truncated ${redacted.length - maxLength} chars]`;
}

function runtimeMongoError(message, options = {}) {
  const error = operationError(message, {
    code: options.code || "MONGODB_QUERY_FAILED",
    statusCode: options.statusCode || 502,
    operationId: options.operation?.operationId,
    layer: "mongodb",
    phase: options.phase || "query",
    retriable: options.retriable === true,
    cause: options.cause
      ? redactMongoSecrets(options.cause.message || options.cause)
      : undefined,
  });
  error.details = options.details;
  return error;
}

function resultCount(data) {
  if (data === null || data === undefined) return 0;
  if (Array.isArray(data)) return data.length;
  if (typeof data === "number") return data;
  if (Array.isArray(data.databases)) return data.databases.length;
  return 1;
}

function markerPayload(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith(MONGODB_RESULT_MARKER)) continue;
    try {
      return JSON.parse(lines[index].slice(MONGODB_RESULT_MARKER.length));
    } catch {
      throw runtimeMongoError(
        "MongoDB helper returned invalid JSON",
        { code: "MONGODB_INVALID_RESPONSE", phase: "response-parse" },
      );
    }
  }
  return null;
}

export async function runMongoQuery(query, options = {}) {
  const normalizedConfig = normalizeMongoConfig(options.config?.mongodb);
  const normalizedQuery = normalizeMongoQuery(query, normalizedConfig);
  if (typeof options.runSSH !== "function") {
    throw runtimeMongoError("MongoDB SSH runner is not configured", {
      code: "MONGODB_RUNNER_UNAVAILABLE",
      statusCode: 500,
      phase: "configuration",
      operation: options.operation,
    });
  }

  const stdin = buildMongoScript(normalizedQuery, normalizedConfig);
  let remoteResult;
  try {
    remoteResult = await options.runSSH(MONGODB_REMOTE_COMMAND, {
      config: options.config,
      operation: options.operation,
      stdin,
    });
  } catch (error) {
    if (options.operation?.signal?.aborted) {
      throw operationErrorForSignal(options.operation.signal, options.operation, {
        layer: "mongodb",
        phase: "query",
      });
    }
    throw runtimeMongoError("MongoDB remote helper could not be executed", {
      code: error.code || "MONGODB_QUERY_FAILED",
      statusCode: error.statusCode || 502,
      phase: error.phase || "remote-exec",
      retriable: error.retriable === true,
      cause: error,
      operation: options.operation,
      details: { cause: redactMongoSecrets(error.message) },
    });
  }

  if (remoteResult?.stdoutTruncated || byteLength(remoteResult?.stdout || "") > MAX_MONGODB_RESULT_BYTES) {
    throw runtimeMongoError("MongoDB result exceeded the response limit", {
      code: "MONGODB_RESULT_TOO_LARGE",
      statusCode: 413,
      phase: "response-size",
      operation: options.operation,
    });
  }

  const payload = markerPayload(remoteResult?.stdout);
  if (!payload) {
    throw runtimeMongoError("MongoDB helper returned no structured response", {
      code: remoteResult?.exitCode === 127 ? "MONGODB_NODE_NOT_FOUND" : "MONGODB_INVALID_RESPONSE",
      phase: "response-parse",
      operation: options.operation,
      details: {
        exitCode: remoteResult?.exitCode,
        stderr: redactMongoSecrets(remoteResult?.stderr),
      },
    });
  }

  if (payload.ok !== true || remoteResult?.exitCode !== 0 || remoteResult?.timedOut) {
    const helperError = payload.error?.message || redactMongoSecrets(remoteResult?.stderr) || "MongoDB query failed";
    throw runtimeMongoError(redactMongoSecrets(helperError), {
      code: remoteResult?.timedOut ? "MONGODB_QUERY_TIMEOUT" : "MONGODB_QUERY_FAILED",
      phase: remoteResult?.timedOut ? "query-timeout" : "database",
      operation: options.operation,
      retriable: remoteResult?.timedOut === true,
      details: {
        exitCode: remoteResult?.exitCode,
        stderr: redactMongoSecrets(remoteResult?.stderr),
      },
    });
  }

  return {
    operation: normalizedQuery.operation,
    database: payload.database || normalizedQuery.database || null,
    collection: payload.collection || normalizedQuery.collection || null,
    data: payload.data,
    resultCount: resultCount(payload.data),
    timing: remoteResult.timing,
  };
}
