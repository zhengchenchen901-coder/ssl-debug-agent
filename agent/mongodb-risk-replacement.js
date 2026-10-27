import { prepareImportRisk, importRiskView, importHumanAction, importRiskAction, importReplacementAdmission, assertImportAdmission } from "./mongodb-import-risk.js";
import { privacyError } from "./privacy-key.js";
import { bulkPreparePayload, prepareRequestDigest } from "../plugins/remote-debug-agent/prepare-protocol.js";
import { digest, fenceChallenge, inspectFenceAuthority, requireFenceAuthority } from "./mongodb-fence-authority.js";

export const RISK_CONFIRMATION = "我接受历史结果未知的风险，并批准建立此替代任务";
export const HUMAN_RISK_POLICY = "human-risk-acceptance-v2";
const humanPolicy = plan => plan.approvalPolicy === HUMAN_RISK_POLICY;
const retirementKey = (store, plan) => store.hash("risk-job-retirement", plan.binding.instanceId, plan.binding.jobId);
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
  if (humanPolicy(plan)) return store.hash("risk-human-review-v2", plan.id, plan.requestDigest, plan.sealDigest, plan.recordFingerprint, plan.expiresAt, plan.reviewMemo, plan.observations, plan.approvalPolicy);
  return store.hash("risk-human-review", plan.id, plan.requestDigest, plan.sealDigest, plan.recordFingerprint, plan.expiresAt, proof.fingerprint || null);
}
export function riskView(store, plan) {
  if (plan.kind === "import") return importRiskView(store, plan);
  const proof = humanPolicy(plan) ? { confirmed: false, reason: "human_risk_acceptance_no_external_attestation" } : inspectFenceAuthority(plan, store.fenceAuthority, store.now());
  const approved = !!plan.approval;
  const human = humanPolicy(plan);
  const scope = store.hash("scope", plan.targetScope), parent = store.get("disposition", plan.dispositionId, plan.binding.contextId, scope);
  const original = store.get("operation", plan.binding.intentId, plan.binding.contextId, scope);
  const originalUnchanged = original?.state === "uncertain" && store.hash("operation-record", plan.binding.contextId, plan.targetScope, plan.binding.intentId, original) === plan.recordFingerprint;
  const candidateEligible = !human || store.get("risk_candidate", store.hash("risk-candidate", plan.binding.instanceId, plan.replacementRequest.jobId), "", "")?.riskPlanId === plan.id;
  const parentEligible = human && parent?.state === "review_required" || human && parent?.state === "termination_requested" && parent.retirement?.riskPlanId === plan.id || parent?.state === "quarantined" || parent?.state === "retired_unknown" && parent.retirement?.riskPlanId === plan.id;
  return { ok: true, riskPlanId: plan.id, dispositionId: plan.dispositionId, state: plan.state,
    binding: plan.binding, replacementJobId: plan.replacementRequest.jobId,
    replacementRequestDigest: plan.requestDigest, sealRequestDigest: plan.sealDigest, effectDigest: plan.effectDigest,
    reviewHash: humanHash(store, plan, proof), createdAt: plan.createdAt, expiresAt: plan.expiresAt,
    historicalOutcome: "unknown", risk: "possible_prior_commit_or_unobserved_rollback_duplicate_compensation_risk",
    confirmation: RISK_CONFIRMATION, humanConfirmationRequired: !approved, humanApproved: approved,
    canApprove: (human || proof.confirmed) && parentEligible && candidateEligible && originalUnchanged && plan.state === "awaiting_human" && store.now() < plan.expiresAt,
    remoteFenceConfirmed: proof.confirmed, fenceReason: proof.reason, fenceReceiptId: proof.receiptId,
    fenceFingerprint: proof.fingerprint, fenceValidUntil: proof.validUntil,
    approvalPolicy: plan.approvalPolicy || "external-fence-v1", approvalAuthority: human ? "independent-human-administrator" : "external-fence-and-human",
    reviewMemo: plan.reviewMemo || "", memoSource: "caller_statement_not_verified_evidence", observations: plan.observations,
    acceptedResidualRisk: human && approved, legacyInFlightOutcome: "unknown",
    originalTaskState: parent?.retirement?.riskPlanId === plan.id ? "terminated_unknown" : "protected_unknown",
    terminationScope: "managed_job_admissions_and_cooperative_workers",
    remoteTermination: plan.remoteRetirement ? "recorded" : "pending",
    warning: "历史结果未知；当前数据不变不能证明从未执行。人工批准接受旧进程迟到、事务结果未知及重复补偿风险；不代表全局撤权或证明未执行。",
    replacementAllowed: approved && parentEligible && originalUnchanged && (human || proof.confirmed && plan.approval.fenceFingerprint === proof.fingerprint) && store.now() < plan.approval.validUntil,
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
  if (action === "prepare_risk_replacement" && input.originalRequest?.importId !== undefined) return prepareImportRisk(store, input, ctx, scope);
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
    const approvalPolicy = store.riskPolicy === "external-fence-v1" ? "external-fence-v1" : HUMAN_RISK_POLICY;
    const reviewMemo = input.reviewMemo || "";
    if (typeof reviewMemo !== "string" || reviewMemo.length > 4000) denied();
    const id = store.hash(approvalPolicy === HUMAN_RISK_POLICY ? "human-risk-replacement-v2" : "risk-replacement", ctx, input.scope, parent.id, prepareRequestDigest(request), parent.recordFingerprint, ...(approvalPolicy === HUMAN_RISK_POLICY ? [reviewMemo] : []));
    if (existingGate && existingGate.riskPlanId !== id) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
    const old = store.get("risk_replacement", id, ctx, scope);
    if (old && (old.approval ? store.now() < old.approval.validUntil : store.now() < old.expiresAt)) return riskView(store, old);
    const plan = { id, approvalPolicy, reviewMemo, observations: input.observations, dispositionId: parent.id, state: "awaiting_human", binding: parent.binding,
      targetScope: input.scope, recordFingerprint: parent.recordFingerprint, replacementRequest: request,
      requestDigest: prepareRequestDigest(request), sealRequest: seal, sealDigest: prepareRequestDigest(seal),
      effectDigest: digest(effects(original, original.jobId)), createdAt: old?.createdAt || store.now(), expiresAt: store.now() + 3600000,
      ...(old?.creationAuditId ? { creationAuditId: old.creationAuditId, replacementIntentId: old.replacementIntentId, planHash: old.planHash, remoteRetirement: old.remoteRetirement } : {}) };
    originalCurrent(store, plan, ctx, scope);
    plan.auditId = audit(store, "risk_replacement_prepared", plan, ctx, scope, { revision: store.now() });
    store.put("risk_replacement", id, ctx, scope, plan, MAX, true);
    if (humanPolicy(plan)) {
      const candidateKey = store.hash("risk-candidate", plan.binding.instanceId, request.jobId);
      const prior = store.get("risk_candidate", candidateKey, "", "");
      if (prior && prior.riskPlanId !== id) {
        const other = load(store, prior.riskPlanId).plan;
        if (other.approval || other.creationAuditId) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
      }
      store.put("risk_candidate", candidateKey, "", "", { riskPlanId: id, ctx, scope }, MAX, true);
    }
    return riskView(store, plan);
  });
  if (["inspect_risk_replacement", "create_risk_replacement", "risk_handoff_context", "record_risk_retirement"].includes(action)) return store.transaction(() => {
    const found = load(store, input.riskPlanId, ctx, scope), { plan } = found;
    if (plan.kind === "import") return importRiskAction(store, action, input, found);
    if (plan.targetScope !== input.scope) denied();
    if (action === "inspect_risk_replacement") return riskView(store, plan);
    if (action === "risk_handoff_context" || action === "record_risk_retirement") {
      if (!humanPolicy(plan)) return { required: false };
      requireHumanApproval(store, plan, input, ctx, scope);
      const request = { jobId: plan.binding.jobId, replacementJobId: plan.replacementRequest.jobId,
        riskPlanId: plan.id, dispositionId: plan.dispositionId, originalRequestDigest: plan.binding.requestDigest,
        replacementRequestDigest: plan.requestDigest, approvalAuditId: plan.approval.auditId };
      if (action === "risk_handoff_context") return { required: true, request };
      const result = input.result;
      if (!result || result.status !== "terminated_unknown" || result.managedAdmissionClosed !== true || !HASH.test(result.controlRecordDigest || "") ||
          Object.entries(request).some(([key, value]) => key !== "approvalAuditId" && result[key] !== value)) denied("BUSINESS_REPLACEMENT_TERMINATION_REQUIRED");
      const saved = { ...plan, remoteRetirement: { ...request, recordedAt: store.now(), originalJobFound: result.originalJobFound === true,
        legacyInFlightOutcome: "unknown", controlRecordDigest: result.controlRecordDigest } };
      store.put("risk_replacement", plan.id, ctx, scope, saved, MAX, true);
      audit(store, "risk_original_remote_termination_recorded", saved, ctx, scope, saved.remoteRetirement);
      return { ok: true };
    }
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
  if (found.plan.kind === "import") return importHumanAction(store, action, input, found);
  if (found.plan.binding.instanceId !== input.instanceId) denied();
  if (action === "human_risk_context") return { targetScope: found.plan.targetScope, database: found.plan.binding.database };
  return store.transaction(() => {
    const { plan, ctx, scope } = load(store, input.riskPlanId);
    if (plan.targetScope !== input.targetScope || plan.binding.instanceId !== input.instanceId) denied();
    if (action === "human_risk_view") return riskView(store, plan);
    if (input.confirmation !== RISK_CONFIRMATION || typeof input.actor?.username !== "string" || !input.actor.username ||
        typeof input.actor.sessionId !== "string" || !input.actor.sessionId || !Number.isSafeInteger(input.actor.verifiedAt) ||
        input.actor.verifiedAt > store.now() || store.now() - input.actor.verifiedAt > 60000) denied();
    const proof = humanPolicy(plan) ? {} : requireFenceAuthority(plan, store);
    if (input.reviewHash !== humanHash(store, plan, proof)) denied("BUSINESS_REPLACEMENT_STALE");
    if (plan.approval) {
      if (plan.approval.reviewHash !== input.reviewHash || store.now() >= plan.approval.validUntil) denied("BUSINESS_REPLACEMENT_APPROVAL_EXPIRED");
      return riskView(store, plan);
    }
    if (store.now() >= plan.expiresAt) denied("BUSINESS_REPLACEMENT_REVIEW_EXPIRED");
    originalCurrent(store, plan, ctx, scope);
    if (humanPolicy(plan) && store.get("risk_candidate", store.hash("risk-candidate", plan.binding.instanceId, plan.replacementRequest.jobId), "", "")?.riskPlanId !== plan.id) denied("BUSINESS_REPLACEMENT_STALE");
    const parent = store.get("disposition", plan.dispositionId, ctx, scope);
    if (!(humanPolicy(plan) && ["review_required", "termination_requested"].includes(parent?.state) || parent?.state === "quarantined" || parent?.state === "retired_unknown" && parent.retirement?.riskPlanId === plan.id)) denied("BUSINESS_REPLACEMENT_QUARANTINE_REQUIRED");
    const gateId = store.hash("replacement-gate", plan.binding.instanceId, plan.replacementRequest.jobId);
    const gate = store.get("replacement_gate", gateId, "", "");
    if (gate && gate.riskPlanId !== plan.id) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
    const approval = { ...input.actor, reviewHash: input.reviewHash, fenceFingerprint: proof.fingerprint,
      validUntil: Math.min(plan.expiresAt, proof.validUntil || MAX, store.now() + 900000), policy: plan.approvalPolicy, residualRiskAccepted: humanPolicy(plan) };
    approval.auditId = audit(store, "risk_replacement_human_approved", plan, ctx, scope, approval);
    const saved = { ...plan, state: "human_approved", approval };
    if (humanPolicy(plan)) {
      const key = retirementKey(store, plan), retired = store.get("risk_job_retirement", key, "", "");
      if (retired && retired.riskPlanId !== plan.id) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
      store.put("risk_job_retirement", key, "", "", { instanceId: plan.binding.instanceId, jobId: plan.binding.jobId,
        database: plan.binding.database, riskPlanId: plan.id, replacementJobId: plan.replacementRequest.jobId,
        dispositionId: parent.id, approvalAuditId: approval.auditId, historicalOutcome: "unknown", at: store.now() }, MAX, true);
      const taskId = store.hash("task", ctx, plan.targetScope, "operation:" + plan.binding.intentId);
      const task = store.get("task", taskId, ctx, scope);
      if (task) store.put("task", taskId, ctx, scope, { ...task, active: false, status: "terminated_unknown", replacementJobId: plan.replacementRequest.jobId }, MAX, true);
      if (parent.state !== "retired_unknown") store.put("disposition", parent.id, ctx, scope, { ...parent, state: "termination_requested",
        retirement: { riskPlanId: plan.id, replacementJobId: plan.replacementRequest.jobId, approvalAuditId: approval.auditId, at: store.now() } }, MAX, true);
    }
    store.put("risk_replacement", plan.id, ctx, scope, saved, MAX, true);
    if (gate) store.put("replacement_gate", gateId, "", "", { ...gate, approvalAuditId: approval.auditId, fenceFingerprint: proof.fingerprint }, MAX, true);
    // No replacement intent, remote job, grant or upload is created here.
    return riskView(store, saved);
  });
}
function requireHumanApproval(store, plan, input, ctx, scope) {
  if (!plan.approval || plan.approval.policy !== HUMAN_RISK_POLICY || input.reviewHash !== plan.approval.reviewHash) denied("BUSINESS_REPLACEMENT_HUMAN_CONFIRMATION_REQUIRED");
  if (store.now() >= plan.approval.validUntil) denied("BUSINESS_REPLACEMENT_APPROVAL_EXPIRED");
  originalCurrent(store, plan, ctx, scope);
  const retirement = store.get("risk_job_retirement", retirementKey(store, plan), "", "");
  if (retirement?.riskPlanId !== plan.id) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
}
function createReplacementIntent(store, plan, input, ctx, scope) {
  if (!plan.approval || input.reviewHash !== plan.approval.reviewHash) denied("BUSINESS_REPLACEMENT_HUMAN_CONFIRMATION_REQUIRED");
  if (humanPolicy(plan)) {
    requireHumanApproval(store, plan, input, ctx, scope);
    if (!plan.remoteRetirement) denied("BUSINESS_REPLACEMENT_TERMINATION_REQUIRED");
  }
  const proof = humanPolicy(plan) ? {} : requireFenceAuthority(plan, store);
  if (!humanPolicy(plan) && proof.fingerprint !== plan.approval.fenceFingerprint || store.now() >= plan.approval.validUntil) denied("BUSINESS_REPLACEMENT_APPROVAL_EXPIRED");
  originalCurrent(store, plan, ctx, scope);
  const parent = store.get("disposition", plan.dispositionId, ctx, scope);
  if (!(humanPolicy(plan) && parent?.state === "termination_requested" && parent.retirement?.riskPlanId === plan.id || parent?.state === "quarantined" || parent?.state === "retired_unknown" && parent.retirement?.riskPlanId === plan.id)) denied("BUSINESS_REPLACEMENT_QUARANTINE_REQUIRED");
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
  if (plan.kind === "import") return { riskPlanId: plan.id, replacementImportId: plan.replacementRequest.importId, historicalOutcome: "unknown", approvalPolicy: plan.approvalPolicy, acceptedResidualRisk: !!plan.approval, replacementAllowed: false, missingRequirements: plan.remoteRetirement ? [] : ["remote_managed_import_termination_pending"] };
  const proof = humanPolicy(plan) ? { confirmed: false, reason: "human_risk_acceptance_no_external_attestation" } : inspectFenceAuthority(plan, store.fenceAuthority, store.now());
  return { riskPlanId: plan.id, replacementJobId: parent.retirement.replacementJobId, replacementIntentId: parent.retirement.replacementIntentId,
    remoteFenceConfirmed: proof.confirmed, historicalOutcome: "unknown", replacementAllowed: false,
    ...(humanPolicy(plan) ? { approvalPolicy: plan.approvalPolicy, acceptedResidualRisk: true,
      missingRequirements: plan.remoteRetirement ? [] : ["remote_managed_job_termination_pending"],
      historicalEvidenceGaps: parent.missingRequirements.filter(x => /^(original_|historical_)/.test(x)) } : {}) };
}

export function replacementAdmission(store, instanceId, admission = {}) {
  if (importReplacementAdmission(store, instanceId, admission) || assertImportAdmission(store, instanceId, admission)) return true;
  const request = admission.request || {}, identity = admission.identity || request;
  if (!identity.jobId || typeof identity.jobId !== "string") return false;
  const gate = store.get("replacement_gate", store.hash("replacement-gate", instanceId, identity.jobId), "", "");
  if (!gate) return false;
  const { plan } = load(store, gate.riskPlanId, gate.ctx, gate.scope);
  const proof = humanPolicy(plan) ? {} : requireFenceAuthority(plan, store);
  if (!plan.approval || !humanPolicy(plan) && proof.fingerprint !== plan.approval.fenceFingerprint || store.now() >= plan.approval.validUntil ||
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

export function assertRiskJobAdmission(store, instanceId, admission = {}) {
  assertImportAdmission(store, instanceId, admission);
  const identity = admission.identity || admission.request || {};
  if (typeof identity.jobId !== "string") return;
  const retired = store.get("risk_job_retirement", store.hash("risk-job-retirement", instanceId, identity.jobId), "", "");
  if (retired) denied("BUSINESS_ORIGINAL_JOB_TERMINATED");
  const candidate = store.get("risk_candidate", store.hash("risk-candidate", instanceId, identity.jobId), "", "");
  if (candidate && !replacementAdmission(store, instanceId, admission)) denied("BUSINESS_REPLACEMENT_NOT_ADMITTED");
}
