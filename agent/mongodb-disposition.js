import { assertOrphanRiskAdmission } from "./mongodb-orphan-risk.js";
import { privacyError } from "./privacy-key.js";
import { prepareRequestDigest } from "../plugins/remote-debug-agent/prepare-protocol.js";
import { replacementAdmission, riskRetirementStatus, assertRiskJobAdmission } from "./mongodb-risk-replacement.js";
import { assertJobNotTerminated } from "./mongodb-job-termination.js";

export const DISPOSITION_CONFIRMATION = "确认隔离原意图";
const HASH = /^[a-f0-9]{64}$/;
const DAY = 86400000;
const READ_ROUTES = new Set([
  "/mongodb/query", "/mongodb/imports/review", "/mongodb/imports/recover-prepare", "/mongodb/bulk/job", "/mongodb/bulk/jobs",
  "/mongodb/mutations/list", "/mongodb/mutations/get",
  "/mongodb/bulk/recover-prepare", "/mongodb/mutations/recover-prepare", "/mongodb/mutations/recover-execution",
]);
export function isMongoAdmissionRoute(route) {
  return typeof route === "string" && (route === "/sandbox/cleanup" || route.startsWith("/mongodb/") && !READ_ROUTES.has(route));
}

// This is containment, not a remote revocation certificate. In particular the
// existing SSH transport can execute previously serialized, fence-unaware code.
// No response from that helper can attest that every legacy executor is fenced.
const requirements = Object.freeze([
  "mandatory_executor_boundary_migration_required",
  "legacy_process_queue_and_lease_drain_attestation_required",
  "durable_remote_fence_receipt_required",
  "historical_transaction_receipts_required",
]);
function denied() { throw privacyError("BUSINESS_DISPOSITION_DENIED"); }
function targetOf(input) {
  let target; try { target = JSON.parse(input.scope); } catch { denied(); }
  if (!target?.id || !target.database) denied();
  return target;
}
function view(store, record) {
  const instanceHold = !!store.get("disposition_hold", store.hash("disposition-instance-hold", record.binding.instanceId), "", "");
  return { ok: true, dispositionId: record.id, reviewHash: record.reviewHash,
    state: record.state, binding: record.binding, recordFingerprint: record.recordFingerprint,
    createdAt: record.createdAt, expiresAt: record.expiresAt, quarantinedAt: record.quarantinedAt,
    auditId: record.auditId, localContainment: instanceHold || ["termination_requested", "retired_unknown"].includes(record.state),
    requiresConfirmation: record.state === "review_required", confirmation: DISPOSITION_CONFIRMATION,
    containmentScope: record.retirement && !instanceHold ? "original_job_managed_admissions" : "instance_all_mongodb_write_admissions",
    remoteFenceConfirmed: false, historicalOutcome: "unknown", replacementAllowed: false,
    missingRequirements: record.missingRequirements, ...riskRetirementStatus(store, record) };
}

