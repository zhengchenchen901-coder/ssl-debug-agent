import { importReviewDiagnostic } from "../plugins/remote-debug-agent/review-diagnostic.js";
export { importReviewDiagnostic } from "../plugins/remote-debug-agent/review-diagnostic.js";
import { privacyError } from "./privacy-key.js";
import { normalizeMongoImport } from "./mongodb-mutations.js";
export { importReviewDisplay } from "./mongodb-import-review-display.js";
import { prepareRequestDigest, isImportRequest } from "../plugins/remote-debug-agent/prepare-protocol.js";

const FIELDS = new Set(["instanceId", "importId", "database", "collection", "documents", "batchSize", "rollbackTtlMs", "purpose", "operationId", "timeoutMs", "deadlineAt"]);
function exactJson(raw) {
  let nodes = 0;
  const visit = (value, depth) => {
    if (++nodes > 400000 || depth > 16) throw privacyError("BUSINESS_DISPOSITION_INPUT_INVALID");
    if (value === null || ["string", "boolean", "undefined"].includes(typeof value)) return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (!value || typeof value !== "object" || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw privacyError("BUSINESS_DISPOSITION_INPUT_INVALID");
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (descriptor.get || descriptor.set) throw privacyError("BUSINESS_DISPOSITION_INPUT_INVALID");
      if (descriptor.enumerable) visit(descriptor.value, depth + 1);
    }
  };
  visit(raw, 0);
  const bytes = JSON.stringify(raw);
  if (typeof bytes !== "string" || Buffer.byteLength(bytes) > 5 * 1024 * 1024) throw privacyError("BUSINESS_DISPOSITION_INPUT_INVALID");
  if (bytes.includes("[REDACTED]")) throw privacyError("BUSINESS_DISPOSITION_ORIGINAL_BYTES_REQUIRED");
  return JSON.parse(bytes);
}

// Inbound business documents belong in the encrypted review, including their
// credential-shaped fields. An OUTPUT sanitizer cannot validate original bytes:
// it intentionally changes those fields and has a different traversal budget.
// This boundary copies JSON without reordering, validates normal import bounds,
// and never returns business data in its diagnostic.
export function normalizeExactImportReview(raw, target, config, requestField) {
  const incoming = exactJson(raw);
  if (!isImportRequest(incoming) || Object.keys(incoming).some(key => !FIELDS.has(key)) || incoming.instanceId !== target.id || incoming.database !== target.database) throw privacyError("BUSINESS_DISPOSITION_ORIGINAL_BYTES_REQUIRED");
  const { operationId, deadlineAt, timeoutMs, ...request } = incoming;
  try {
    // Long legacy IDs may be reviewed as identities only. A future preparation
    // retains the ordinary 64-character bound and uses the existing candidate.
    const plan = normalizeMongoImport(request, config, { historicalReviewOnly: requestField === "originalRequest" });
    if (plan.importId !== request.importId || plan.database !== request.database || plan.collection !== request.collection) throw privacyError("BUSINESS_DISPOSITION_INPUT_INVALID");
  } catch (error) {
    const rejected = privacyError("BUSINESS_DISPOSITION_INPUT_INVALID");
    rejected.inputDiagnostic = importReviewDiagnostic({ requestField, code: error.code });
    throw rejected;
  }
  if (prepareRequestDigest(incoming) !== prepareRequestDigest(request)) throw privacyError("BUSINESS_DISPOSITION_ORIGINAL_BYTES_REQUIRED");
  return request;
}

