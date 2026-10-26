import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { localMcp, mcpPeer } from "./helpers/local-mcp.js";
import { PrivacyStore } from "../../../agent/privacy-store.js";
import { PrivacyService } from "../../../agent/privacy-service.js";
import { createManagerApp } from "../../../agent/server.js";
import { InstanceRegistry } from "../../../agent/instance-registry.js";
import { loadConfig } from "../../../agent/config.js";
import { bulkPreparePayload } from "../prepare-protocol.js";
import { businessTargetScope } from "../business-privacy.js";
import localAuth from "../local-auth.cjs";

const base = { instanceId: "isolated", database: "business", jobId: "legacy-original-job", chunkIndex: 0,
  units: [{ unitId: "one", operations: [{ operation: "updateOne", collection: "orders", id: { $oid: "507f1f77bcf86cd799439011" },
    expected: { count: { exists: true, value: 0 } }, update: { $inc: { count: 3 } } }] }], purpose: "legacy safety fixture" };
const wire = x => JSON.parse(JSON.stringify(bulkPreparePayload(x)));

for (const bundled of [false, true]) test(`public MCP ${bundled ? "bundled" : "source"} store quarantines exact typed legacy input without replay or replacement`, async t => {
  const instance = { id: "isolated", host: "fixture.invalid", mongodb: { database: "business" } };
  let id, ref;
  const f = await localMcp(t, { instance, ...(bundled ? { pluginRoot: path.resolve(import.meta.dirname, "..") } : {}),
    beforePeer: ({ directory, key, root, origin }) => {
      const store = new PrivacyStore({ directory, key }), auth = store.execute("create"), scope = businessTargetScope(origin, instance, "business");
      id = store.execute("intent", { auth, scope, route: "/mongodb/bulk/prepare", request: wire(base), identity: { instanceId: instance.id, jobId: base.jobId, chunkIndex: 0 } }).id;
      ref = "rda_ref_v1_" + randomBytes(24).toString("hex");
      store.execute("commit", { auth, scope, records: [{ ref, scope, value: base.units[0].operations[0].id }] });
      store.close(); fs.writeFileSync(path.join(root, "context.json"), JSON.stringify({ version: 1, origin, auth }), { mode: 0o600 });
    }, handler: () => assert.fail("disposition cannot dispatch, upload or execute anything") });
  const target = { instanceId: instance.id, database: "business" };
  const historical = () => f.call("remote_debug_mongodb_recover_operation", { ...target, intentId: id, mode: "historical" });
  const before = (await historical()).payload.history.recordFingerprint;
  const candidate = structuredClone(base); candidate.units[0].operations[0].id = ref;
  const review = await f.call("remote_debug_mongodb_disposition", { ...target, mode: "prepare", intentId: id, originalRequest: candidate });
  assert.notEqual(review.isError, true, JSON.stringify(review));
  const plan = review.payload;
  assert.equal(plan.state, "review_required"); assert.equal(plan.binding.intentId, id); assert.equal(plan.recordFingerprint, before);
  assert.equal(plan.binding.originalOperationId, null); assert.equal(plan.binding.planHash, null);
  assert.equal(plan.remoteFenceConfirmed, false); assert.equal(plan.replacementAllowed, false);
  assert.ok(plan.missingRequirements.includes("historical_transaction_receipts_required"));
  const fields = { ...target, dispositionId: plan.dispositionId, reviewHash: plan.reviewHash };
  const deniedBefore = await f.call("remote_debug_mongodb_disposition", { ...fields, mode: "admit_replacement" });
  assert.equal(deniedBefore.payload.admission, "blocked");
  const held = await f.call("remote_debug_mongodb_disposition", { ...fields, mode: "quarantine", confirmation: "确认隔离原意图" });
  assert.equal(held.payload.state, "quarantined"); assert.equal(held.payload.localContainment, true);
  assert.equal(held.payload.remoteFenceConfirmed, false); assert.equal(held.payload.historicalOutcome, "unknown");
  await f.restart();
  const retry = await f.call("remote_debug_mongodb_disposition", { ...fields, mode: "quarantine", confirmation: "确认隔离原意图" });
  assert.equal(retry.payload.auditId, held.payload.auditId); assert.equal(retry.payload.quarantinedAt, held.payload.quarantinedAt);
  const inspected = await f.call("remote_debug_mongodb_disposition", { ...target, mode: "inspect", dispositionId: plan.dispositionId });
  assert.equal(inspected.payload.state, "quarantined");
  assert.equal((await historical()).payload.history.recordFingerprint, before);
  assert.equal((await f.call("remote_debug_mongodb_recover_operation", { ...target, intentId: id })).payload.state, "uncertain");
  const deniedAfter = await f.call("remote_debug_mongodb_disposition", { ...fields, mode: "admit_replacement" });
  assert.equal(deniedAfter.payload.admission, "blocked"); assert.equal(deniedAfter.payload.admissionAuditId, deniedBefore.payload.admissionAuditId);
  for (const args of [base, { ...base, jobId: "replacement-job" }, { ...base, database: "other", jobId: "different-database" }]) {
    assert.equal((await f.call("remote_debug_mongodb_prepare_bulk", args)).payload.error.code, "BUSINESS_DISPOSITION_QUARANTINED");
  }
  const ordinary = await f.call("remote_debug_mongodb_prepare_write", { ...target, operation: "insertOne", collection: "orders", document: { _id: "replacement", count: 3 } });
  assert.equal(ordinary.payload.error.code, "BUSINESS_DISPOSITION_QUARANTINED");
  assert.equal(f.requests.length, 0);
  assert.equal(f.wire.join("").includes("507f1f77bcf86cd799439011"), false, "typed identifier remains protected");
});

