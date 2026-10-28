import { importReviewDisplay } from "./mongodb-import-review-display.js";
import { privacyError } from "./privacy-key.js";
import { resolveImportOperation, validateImportLookup } from "./mongodb-import-recovery.js";
import { IMPORT_PREPARE_ROUTE, prepareRequestDigest } from "../plugins/remote-debug-agent/prepare-protocol.js";

export const ORPHAN_RISK_POLICY = "human-orphan-import-risk-v1";
export const ORPHAN_RISK_CONFIRMATION = "我接受缺少历史回执、重复、迟到执行及回滚风险，并批准一次此精确准备处置";
const MAX = Number.MAX_SAFE_INTEGER;
const deny = (code = "BUSINESS_ORPHAN_RISK_DENIED") => { throw privacyError(code); };
const key = (s, instanceId, database, importId) => s.hash("orphan-import-gate", instanceId, database, importId);
function load(s, id, ctx, scope) {
  const row = s.db.prepare("SELECT * FROM records WHERE kind='orphan_risk' AND id=?").get(id);
  if (!row || ctx !== undefined && (row.ctx !== ctx || row.scope !== scope)) deny();
  return { p: s.open(row), ctx: row.ctx, scope: row.scope };
}
function audit(s, p, ctx, scope, type, details = {}) {
  const id = s.hash("orphan-risk-audit", p.id, p.reviewHash, type);
  s.put("orphan_risk_audit", id, ctx, scope, { type, riskPlanId: p.id, reviewHash: p.reviewHash,
    binding: p.binding, originalState: "unresolved", historicalOutcome: "unknown", at: s.now(), ...details }, MAX, true);
  return id;
}
function missing(s, input, ctx, scope, request) {
  const lookup = resolveImportOperation(s, input, ctx, scope);
  // Budget/ambiguity are not absence. Even an unindexed legacy keyed record
  // must use its existing intent workflow, never this independent admission.
  const id = s.hash("operation", ctx, input.scope, IMPORT_PREPARE_ROUTE, request);
  if (lookup.state !== "unresolved" || lookup.reason !== "trusted_record_not_found" || s.get("operation", id, ctx, scope)) deny("BUSINESS_ORPHAN_RISK_EXISTING_OR_UNKNOWN_INTENT");
  const rows = s.db.prepare("SELECT * FROM records WHERE ctx=? AND scope=? AND kind IN ('operation','import_prepare_evidence') LIMIT 1001").all(ctx, scope);
  if (rows.length > 1000 || rows.reduce((n, row) => n + row.envelope.length, 0) > 8 * 1024 * 1024) deny("BUSINESS_ORPHAN_RISK_EXISTING_OR_UNKNOWN_INTENT");
  if (rows.some(row => {
    const r = s.open(row), record = r.record || r;
    return record.route === IMPORT_PREPARE_ROUTE && (record.identity?.importId === request.importId || record.importPrepare?.requestDigest === input.requestDigest);
  })) deny("BUSINESS_ORPHAN_RISK_EXISTING_OR_UNKNOWN_INTENT");
  return { source: "protected_bounded_lookup", reason: lookup.reason, observedAt: s.now(),
    historicalReceipts: "unavailable", historicalOutcome: "unknown", provesNotDispatched: false };
}
function current(s, p, ctx, scope) {
  missing(s, { scope: p.targetScope, ...p.binding }, ctx, scope, p.originalRequest);
  for (const request of [p.originalRequest, p.replacementRequest]) {
    const gate = s.get("orphan_import_gate", key(s, request.instanceId, request.database, request.importId), "", "");
    if (gate?.riskPlanId !== p.id) deny();
  }
}
function view(s, p, human = false) {
  const originalDisplay = human && importReviewDisplay(p.originalRequest), followupDisplay = human && importReviewDisplay(p.replacementRequest);
  return { ok: true, kind: "orphan_import", riskPlanId: p.id, approvalPolicy: ORPHAN_RISK_POLICY,
    binding: p.binding, reviewHash: p.reviewHash, state: p.state, originalStatus: "unresolved", historicalOutcome: "unknown",
    provesNotDispatched: false, expiresAt: p.expiresAt, confirmation: ORPHAN_RISK_CONFIRMATION,
    canApprove: p.state === "awaiting_human" && s.now() < p.expiresAt,
    humanApproved: !!p.approval, approvalAuditId: p.approval?.auditId, consumptionAuditId: p.consumptionAuditId,
    followup: { action: "prepare_import_once", importId: p.replacementRequest.importId, requestDigest: p.replacementDigest,
      collection: p.originalRequest.collection, documentCount: p.originalRequest.documents.length, batches: p.batches },
    observation: p.observation, reviewMemo: p.reviewMemo, memoSource: "caller_statement_not_execution_proof",
    intentId: p.followupIntentId, result: p.result,
    ...(human ? { orderedOriginalRequest: originalDisplay.orderedRequest, orderedFollowupRequest: followupDisplay.orderedRequest,
      requestDisplay: { redacted: originalDisplay.redacted || followupDisplay.redacted, withheldDocuments: originalDisplay.withheldDocuments + followupDisplay.withheldDocuments, originalBytes: "encrypted_only", projectionIsInputProof: false } } : {}),
    warning: "没有历史 intentId 或精确回执，旧状态保持 unresolved/unknown。当前缺少数据不证明未派发。须接受重复、迟到提交、部分成功、回滚无法覆盖历史写入及回滚冲突风险。批准只授权一次精确导入准备；不保证召回旧执行器，不执行业务写入。每批执行和回滚仍需独立确认。处置结果未知时不得再次派发。" };
}
export function orphanRiskHumanAction(s, action, input) {
  if (!action?.startsWith("human_orphan_risk_")) return;
  const { p, ctx, scope } = load(s, input.riskPlanId);
  if (input.instanceId !== p.binding.instanceId) deny();
  if (action === "human_orphan_risk_context") return { targetScope: p.targetScope, database: p.binding.database };
  if (input.targetScope !== p.targetScope) deny();
  if (action === "human_orphan_risk_view") { current(s, p, ctx, scope); return view(s, p, true); }
  if (action !== "human_orphan_risk_approve") deny();
  return s.transaction(() => {
    const { p } = load(s, input.riskPlanId, ctx, scope);
    current(s, p, ctx, scope);
    const a = input.actor;
    if (p.state !== "awaiting_human" || s.now() >= p.expiresAt || input.reviewHash !== p.reviewHash ||
        input.confirmation !== ORPHAN_RISK_CONFIRMATION || typeof a?.username !== "string" || !a.username ||
        typeof a.sessionId !== "string" || !a.sessionId || !Number.isSafeInteger(a.verifiedAt) || a.verifiedAt > s.now() || s.now() - a.verifiedAt > 60000) deny();
    p.approval = { username: a.username, sessionId: a.sessionId, verifiedAt: a.verifiedAt,
      reviewHash: p.reviewHash, validUntil: Math.min(p.expiresAt, s.now() + 900000) };
    p.approval.auditId = audit(s, p, ctx, scope, "orphan_risk_human_approved", { actor: p.approval });
    p.state = "human_approved";
    s.put("orphan_risk", p.id, ctx, scope, p, MAX, true);
    return view(s, p, true);
  });
}
export function orphanRiskStoreAction(s, action, input, ctx, scope) {
  if (action === "orphan_risk_prepare") return s.transaction(() => {
    validateImportLookup(input);
    const target = JSON.parse(input.scope), original = input.originalRequest, replacement = input.replacementRequest;
    if (original.instanceId !== target.id || original.database !== target.database || original.importId !== input.importId ||
        prepareRequestDigest(original) !== input.requestDigest || original.importId === replacement.importId ||
        JSON.stringify({ ...replacement, importId: original.importId }) !== JSON.stringify(original)) deny();
    const observation = missing(s, input, ctx, scope, original);
    const id = s.hash("orphan-risk", ctx, input.scope, input.originalOperationId, input.importId);
    const old = s.get("orphan_risk", id, ctx, scope);
    if (old) {
      if (old.binding.requestDigest !== input.requestDigest || old.replacementDigest !== prepareRequestDigest(replacement) || old.reviewMemo !== input.reviewMemo) deny("BUSINESS_ORPHAN_RISK_BINDING_CONFLICT");
      // An expired, unconsumed review may be renewed with identical inputs.
      if (s.now() < old.expiresAt || old.state === "consumed") return view(s, old);
      s.put("orphan_risk_revision", s.hash("orphan-risk-revision", id, old.reviewHash), ctx, scope, old, MAX, true);
    }
    missing(s, { ...input, importId: replacement.importId, requestDigest: prepareRequestDigest(replacement) }, ctx, scope, replacement);
    const followupId = s.hash("operation", ctx, input.scope, IMPORT_PREPARE_ROUTE, replacement);
    if (s.get("operation", followupId, ctx, scope)) deny("BUSINESS_ORPHAN_RISK_CANDIDATE_EXISTS");
    const p = { id, state: "awaiting_human", targetScope: input.scope, expiresAt: s.now() + 3600000,
      binding: { instanceId: target.id, database: target.database, originalOperationId: input.originalOperationId,
        importId: input.importId, requestDigest: input.requestDigest, collection: original.collection },
      originalRequest: original, replacementRequest: replacement, replacementDigest: prepareRequestDigest(replacement),
      batches: input.batches, observation, reviewMemo: input.reviewMemo };
    p.reviewHash = s.hash(ORPHAN_RISK_POLICY, p);
    for (const request of [original, replacement]) {
      const k = key(s, target.id, target.database, request.importId), gate = s.get("orphan_import_gate", k, "", "");
      if (gate && gate.riskPlanId !== id) deny("BUSINESS_ORPHAN_RISK_BINDING_CONFLICT");
      s.put("orphan_import_gate", k, "", "", { riskPlanId: id, ctx, scope,
        role: request.importId === original.importId ? "original" : "followup" }, MAX, true);
    }
    p.auditId = audit(s, p, ctx, scope, "orphan_risk_prepared");
    s.put("orphan_risk", id, ctx, scope, p, MAX, true);
    return view(s, p);
  });
  if (!["orphan_risk_inspect", "orphan_risk_consume", "orphan_risk_result"].includes(action)) return;
  return s.transaction(() => {
    const { p } = load(s, input.riskPlanId, ctx, scope);
    if (action === "orphan_risk_inspect") return view(s, p);
    if (input.reviewHash !== p.reviewHash || !p.approval) deny("BUSINESS_ORPHAN_RISK_HUMAN_REQUIRED");
    if (action === "orphan_risk_result") {
      if (p.state !== "consumed") deny();
      p.result = input.result; // Followup result only; never an original receipt.
      audit(s, p, ctx, scope, "orphan_risk_followup_observed", { intentId: p.followupIntentId, state: input.result?.intentState });
      s.put("orphan_risk", p.id, ctx, scope, p, MAX, true);
      return view(s, p);
    }
    if (p.state === "consumed") return { done: true, ...view(s, p) };
    current(s, p, ctx, scope);
    if (p.state !== "human_approved" || s.now() >= p.approval.validUntil) deny("BUSINESS_ORPHAN_RISK_EXPIRED");
    const id = s.hash("operation", ctx, p.targetScope, IMPORT_PREPARE_ROUTE, p.replacementRequest);
    if (s.get("operation", id, ctx, scope)) deny("BUSINESS_ORPHAN_RISK_CANDIDATE_EXISTS");
    const r = p.replacementRequest;
    const record = { state: "uncertain", route: IMPORT_PREPARE_ROUTE, started: s.now(), orphanRiskPlanId: p.id,
      identity: { instanceId: r.instanceId, database: r.database, importId: r.importId, collection: r.collection },
      importBatches: p.batches, importPrepare: { binding: id, requestDigest: p.replacementDigest, attempt: 1 } };
    s.put("operation", id, ctx, scope, record, MAX, true);
    s.put("task", s.hash("task", ctx, p.targetScope, "operation:" + id), ctx, scope, { id: "operation:" + id, active: true, expires: MAX }, MAX, true);
    p.state = "consumed"; p.followupIntentId = id;
    p.consumptionAuditId = audit(s, p, ctx, scope, "orphan_risk_consumed", { approvalAuditId: p.approval.auditId, intentId: id });
    s.put("orphan_risk", p.id, ctx, scope, p, MAX, true);
    // Consumption and the only followup identity are durable before any await.
    // A lost reply/crash never grants a second dispatch; inspect/reconcile only.
    return { intent: { id, ...record }, request: r, risk: view(s, p) };
  });
}
export function assertOrphanRiskAdmission(s, instanceId, admission) {
  const r = admission.request || admission.identity || {};
  if (!r.importId || !r.database) return;
  const gate = s.get("orphan_import_gate", key(s, instanceId, r.database, r.importId), "", "");
  if (!gate) return;
  if (gate.role === "original") deny("BUSINESS_ORPHAN_ORIGINAL_PROTECTED");
  const { p, ctx, scope } = load(s, gate.riskPlanId);
  const id = admission.orphanIntentId;
  const record = id && s.get("operation", id, ctx, scope);
  if (p.state !== "consumed" || admission.ctx && admission.ctx !== ctx || id !== p.followupIntentId ||
      record?.orphanRiskPlanId !== p.id || admission.route !== IMPORT_PREPARE_ROUTE ||
      (admission.dispatchDigest || prepareRequestDigest(r)) !== p.replacementDigest) deny("BUSINESS_ORPHAN_FOLLOWUP_PROTECTED");
}
