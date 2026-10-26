import { privacyError } from "./privacy-key.js";
import { bulkPreparePayload, prepareRequestDigest } from "../plugins/remote-debug-agent/prepare-protocol.js";
import { digest, fenceChallenge, inspectFenceAuthority, requireFenceAuthority } from "./mongodb-fence-authority.js";

export const RISK_CONFIRMATION = "我接受历史结果未知的风险，并批准建立此替代任务";
const HASH = /^[a-f0-9]{64}$/;
const MAX = Number.MAX_SAFE_INTEGER;
const denied = (code = "BUSINESS_REPLACEMENT_DENIED") => { throw privacyError(code); };
const wire = value => JSON.parse(JSON.stringify(bulkPreparePayload(value)));

// Guard preimages may be refreshed, but write effects, IDs, unit order, amounts,
// restored batch dates and all other business content must remain identical.
// Only explicit job-association fields are rebound to the replacement job.
function effects(request, originalJobId) {
  function walk(value, key = "", insideIdentity = false) {
    insideIdentity ||= ["id", "_id"].includes(key.split(".").at(-1));
    if (!insideIdentity && typeof value === "string" && ["remediation_job_id", "job_id"].includes(key.split(".").at(-1)) && value === request.jobId) return originalJobId;
    if (Array.isArray(value)) return value.map(x => walk(x, "", insideIdentity));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k, insideIdentity)]));
    return value;
  }
  return { database: request.database, units: request.units.map(unit => ({ unitId: unit.unitId, operations: unit.operations.map(({ expected, ...operation }) => {
    const updated = new Set(Object.values(operation.update || {}).flatMap(value => Object.keys(value)));
    const guards = expected && Object.fromEntries(Object.entries(expected).map(([field, guard]) => [field,
      updated.has(field) && guard.exists === true && (guard.value === null || ["string", "number", "boolean"].includes(typeof guard.value))
        ? { exists: true, refreshableScalarPreimage: true } : guard]));
    return { ...walk(operation), ...(guards ? { guards } : {}) };
  }) })) };
}
function originalCurrent(store, plan, ctx, scope) {
  const original = store.get("operation", plan.binding.intentId, ctx, scope);
  if (!original || original.state !== "uncertain" || store.hash("operation-record", ctx, plan.targetScope, plan.binding.intentId, original) !== plan.recordFingerprint) denied("BUSINESS_REPLACEMENT_STALE");
}
function humanHash(store, plan, proof) {
  return store.hash("risk-human-review", plan.id, plan.requestDigest, plan.sealDigest, plan.recordFingerprint, plan.expiresAt, proof.fingerprint || null);
}
export function riskView(store, plan) {
  const proof = inspectFenceAuthority(plan, store.fenceAuthority, store.now());
  const approved = !!plan.approval;
  const scope = store.hash("scope", plan.targetScope), parent = store.get("disposition", plan.dispositionId, plan.binding.contextId, scope);
  const original = store.get("operation", plan.binding.intentId, plan.binding.contextId, scope);
  const originalUnchanged = original?.state === "uncertain" && store.hash("operation-record", plan.binding.contextId, plan.targetScope, plan.binding.intentId, original) === plan.recordFingerprint;
  const parentEligible = parent?.state === "quarantined" || parent?.state === "retired_unknown" && parent.retirement?.riskPlanId === plan.id;
  return { ok: true, riskPlanId: plan.id, dispositionId: plan.dispositionId, state: plan.state,
    binding: plan.binding, replacementJobId: plan.replacementRequest.jobId,
    replacementRequestDigest: plan.requestDigest, sealRequestDigest: plan.sealDigest, effectDigest: plan.effectDigest,
    reviewHash: humanHash(store, plan, proof), createdAt: plan.createdAt, expiresAt: plan.expiresAt,
    historicalOutcome: "unknown", risk: "possible_prior_commit_or_unobserved_rollback_duplicate_compensation_risk",
    confirmation: RISK_CONFIRMATION, humanConfirmationRequired: !approved, humanApproved: approved,
    canApprove: proof.confirmed && parentEligible && originalUnchanged && plan.state === "awaiting_human" && store.now() < plan.expiresAt,
    remoteFenceConfirmed: proof.confirmed, fenceReason: proof.reason, fenceReceiptId: proof.receiptId,
    fenceFingerprint: proof.fingerprint, fenceValidUntil: proof.validUntil,
    replacementAllowed: approved && parentEligible && originalUnchanged && proof.confirmed && plan.approval.fenceFingerprint === proof.fingerprint && store.now() < plan.approval.validUntil,
    unitCount: plan.replacementRequest.units.length,
    operationCount: plan.replacementRequest.units.reduce((n, u) => n + u.operations.length, 0),
    collections: [...new Set(plan.replacementRequest.units.flatMap(u => u.operations.map(o => o.collection)))],
    auditId: plan.auditId, approvalAuditId: plan.approval?.auditId, creationAuditId: plan.creationAuditId,
    replacementIntentId: plan.replacementIntentId, planHash: plan.planHash,
    fenceChallenge: fenceChallenge(plan) };
}
function load(store, id, ctx, scope) {
  if (!HASH.test(id || "")) denied();
  const row = store.db.prepare("SELECT * FROM records WHERE kind='risk_replacement' AND id=?").get(id);
  if (!row || ctx !== undefined && (row.ctx !== ctx || row.scope !== scope)) denied();
  return { plan: store.open(row), ctx: row.ctx, scope: row.scope };
}
function audit(store, type, plan, ctx, scope, extra = {}) {
  const id = store.hash("risk-audit", type, plan.id, extra);
  if (!store.get("event", id, ctx, scope)) store.put("event", id, ctx, scope,
    { type, riskPlanId: plan.id, dispositionId: plan.dispositionId, binding: plan.binding, requestDigest: plan.requestDigest,
      historicalOutcome: "unknown", at: store.now(), ...extra }, MAX, true);
  return id;
}
export function riskStoreAction(store, action, input, ctx, scope) {
  if (action === "prepare_risk_replacement") return store.transaction(() => {
    const parent = store.get("disposition", input.dispositionId, ctx, scope), original = input.originalRequest, replacement = input.replacementRequest;
    if (!parent || input.reviewHash !== parent.reviewHash || !original || !replacement ||
        parent.binding.contextId !== ctx || original.instanceId !== parent.binding.instanceId || original.database !== parent.binding.database ||
        replacement.instanceId !== original.instanceId || replacement.database !== original.database ||
        prepareRequestDigest(original) !== parent.binding.requestDigest ||
        store.hash("operation", ctx, input.scope, "/mongodb/bulk/prepare", original) !== parent.binding.intentId ||
        original.chunkIndex !== 0 || original.endOfUpload === true || replacement.chunkIndex !== 0 || replacement.endOfUpload === true ||
        !Array.isArray(original.units) || !original.units.length || !Array.isArray(replacement.units) ||
        typeof replacement.jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(replacement.jobId) || replacement.jobId === original.jobId ||
        digest(effects(original, original.jobId)) !== digest(effects(replacement, original.jobId))) denied();
    const gateId = store.hash("replacement-gate", replacement.instanceId, replacement.jobId);
    const existingGate = store.get("replacement_gate", gateId, "", "");
    const request = wire(replacement), seal = wire({ ...replacement, chunkIndex: 1, chunkHash: undefined, units: [], endOfUpload: true });
    const id = store.hash("risk-replacement", ctx, input.scope, parent.id, prepareRequestDigest(request), parent.recordFingerprint);
    if (existingGate && existingGate.riskPlanId !== id) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
    const old = store.get("risk_replacement", id, ctx, scope);
    if (old && (old.approval ? store.now() < old.approval.validUntil : store.now() < old.expiresAt)) return riskView(store, old);
    const plan = { id, dispositionId: parent.id, state: "awaiting_human", binding: parent.binding,
      targetScope: input.scope, recordFingerprint: parent.recordFingerprint, replacementRequest: request,
      requestDigest: prepareRequestDigest(request), sealRequest: seal, sealDigest: prepareRequestDigest(seal),
      effectDigest: digest(effects(original, original.jobId)), createdAt: old?.createdAt || store.now(), expiresAt: store.now() + 3600000,
      ...(old?.creationAuditId ? { creationAuditId: old.creationAuditId, replacementIntentId: old.replacementIntentId, planHash: old.planHash } : {}) };
    originalCurrent(store, plan, ctx, scope);
    plan.auditId = audit(store, "risk_replacement_prepared", plan, ctx, scope, { revision: store.now() });
    store.put("risk_replacement", id, ctx, scope, plan, MAX, true);
    return riskView(store, plan);
  });
  if (["inspect_risk_replacement", "create_risk_replacement"].includes(action)) return store.transaction(() => {
    const { plan } = load(store, input.riskPlanId, ctx, scope);
    if (plan.targetScope !== input.scope) denied();
    if (action === "inspect_risk_replacement") return riskView(store, plan);
    return createReplacementIntent(store, plan, input, ctx, scope);
  });
  return undefined;
}

