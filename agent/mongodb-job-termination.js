import { privacyError } from "./privacy-key.js";
import { businessTargetScope } from "../plugins/remote-debug-agent/business-privacy.js";
import { createOutputGuard } from "../plugins/remote-debug-agent/output-guard.js";

export const TERMINATION_CONFIRMATION = "我确认永久终止此任务，不再恢复或重试";
const MAX = Number.MAX_SAFE_INTEGER;
const HASH = /^[a-f0-9]{64}$/;
const JOB = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const deny = (code = "BUSINESS_TERMINATION_REVIEW_REQUIRED") => { throw privacyError(code); };
const key = (store, instanceId, jobId) => store.hash("job-termination", instanceId, jobId);
const load = (store, id) => store.get("job_termination", id, "", "") || deny();
const view = (store, p) => ({ ok: true, terminationId: p.id, instanceId: p.instanceId, database: p.database,
  jobId: p.jobId, planHash: p.planHash, reason: p.reason, state: p.state, reviewHash: p.reviewHash,
  observations: p.observations, expiresAt: p.expiresAt, confirmation: TERMINATION_CONFIRMATION,
  canApprove: p.state !== "terminated_unknown" && (!!p.approval || store.now() < p.expiresAt),
  managedAdmissionClosed: !!p.approval, remoteTermination: p.receipt ? "recorded" : "pending",
  historicalOutcome: "unknown", legacyInFlightOutcome: "unknown", approvalAuditId: p.approval?.auditId,
  controlRecordDigest: p.receipt?.controlRecordDigest,
  warning: "永久关闭此任务的后续执行、恢复及回滚准入；不回滚业务数据，不创建新任务，不证明历史或旧在途事务从未提交。" });

// Manager-only actions. Neither MCP nor the public protected-storage protocol
// may submit these actions, actor identities or remote acknowledgements.
export function jobTerminationStoreAction(store, action, input) {
  if (!action.startsWith("human_job_termination_")) return undefined;
  if (action === "human_job_termination_prepare") return store.transaction(() => {
    if (!JOB.test(input.jobId || "") || !HASH.test(input.planHash || "") || typeof input.reason !== "string" ||
        !input.reason.trim() || input.reason.length > 1000 || input.observations?.jobId !== input.jobId ||
        input.observations.planHash !== input.planHash || input.observations.database !== input.database) deny();
    const id = key(store, input.instanceId, input.jobId), old = store.get("job_termination", id, "", "");
    if (old && (old.planHash !== input.planHash || old.targetScope !== input.targetScope)) deny("BUSINESS_TERMINATION_TARGET_CHANGED");
    if (old?.approval) return view(store, old);
    const p = { id, instanceId: input.instanceId, database: input.database, targetScope: input.targetScope,
      jobId: input.jobId, planHash: input.planHash, reason: input.reason.trim(), observations: input.observations,
      state: "awaiting_human", expiresAt: store.now() + 300000 };
    p.reviewHash = store.hash("termination-review-v1", p);
    store.put("job_termination", id, "", "", p, MAX, true);
    return view(store, p);
  });
  const p = load(store, input.terminationId);
  if (p.instanceId !== input.instanceId || input.targetScope !== undefined && p.targetScope !== input.targetScope) deny("BUSINESS_TERMINATION_TARGET_CHANGED");
  if (action === "human_job_termination_context") return { targetScope: p.targetScope, database: p.database, jobId: p.jobId, planHash: p.planHash, state: p.state };
  if (action === "human_job_termination_view") return view(store, p);
  if (action === "human_job_termination_approve") return store.transaction(() => {
    const current = load(store, p.id);
    if (current.reviewHash !== input.reviewHash || input.confirmation !== TERMINATION_CONFIRMATION ||
        typeof input.actor?.username !== "string" || !input.actor.username || typeof input.actor.sessionId !== "string" || !input.actor.sessionId || !Number.isSafeInteger(input.actor.verifiedAt) ||
        input.actor.verifiedAt > store.now() || store.now() - input.actor.verifiedAt > 60000) deny();
    if (current.approval) return view(store, current);
    if (store.now() >= current.expiresAt || store.hash("termination-observations", input.observations) !== store.hash("termination-observations", current.observations)) deny("BUSINESS_TERMINATION_REVIEW_STALE");
    const auditId = store.hash("job-termination-approved", current.id, current.reviewHash, input.actor);
    const saved = { ...current, state: "termination_pending", approval: { ...input.actor, auditId, at: store.now() } };
    // This record is the permanent gate. Never expire it or release old pins.
    store.put("job_termination", p.id, "", "", saved, MAX, true);
    store.put("event", auditId, "", "", { type: "bulk_job_termination_approved", terminationId: p.id,
      instanceId: p.instanceId, jobId: p.jobId, planHash: p.planHash, reviewHash: p.reviewHash, actor: input.actor,
      historicalOutcome: "unknown", at: store.now() }, MAX, true);
    // Mark existing job tasks inactive without editing journals or ref links.
    for (const row of store.db.prepare("SELECT * FROM records WHERE kind='task'").all()) {
      const task = store.open(row);
      if (task.id !== p.jobId) continue;
      const target = store.get("context", row.ctx, row.ctx, "");
      if (!target) continue;
      // Task scope is a keyed hash of the configured business target. Match it
      // using the same origin as its existing mappings, never another instance.
      const mappings = store.db.prepare("SELECT * FROM records WHERE kind='mapping' AND ctx=? AND scope=? LIMIT 1").all(row.ctx, row.scope);
      if (!mappings.length) continue;
      let scope;
      try { scope = JSON.parse(store.open(mappings[0]).scope); } catch { continue; }
      if (scope.id === p.instanceId && scope.database === p.database) store.put("task", row.id, row.ctx, row.scope,
        { ...task, active: false, status: "termination_pending", terminationId: p.id }, MAX, true);
    }
    return view(store, saved);
  });
  if (action === "human_job_termination_dispatch") {
    if (!p.approval) deny();
    return { jobId: p.jobId, planHash: p.planHash, terminationId: p.id, reviewHash: p.reviewHash, approvalAuditId: p.approval.auditId };
  }
  if (action === "human_job_termination_record") return store.transaction(() => {
    const current = load(store, p.id), r = input.result;
    if (!current.approval || r?.ok !== true || r.jobId !== p.jobId || r.database !== p.database || r.planHash !== p.planHash ||
        r.terminationId !== p.id || r.reviewHash !== p.reviewHash || r.approvalAuditId !== current.approval.auditId ||
        r.status !== "terminated_unknown" || r.managedAdmissionClosed !== true || !HASH.test(r.controlRecordDigest || "")) deny("BUSINESS_TERMINATION_ACK_REQUIRED");
    const saved = { ...current, state: "terminated_unknown", receipt: r };
    store.put("job_termination", p.id, "", "", saved, MAX, true);
    const auditId = store.hash("job-termination-recorded", p.id, r.controlRecordDigest);
    store.put("event", auditId, "", "", { type: "bulk_job_termination_recorded", terminationId: p.id, instanceId: p.instanceId,
      jobId: p.jobId, planHash: p.planHash, controlRecordDigest: r.controlRecordDigest, historicalOutcome: "unknown", at: store.now() }, MAX, true);
    return view(store, saved);
  });
  deny();
}

