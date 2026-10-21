import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createManagerApp } from "../../../agent/server.js";
import { InstanceRegistry } from "../../../agent/instance-registry.js";
import { loadConfig } from "../../../agent/config.js";
import { PrivacyService } from "../../../agent/privacy-service.js";
import { mutationPrepareHarness } from "../../../agent/test/helpers/mutation-prepare-harness.js";
import { mcpPeer, localMcp } from "./helpers/local-mcp.js";
import localAuth from "../local-auth.cjs";

const index = { instanceId: "isolated", database: "business", operation: "createIndex", collection: "orders", name: "idx_consume",
  key: { group_string_id: 1, res_string_id: 1, belonged_customer: 1 }, options: { unique: false, sparse: false } };

for (const bundled of [false, true]) test(`index allowlist rejection is durable and retryable with source MCP + ${bundled ? "bundled" : "source"} Manager`, async (t) => {
  const h = mutationPrepareHarness(t); h.config.allowedCollections = ["Customer"];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rda-prepare-manager-")), key = randomBytes(32);
  const registry = new InstanceRegistry({ cwd: root, env: {}, registryPath: path.join(root, "instances.json") });
  registry.create({ id: "isolated", name: "Disposable", host: "fixture.invalid", username: "fixture", privateKeyPath: "/fixture",
    hostKeyFingerprints: ["SHA256:" + "A".repeat(43)], mongodb: h.config });
  const config = loadConfig({}, root); config.agent = { host: "127.0.0.1", port: 0 }; config.runtime.statePath = path.join(root, ".runtime", "state.json");
  const token = localAuth.ensureAuthToken(localAuth.resolveAuthFile(root));
  const service = new PrivacyService({ directory: path.join(root, "storage"), key,
    ...(bundled ? { workerPath: path.resolve(import.meta.dirname, "../runtime/agent/privacy-worker.cjs") } : {}) });
  const calls = [];
  const workerManager = { publicInstances: () => registry.list(), callInstance: async (id, route, request) => {
    calls.push({ id, route, request });
    if (route === "/mongodb/query") throw Object.assign(Error("Denied"), { code: "MONGODB_COLLECTION_NOT_ALLOWED", statusCode: 403, layer: "mongodb", phase: "validation", retriable: false });
    return { ok: true, instanceId: id, ...await h.run({ ...request, mode: route.endsWith("recover-prepare") ? "recover_prepare" : "prepare" }) };
  } };
  const runtime = bundled ? createRequire(import.meta.url)("../runtime/agent/server.cjs") : { createManagerApp };
  const server = http.createServer(runtime.createManagerApp({ config, registry, workerManager, privacyService: service, authToken: token }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  const options = { root, url: `http://127.0.0.1:${server.address().port}`, contextFile: path.join(root, "context.json") };
  let peer = await mcpPeer(t, options);
  const denied = await peer.call("remote_debug_mongodb_prepare_index", index);
  assert.equal(denied.payload.error.code, "MONGODB_COLLECTION_NOT_ALLOWED"); assert.equal(denied.payload.error.retriable, false);
  assert.equal(h.state.sshCalls, 0);
  const id = denied.payload.error.intentId; assert.match(id, /^[a-f0-9]{64}$/);
  const inspected = await peer.call("remote_debug_mongodb_recover_operation", { instanceId: "isolated", database: "business", intentId: id });
  assert.equal(inspected.payload.state, "rejected_before_dispatch");
  const mutationId = inspected.payload.mutationId;
  await peer.stop("SIGKILL"); peer = await mcpPeer(t, options);
  h.config.allowedCollections.push("orders");
  const prepared = await peer.call("remote_debug_mongodb_prepare_index", index);
  assert.equal(prepared.payload.status, "planned"); assert.equal(prepared.payload.mutationId, mutationId);
  const repeated = await peer.call("remote_debug_mongodb_prepare_index", { ...index, timeoutMs: 60000 });
  assert.equal(repeated.payload.planHash, prepared.payload.planHash); assert.equal(h.state.sshCalls, 1); assert.equal(h.state.writes, 0);
  const wrongScope = await peer.call("remote_debug_mongodb_recover_operation", { instanceId: "isolated", database: "other", intentId: id });
  assert.equal(wrongScope.payload.error.code, "BUSINESS_OPERATION_DENIED");
  const query = await peer.call("remote_debug_mongodb_query", { instanceId: "isolated", database: "business", operation: "countDocuments", collection: "orders" });
  assert.equal(query.payload.error.code, "MONGODB_COLLECTION_NOT_ALLOWED"); assert.equal(query.payload.error.retriable, false);
});

test("prepare success lost on delivery is cached across restart, never dispatched twice", async (t) => {
  const h = mutationPrepareHarness(t), instance = { id: "isolated", host: "fixture.invalid", mongodb: h.config };
  const f = await localMcp(t, { instance, handler: (route, body) => h.run({ ...body, mode: route.endsWith("recover-prepare") ? "recover_prepare" : "prepare" }) });
  f.dropNextReply("/mongodb/mutations/prepare");
  assert.equal((await f.call("remote_debug_mongodb_prepare_index", index)).isError, true);
  await f.restart();
  const recovered = await f.call("remote_debug_mongodb_prepare_index", index);
  assert.equal(recovered.payload.status, "planned"); assert.equal(h.state.sshCalls, 1); assert.equal(h.state.writes, 0);
});

test("lost remote prepare reply recovers by exact identity without a second prepare", async (t) => {
  const h = mutationPrepareHarness(t), instance = { id: "isolated", host: "fixture.invalid", mongodb: h.config };
  const f = await localMcp(t, { instance, handler: (route, body) => h.run({ ...body, mode: route.endsWith("recover-prepare") ? "recover_prepare" : "prepare" }) });
  h.state.dropReply = true;
  const lost = await f.call("remote_debug_mongodb_prepare_index", index); assert.equal(lost.isError, true);
  await f.restart();
  const recovered = await f.call("remote_debug_mongodb_recover_operation", { instanceId: "isolated", database: "business", intentId: lost.payload.error.intentId, mode: "reconcile" });
  assert.equal(recovered.payload.state, "prepared"); assert.equal(recovered.payload.result.status, "planned");
  const repeated = await f.call("remote_debug_mongodb_prepare_index", index);
  assert.equal(repeated.payload.planHash, recovered.payload.result.planHash);
  assert.equal(f.requests.filter((r) => r.path === "/mongodb/mutations/prepare").length, 1); assert.equal(h.state.writes, 0);
});

test("no-plan recovery fences the old attempt before the same intent can retry", async (t) => {
  const h = mutationPrepareHarness(t), instance = { id: "isolated", host: "fixture.invalid", mongodb: h.config }; let interrupted = true, oldTicket;
  const f = await localMcp(t, { instance, handler: (route, body) => {
    if (interrupted && route === "/mongodb/mutations/prepare") {
      interrupted = false; oldTicket = body._businessPrepare;
      h.state.beforeRead = () => { delete h.state.beforeRead; throw Error("prepare interrupted before manifest"); };
    }
    return h.run({ ...body, mode: route.endsWith("recover-prepare") ? "recover_prepare" : "prepare" });
  } });
  const lost = await f.call("remote_debug_mongodb_prepare_index", index);
  const recovered = await f.call("remote_debug_mongodb_recover_operation", { instanceId: "isolated", database: "business", intentId: lost.payload.error.intentId, mode: "reconcile" });
  assert.equal(recovered.payload.state, "rejected_before_dispatch"); assert.equal(recovered.payload.reason, "old_attempt_fenced");
  await assert.rejects(h.run({ ...index, kind: "index", mode: "prepare", _businessPrepare: oldTicket }), { code: "MONGODB_PREPARE_FENCED" });
  const prepared = await f.call("remote_debug_mongodb_prepare_index", index);
  assert.equal(prepared.payload.status, "planned"); assert.equal(prepared.payload.mutationId, oldTicket.mutationId); assert.equal(h.state.writes, 0);
});

test("validation rejection lost on delivery stays retryable after restart", async (t) => {
  const h = mutationPrepareHarness(t), instance = { id: "isolated", host: "fixture.invalid", mongodb: h.config };
  h.config.allowedCollections = ["Customer"];
  const f = await localMcp(t, { instance, handler: (route, body) => h.run({ ...body, mode: "prepare" }) });
  f.dropNextReply("/mongodb/mutations/prepare");
  const lost = await f.call("remote_debug_mongodb_prepare_index", index);
  assert.equal(lost.isError, true); assert.equal(h.state.sshCalls, 0);
  await f.restart(); h.config.allowedCollections.push("orders");
  const prepared = await f.call("remote_debug_mongodb_prepare_index", index);
  assert.equal(prepared.payload.status, "planned"); assert.equal(h.state.sshCalls, 1); assert.equal(h.state.writes, 0);
});

test("committed index with a lost response reconciles without repeating createIndex", async (t) => {
  const h = mutationPrepareHarness(t), instance = { id: "isolated", host: "fixture.invalid", mongodb: h.config };
  const f = await localMcp(t, { instance, handler: (route, body) => h.run({ ...body,
    mode: route.endsWith("/execute") ? "commit" : route.endsWith("/list") ? "list" : route.endsWith("/get") ? "get" : "prepare" }) });
  const prepared = await f.call("remote_debug_mongodb_prepare_index", index), plan = prepared.payload;
  const execute = { instanceId: "isolated", mutationId: plan.mutationId, planHash: plan.planHash, confirmation: "确认执行" };
  h.state.dropReply = true;
  const lost = await f.call("remote_debug_mongodb_execute_mutation", execute);
  assert.equal(lost.isError, true); assert.equal(h.state.writes, 1);
  await f.restart();
  const reconciled = await f.call("remote_debug_mongodb_recover_operation", { instanceId: "isolated", database: "business", intentId: lost.payload.error.intentId, mode: "reconcile" });
  assert.equal(reconciled.payload.state, "complete"); assert.equal(reconciled.payload.result.status, "committed");
  const repeated = await f.call("remote_debug_mongodb_execute_mutation", execute);
  assert.equal(repeated.payload.status, "committed"); assert.equal(h.state.writes, 1);
  assert.equal(f.requests.filter((r) => r.path === "/mongodb/mutations/execute").length, 1);
});