// These actions are available only to the independent administrator listener.
// No Manager bearer token, context capability, MCP flag or confirmation string
// is accepted as a substitute for its native owner verification.
export function humanRiskStoreAction(store, action, input) {
  if (!["human_risk_context", "human_risk_view", "human_risk_approve"].includes(action)) return undefined;
  const found = load(store, input.riskPlanId);
  if (found.plan.binding.instanceId !== input.instanceId) denied();
  if (action === "human_risk_context") return { targetScope: found.plan.targetScope, database: found.plan.binding.database };
  return store.transaction(() => {
    const { plan, ctx, scope } = load(store, input.riskPlanId);
    if (plan.targetScope !== input.targetScope || plan.binding.instanceId !== input.instanceId) denied();
    if (action === "human_risk_view") return riskView(store, plan);
    if (input.confirmation !== RISK_CONFIRMATION || typeof input.actor?.username !== "string" || !input.actor.username ||
        typeof input.actor.sessionId !== "string" || !input.actor.sessionId || !Number.isSafeInteger(input.actor.verifiedAt) ||
        input.actor.verifiedAt > store.now() || store.now() - input.actor.verifiedAt > 60000) denied();
    const proof = requireFenceAuthority(plan, store);
    if (input.reviewHash !== humanHash(store, plan, proof)) denied("BUSINESS_REPLACEMENT_STALE");
    if (plan.approval) {
      if (plan.approval.reviewHash !== input.reviewHash || store.now() >= plan.approval.validUntil) denied("BUSINESS_REPLACEMENT_APPROVAL_EXPIRED");
      return riskView(store, plan);
    }
    if (store.now() >= plan.expiresAt) denied("BUSINESS_REPLACEMENT_REVIEW_EXPIRED");
    originalCurrent(store, plan, ctx, scope);
    const parent = store.get("disposition", plan.dispositionId, ctx, scope);
    if (!(parent?.state === "quarantined" || parent?.state === "retired_unknown" && parent.retirement?.riskPlanId === plan.id)) denied("BUSINESS_REPLACEMENT_QUARANTINE_REQUIRED");
    const gateId = store.hash("replacement-gate", plan.binding.instanceId, plan.replacementRequest.jobId);
    const gate = store.get("replacement_gate", gateId, "", "");
    if (gate && gate.riskPlanId !== plan.id) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
    const approval = { ...input.actor, reviewHash: input.reviewHash, fenceFingerprint: proof.fingerprint,
      validUntil: Math.min(plan.expiresAt, proof.validUntil, store.now() + 900000) };
    approval.auditId = audit(store, "risk_replacement_human_approved", plan, ctx, scope, approval);
    const saved = { ...plan, state: "human_approved", approval };
    store.put("risk_replacement", plan.id, ctx, scope, saved, MAX, true);
    if (gate) store.put("replacement_gate", gateId, "", "", { ...gate, approvalAuditId: approval.auditId, fenceFingerprint: proof.fingerprint }, MAX, true);
    // No replacement intent, remote job, grant or upload is created here.
    return riskView(store, saved);
  });
}
function createReplacementIntent(store, plan, input, ctx, scope) {
  if (!plan.approval || input.reviewHash !== plan.approval.reviewHash) denied("BUSINESS_REPLACEMENT_HUMAN_CONFIRMATION_REQUIRED");
  const proof = requireFenceAuthority(plan, store);
  if (proof.fingerprint !== plan.approval.fenceFingerprint || store.now() >= plan.approval.validUntil) denied("BUSINESS_REPLACEMENT_APPROVAL_EXPIRED");
  originalCurrent(store, plan, ctx, scope);
  const parent = store.get("disposition", plan.dispositionId, ctx, scope);
  if (!(parent?.state === "quarantined" || parent?.state === "retired_unknown" && parent.retirement?.riskPlanId === plan.id)) denied("BUSINESS_REPLACEMENT_QUARANTINE_REQUIRED");
  const id = store.hash("operation", ctx, plan.targetScope, "/mongodb/bulk/prepare", plan.replacementRequest);
  const previous = store.get("operation", id, ctx, scope);
  const gateId = store.hash("replacement-gate", plan.binding.instanceId, plan.replacementRequest.jobId);
  const existingGate = store.get("replacement_gate", gateId, "", "");
  if (existingGate && existingGate.riskPlanId !== plan.id || previous && !existingGate) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
  const record = previous && previous.state !== "rejected_before_dispatch" ? previous : {
    state: "uncertain", route: "/mongodb/bulk/prepare", identity: { instanceId: plan.binding.instanceId, jobId: plan.replacementRequest.jobId, chunkIndex: 0 },
    started: store.now(), bulkPrepare: { binding: id, requestDigest: plan.requestDigest, attempt: (previous?.bulkPrepare?.attempt || 0) + 1 } };
  if (!previous || previous.state === "rejected_before_dispatch") store.put("operation", id, ctx, scope, record, MAX, true);
  const taskId = store.hash("task", ctx, plan.targetScope, "operation:" + id);
  store.put("task", taskId, ctx, scope, { id: "operation:" + id, active: true, expires: MAX }, MAX, true);
  const oldTask = store.hash("task", ctx, plan.targetScope, "operation:" + plan.binding.intentId);
  store.db.prepare("INSERT OR IGNORE INTO links SELECT ctx,scope,?,ref FROM links WHERE ctx=? AND scope=? AND task=?").run(taskId, ctx, scope, oldTask);
  const creationAuditId = plan.creationAuditId || audit(store, "risk_replacement_creation_reserved", plan, ctx, scope,
    { replacementIntentId: id, fenceFingerprint: proof.fingerprint, approvalAuditId: plan.approval.auditId });
  const saved = { ...plan, state: plan.planHash ? "prepared" : plan.state === "uploaded" ? "uploaded" : "creating", replacementIntentId: id, creationAuditId };
  store.put("risk_replacement", plan.id, ctx, scope, saved, MAX, true);
  if (parent.state !== "retired_unknown") store.put("disposition", parent.id, ctx, scope, { ...parent, state: "retired_unknown",
    retirement: { riskPlanId: plan.id, replacementJobId: plan.replacementRequest.jobId, replacementIntentId: id,
      approvalAuditId: plan.approval.auditId, creationAuditId, fenceFingerprint: proof.fingerprint, at: store.now() } }, MAX, true);
  store.put("replacement_gate", gateId, "", "", { ...(existingGate || { riskPlanId: plan.id, ctx, scope, instanceId: plan.binding.instanceId,
    jobId: plan.replacementRequest.jobId }), approvalAuditId: plan.approval.auditId, fenceFingerprint: proof.fingerprint }, MAX, true);
  return { intent: { id, ...record }, request: plan.replacementRequest, risk: riskView(store, saved) };
}

