// Shared, fail-closed public diagnostics. Never serialize Error/details/stack or
// arbitrary driver text: duplicate-key/validation errors can contain whole rows.
export function publicBulkFailure(error, context = {}, messages = [], depth = 0) {
  error = error || {};
  // 兼容旧驱动的 BulkWriteResult；只提取有界元数据，不序列化原始错误或文档。
  const read = (value, key) => { try { return value && value[key]; } catch { return undefined; } };
  const numericCode = value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
  const categoryFor = (value, text = "") => {
    const known = { 13: "authorization", 14: "type_mismatch", 28: "invalid_update_path", 40: "update_path_conflict", 50: "timeout", 66: "immutable_field", 112: "write_conflict", 121: "document_validation", 251: "transaction_aborted", 11000: "duplicate_key", 11001: "duplicate_key" };
    if (numericCode(value) && Object.prototype.hasOwnProperty.call(known, value)) return known[value];
    if (/^Transaction numbers are only allowed/.test(text)) return "transaction_topology";
    if (/^Read preference in a transaction must be primary/.test(text)) return "transaction_read_preference";
    if (/^Cannot (?:read|set) propert(?:y|ies) of (?:undefined|null)/.test(text)) return "javascript_property";
    if (/is not a function/.test(text)) return "javascript_callable";
    if (/^object \[[\s\S]*\] is not a valid ObjectId$/.test(text)) return "bson_object_id";
    if (/^(?:Update document requires atomic operators|update document must contain key operators|Invalid op passed to bulkWrite)/i.test(text)) return "invalid_bulk_operation";
    return "unknown";
  };
  const metadata = value => {
    const result = {};
    const code = read(value, "code"), index = read(value, "index");
    if (numericCode(code)) result.code = code;
    if (Number.isInteger(index) && index >= 0 && index < 100000) result.index = index;
    if (!Object.keys(result).length) return null;
    result.category = categoryFor(code);
    return result;
  };
  const response = read(error, "errorResponse"), resultObject = read(error, "result"), legacyResult = read(resultObject, "result");
  const writeErrors = [read(error, "writeErrors"), read(response, "writeErrors"), read(resultObject, "writeErrors"), read(legacyResult, "writeErrors")].find(Array.isArray);
  const concernErrors = [read(error, "writeConcernErrors"), read(response, "writeConcernErrors"), read(resultObject, "writeConcernErrors"), read(legacyResult, "writeConcernErrors")].find(Array.isArray);
  const code = typeof error.code === "number" && Number.isSafeInteger(error.code) ? error.code
    : typeof error.code === "string" && /^(?:MONGODB_|SANDBOX_|SSH_|RESOURCE_|OPERATION_|ERR_|E[A-Z]+$)[A-Z0-9_]{0,95}$/.test(error.code) ? error.code : "MONGODB_BULK_FAILED";
  const original = String(error.message || "MongoDB bulk request failed");
  let message = messages.indexOf(original) !== -1 ? original : "Unrecognized error text withheld; inspect code, phase and message fingerprint";
  const categories = [
    [/^E11000 duplicate key error/, "Duplicate key rejected by MongoDB; key and document details withheld"],
    [/^Transaction numbers are only allowed/, "Transaction numbers are only allowed on a replica set member or mongos"],
    [/^not authorized on /i, "MongoDB authorization rejected; database and command details withheld"],
    [/^Read preference in a transaction must be primary/, "Read preference in a transaction must be primary"],
    [/^Cannot (?:read|set) propert(?:y|ies) of (?:undefined|null)/, "Cannot access property of undefined or null; property details withheld"],
    [/^[A-Za-z_$][A-Za-z0-9_$]* is not (?:defined|a function)$/, "JavaScript reference or callable is missing; identifier withheld"],
    [/^Document failed validation/, "Document failed MongoDB validation; document details withheld"],
    [/^object \[[\s\S]*\] is not a valid ObjectId$/, "BSON ObjectId serialization rejected; value details withheld"],
  ];
  if (messages.indexOf(original) === -1) for (const entry of categories) if (entry[0].test(original)) { message = entry[1]; break; }
  if (categories.some(entry => entry[1] === original) || original === "Unrecognized error text withheld; inspect code, phase and message fingerprint") message = original;
  const names = ["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "MongoError", "MongoServerError", "MongoNetworkError", "MongoServerSelectionError", "MongoBulkWriteError", "BulkWriteError", "OperationError"];
  const result = { version: 1, at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(error.at || "") ? error.at : new Date().toISOString(), code, name: names.indexOf(error.name) !== -1 ? error.name : "Error", message, messageRedacted: error.messageRedacted === true || message !== original,
    layer: ["mongodb-bulk", "mongodb-helper", "ssh", "resource", "operation"].indexOf(context.layer) !== -1 ? context.layer : "mongodb-bulk",
    phase: ["unknown", "runner", "resource_wait", "upload", "get", "list", "executeStart", "rollbackStart", "resume", "control", "dispatch", "executeBatch", "verifyBatch", "rollbackBatch", "pause", "heartbeat", "finish", "connect", "receipt_lookup", "transaction_start", "preimage_check", "business_write", "postimage_read", "after_log_write", "receipt_write", "retirement_check", "commit"].indexOf(context.phase) !== -1 ? context.phase : "unknown",
    outcome: "unknown", recovery: "inspect_before_resume", retriable: error.retriable === true };
  const categoriesAllowed = ["authorization", "type_mismatch", "invalid_update_path", "update_path_conflict", "timeout", "immutable_field", "write_conflict", "document_validation", "transaction_aborted", "duplicate_key", "transaction_topology", "transaction_read_preference", "javascript_property", "javascript_callable", "bson_object_id", "invalid_bulk_operation", "unknown"];
  result.category = categoriesAllowed.includes(error.category) ? error.category : categoryFor(error.code, original);
  if (writeErrors) {
    result.writeErrors = writeErrors.slice(0, 5).map(metadata).filter(Boolean);
    result.writeErrorCount = Number.isInteger(error.writeErrorCount) && error.writeErrorCount >= writeErrors.length && error.writeErrorCount <= 100000 ? error.writeErrorCount : Math.min(writeErrors.length, 100000);
    result.writeErrorsTruncated = error.writeErrorsTruncated === true || writeErrors.length > 5;
  }
  const singleConcern = metadata(read(error, "writeConcernError") || read(response, "writeConcernError"));
  if (concernErrors || singleConcern) result.writeConcernErrors = concernErrors ? concernErrors.slice(0, 3).map(metadata).filter(Boolean) : [singleConcern];
  const nestedError = (result.writeErrors || []).concat(result.writeConcernErrors || []).find(item => item.code !== undefined);
  const nestedCode = nestedError && nestedError.code;
  if (numericCode(error.driverCode)) result.driverCode = error.driverCode;
  else if (numericCode(error.code)) result.driverCode = error.code;
  else if (nestedCode !== undefined) result.driverCode = nestedCode;
  if (result.category === "unknown" && result.driverCode !== undefined) result.category = categoryFor(result.driverCode);
  const labels = read(error, "errorLabels");
  if (Array.isArray(labels)) result.errorLabels = [...new Set(labels.slice(0, 16).filter(label => ["TransientTransactionError", "UnknownTransactionCommitResult", "RetryableWriteError", "NoWritesPerformed"].includes(label)))];
  const stackFrames = String(error.stack || "").split("\n").slice(1, 16).map(line => {
    const frame = /\bat (__bulk[A-Za-z0-9_$]+) .*?:(\d+):(\d+)\)?$/.exec(line);
    return frame ? { function: frame[1], line: Number(frame[2]), column: Number(frame[3]) } : null;
  }).filter(Boolean);
  result.frames = (Array.isArray(error.frames) ? error.frames : stackFrames).slice(0, 8)
    .filter(frame => frame && /^__bulk[A-Za-z0-9_$]+$/.test(frame.function) && Number.isInteger(frame.line) && Number.isInteger(frame.column))
    .map(frame => ({ function: frame.function, line: frame.line, column: frame.column }));
  const modules = ["mongodb/lib/bulk/common.js", "mongodb/lib/bulk/ordered.js", "mongodb/lib/bulk/unordered.js", "mongodb/lib/operations/bulk_write.js", "mongodb/lib/utils.js", "bson/lib/bson/parser/serializer.js"];
  const driverFrames = String(error.stack || "").split("\n").slice(1, 16).flatMap(line => {
    const frame = /node_modules\/((?:mongodb|bson)\/[A-Za-z0-9_/-]+\.js):(\d+):(\d+)\)?$/.exec(line);
    return frame && modules.includes(frame[1]) ? [{ module: frame[1], line: Number(frame[2]), column: Number(frame[3]) }] : [];
  });
  result.driverFrames = (Array.isArray(error.driverFrames) ? error.driverFrames : driverFrames).slice(0, 8)
    .filter(frame => frame && modules.includes(frame.module) && Number.isSafeInteger(frame.line) && frame.line > 0 && frame.line <= 1000000 && Number.isSafeInteger(frame.column) && frame.column > 0 && frame.column <= 1000000)
    .map(frame => ({ module: frame.module, line: frame.line, column: frame.column }));
  if (typeof context.fingerprint === "function") result.messageFingerprint = context.fingerprint(original);
  if (/^[a-f0-9]{64}$/.test(error.messageFingerprint || "")) result.messageFingerprint = error.messageFingerprint;
  if (Number.isInteger(context.batchIndex) && context.batchIndex >= 0) result.batchIndex = context.batchIndex;
  for (const key of ["operationId", "parentOperationId"]) if (typeof context[key] === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(context[key])) result[key] = context[key];
  if (["not_started", "not_committed", "unknown"].indexOf(context.outcome) !== -1) result.outcome = context.outcome;
  if (code === "MONGODB_BULK_COMMIT_UNKNOWN") { result.outcome = "unknown"; result.recovery = "reconcile_exact_receipt"; }
  else if (code === "MONGODB_BULK_CONFLICT" || code === "MONGODB_ROLLBACK_CONFLICT" || code === "MONGODB_BULK_JOB_RETIRED") result.recovery = "review_required";
  for (const key of ["driverVersion", "nodeVersion"]) if (/^v?\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(context[key] || error[key] || "")) result[key] = context[key] || error[key];
  for (const key of ["collectionIndex", "collectionOperationCount"]) if (Number.isInteger(context[key]) && context[key] >= 0 && context[key] <= 100000) result[key] = context[key];
  if (error.persistenceFailure && depth < 2) result.persistenceFailure = publicBulkFailure(error.persistenceFailure, { phase: "pause" }, messages, depth + 1);
  if (error.receiptCheckFailure && depth < 2) result.receiptCheckFailure = publicBulkFailure(error.receiptCheckFailure, context, messages, depth + 1);
  if (error.cause && depth < 2) result.cause = publicBulkFailure(error.cause, context, messages, depth + 1);
  return result;
}
