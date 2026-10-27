import { privacyError } from "./privacy-key.js";
import { createHash } from "node:crypto";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const EXECUTION_RISK_POLICY = "human-execution-risk-v1";
export const EXECUTION_RISK_CONFIRMATION = "我接受此执行结果未知及迟到提交、重复和部分成功风险，并批准唯一接续计划";
const MAX = Number.MAX_SAFE_INTEGER;
const denied = (code = "BUSINESS_EXECUTION_RISK_DENIED") => { throw privacyError(code); };
const gateId = (s, instanceId, mutationId) => s.hash("execution-risk-gate", instanceId, mutationId);
function load(s, id, ctx, scope) {
  const row = s.db.prepare("SELECT * FROM records WHERE kind='execution_risk' AND id=?").get(id);
  if (!row || ctx && (ctx !== row.ctx || scope !== row.scope)) denied();
  return { p: s.open(row), ctx: row.ctx, scope: row.scope };
}
function audit(s, type, p, ctx, scope, details = {}) {
  const id = s.hash("execution-risk-audit", type, p.id, p.reviewHash, details);
  if (!s.get("event", id, ctx, scope)) s.put("event", id, ctx, scope,
    { type, reviewId: p.id, binding: p.binding, historicalOutcome: "unknown", at: s.now(), ...details }, MAX, true);
  return id;
}
function current(s, p, ctx, scope) {
  const old = s.get("operation", p.binding.intentId, ctx, scope);
  if (old?.state !== "uncertain" || s.hash("execution-risk-original", old) !== p.recordFingerprint) denied("BUSINESS_EXECUTION_RISK_STALE");
}
function view(s, p, human = false) {
  const c = p.proposal?.candidate;
  return { ok: true, kind: "import_execution", riskPlanId: p.id, reviewHash: p.reviewHash, state: p.state,
    approvalPolicy: EXECUTION_RISK_POLICY, approvalAuthority: "independent-human-administrator", binding: p.binding,
    historicalOutcome: "unknown", legacyInFlightOutcome: "unknown", humanApproved: !!p.approval,
    canApprove: !p.lateCommitted && p.state === "awaiting_human" && s.now() < p.binding.expiresAt,
    lateOriginalCommitObserved: !!p.lateCommitted, lateObservation: p.latestMachineObservation,
    expiresAt: p.binding.expiresAt, confirmation: EXECUTION_RISK_CONFIRMATION,
    proposalDigest: p.proposalDigest, originalStatus: p.proposal.originalStatus,
    originalCollectionIdentity: p.proposal.originalCollectionIdentity, collectionIdentity: p.proposal.collectionIdentity,
    mutationId: c.mutationId, planHash: c.planHash, documentCount: c.request.documents.length,
    effectDigest: digest({ documents: c.request.documents }), missingEvidence: p.proposal.missingEvidence,
    approvalAuditId: p.approval?.auditId, reservationAuditId: p.reservationAuditId, result: p.result,
    ...(human ? { orderedDocuments: JSON.stringify(c.request.documents), orderedRequest: JSON.stringify(c.request),
      knownExecution: p.original, lineage: p.lineage, prerequisiteSource: p.proposal.source } : {}),
    warning: "原执行结果仍未知；当前缺少文档不是历史未执行证明。接受历史进程迟到提交、重复、部分成功和唯一键冲突风险。只批准同一导入的一个接续计划；不证明安全终止、不授予历史所有权、不执行写入。新计划仍需独立精确业务确认；新未知不会自动重派。" };
}
export function executionRiskHumanAction(s, action, input) {
  if (typeof action !== "string" || !action.startsWith("human_execution_risk_")) return;
  const found = load(s, input.riskPlanId), { p, ctx, scope } = found;
  if (input.instanceId !== p.binding.instanceId) denied();
  if (action === "human_execution_risk_context") return { targetScope: p.targetScope, database: p.binding.database };
  if (input.targetScope !== p.targetScope) denied();
  if (action === "human_execution_risk_view") { current(s, p, ctx, scope); return view(s, p, true); }
  if (action !== "human_execution_risk_approve") denied();
  return s.transaction(() => {
    // Reload within BEGIN IMMEDIATE: concurrent native approvals cannot race.
    const { p } = load(s, input.riskPlanId);
    current(s, p, ctx, scope);
    if (p.lateCommitted) denied("BUSINESS_EXECUTION_RISK_STALE");
    if (input.reviewHash !== p.reviewHash || input.confirmation !== EXECUTION_RISK_CONFIRMATION ||
        !input.actor?.username || !input.actor.sessionId || !Number.isSafeInteger(input.actor.verifiedAt) ||
        input.actor.verifiedAt > s.now() || s.now() - input.actor.verifiedAt > 60000 || s.now() >= p.binding.expiresAt) denied();
    if (p.state !== "awaiting_human") return view(s, p, true);
    const approval = { ...input.actor, reviewHash: p.reviewHash, validUntil: p.binding.expiresAt };
    approval.auditId = audit(s, "execution_risk_human_approved", p, ctx, scope, approval);
    const saved = { ...p, state: "human_approved", approval };
    s.put("execution_risk", p.id, ctx, scope, saved, MAX, true);
    return view(s, saved, true);
  });
}
export function executionRiskStoreAction(s, action, input, ctx, scope) {
  if (action === "execution_risk_context") {
    const target = JSON.parse(input.scope), old = s.get("operation", input.id, ctx, scope);
    const row = s.db.prepare("SELECT * FROM records WHERE kind='risk_replacement' AND id=? AND ctx=? AND scope=?").get(input.riskPlanId, ctx, scope);
    const lineage = row && s.open(row), execution = old?.execution;
    const batch = lineage?.preparedBatches?.find(b => b.mutationId === old?.identity?.mutationId && b.planHash === old?.identity?.planHash);
    const originalBatch = lineage?.replacementBatches?.find(b => b.mutationId === batch?.mutationId);
    if (old?.state !== "uncertain" || old.route !== "/mongodb/mutations/execute" || !execution || execution.intentId !== input.id ||
        typeof execution.operationId !== "string" || !execution.operationId || lineage?.kind !== "import" || !lineage.creationAuditId ||
        !lineage.remoteRetirement || !batch || !originalBatch || old.identity.instanceId !== target.id ||
        lineage.targetScope !== input.scope || lineage.binding.database !== target.database || lineage.binding.instanceId !== target.id) denied();
    const id = s.hash("execution-risk", ctx, input.scope, input.id);
    const previous = s.get("execution_risk", id, ctx, scope);
    if (previous && (!["awaiting_human", "human_approved"].includes(previous.state) || s.now() < previous.binding.expiresAt)) return { existing: view(s, previous) };
    const binding = { reviewId: id, contextId: ctx, instanceId: target.id, database: target.database,
      collection: lineage.replacementRequest.collection, importId: lineage.replacementRequest.importId,
      riskPlanId: lineage.id, originalPrepareIntentId: lineage.binding.intentId, replacementPrepareIntentId: lineage.replacementIntentId,
      intentId: input.id, execution, attempt: old.executionAttempt || null, executionProtocol: old.executionProtocol || null,
      mutationId: batch.mutationId, planHash: batch.planHash, batchRequestDigest: originalBatch.requestDigest,
      expiresAt: s.now() + 900000 };
    return { binding, recordFingerprint: s.hash("execution-risk-original", old), original: old,
      lineage: { riskPlanId: lineage.id, originalImportId: lineage.binding.importId, replacementImportId: lineage.replacementRequest.importId,
        originalBatches: lineage.originalBatches, replacementBatches: lineage.replacementBatches, remoteRetirement: lineage.remoteRetirement } };
  }
  if (action === "execution_risk_prepare") return s.transaction(() => {
    const proposal = input.proposal, b = input.context.binding;
    if (!proposal || digest(proposal) !== input.proposalDigest || digest(proposal.binding) !== digest(b) ||
        proposal.candidate.executionContinuation?.binding?.reviewId !== b.reviewId ||
        proposal.candidate.request.database !== b.database || proposal.candidate.request.collection !== b.collection ||
        proposal.candidate.request.importId !== b.importId) denied();
    const p = { id: b.reviewId, binding: b, targetScope: input.scope, state: "awaiting_human", proposal,
      proposalDigest: input.proposalDigest, recordFingerprint: input.context.recordFingerprint, original: input.context.original, lineage: input.context.lineage };
    current(s, p, ctx, scope);
    const prior = s.get("execution_risk", p.id, ctx, scope);
    if (prior && !["awaiting_human", "human_approved"].includes(prior.state)) return view(s, prior);
    if (prior && s.now() < prior.binding.expiresAt) return view(s, prior);
    if (prior) s.put("execution_risk_revision", s.hash("execution-risk-revision", p.id, prior.reviewHash), ctx, scope, prior, MAX, true);
    p.reviewHash = s.hash("execution-risk-review", p);
    p.auditId = audit(s, "execution_risk_prepared", p, ctx, scope);
    s.put("execution_risk", p.id, ctx, scope, p, MAX, true);
    // Close only this original batch's managed writes, independently of old
    // prepare approval. Read-only machine reconciliation remains available.
    s.put("execution_risk_gate", gateId(s, b.instanceId, b.mutationId), "", "", { reviewId: p.id, ctx, scope, role: "original" }, MAX, true);
    return view(s, p);
  });
  if (!["execution_risk_inspect", "execution_risk_reserve", "execution_risk_result"].includes(action)) return;
  return s.transaction(() => {
    const { p } = load(s, input.riskPlanId, ctx, scope);
    if (action === "execution_risk_inspect") return view(s, p);
    if (input.reviewHash !== p.reviewHash || !p.approval) denied("BUSINESS_EXECUTION_RISK_HUMAN_REQUIRED");
    if (action === "execution_risk_reserve") {
      if (p.lateCommitted) denied("BUSINESS_EXECUTION_RISK_STALE");
      if (p.state === "prepared") return { ...view(s, p), done: true };
      if (p.state !== "reserved") {
        current(s, p, ctx, scope);
        if (s.now() >= p.approval.validUntil) denied("BUSINESS_EXECUTION_RISK_EXPIRED");
        p.state = "reserved";
        p.reservationAuditId = audit(s, "execution_risk_reserved", p, ctx, scope, { approvalAuditId: p.approval.auditId });
        s.put("execution_risk", p.id, ctx, scope, p, MAX, true);
      }
      return { binding: p.binding, proposalDigest: p.proposalDigest, approvalAuditId: p.approval.auditId };
    }
    if (p.state === "prepared") return view(s, p);
    const r = input.result, c = p.proposal.candidate;
    if (p.state !== "reserved" || r?.ok !== true || r.reviewId !== p.id || r.proposalDigest !== p.proposalDigest ||
        r.approvalAuditId !== p.approval.auditId || r.managedOriginalClosed !== true || r.historicalOutcome !== "unknown" ||
        r.mutationId !== c.mutationId || r.planHash !== c.planHash || r.database !== p.binding.database || r.collection !== p.binding.collection) denied();
    p.state = "prepared"; p.result = JSON.parse(JSON.stringify(r));
    p.completionAuditId = audit(s, "execution_risk_child_prepared", p, ctx, scope, { mutationId: r.mutationId, planHash: r.planHash });
    s.put("execution_risk", p.id, ctx, scope, p, MAX, true);
    s.put("execution_risk_gate", gateId(s, p.binding.instanceId, c.mutationId), "", "", { reviewId: p.id, ctx, scope, role: "child" }, MAX, true);
    return view(s, p);
  });
}
export function executionRiskAdmission(s, instanceId, admission) {
  const r = admission.request || admission.identity || {};
  const gate = s.get("execution_risk_gate", gateId(s, instanceId, r.mutationId), "", "");
  if (!gate) return false;
  if (gate.role === "original") denied("BUSINESS_EXECUTION_ORIGINAL_PROTECTED");
  const { p } = load(s, gate.reviewId), c = p.proposal.candidate;
  if (p.state !== "prepared" || p.lateCommitted || admission.ctx && admission.ctx !== gate.ctx || r.planHash !== c.planHash ||
      !["/mongodb/mutations/execute", "/mongodb/mutations/rollback"].includes(admission.route)) denied();
  // The immutable plan's TTL and v2 execution receipts remain authoritative.
  // The prepare-stage approval need not be renewed for this independent grant.
  return true;
}

