import { createHash } from "node:crypto";
import { importRiskFixture } from "./import-risk-fixture.js";
import { privacyRequest } from "../../privacy-service.js";
export async function executionRiskFixture(t, options = {}) {
  const f = importRiskFixture(t, options);
  const lineage = await f.prepare(JSON.parse(JSON.stringify(f.candidate))); f.approve(lineage);
  const created = await f.create(lineage), batch = created.result.batches[0];
  if (options.legacyNoUuid) {
    // Synthetic historical .2 bytes: no collection UUID, no modern receipt.
    // This fixture is created before its local execution intent exists.
    const file = "/tmp/remote-debug-agent/mutations/" + batch.mutationId + "/manifest.json";
    const m = JSON.parse(f.h.files.get(file)); delete m.collectionIdentity;
    const identity = { schemaVersion: m.schemaVersion, mutationId: m.mutationId, operationId: m.operationId, kind: m.kind,
      request: m.request, before: m.before, beforeIndex: m.beforeIndex, beforeOperations: m.beforeOperations,
      riskLineage: m.riskLineage, orderedRequest: JSON.stringify(m.request) };
    const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
    m.planHash = createHash("sha256").update(JSON.stringify(stable(identity))).digest("hex");
    f.h.files.set(file, JSON.stringify(m)); batch.planHash = m.planHash;
    const scope = f.store.hash("scope", f.scope), p = f.store.get("risk_replacement", lineage.riskPlanId, f.auth.contextId, scope);
    p.preparedBatches.find(b => b.mutationId === batch.mutationId).planHash = m.planHash;
    f.store.put("risk_replacement", p.id, f.auth.contextId, scope, p, Number.MAX_SAFE_INTEGER, true);
  }
  const request = { mutationId: batch.mutationId, planHash: batch.planHash, confirmation: "确认执行" };
  const intent = f.call("intent", { route: "/mongodb/mutations/execute", request,
    identity: { instanceId: f.instance.id, mutationId: batch.mutationId, planHash: batch.planHash } });
  if (options.legacy) {
    const scope = f.store.hash("scope", f.scope), old = f.store.get("operation", intent.id, f.auth.contextId, scope);
    delete old.executionProtocol; delete old.executionAttempt;
    f.store.put("operation", intent.id, f.auth.contextId, scope, old, Number.MAX_SAFE_INTEGER, true);
  }
  const execution = f.call("claim_execution", { id: intent.id, operationId: "synthetic-original-execute", attempt: intent.executionAttempt });
  f.h.state.failInsert = true; f.h.state.failAbort = true;
  try { await f.h.run({ mode: "commit", ...request, _businessExecution: execution }); } catch (e) { if (e.code !== "MONGODB_OPERATION_FAILED" && !(options.legacyNoUuid && e.code === "MONGODB_COLLECTION_IDENTITY_CHANGED")) throw e; }
  f.h.state.failAbort = false;
  const dispatch = async (_id, route, body) => {
    const modes = { "/mongodb/imports/execution-review": "execution_risk_review", "/mongodb/imports/execution-continue": "execution_risk_continue",
      "/mongodb/mutations/get": "get", "/mongodb/mutations/recover-execution": "recover_execution" };
    if (!modes[route]) return f.requestOptions.dispatch(_id, route, body);
    return { ok: true, ...await f.h.run({ ...body, mode: modes[route] }) };
  };
  const requestOptions = { ...f.requestOptions, dispatch };
  const pub = input => privacyRequest(f.service, { action: "disposition", auth: f.auth, scope: f.scope, ...input }, requestOptions);
  return { f, batch, intent, execution, request, requestOptions, pub,
    prepare: () => pub({ mode: "prepare_execution_risk", id: intent.id, riskPlanId: lineage.riskPlanId }),
    approve: p => f.human("human_execution_risk_approve", { riskPlanId: p.riskPlanId, instanceId: f.instance.id,
      reviewHash: p.reviewHash, confirmation: p.confirmation, actor: { username: "synthetic-admin", sessionId: "synthetic-native-session", verifiedAt: f.now } }),
    continue: p => pub({ mode: "continue_execution", riskPlanId: p.riskPlanId, reviewHash: p.reviewHash }), lineage };
}