// Internal store actions only; public input cannot supply evidence, binding,
// state, an execution ticket, risk acceptance or an alternate request identity.
export function dispositionStoreAction(store, action, input, ctx, scope) {
  if (action === "prepare_disposition") return store.transaction(() => {
    const target = targetOf(input), original = store.get("operation", input.id, ctx, scope), request = input.request;
    if (!HASH.test(input.id || "") || !original || original.state !== "uncertain" || !["/mongodb/bulk/prepare", "/mongodb/imports/prepare"].includes(original.route) ||
        original.identity?.instanceId !== target.id || !request || request.instanceId !== target.id || request.database !== target.database ||
        store.hash("operation", ctx, input.scope, original.route, request) !== input.id ||
        (original.route === "/mongodb/bulk/prepare" ? typeof original.identity.jobId !== "string" || original.identity.jobId !== request.jobId ||
        !Number.isSafeInteger(original.identity.chunkIndex) || original.identity.chunkIndex !== request.chunkIndex :
        typeof request.importId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(request.importId) || request.jobId !== undefined ||
        original.identity.importId !== undefined && original.identity.importId !== request.importId) ||
        input.requestDigest !== prepareRequestDigest(request)) denied();
    if (original.importPrepare && original.importPrepare.requestDigest !== input.requestDigest) denied();
    if (original.bulkPrepare && original.bulkPrepare.requestDigest !== input.requestDigest) denied();
    const fingerprint = store.hash("operation-record", ctx, input.scope, input.id, original);
    const binding = { ...(original.route === "/mongodb/imports/prepare" ? { kind: "import", route: original.route, importId: request.importId, collection: request.collection } : {}), contextId: ctx, instanceId: target.id, database: target.database, intentId: input.id,
      requestDigest: input.requestDigest, originalOperationId: original.operationId || null,
      jobId: original.identity.jobId, chunkIndex: original.identity.chunkIndex,
      chunkHash: original.bulkChunk?.chunkHash || null, planHash: original.identity.planHash || null };
    const missingRequirements = binding.kind === "import" ? ["historical_import_batch_receipts_required", "historical_in_flight_outcomes_unknown"] : [...requirements];
    const identityGaps = binding.kind === "import" ? [["originalOperationId", "original_operation_identity_unbound"]]
      : [["originalOperationId", "original_operation_identity_unbound"], ["chunkHash", "original_chunk_hash_unbound"], ["planHash", "original_plan_hash_unbound"]];
    for (const [field, reason] of identityGaps) {
      if (!binding[field]) missingRequirements.push(reason);
    }
    const id = store.hash("disposition", ctx, input.scope, binding, fingerprint);
    const previous = store.get("disposition", id, ctx, scope);
    if (previous && (["quarantined", "retired_unknown"].includes(previous.state) || store.now() < previous.expiresAt)) return view(store, previous);
    const createdAt = store.now(), expiresAt = createdAt + DAY;
    const record = { id, state: "review_required", binding, recordFingerprint: fingerprint, createdAt, expiresAt, missingRequirements,
      auditId: store.hash("disposition-audit", id, "review", createdAt) };
    record.reviewHash = store.hash("disposition-review", record);
    store.put("disposition", id, ctx, scope, record, Number.MAX_SAFE_INTEGER, true);
    store.put("event", record.auditId, ctx, scope, { type: "disposition_review_prepared", dispositionId: id,
      binding, recordFingerprint: fingerprint, reviewHash: record.reviewHash, at: createdAt }, Number.MAX_SAFE_INTEGER, true);
    return view(store, record);
  });
  if (["inspect_disposition", "quarantine_disposition", "admit_disposition"].includes(action)) return store.transaction(() => {
    if (!HASH.test(input.dispositionId || "")) denied();
    const record = store.get("disposition", input.dispositionId, ctx, scope);
    if (!record || record.binding.contextId !== ctx || record.binding.instanceId !== targetOf(input).id || record.binding.database !== targetOf(input).database) denied();
    if (action === "inspect_disposition") return view(store, record);
    if (input.reviewHash !== record.reviewHash) denied();
    if (action === "admit_disposition") {
      // Intentionally no success branch: the current transport has no mandatory
      // remote execution boundary or legacy drain proof. A local hold, helper
      // version, missing job, balances or caller assertion cannot substitute.
      const auditId = store.hash("disposition-audit", record.id, "replacement_denied");
      if (!store.get("event", auditId, ctx, scope)) store.put("event", auditId, ctx, scope,
        { type: "disposition_replacement_denied", dispositionId: record.id, at: store.now(), reasons: record.missingRequirements }, Number.MAX_SAFE_INTEGER, true);
      return { ...view(store, record), admission: "blocked", admissionAuditId: auditId };
    }
    if (input.confirmation !== DISPOSITION_CONFIRMATION) denied();
    if (["quarantined", "retired_unknown"].includes(record.state)) return view(store, record); // lost reply/restart
    if (store.now() >= record.expiresAt) throw privacyError("BUSINESS_DISPOSITION_REVIEW_EXPIRED");
    const original = store.get("operation", record.binding.intentId, ctx, scope);
    if (!original || original.state !== "uncertain" || record.recordFingerprint !==
        store.hash("operation-record", ctx, input.scope, record.binding.intentId, original)) throw privacyError("BUSINESS_DISPOSITION_STALE");
    const holdId = store.hash("disposition-instance-hold", record.binding.instanceId);
    // One pinned, context-independent instance gate. A new context, job, database,
    // changed parameters or ordinary mutation API must not bypass containment.
    const hold = store.get("disposition_hold", holdId, "", "");
    if (hold && hold.instanceId !== record.binding.instanceId) denied();
    const at = store.now(), auditId = store.hash("disposition-audit", record.id, "quarantine");
    store.put("disposition_hold", holdId, "", "", hold || { instanceId: record.binding.instanceId, firstDispositionId: record.id, at }, Number.MAX_SAFE_INTEGER, true);
    const saved = { ...record, state: "quarantined", quarantinedAt: at, auditId };
    store.put("disposition", record.id, ctx, scope, saved, Number.MAX_SAFE_INTEGER, true);
    store.put("event", auditId, ctx, scope, { type: "disposition_locally_quarantined", dispositionId: record.id,
      binding: record.binding, reviewHash: record.reviewHash, recordFingerprint: record.recordFingerprint,
      remoteFenceConfirmed: false, historicalOutcome: "unknown", replacementAllowed: false, at }, Number.MAX_SAFE_INTEGER, true);
    // The original operation, task, evidence, result and mapping pins are never
    // rewritten, unpinned, expired or represented as cancelled/not-dispatched.
    return view(store, saved);
  });
  return undefined;
}

export function assertInstanceAdmission(store, instanceId, admission = {}) {
  if (typeof instanceId !== "string" || !instanceId) denied();
  assertOrphanRiskAdmission(store, instanceId, admission);
  assertJobNotTerminated(store, instanceId, admission);
  assertRiskJobAdmission(store, instanceId, admission);
  if (store.get("disposition_hold", store.hash("disposition-instance-hold", instanceId), "", "")) {
    if (replacementAdmission(store, instanceId, admission)) return { ok: true };
    throw privacyError("BUSINESS_DISPOSITION_QUARANTINED");
  }
  return { ok: true };
}
