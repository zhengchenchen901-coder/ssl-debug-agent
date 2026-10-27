import { privacyError } from "./privacy-key.js";
import { prepareRequestDigest as digest, IMPORT_PREPARE_ROUTE as ROUTE, importPreparePayload } from "../plugins/remote-debug-agent/prepare-protocol.js";

// Import identities have their own namespace. No synthetic bulk job/chunk exists.
const MAX = Number.MAX_SAFE_INTEGER;
const POLICY = "human-risk-acceptance-v2";
const CONFIRM = "我接受历史结果未知的风险，并批准建立此替代任务";
const fail = (code = "BUSINESS_REPLACEMENT_DENIED") => { throw privacyError(code); };
const key = (store, kind, instanceId, database, id) => store.hash("risk-import-" + kind, instanceId, database, id);
function load(store, id) {
  const row = store.db.prepare("SELECT * FROM records WHERE kind='risk_replacement' AND id=?").get(id);
  if (!row) fail();
  const plan = store.open(row);
  if (plan.kind !== "import") fail();
  return { plan, ctx: row.ctx, scope: row.scope };
}
function current(store, plan, ctx, scope) {
  const record = store.get("operation", plan.binding.intentId, ctx, scope);
  if (record?.state !== "uncertain" || store.hash("operation-record", ctx, plan.targetScope, plan.binding.intentId, record) !== plan.recordFingerprint) fail("BUSINESS_REPLACEMENT_STALE");
}
function event(store, type, plan, ctx, scope, details = {}) {
  const id = store.hash("risk-import-audit", type, plan.id, details);
  if (!store.get("event", id, ctx, scope)) store.put("event", id, ctx, scope,
    { type, riskPlanId: plan.id, dispositionId: plan.dispositionId, binding: plan.binding,
      requestDigest: plan.requestDigest, historicalOutcome: "unknown", at: store.now(), ...details }, MAX, true);
  return id;
}
const candidateKey = (store, plan) => key(store, "candidate", plan.binding.instanceId, plan.binding.database, plan.replacementRequest.importId);
const retirementKey = (store, plan) => key(store, "retirement", plan.binding.instanceId, plan.binding.database, plan.binding.importId);
const gateKey = (store, plan) => key(store, "gate", plan.binding.instanceId, plan.binding.database, plan.replacementRequest.importId);
function reviewHash(store, plan) {
  return store.hash("risk-import-human-review-v2", plan.id, plan.recordFingerprint, plan.expiresAt,
    plan.requestDigest, plan.effectDigest, plan.originalBatches, plan.replacementBatches, plan.observations, plan.reviewMemo, plan.approvalPolicy);
}
export function importRiskView(store, plan) {
  const { ctx, scope } = load(store, plan.id);
  const parent = store.get("disposition", plan.dispositionId, ctx, scope);
  let unchanged = true; try { current(store, plan, ctx, scope); } catch { unchanged = false; }
  const candidate = store.get("risk_import_candidate", candidateKey(store, plan), "", "");
  const eligible = candidate?.riskPlanId === plan.id && unchanged && (parent?.state === "review_required" ||
    parent?.state === "quarantined" || ["termination_requested", "retired_unknown"].includes(parent?.state) && parent.retirement?.riskPlanId === plan.id);
  return { ok: true, kind: "import", riskPlanId: plan.id, dispositionId: plan.dispositionId, binding: plan.binding,
    state: plan.state, replacementImportId: plan.replacementRequest.importId, replacementIntentId: plan.replacementIntentId,
    replacementRequestDigest: plan.requestDigest, effectDigest: plan.effectDigest,
    originalBatches: plan.originalBatches, replacementBatches: plan.replacementBatches, batchCount: plan.replacementBatches.length,
    documentCount: plan.replacementRequest.documents.length, collections: [plan.replacementRequest.collection], atomicity: "per_batch",
    reviewHash: reviewHash(store, plan), createdAt: plan.createdAt, expiresAt: plan.expiresAt, approvalPolicy: POLICY,
    approvalAuthority: "independent-human-administrator", confirmation: CONFIRM, historicalOutcome: "unknown", legacyInFlightOutcome: "unknown",
    humanApproved: !!plan.approval, humanConfirmationRequired: !plan.approval,
    canApprove: eligible && !plan.approval && store.now() < plan.expiresAt,
    replacementAllowed: eligible && !!plan.approval && store.now() < plan.approval.validUntil,
    remoteFenceConfirmed: false, remoteTermination: plan.remoteRetirement ? "recorded" : "pending",
    originalTaskState: parent?.retirement?.riskPlanId === plan.id ? "terminated_unknown" : "protected_unknown",
    acceptedResidualRisk: !!plan.approval, reviewMemo: plan.reviewMemo, memoSource: "caller_statement_not_verified_evidence",
    observations: plan.observations, historicalEvidenceGaps: parent?.missingRequirements || [], batches: plan.preparedBatches || [],
    warning: "历史导入及在途事务结果未知。人工接受迟到提交、重复导入和部分批次成功风险，不证明未执行。每批独立确认、事务及回滚；已有文档不证明本任务所有权。",
    auditId: plan.auditId, approvalAuditId: plan.approval?.auditId, creationAuditId: plan.creationAuditId };
}
export function prepareImportRisk(store, input, ctx, scope) {
  return store.transaction(() => {
    const parent = store.get("disposition", input.dispositionId, ctx, scope), a = input.originalRequest, b = input.replacementRequest;
    const { importId: _a, ...effectA } = a || {}, { importId: _b, ...effectB } = b || {};
    if (!parent || parent.binding.kind !== "import" || parent.binding.contextId !== ctx || input.reviewHash !== parent.reviewHash ||
        !a || !b || a.instanceId !== parent.binding.instanceId || a.database !== parent.binding.database ||
        digest(a) !== parent.binding.requestDigest || store.hash("operation", ctx, input.scope, ROUTE, a) !== parent.binding.intentId ||
        a.importId !== parent.binding.importId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(b.importId || "") || a.importId === b.importId ||
        digest(effectA) !== digest(effectB) || !input.originalBatches?.length || !input.replacementBatches?.length) fail();
    const id = store.hash("risk-import-human-v2", ctx, input.scope, parent.id, digest(b), parent.recordFingerprint, input.reviewMemo || "");
    const old = store.get("risk_replacement", id, ctx, scope);
    if (old && (JSON.stringify(old.originalBatches) !== JSON.stringify(input.originalBatches) || JSON.stringify(old.replacementBatches) !== JSON.stringify(input.replacementBatches))) fail("BUSINESS_REPLACEMENT_STALE");
    if (old && store.now() < (old.approval?.validUntil || old.expiresAt)) return importRiskView(store, old);
    const plan = { ...old, id, kind: "import", approvalPolicy: POLICY, dispositionId: parent.id, binding: parent.binding,
      targetScope: input.scope, recordFingerprint: parent.recordFingerprint, originalRequest: a, replacementRequest: b,
      requestDigest: digest(b), effectDigest: digest(effectA), originalBatches: input.originalBatches, replacementBatches: input.replacementBatches,
      reviewMemo: input.reviewMemo || "", observations: input.observations, state: "awaiting_human", approval: undefined,
      createdAt: old?.createdAt || store.now(), expiresAt: store.now() + 3600000 };
    current(store, plan, ctx, scope);
    for (const [kind, k] of [["risk_import_candidate", candidateKey(store, plan)], ["risk_import_gate", gateKey(store, plan)]]) {
      const existing = store.get(kind, k, "", "");
      if (existing && existing.riskPlanId !== id) fail("BUSINESS_REPLACEMENT_JOB_CONFLICT");
    }
    const retired = store.get("risk_import_retirement", retirementKey(store, plan), "", "");
    if (retired && retired.riskPlanId !== id) fail("BUSINESS_REPLACEMENT_JOB_CONFLICT");
    plan.auditId = event(store, "risk_import_prepared", plan, ctx, scope, { revision: store.now() });
    store.put("risk_replacement", id, ctx, scope, plan, MAX, true);
    store.put("risk_import_candidate", candidateKey(store, plan), "", "", { riskPlanId: id, ctx, scope }, MAX, true);
    for (const batch of plan.replacementBatches) {
      const k = key(store, "batch", b.instanceId, "", batch.mutationId), existing = store.get("risk_import_batch", k, "", "");
      if (existing && existing.riskPlanId !== id) fail("BUSINESS_REPLACEMENT_JOB_CONFLICT");
      store.put("risk_import_batch", k, "", "", { riskPlanId: id, role: "replacement", ctx, scope }, MAX, true);
    }
    return importRiskView(store, plan);
  });
}
export function importHumanAction(store, action, input, found) {
  const { plan, ctx, scope } = found;
  if (plan.binding.instanceId !== input.instanceId) fail();
  if (action === "human_risk_context") return { targetScope: plan.targetScope, database: plan.binding.database };
  if (input.targetScope !== plan.targetScope) fail();
  if (action === "human_risk_view") return importRiskView(store, plan);
  return store.transaction(() => {
    if (input.confirmation !== CONFIRM || input.reviewHash !== reviewHash(store, plan) || typeof input.actor?.username !== "string" || !input.actor.username || typeof input.actor?.sessionId !== "string" || !input.actor.sessionId ||
        !Number.isSafeInteger(input.actor.verifiedAt) || input.actor.verifiedAt > store.now() || store.now() - input.actor.verifiedAt > 60000) fail();
    if (plan.approval) { requireApproval(store, plan, input, ctx, scope); return importRiskView(store, plan); }
    if (!importRiskView(store, plan).canApprove) fail("BUSINESS_REPLACEMENT_STALE");
    const retired = store.get("risk_import_retirement", retirementKey(store, plan), "", "");
    if (retired && retired.riskPlanId !== plan.id) fail("BUSINESS_REPLACEMENT_JOB_CONFLICT");
    const approval = { ...input.actor, reviewHash: input.reviewHash, policy: POLICY, validUntil: Math.min(plan.expiresAt, store.now() + 900000) };
    approval.auditId = event(store, "risk_import_human_approved", plan, ctx, scope, approval);
    const retirement = { riskPlanId: plan.id, replacementImportId: plan.replacementRequest.importId, approvalAuditId: approval.auditId, at: store.now() };
    store.put("risk_import_retirement", retirementKey(store, plan), "", "", { ...retirement, database: plan.binding.database, importId: plan.binding.importId }, MAX, true);
    for (const batch of plan.originalBatches) store.put("risk_import_batch", key(store, "batch", plan.binding.instanceId, "", batch.mutationId), "", "",
      { riskPlanId: plan.id, role: "original", ctx, scope }, MAX, true);
    const parent = store.get("disposition", plan.dispositionId, ctx, scope);
    if (parent.state !== "retired_unknown") store.put("disposition", parent.id, ctx, scope, { ...parent, state: "termination_requested", retirement }, MAX, true);
    const taskId = store.hash("task", ctx, plan.targetScope, "operation:" + plan.binding.intentId), task = store.get("task", taskId, ctx, scope);
    if (task) store.put("task", taskId, ctx, scope, { ...task, active: false, status: "terminated_unknown" }, MAX, true);
    const saved = { ...plan, state: "human_approved", approval };
    store.put("risk_replacement", plan.id, ctx, scope, saved, MAX, true);
    return importRiskView(store, saved);
  });
}
function requireApproval(store, plan, input, ctx, scope) {
  if (plan.approval?.policy !== POLICY || input.reviewHash !== plan.approval.reviewHash) fail("BUSINESS_REPLACEMENT_HUMAN_CONFIRMATION_REQUIRED");
  if (store.now() >= plan.approval.validUntil) fail("BUSINESS_REPLACEMENT_APPROVAL_EXPIRED");
  current(store, plan, ctx, scope);
  if (store.get("risk_import_retirement", retirementKey(store, plan), "", "")?.riskPlanId !== plan.id) fail("BUSINESS_REPLACEMENT_JOB_CONFLICT");
}
export function importRiskAction(store, action, input, found) {
    const { plan, ctx, scope } = found;
    if (plan.targetScope !== input.scope) fail();
    if (action === "inspect_risk_replacement") return importRiskView(store, plan);
    requireApproval(store, plan, input, ctx, scope);
    const request = { database: plan.binding.database, importId: plan.binding.importId, replacementImportId: plan.replacementRequest.importId,
      riskPlanId: plan.id, dispositionId: plan.dispositionId, originalRequestDigest: plan.binding.requestDigest,
      replacementRequestDigest: plan.requestDigest, approvalAuditId: plan.approval.auditId,
      originalBatches: plan.originalBatches, replacementBatches: plan.replacementBatches };
    if (action === "risk_handoff_context") return { required: true, route: "/mongodb/imports/retire", request };
    if (action === "record_risk_retirement") {
      const result = input.result;
      if (result?.ok !== true || result.status !== "terminated_unknown" || result.managedAdmissionClosed !== true ||
          result.riskPlanId !== plan.id || result.originalRequestDigest !== plan.binding.requestDigest || result.replacementRequestDigest !== plan.requestDigest ||
          result.importId !== plan.binding.importId || result.replacementImportId !== plan.replacementRequest.importId ||
          result.database !== plan.binding.database || result.dispositionId !== plan.dispositionId || result.approvalAuditId !== plan.approval.auditId ||
          JSON.stringify(result.originalBatches) !== JSON.stringify(plan.originalBatches) || JSON.stringify(result.replacementBatches) !== JSON.stringify(plan.replacementBatches) ||
          !/^[a-f0-9]{64}$/.test(result.controlRecordDigest || "")) fail("BUSINESS_REPLACEMENT_TERMINATION_REQUIRED");
      const saved = { ...plan, remoteRetirement: { ...request, controlRecordDigest: result.controlRecordDigest, recordedAt: store.now() } };
      store.put("risk_replacement", plan.id, ctx, scope, saved, MAX, true);
      event(store, "risk_import_remote_retirement", saved, ctx, scope, { controlRecordDigest: result.controlRecordDigest });
      return { ok: true };
    }
    if (!plan.remoteRetirement) fail("BUSINESS_REPLACEMENT_TERMINATION_REQUIRED");
    const id = store.hash("operation", ctx, plan.targetScope, ROUTE, plan.replacementRequest);
    const previousRecord = store.get("operation", id, ctx, scope);
    const previous = previousRecord && continuePartialImport(store, id, previousRecord, ctx, scope), gate = store.get("risk_import_gate", gateKey(store, plan), "", "");
    if (previous && !gate || gate && gate.riskPlanId !== plan.id) fail("BUSINESS_REPLACEMENT_JOB_CONFLICT");
    if (previous?.state === "rejected_before_dispatch") {
      const evidenceId = store.hash("import-attempt", ctx, plan.targetScope, id, previous.importPrepare.attempt);
      if (!store.get("import_prepare_evidence", evidenceId, ctx, scope)) store.put("import_prepare_evidence", evidenceId, ctx, scope, { intentId: id, ...previous }, MAX, true);
    }
    const record = previous && previous.state !== "rejected_before_dispatch" ? previous : { route: ROUTE, state: "uncertain", started: store.now(), identity: { instanceId: plan.binding.instanceId,
      database: plan.binding.database, collection: plan.binding.collection, importId: plan.replacementRequest.importId }, importPrepare: { binding: id, requestDigest: plan.requestDigest, attempt: (previous?.importPrepare?.attempt || 0) + 1 },
      importBatches: plan.replacementBatches, riskPlanId: plan.id };
    if (!previous || previous.state === "rejected_before_dispatch" || previous !== previousRecord) store.put("operation", id, ctx, scope, record, MAX, true);
    const taskId = store.hash("task", ctx, plan.targetScope, "operation:" + id), oldTask = store.hash("task", ctx, plan.targetScope, "operation:" + plan.binding.intentId);
    store.put("task", taskId, ctx, scope, { id: "operation:" + id, active: record.state === "uncertain", expires: MAX }, MAX, true);
    store.db.prepare("INSERT OR IGNORE INTO links SELECT ctx,scope,?,ref FROM links WHERE ctx=? AND scope=? AND task=?").run(taskId, ctx, scope, oldTask);
    const creationAuditId = plan.creationAuditId || event(store, "risk_import_creation_reserved", plan, ctx, scope, { replacementIntentId: id, approvalAuditId: plan.approval.auditId });
    const saved = { ...plan, state: record.state === "complete" ? "prepared" : "creating", creationAuditId, replacementIntentId: id };
    store.put("risk_replacement", plan.id, ctx, scope, saved, MAX, true);
    store.put("risk_import_gate", gateKey(store, plan), "", "", { riskPlanId: plan.id, ctx, scope }, MAX, true);
    const parent = store.get("disposition", plan.dispositionId, ctx, scope);
    store.put("disposition", parent.id, ctx, scope, { ...parent, state: "retired_unknown", retirement: { ...parent.retirement, replacementIntentId: id } }, MAX, true);
    return { intent: { id, ...record }, request: plan.replacementRequest, risk: importRiskView(store, saved) };
}
export function importReplacementAdmission(store, instanceId, admission) {
  const request = admission.request || admission.identity || {}, database = request.database || (() => { try { return JSON.parse(admission.scope).database; } catch { return undefined; } })();
  if (!database || typeof request.importId !== "string") return false;
  const gate = store.get("risk_import_gate", key(store, "gate", instanceId, database, request.importId), "", "");
  if (!gate) return false;
  const { plan } = load(store, gate.riskPlanId);
  if (admission.ctx && admission.ctx !== gate.ctx) return false;
  return admission.route === ROUTE && !!plan.approval && store.now() < plan.approval.validUntil &&
    (admission.dispatchDigest || digest(importPreparePayload({ ...request, instanceId, database }))) === plan.requestDigest;
}
export function assertImportAdmission(store, instanceId, admission) {
  const request = admission.request || admission.identity || {};
  let database = request.database;
  if (!database && admission.scope) { try { database = JSON.parse(admission.scope).database; } catch {} }
  const found = typeof request.mutationId === "string" && store.get("risk_import_batch", key(store, "batch", instanceId, "", request.mutationId), "", "");
  if (found) {
    const { plan } = load(store, found.riskPlanId);
    if (database && plan.binding.database !== database) fail("BUSINESS_REPLACEMENT_NOT_ADMITTED");
    if (found.role === "original") fail("BUSINESS_ORIGINAL_JOB_TERMINATED");
    const batch = plan.preparedBatches?.find(b => b.mutationId === request.mutationId);
    if (!batch || batch.planHash !== request.planHash || !plan.approval || store.now() >= plan.approval.validUntil ||
        admission.ctx && admission.ctx !== found.ctx ||
        !["/mongodb/mutations/execute", "/mongodb/mutations/rollback"].includes(admission.route)) fail("BUSINESS_REPLACEMENT_NOT_ADMITTED");
    return true;
  }
  if (!request.importId || !database) return false;
  if (store.get("risk_import_retirement", key(store, "retirement", instanceId, database, request.importId), "", "")) fail("BUSINESS_ORIGINAL_JOB_TERMINATED");
  const candidate = store.get("risk_import_candidate", key(store, "candidate", instanceId, database, request.importId), "", "");
  if (candidate && !importReplacementAdmission(store, instanceId, admission)) fail("BUSINESS_REPLACEMENT_NOT_ADMITTED");
  return !!candidate;
}
// A terminal partial preparation may continue with the identical input and
// identity. Keep its full evidence pinned before advancing the delivery attempt.
export function continuePartialImport(store, id, record, ctx, scope) {
  if (record.state !== "complete" || record.result?.status !== "prepare_partial") return record;
  const attempt = record.importPrepare.attempt;
  const evidenceId = store.hash("import-prepare-evidence", ctx, scope, id, attempt);
  store.put("import_prepare_evidence", evidenceId, ctx, scope, { intentId: id, attempt, result: record.result, at: store.now() }, MAX, true);
  return { ...record, state: "uncertain", importPrepare: { ...record.importPrepare, attempt: attempt + 1 },
    dispatched: undefined, operationId: undefined, result: undefined, reconciliation: undefined };
}
export function recordImportPrepared(store, record, result) {
  if (!record.riskPlanId) return;
  const { plan, ctx, scope } = load(store, record.riskPlanId);
  const batches = result.batches.map(({ mutationId, planHash, batchIndex, status }) => ({ mutationId, planHash, batchIndex, status }));
  const saved = { ...plan, state: result.status === "prepared" ? "prepared" : "prepare_partial", preparedBatches: batches };
  saved.preparedAuditId = event(store, "risk_import_prepared_remotely", plan, ctx, scope, { batches });
  store.put("risk_replacement", plan.id, ctx, scope, saved, MAX, true);
}
