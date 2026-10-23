import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { mcpPeer } from "./helpers/local-mcp.js";
import localAuth from "../local-auth.cjs";

for (const bundled of [false, true]) test(`persistent references across MCP + actual ${bundled ? "bundled" : "source"} Manager SIGKILL and lost remote acknowledgment`, { timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rda-privacy-restart-")), key = randomBytes(32);
  const contextFile = path.join(root, "context.json"), wire = [], diagnostics = [], requests = [];
  localAuth.ensureAuthToken(localAuth.resolveAuthFile(root));
  const raw = "PRIVATE_RESTART_ORDER_73001"; let executed = 0, crash = true, crashPrepare = true, prepareCalls = 0;
  let preparedIndex;
  const backend = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const input = JSON.parse(Buffer.concat(chunks));
    requests.push({ route: req.url, input });
    let result;
    if (req.url === "/mongodb/query") result = { database: "business", operation: "find", data: [{ _id: raw, apiKey: "PRIVATE_CREDENTIAL" }], resultCount: 1 };
    else if (req.url === "/mongodb/mutations/prepare") {
      prepareCalls++; preparedIndex = { status: "planned", mutationId: input._businessPrepare.mutationId, planHash: "d".repeat(64) };
      result = { ...preparedIndex, __crashAfterRemote: crashPrepare }; crashPrepare = false;
    }
    else if (req.url === "/mongodb/mutations/recover-prepare") result = { ...preparedIndex, prepare: input._businessPrepare, recovery: "prepared" };
    else if (req.url === "/mongodb/mutations/execute") { executed++; result = { status: "committed", mutationId: input.mutationId, planHash: input.planHash, __crashAfterRemote: crash }; crash = false; }
    else if (req.url === "/mongodb/mutations/list") result = { mutations: [{ mutationId: "mutation-uncertain", status: "committed" }] };
    else if (req.url === "/mongodb/mutations/recover-execution") result = { mutationId: input.mutationId, planHash: input.planHash,
      status: "commit_unknown", execution: input._businessExecution, indexRecovery: { reason: "execution_acknowledgement_required" } };
    else result = { database: "business", mutationId: "mutation-1", planHash: "a".repeat(64), affectedIds: [raw], affectedCount: 1 };
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, ...result }));
  });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  let manager, port = 0;
  async function start() {
    manager = fork(path.resolve(import.meta.dirname, "helpers/privacy-manager.mjs"), { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    manager.stderr.on("data", (b) => diagnostics.push(b.toString())); manager.stdout.on("data", (b) => diagnostics.push(b.toString()));
    const ready = once(manager, "message");
    manager.send({ root, port, key: key.toString("hex"), backend: `http://127.0.0.1:${backend.address().port}`, bundled });
    const [message] = await ready; assert.equal(message.ready, true); port = message.port;
  }
  async function killManager() { if (manager && manager.exitCode === null && manager.signalCode === null) { const done = once(manager, "exit"); manager.kill("SIGKILL"); await done; } }
  t.after(async () => { await killManager(); backend.closeAllConnections(); await new Promise((r) => backend.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  await start();
  const peer = () => mcpPeer(t, { root, url: `http://127.0.0.1:${port}`, contextFile, wire, diagnostics });
  const a = await peer();
  const found = await a.call("remote_debug_mongodb_query", { operation: "find", collection: "orders" });
  const ref = found.payload.data[0]._id; assert.match(ref, /^rda_ref_v1_/); assert.equal(found.payload.outputGuard.businessPrivacy.storage, "encrypted_sqlite");
  const b = await peer();
  const again = await b.call("remote_debug_mongodb_query", { operation: "find", collection: "orders", filter: { _id: ref } });
  assert.equal(again.payload.data[0]._id, ref); assert.equal(requests.at(-1).input.filter._id, raw);
  // Same-value output from another MCP process must use the unique stored alias.
  const same = await b.call("remote_debug_mongodb_query", { operation: "find", collection: "orders" }); assert.equal(same.payload.data[0]._id, ref);
  const foreign = await mcpPeer(t, { root, url: `http://127.0.0.1:${port}`, wire, diagnostics });
  const denied = await foreign.call("remote_debug_mongodb_query", { operation: "find", collection: "orders", filter: { _id: ref } });
  assert.equal(denied.payload.error.code, "BUSINESS_REFERENCE_INVALID"); await foreign.stop();
  const targetDenied = await b.call("remote_debug_mongodb_query", { operation: "find", collection: "orders", database: "other", filter: { _id: ref } });
  assert.equal(targetDenied.payload.error.code, "BUSINESS_REFERENCE_INVALID");
  await a.stop("SIGKILL"); await b.stop("SIGKILL"); await killManager(); await start();
  const c = await peer();
  const restored = await c.call("remote_debug_mongodb_query", { operation: "find", collection: "orders", filter: { _id: ref } });
  assert.equal(restored.payload.data[0]._id, ref); assert.equal(requests.at(-1).input.filter._id, raw);
  const lost = await c.call("remote_debug_mongodb_execute_mutation", { mutationId: "mutation-uncertain", planHash: "a".repeat(64), confirmation: "确认执行" });
  assert.equal(lost.isError, true); assert.equal(executed, 1);
  await c.stop("SIGKILL"); await start(); const d = await peer();
  const retry = await d.call("remote_debug_mongodb_execute_mutation", { mutationId: "mutation-uncertain", planHash: "a".repeat(64), confirmation: "确认执行" });
  assert.equal(retry.payload.error.code, "BUSINESS_OPERATION_RECONCILIATION_REQUIRED"); assert.equal(executed, 1);
  assert.equal(requests.at(-1).route, "/mongodb/mutations/recover-execution", "Read the exact remote journal, never replay the uncertain commit");
  assert.equal(requests.at(-1).input.planHash, "a".repeat(64));
  assert.match(requests.at(-1).input._businessExecution.intentId, /^[a-f0-9]{64}$/);
  const normal = { mutationId: "mutation-known", planHash: "b".repeat(64), confirmation: "确认执行" };
  const committed = await d.call("remote_debug_mongodb_execute_mutation", normal); assert.notEqual(committed.isError, true); assert.equal(executed, 2);
  const repeated = await d.call("remote_debug_mongodb_execute_mutation", normal); assert.notEqual(repeated.isError, true); assert.equal(executed, 2);
  const prepare = { kind: "index", operation: "createIndex", collection: "orders", name: "idx_restart", key: { customerId: 1 } };
  const lostPrepare = await d.call("remote_debug_mongodb_prepare_index", prepare);
  assert.equal(lostPrepare.isError, true); assert.equal(prepareCalls, 1);
  await d.stop("SIGKILL"); await start(); const e = await peer();
  const recoveredPrepare = await e.call("remote_debug_mongodb_prepare_index", prepare);
  assert.equal(recoveredPrepare.payload.status, "planned"); assert.equal(recoveredPrepare.payload.mutationId, preparedIndex.mutationId);
  assert.equal(prepareCalls, 1, "Manager SIGKILL must not create a replacement plan");
  // Authenticated local protocol rejects knowing a context ID without its capability.
  const saved = JSON.parse(await fs.readFile(contextFile));
  const bad = await fetch(`http://127.0.0.1:${port}/api/private/business-storage`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${localAuth.readAuthToken(localAuth.resolveAuthFile(root))}` },
    body: JSON.stringify({ action: "attach", auth: { contextId: saved.auth.contextId, capability: "0".repeat(64) } }) });
  assert.equal(bad.status, 409);
  const malformed = await fetch(`http://127.0.0.1:${port}/api/private/business-storage`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${localAuth.readAuthToken(localAuth.resolveAuthFile(root))}` }, body: '{"PRIVATE_MALFORMED_BUSINESS":invalid}' });
  assert.equal(malformed.status, 400); assert.doesNotMatch(await malformed.text(), /PRIVATE_MALFORMED_BUSINESS/);
  const unauth = await fetch(`http://127.0.0.1:${port}/api/private/business-storage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"create"}' }); assert.equal(unauth.status, 401);
  await e.stop(); await killManager();
  for (const filename of await fs.readdir(path.join(root, ".private", "business"))) {
    const data = await fs.readFile(path.join(root, ".private", "business", filename));
    for (const secret of [raw, "PRIVATE_CREDENTIAL", key.toString("hex"), saved.auth.capability]) assert.equal(data.includes(Buffer.from(secret)), false);
  }
  assert.doesNotMatch(wire.join("") + diagnostics.join(""), /PRIVATE_RESTART_ORDER|PRIVATE_CREDENTIAL|PRIVATE_MALFORMED_BUSINESS/);
  assert.ok(!wire.join("").includes(key.toString("hex"))); assert.ok(!wire.join("").includes(saved.auth.capability));
});