export function assertJobNotTerminated(store, instanceId, admission) {
  const jobId = (admission.identity || admission.request || {}).jobId;
  if (typeof jobId !== "string") return;
  const p = store.get("job_termination", key(store, instanceId, jobId), "", "");
  if (p?.approval) deny("BUSINESS_JOB_PERMANENTLY_TERMINATED");
}

export function jobTerminationFor(store, instanceId, jobId) {
  const p = store.get("job_termination", key(store, instanceId, jobId), "", "");
  return p?.approval ? { terminationId: p.id, state: p.state } : undefined;
}

function observations(result) {
  if (!result?.ok || !JOB.test(result.jobId || "") || !HASH.test(result.planHash || "")) deny("BUSINESS_TERMINATION_TARGET_CHANGED");
  const names = ["jobId", "database", "planHash", "status", "desiredState", "updatedAt", "activeBatchIndexes", "activePhase",
    "committedBatchCount", "verifiedBatchCount", "batchCount", "unitCount", "operationCount", "pauseReason", "committed"];
  return Object.fromEntries(names.filter(k => result[k] !== undefined).map(k => [k, result[k]]));
}

export async function humanJobTerminationRequest(service, action, input, { instance, dispatch }) {
  const current = instance(input.instanceId);
  if (!current || current.enabled === false || !current.mongodb?.enabled) deny("BUSINESS_TERMINATION_TARGET_CHANGED");
  const context = action === "review" ? input : await service.call("human_job_termination_context", input);
  if (context.database !== current.mongodb.database) deny("BUSINESS_TERMINATION_TARGET_CHANGED");
  const targetScope = businessTargetScope("independent-job-termination-v1", current, context.database);
  if (action !== "review" && targetScope !== context.targetScope) deny("BUSINESS_TERMINATION_TARGET_CHANGED");
  const bound = { ...input, targetScope };
  if (action === "review") {
    const result = await dispatch(input.instanceId, "/mongodb/bulk/job", { jobId: input.jobId, includeDifferences: false });
    return service.call("human_job_termination_prepare", { ...bound, reason: createOutputGuard().sanitize({ reason: input.reason }).value.reason, observations: observations(result) });
  }
  if (action !== "approve") deny();
  const result = context.state === "awaiting_human" ? await dispatch(input.instanceId, "/mongodb/bulk/job", { jobId: context.jobId }) : undefined;
  const approved = await service.call("human_job_termination_approve", { ...bound, observations: result ? observations(result) : undefined });
  if (approved.state === "terminated_unknown") return approved;
  try {
    const request = await service.call("human_job_termination_dispatch", bound);
    await dispatch(input.instanceId, "/mongodb/bulk/terminate", request);
    // Independently read the durable tombstone; a command acknowledgement alone
    // must never be promoted to verified remote termination.
    const receipt = await dispatch(input.instanceId, "/mongodb/bulk/job", { jobId: context.jobId });
    return await service.call("human_job_termination_record", { ...bound, result: receipt });
  } catch (error) {
    return { ...approved, recoveryCode: /^(?:MONGODB_|SSH_|BUSINESS_|INSTANCE_)[A-Z0-9_]+$/.test(error.code || "") ? error.code : "BUSINESS_TERMINATION_ACK_REQUIRED" };
  }
}
