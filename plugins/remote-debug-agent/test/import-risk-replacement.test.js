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
import { createManagerApp } from "../../../agent/server.js";
import { InstanceRegistry } from "../../../agent/instance-registry.js";
import { loadConfig } from "../../../agent/config.js";
import { importConfig, importHarness } from "../../../agent/test/helpers/import-fixture.js";
import { importWire } from "../../../agent/test/helpers/import-risk-fixture.js";
import { mcpPeer } from "./helpers/local-mcp.js";
import { businessTargetScope } from "../business-privacy.js";
import localAuth from "../local-auth.cjs";

for (const bundled of [false, true]) test(`import public MCP and ${bundled ? "bundled" : "source"} Manager require native admin review and preserve per-batch confirmation`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rda-import-mcp-")); fs.chmodSync(root, 0o700);
  const directory = path.join(root, "storage"), key = randomBytes(32), h = importHarness();
  const registry = new InstanceRegistry({ cwd: root, env: {}, registryPath: path.join(root, "instances.json") });
  registry.create({ id: "isolated", host: "fixture.invalid", username: "fixture", privateKeyPath: "/fixture", hostKeyFingerprints: ["SHA256:" + "A".repeat(43)], mongodb: importConfig });
  const instance = registry.getInternal("isolated"), config = loadConfig({}, root), token = localAuth.ensureAuthToken(localAuth.resolveAuthFile(root));
  config.agent = { host: "127.0.0.1", port: 0 }; config.runtime.statePath = path.join(root, ".runtime", "state.json");
  const service = new PrivacyService({ directory, key, ...(bundled ? { workerPath: path.resolve(import.meta.dirname, "../runtime/agent/privacy-worker.cjs") } : {}) });
  let nativeChecks = 0;
  const workerManager = { publicInstances: () => registry.list(), callInstance: async (_id, route, request) => {
    const modes = { "/mongodb/imports/review": "import_review", "/mongodb/imports/retire": "import_retire", "/mongodb/imports/recover-prepare": "import_recover", "/mongodb/imports/prepare": "prepare", "/mongodb/mutations/execute": "commit", "/mongodb/mutations/rollback": "rollback", "/mongodb/mutations/recover-execution": "recover_execution" };
    assert.ok(modes[route], "only fixed import/mutation routes are dispatched");
    return { ok: true, ...await h.run({ ...request, mode: modes[route], ...(route === "/mongodb/imports/prepare" ? { kind: "import_plan" } : {}) }, instance.mongodb) };
  } };
  const runtime = bundled ? createRequire(import.meta.url)("../runtime/agent/server.cjs") : { createManagerApp };
  const app = runtime.createManagerApp({ config, registry, workerManager, privacyService: service, authToken: token,
    manualOptions: { ownerVerification: { status: () => ({ supported: true }), verify: async () => { nativeChecks++; } } } });
  const server = http.createServer(app); await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { await app.locals.manualWorkbench.close(); await service.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, scope = businessTargetScope(origin, instance, "test");
  const original = importWire({ instanceId: instance.id, database: "test", importId: "old-import", collection: "members", batchSize: 1,
    documents: [{ _id: { $oid: "507f1f77bcf86cd799439011" }, nested: { b: 1, a: 2 } }, { _id: "synthetic-member", value: 3 }], purpose: "isolated import" });
  const store = new PrivacyStore({ directory, key }), auth = store.execute("create");
  const old = store.execute("intent", { auth, scope, route: "/mongodb/imports/prepare", request: original, identity: { instanceId: instance.id } });
  const ref = "rda_ref_v1_" + randomBytes(24).toString("hex"); store.execute("commit", { auth, scope, records: [{ ref, scope, value: original.documents[0]._id }] }); store.close();
  const contextFile = path.join(root, "context.json"); fs.writeFileSync(contextFile, JSON.stringify({ version: 1, origin, auth }), { mode: 0o600 });
  const peer = await mcpPeer(t, { root, url: origin, contextFile }), target = { instanceId: instance.id, database: "test" };
  const call = input => peer.call("remote_debug_mongodb_disposition", { ...target, ...input });
  const typed = structuredClone(original); typed.documents[0]._id = ref;
  const base = await call({ mode: "prepare", intentId: old.id, originalRequest: typed });
  assert.notEqual(base.isError, true, JSON.stringify(base)); assert.equal(base.payload.binding.kind, "import");
  const prepared = await call({ mode: "prepare_risk", dispositionId: base.payload.dispositionId, reviewHash: base.payload.reviewHash, originalRequest: typed, replacementRequest: { ...typed, importId: "new-import" } });
  assert.notEqual(prepared.isError, true, JSON.stringify(prepared)); const plan = prepared.payload;
  assert.equal(plan.kind, "import"); assert.equal(plan.originalBatches.length, 2); assert.equal(plan.observations.batches[0].status, "missing");
  assert.equal((await call({ mode: "create_replacement", riskPlanId: plan.riskPlanId, reviewHash: plan.reviewHash })).payload.error.code, "BUSINESS_REPLACEMENT_HUMAN_CONFIRMATION_REQUIRED");
  for (const route of ["/mongodb/imports/retire", "/mongodb/imports/review", "/api/risk-replacement/approve"]) {
    const r = await fetch(origin + route, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: "{}" });
    assert.notEqual(r.status, 200, "Manager token cannot access internal retirement/approval routes");
  }
  for (const importId of ["new-import"]) {
    const r = await fetch(origin + "/mongodb/imports/prepare", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ importId, collection: "members", documents: original.documents }) });
    assert.equal(r.status, 409, "omitting database cannot bypass the protected configured target");
  }
  const workbench = app.locals.manualWorkbench;
  await workbench.store.register("admin", "disposable-import-admin-123");
  const admin = await workbench.login({ username: "admin", password: "disposable-import-admin-123", instanceId: instance.id }); await workbench.start();
  const human = async (route, body) => { const r = await fetch(workbench.origin + route, { method: "POST", headers: { Authorization: "Bearer " + admin.token, Origin: workbench.origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const reviewed = await human("/api/risk-replacement/review", { riskPlanId: plan.riskPlanId }); assert.equal(reviewed.status, 200);
  const approved = await human("/api/risk-replacement/approve", { riskPlanId: plan.riskPlanId, reviewHash: reviewed.body.reviewHash, confirmation: reviewed.body.confirmation });
  assert.equal(approved.status, 200, JSON.stringify(approved)); assert.equal(nativeChecks, 1); assert.equal(h.state.insert, 0);
  const created = await call({ mode: "create_replacement", riskPlanId: plan.riskPlanId, reviewHash: approved.body.reviewHash });
  assert.notEqual(created.isError, true, JSON.stringify(created)); assert.equal(created.payload.result.status, "prepared", JSON.stringify(created.payload)); assert.equal(created.payload.result.batches.length, 2); assert.equal(h.state.insert, 0);
  const batch = created.payload.result.batches[0];
  const mutation = (name, confirmation) => peer.call(name, { ...target, mutationId: batch.mutationId, planHash: batch.planHash, confirmation });
  assert.equal((await mutation("remote_debug_mongodb_execute_mutation", "wrong")).isError, true);
  h.state.failInsert = true;
  h.state.insertError = Object.assign(Error("PRIVATE_DOCUMENT_QUEUED and mongodb://private"), { name: "MongoServerError", code: 13 });
  const failed = await mutation("remote_debug_mongodb_execute_mutation", "确认执行");
  assert.equal(failed.isError, true);
  assert.equal(failed.payload.error.code, "MONGODB_OPERATION_FAILED");
  assert.deepEqual(failed.payload.error.diagnostic, { phase: "transaction_write", category: "permission", databaseCode: 13, serverMaxWireVersion: 9 });
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_DOCUMENT|mongodb:\/\/private/);
  const recovered = await peer.call("remote_debug_mongodb_recover_operation", { ...target, intentId: failed.payload.error.intentId, mode: "reconcile" });
  assert.equal(recovered.payload.state, "retryable", JSON.stringify(recovered));
  assert.equal(h.state.rows.size, 0);
  const committed = await mutation("remote_debug_mongodb_execute_mutation", "确认执行"); assert.notEqual(committed.isError, true, JSON.stringify(committed)); assert.equal(committed.payload.status, "committed");
  const rollback = await mutation("remote_debug_mongodb_rollback_mutation", "确认回滚"); assert.notEqual(rollback.isError, true, JSON.stringify(rollback)); assert.equal(h.state.rows.size, 0);
  assert.equal((await peer.call("remote_debug_mongodb_prepare_import", original)).payload.error.code, "BUSINESS_ORIGINAL_JOB_TERMINATED");
  const inspected = await call({ mode: "inspect_risk", riskPlanId: plan.riskPlanId }); assert.equal(inspected.payload.batches.length, 2); assert.equal(inspected.payload.historicalOutcome, "unknown");
});
