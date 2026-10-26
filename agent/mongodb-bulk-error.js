// Shared, fail-closed public diagnostics. Never serialize Error/details/stack or
// arbitrary driver text: duplicate-key/validation errors can contain whole rows.
export function publicBulkFailure(error, context = {}, messages = [], depth = 0) {
  error = error || {};
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
  ];
  if (messages.indexOf(original) === -1) for (const entry of categories) if (entry[0].test(original)) { message = entry[1]; break; }
  if (categories.some(entry => entry[1] === original) || original === "Unrecognized error text withheld; inspect code, phase and message fingerprint") message = original;
  const names = ["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "MongoError", "MongoServerError", "MongoNetworkError", "MongoServerSelectionError", "MongoBulkWriteError", "BulkWriteError", "OperationError"];
  const result = { version: 1, at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(error.at || "") ? error.at : new Date().toISOString(), code, name: names.indexOf(error.name) !== -1 ? error.name : "Error", message, messageRedacted: error.messageRedacted === true || message !== original,
    layer: ["mongodb-bulk", "mongodb-helper", "ssh", "resource", "operation"].indexOf(context.layer) !== -1 ? context.layer : "mongodb-bulk",
    phase: ["unknown", "runner", "resource_wait", "upload", "get", "list", "executeStart", "rollbackStart", "resume", "control", "dispatch", "executeBatch", "verifyBatch", "rollbackBatch", "pause", "heartbeat", "finish", "connect", "receipt_lookup", "transaction_start", "preimage_check", "business_write", "postimage_read", "after_log_write", "receipt_write", "retirement_check", "commit"].indexOf(context.phase) !== -1 ? context.phase : "unknown",
    outcome: "unknown", recovery: "inspect_before_resume", retriable: error.retriable === true };
  const stackFrames = String(error.stack || "").split("\n").slice(1, 16).map(line => {
    const frame = /\bat (__bulk[A-Za-z0-9_$]+) .*?:(\d+):(\d+)\)?$/.exec(line);
    return frame ? { function: frame[1], line: Number(frame[2]), column: Number(frame[3]) } : null;
  }).filter(Boolean);
  result.frames = (Array.isArray(error.frames) ? error.frames : stackFrames).slice(0, 8)
    .filter(frame => frame && /^__bulk[A-Za-z0-9_$]+$/.test(frame.function) && Number.isInteger(frame.line) && Number.isInteger(frame.column))
    .map(frame => ({ function: frame.function, line: frame.line, column: frame.column }));
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