test("public MCP rejects invented proof, risk override, wrong confirmation, and extra identity fields", async t => {
  const instance = { id: "isolated", host: "fixture.invalid", mongodb: { database: "business" } };
  const f = await localMcp(t, { instance, handler: () => assert.fail("invalid public arguments must not dispatch") });
  for (const fields of [
    { mode: "cancel" }, { mode: "prepare", intentId: "a".repeat(64), originalRequest: base, notDispatched: true },
    { mode: "prepare", intentId: "a".repeat(64), originalRequest: base, originalOperationId: "invented" },
    { mode: "admit_replacement", dispositionId: "a".repeat(64), reviewHash: "b".repeat(64), riskAccepted: true },
    { mode: "quarantine", dispositionId: "a".repeat(64), reviewHash: "b".repeat(64), confirmation: "确认执行" },
    { mode: "prepare", intentId: "a".repeat(64), originalRequest: { ...base, notDispatched: true } },
  ]) assert.equal((await f.call("remote_debug_mongodb_disposition", { instanceId: instance.id, database: "business", ...fields })).isError, true);
  assert.equal(f.requests.length, 0);
});

for (const bundled of [false, true]) test(`real ${bundled ? "bundled" : "source"} Manager guards direct requests but never certifies an already queued old execution`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rda-disposition-manager-")), directory = path.join(root, "storage"), key = randomBytes(32);
  const registry = new InstanceRegistry({ cwd: root, env: {}, registryPath: path.join(root, "instances.json") });
  registry.create({ id: "isolated", name: "Disposable", host: "fixture.invalid", username: "fixture", privateKeyPath: "/fixture", hostKeyFingerprints: ["SHA256:" + "A".repeat(43)], mongodb: {
    enabled: true, database: "business", configPath: "/fixture/config.json", driverPath: "/fixture/node_modules/mongodb", configProfile: "fixture", uriKey: "url" } });
  const instance = registry.getInternal("isolated"), config = loadConfig({}, root);
  config.agent = { host: "127.0.0.1", port: 0 }; config.runtime.statePath = path.join(root, ".runtime", "state.json");
  const token = localAuth.ensureAuthToken(localAuth.resolveAuthFile(root));
  const service = new PrivacyService({ directory, key, ...(bundled ? { workerPath: path.resolve(import.meta.dirname, "../runtime/agent/privacy-worker.cjs") } : {}) });
  let entered, release;
  const queued = new Promise(r => entered = r), continueOld = new Promise(r => release = r), calls = [];
  const workerManager = { publicInstances: () => registry.list(), callInstance: async (id, route, payload) => {
    calls.push(route);
    if (route === "/mongodb/bulk/execute") { entered(); await continueOld; return { ok: true, instanceId: id, jobId: payload.jobId, status: "completed" }; }
    return { ok: true, instanceId: id, data: [] };
  } };
  const runtime = bundled ? createRequire(import.meta.url)("../runtime/agent/server.cjs") : { createManagerApp };
  const server = http.createServer(runtime.createManagerApp({ config, registry, workerManager, privacyService: service, authToken: token }));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { release(); await service.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, scope = businessTargetScope(origin, instance, "business");
  const store = new PrivacyStore({ directory, key }), auth = store.execute("create");
  const intent = store.execute("intent", { auth, scope, route: "/mongodb/bulk/prepare", request: wire(base), identity: { instanceId: instance.id, jobId: base.jobId, chunkIndex: 0 } });
  store.close(); const contextFile = path.join(root, "context.json"); fs.writeFileSync(contextFile, JSON.stringify({ version: 1, origin, auth }), { mode: 0o600 });
  const peer = await mcpPeer(t, { root, url: origin, contextFile });
  const post = async (route, input) => { const res = await fetch(origin + route, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input) }); return { status: res.status, body: await res.json() }; };
  // Already-admitted legacy work can finish. A local hold cannot certify that
  // an old worker or serialized SSH helper will honor a new remote fence.
  const old = post("/mongodb/bulk/execute", { instanceId: instance.id, jobId: base.jobId, planHash: "d".repeat(64), confirmation: "确认执行" });
  await queued;
  const target = { instanceId: instance.id, database: "business" };
  const plan = (await peer.call("remote_debug_mongodb_disposition", { ...target, mode: "prepare", intentId: intent.id, originalRequest: base })).payload;
  const fields = { ...target, dispositionId: plan.dispositionId, reviewHash: plan.reviewHash };
  const held = (await peer.call("remote_debug_mongodb_disposition", { ...fields, mode: "quarantine", confirmation: "确认隔离原意图" })).payload;
  assert.equal(held.remoteFenceConfirmed, false); release();
  assert.equal((await old).body.status, "completed", "already-admitted old work is not retroactively cancelled");
  for (const route of ["/mongodb/bulk/prepare", "/mongodb/bulk/execute", "/mongodb/bulk/control", "/mongodb/bulk/rollback", "/mongodb/mutations/prepare", "/mongodb/mutations/execute", "/mongodb/imports/prepare", "/mongodb/bulk/storage/prepare", "/mongodb/sandbox/access/execute", "/sandbox/cleanup"]) {
    const rejected = await post(route, { instanceId: instance.id, jobId: "new-job", command: "resume" });
    assert.equal(rejected.body.error.code, "BUSINESS_DISPOSITION_QUARANTINED", route + JSON.stringify(rejected));
  }
  assert.equal((await post("/mongodb/bulk/job", { instanceId: instance.id, jobId: base.jobId })).status, 200);
  const denied = (await peer.call("remote_debug_mongodb_disposition", { ...fields, mode: "admit_replacement" })).payload;
  assert.equal(denied.admission, "blocked"); assert.equal(denied.replacementAllowed, false); assert.equal(denied.historicalOutcome, "unknown");
  assert.deepEqual(calls, ["/mongodb/bulk/execute", "/mongodb/bulk/job"]);
  assert.equal((await peer.call("remote_debug_mongodb_recover_operation", { ...target, intentId: intent.id })).payload.state, "uncertain");
});