export function riskRetirementStatus(store, parent) {
  if (!parent.retirement) return {};
  const { plan, ctx } = load(store, parent.retirement.riskPlanId);
  if (ctx !== parent.binding.contextId || plan.dispositionId !== parent.id || plan.binding.intentId !== parent.binding.intentId) denied();
  const proof = inspectFenceAuthority(plan, store.fenceAuthority, store.now());
  return { riskPlanId: plan.id, replacementJobId: parent.retirement.replacementJobId, replacementIntentId: parent.retirement.replacementIntentId,
    remoteFenceConfirmed: proof.confirmed, historicalOutcome: "unknown", replacementAllowed: false };
}

export function replacementAdmission(store, instanceId, admission = {}) {
  const request = admission.request || {}, identity = admission.identity || request;
  if (!identity.jobId || typeof identity.jobId !== "string") return false;
  const gate = store.get("replacement_gate", store.hash("replacement-gate", instanceId, identity.jobId), "", "");
  if (!gate) return false;
  const { plan } = load(store, gate.riskPlanId, gate.ctx, gate.scope);
  const proof = requireFenceAuthority(plan, store);
  if (!plan.approval || proof.fingerprint !== plan.approval.fenceFingerprint || store.now() >= plan.approval.validUntil ||
      plan.binding.instanceId !== instanceId || admission.ctx && admission.ctx !== gate.ctx) denied("BUSINESS_REPLACEMENT_APPROVAL_EXPIRED");
  if (admission.route === "/mongodb/bulk/prepare") {
    const candidate = admission.dispatchDigest || prepareRequestDigest(wire({ ...request, instanceId }));
    return [plan.requestDigest, plan.sealDigest].includes(candidate);
  }
  return ["/mongodb/bulk/execute", "/mongodb/bulk/rollback", "/mongodb/bulk/control"].includes(admission.route) &&
    /^[a-f0-9]{64}$/.test(gate.planHash || "") && identity.planHash === gate.planHash;
}
export function recordReplacementPrepared(store, record, result) {
  const instanceId = record.identity?.instanceId, jobId = record.identity?.jobId;
  if (!instanceId || !jobId || !record.bulkChunk) return;
  const gateId = store.hash("replacement-gate", instanceId, jobId), gate = store.get("replacement_gate", gateId, "", "");
  if (!gate) return;
  const { plan, ctx, scope } = load(store, gate.riskPlanId, gate.ctx, gate.scope);
  if (!record.bulkChunk.endOfUpload) {
    if (record.bulkPrepare.requestDigest !== plan.requestDigest) denied();
    const firstUploadAuditId = audit(store, "risk_replacement_uploaded", plan, ctx, scope, { chunkHash: result.chunkHash });
    store.put("risk_replacement", plan.id, ctx, scope, { ...plan, state: plan.planHash ? "prepared" : "uploaded", firstUploadAuditId }, MAX, true);
    return;
  }
  if (record.bulkPrepare.requestDigest !== plan.sealDigest || !HASH.test(result.planHash || "") || gate.planHash && gate.planHash !== result.planHash) denied();
  store.put("replacement_gate", gateId, "", "", { ...gate, planHash: result.planHash }, MAX, true);
  const auditId = audit(store, "risk_replacement_prepared_remotely", plan, ctx, scope, { planHash: result.planHash });
  store.put("risk_replacement", plan.id, ctx, scope, { ...plan, state: "prepared", planHash: result.planHash, preparedAuditId: auditId }, MAX, true);
}