// Machine observations remain a distinct evidence channel after acceptance.
// Neither a caller outcome nor a late safe receipt rewrites the pinned original.
export function recordExecutionRiskEvidence(s, action, input, ctx, scope) {
  const old = s.get("operation", input.id, ctx, scope);
  const gate = old && s.get("execution_risk_gate", gateId(s, old.identity?.instanceId, old.identity?.mutationId), "", "");
  if (gate?.role !== "original") return;
  if (ctx !== gate.ctx || scope !== gate.scope) denied();
  const { p } = load(s, gate.reviewId);
  const entry = action === "reconcile" && input.result?.ok === true && input.result.entries?.find(e =>
    e.mutationId === p.binding.mutationId && e.planHash === p.binding.planHash);
  if (entry) {
    const receiptDigest = digest(entry);
    const auditId = audit(s, "execution_risk_late_observation", p, ctx, scope, { receiptDigest, status: entry.status });
    const receipt = entry.importExecution;
    const exactAcknowledgedCommit = entry.status === "committed" && receipt?.version === 2 && receipt.stage === "acknowledged" &&
        digest(entry.execution) === digest(p.binding.execution) && digest(receipt.execution) === digest(p.binding.execution) &&
        receipt.mutationId === p.binding.mutationId && receipt.planHash === p.binding.planHash &&
        receipt.database === p.binding.database && receipt.collection === p.binding.collection && receipt.mode === "commit" && receipt.confirmation === "确认执行";
    s.put("execution_risk", p.id, ctx, scope, { ...p, lateCommitted: !!(p.lateCommitted || exactAcknowledgedCommit),
      latestMachineObservation: { receiptDigest, status: entry.status, observedAt: s.now(), exactAcknowledgedCommit: !!exactAcknowledgedCommit, auditId } }, MAX, true);
  }
  return { state: old.state };
}
