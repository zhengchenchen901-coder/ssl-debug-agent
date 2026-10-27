import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { PrivacyStore } from "../../../agent/privacy-store.js";
import { PrivacyService } from "../../../agent/privacy-service.js";
import { createApp, createManagerApp } from "../../../agent/server.js";
import { InstanceRegistry } from "../../../agent/instance-registry.js";
import { loadConfig } from "../../../agent/config.js";
import { importConfig, importHarness } from "../../../agent/test/helpers/import-fixture.js";
import { importWire } from "../../../agent/test/helpers/import-risk-fixture.js";
import { mcpPeer } from "./helpers/local-mcp.js";
import { businessTargetScope } from "../business-privacy.js";
import localAuth from "../local-auth.cjs";

import { WorkerManager, workerConfigFingerprint } from "../../../agent/worker-manager.js";
test("public MCP to Manager to authenticated Worker HTTP and fixed helper: independent execution-risk review and no replay", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rda-execution-risk-mcp-")); fs.chmodSync(root, 0o700);
  const directory = path.join(root, "storage"), key = randomBytes(32), h = importHarness();
  const registry = new InstanceRegistry({ cwd: root, env: {}, registryPath: path.join(root, "instances.json") });
  registry.create({ id: "isolated", host: "fixture.invalid", username: "fixture", privateKeyPath: "/fixture", hostKeyFingerprints: ["SHA256:" + "A".repeat(43)], mongodb: importConfig });
  const instance = registry.getInternal("isolated"), config = loadConfig({}, root), token = localAuth.ensureAuthToken(localAuth.resolveAuthFile(root));
  config.agent = { host: "127.0.0.1", port: 0 }; config.runtime.statePath = path.join(root, ".runtime", "state.json");
  const workerConfig = { ...config, mongodb: instance.mongodb, audit: { logPath: path.join(root, "worker-audit.jsonl") } };
  const workerApp = createApp({ config: workerConfig, authToken: token, runMongoMutation: body => h.run(body, instance.mongodb) });
  const workerServer = http.createServer(workerApp); await new Promise(r => workerServer.listen(0, "127.0.0.1", r));
  const policy = { host: "127.0.0.1", sshNetwork: {} };
  const runtime = { status: "running", workerPort: workerServer.address().port, authToken: token, configFingerprint: workerConfigFingerprint(instance, policy, root) };
  const workerManager = { cwd: root, registry, resolveInstanceId: id => id, runtime: new Map([[instance.id, runtime]]),
    managerConfig: () => policy, fetchImpl: fetch, publicInstances: () => registry.list(),
    assertMongoConfigurationCurrent: id => WorkerManager.prototype.assertMongoConfigurationCurrent.call(workerManager, id),
    callInstance: (...args) => WorkerManager.prototype.callInstance.call(workerManager, ...args) };
  const service = new PrivacyService({ directory, key }); let nativeChecks = 0, rejectNative = false;
  const app = createManagerApp({ config, registry, workerManager, privacyService: service, authToken: token,
    manualOptions: { ownerVerification: { status: () => ({ supported: true }), verify: async () => { nativeChecks++; if (rejectNative) throw Error("cancelled synthetic native dialog"); } } } });
  const server = http.createServer(app); await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { await app.locals.manualWorkbench.close(); await service.close();
    for (const srv of [server, workerServer]) { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
    fs.rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, scope = businessTargetScope(origin, instance, "test");
  const original = importWire({ instanceId: instance.id, database: "test", importId: "old-import", collection: "members", batchSize: 2,
    documents: [{ _id: { $oid: "507f1f77bcf86cd799439011" }, nested: { b: 1, a: 2 } }, { _id: "synthetic-member", value: 3 }], purpose: "isolated execution review" });
  const store = new PrivacyStore({ directory, key }), auth = store.execute("create");
  const old = store.execute("intent", { auth, scope, route: "/mongodb/imports/prepare", request: original, identity: { instanceId: instance.id } }); store.close();
  const contextFile = path.join(root, "context.json"); fs.writeFileSync(contextFile, JSON.stringify({ version: 1, origin, auth }), { mode: 0o600 });
  const peer = await mcpPeer(t, { root, url: origin, contextFile }), target = { instanceId: instance.id, database: "test" };
  const call = async input => { const r = await peer.call("remote_debug_mongodb_disposition", { ...target, ...input }); assert.notEqual(r.isError, true, JSON.stringify(r)); return r.payload; };
  const base = await call({ mode: "prepare", intentId: old.id, originalRequest: original });
  const lineage = await call({ mode: "prepare_risk", dispositionId: base.dispositionId, reviewHash: base.reviewHash, originalRequest: original, replacementRequest: { ...original, importId: "unique-replacement" } });
  const w = app.locals.manualWorkbench; await w.store.register("admin", "disposable-execution-risk-mcp-password");
  const admin = await w.login({ username: "admin", password: "disposable-execution-risk-mcp-password", instanceId: instance.id }); await w.start();
  const human = async (stage, action, body, bearer = admin.token) => {
    const r = await fetch(w.origin + `/api/${stage}/${action}`, { method: "POST", headers: { Authorization: "Bearer " + bearer, Origin: w.origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const approve = async (stage, id) => { const r = await human(stage, "review", { riskPlanId: id }); assert.equal(r.status, 200, JSON.stringify(r));
    return human(stage, "approve", { riskPlanId: id, reviewHash: r.body.reviewHash, confirmation: r.body.confirmation }); };
  assert.equal((await approve("risk-replacement", lineage.riskPlanId)).status, 200);
  const created = await call({ mode: "create_replacement", riskPlanId: lineage.riskPlanId, reviewHash: lineage.reviewHash }); const batch = created.result.batches[0];
  const execute = (b, confirmation = "确认执行") => peer.call("remote_debug_mongodb_execute_mutation", { ...target, mutationId: b.mutationId, planHash: b.planHash, confirmation });
  h.state.failInsert = true; h.state.failAbort = true;
  const failed = await execute(batch); assert.equal(failed.isError, true); const intentId = failed.payload.error.intentId; assert.ok(intentId); h.state.failAbort = false;
  const plan = await call({ mode: "prepare_execution_risk", intentId, riskPlanId: lineage.riskPlanId });
  assert.equal(plan.kind, "import_execution"); assert.equal(plan.humanApproved, false); assert.equal(plan.binding.mutationId, batch.mutationId);
  assert.equal(plan.binding.importId, "unique-replacement"); assert.notEqual(plan.planHash, batch.planHash);
  assert.equal((await peer.call("remote_debug_mongodb_disposition", { ...target, mode: "continue_execution", riskPlanId: plan.riskPlanId, reviewHash: plan.reviewHash })).isError, true);
  for (const bearer of [token, auth.capability]) assert.equal((await human("execution-risk", "review", { riskPlanId: plan.riskPlanId }, bearer)).status, 401);
  for (const route of ["/mongodb/imports/execution-review", "/mongodb/imports/execution-continue", "/api/execution-risk/approve"]) {
    const r = await fetch(origin + route, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: "{}" }); assert.notEqual(r.status, 200);
  }
  rejectNative = true; assert.notEqual((await approve("execution-risk", plan.riskPlanId)).status, 200);
  rejectNative = false; assert.equal((await approve("execution-risk", plan.riskPlanId)).status, 200); assert.equal(nativeChecks, 3);
  const child = await call({ mode: "continue_execution", riskPlanId: plan.riskPlanId, reviewHash: plan.reviewHash });
  assert.equal(child.state, "prepared"); assert.equal(child.result.importId, "unique-replacement"); assert.equal(h.state.rows.size, 0);
  assert.equal((await execute(child, "wrong")).isError, true);
  h.state.failInsert = true; h.state.failAbort = true;
  const newUnknown = await execute(child); assert.equal(newUnknown.isError, true); h.state.failAbort = false;
  const insertCalls = h.state.insert;
  assert.equal((await execute(child)).payload.error.code, "BUSINESS_OPERATION_RECONCILIATION_REQUIRED"); assert.equal(h.state.insert, insertCalls);
  const secondReview = await peer.call("remote_debug_mongodb_disposition", { ...target, mode: "prepare_execution_risk", intentId: newUnknown.payload.error.intentId, riskPlanId: lineage.riskPlanId }); assert.equal(secondReview.isError, true);
  const retained = await call({ mode: "inspect_execution_risk", riskPlanId: plan.riskPlanId }); assert.equal(retained.historicalOutcome, "unknown"); assert.equal(retained.mutationId, child.mutationId);
  const auditText = fs.readFileSync(path.join(root, "worker-audit.jsonl"), "utf8"); assert.match(auditText, /mongodb-mutation-execution_risk_continue/);
});
