import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { localMcp, mcpPeer } from "./helpers/local-mcp.js";
import { bulkSandboxFixture } from "../../../agent/test/helpers/bulk-sandbox-fixture.js";
import { normalizeMongoBulkChunk, runMongoBulk } from "../../../agent/mongodb-bulk.js";
import { createManagerApp } from "../../../agent/server.js";
import { InstanceRegistry } from "../../../agent/instance-registry.js";
import { loadConfig } from "../../../agent/config.js";
import { PrivacyService } from "../../../agent/privacy-service.js";
import localAuth from "../local-auth.cjs";

const chunk = { instanceId: "isolated", database: "business", jobId: "fixed-job", chunkIndex: 0, purpose: "redacted fixture",
  units: [{ unitId: "unit-1", operations: [{ operation: "updateOne", collection: "orders", id: "order-1",
    expected: { count: { exists: true, value: 0 } }, update: { $inc: { count: 3 } } }] }] };
const end = { ...chunk, chunkIndex: 1, units: [], endOfUpload: true };
async function fixture(t, hook = async (route, body, run) => run(route, body)) {
  const h = bulkSandboxFixture(t); await h.initialize();
  const run = (route, body) => h.run(route.endsWith("recover-prepare") ? { ...body, action: "recoverUpload" } : { action: "upload", chunk: body });
  const f = await localMcp(t, { instance: { id: "isolated", host: "fixture.invalid", mongodb: h.config }, handler: (route, body) => hook(route, body, run) });
  return { h, f };
}
const inspect = (f, intentId, mode = "inspect") => f.call("remote_debug_mongodb_recover_operation", { instanceId: "isolated", database: "business", intentId, mode });

test("bulk validation rejection is durable, preserves exact intent, and never dispatches", async (t) => {
  const { h, f } = await fixture(t);
  const bad = structuredClone(chunk); bad.units[0].operations[0].update = { $inc: { "rows.$.count": 3 } };
  const denied = await f.call("remote_debug_mongodb_prepare_bulk", bad);
  assert.equal(denied.payload.error.code, "MONGODB_BULK_FIELD_REJECTED");
  const intentId = denied.payload.error.intentId; assert.match(intentId, /^[a-f0-9]{64}$/);
  await f.restart();
  const recovered = await inspect(f, intentId, "reconcile");
  assert.equal(recovered.payload.state, "rejected_before_dispatch"); assert.equal(recovered.payload.legacy, false);
  const deniedAgain = await f.call("remote_debug_mongodb_prepare_bulk", bad);
  assert.equal(deniedAgain.payload.error.intentId, intentId);
  assert.equal((await inspect(f, intentId)).payload.attempt, 2);
  assert.equal(f.requests.length, 0); assert.equal(h.state.events.some((e) => e.action === "businessWrite"), false);
});

test("bulk pre-SSH worker rejection survives Manager config drift without being confused with a remote error", async (t) => {
  const { h, f } = await fixture(t, async (route, body) => runMongoBulk({ action: "upload", chunk: body },
    { config: { ...h.config, allowedCollections: [] }, runSSH: () => { throw Error("must not reach SSH"); } }));
  const denied = await f.call("remote_debug_mongodb_prepare_bulk", chunk);
  assert.equal(denied.payload.error.code, "MONGODB_COLLECTION_NOT_ALLOWED");
  assert.equal((await inspect(f, denied.payload.error.intentId)).payload.state, "rejected_before_dispatch");
});

for (const seal of [false, true]) test(`bulk ${seal ? "seal" : "chunk"} success lost between Manager and MCP survives restart without reupload`, async (t) => {
  const { h, f } = await fixture(t);
  if (seal) assert.equal((await f.call("remote_debug_mongodb_prepare_bulk", chunk)).payload.status, "uploading");
  f.dropNextReply("/mongodb/bulk/prepare");
  const lost = await f.call("remote_debug_mongodb_prepare_bulk", seal ? end : chunk);
  assert.equal(lost.isError, true); await f.restart();
  const repeated = await f.call("remote_debug_mongodb_prepare_bulk", seal ? end : chunk);
  assert.equal(repeated.payload.status, seal ? "prepared" : "uploading");
  assert.equal(f.requests.length, seal ? 2 : 1);
  assert.equal(h.rows("business", "orders").get("order-1").count, 0);
});

for (const seal of [false, true]) test(`lost worker ${seal ? "seal" : "chunk"} reply recovers exact durable evidence without replay`, async (t) => {
  let drop = false;
  const { h, f } = await fixture(t, async (route, body, run) => {
    const result = await run(route, body);
    if (drop && route === "/mongodb/bulk/prepare") { drop = false; throw Object.assign(Error("lost reply"), { code: "ECONNRESET" }); }
    return result;
  });
  if (seal) await f.call("remote_debug_mongodb_prepare_bulk", chunk);
  drop = true;
  const lost = await f.call("remote_debug_mongodb_prepare_bulk", seal ? end : chunk);
  assert.equal(lost.isError, true); await f.restart();
  const recovered = await inspect(f, lost.payload.error.intentId, "reconcile");
  assert.equal(recovered.payload.state, "complete"); assert.equal(recovered.payload.legacy, false);
  assert.equal(recovered.payload.result.status, seal ? "prepared" : "uploading");
  const repeated = await f.call("remote_debug_mongodb_prepare_bulk", seal ? end : chunk);
  assert.equal(repeated.payload.chunkHash, recovered.payload.result.chunkHash);
  assert.equal(f.requests.filter((r) => r.path === "/mongodb/bulk/prepare").length, seal ? 2 : 1);
  assert.equal(h.rows("business", "orders").get("order-1").count, 0);
});

test("disconnect after dispatch with no remote receipt stays uncertain, never inferred from missing job", async (t) => {
  const { f } = await fixture(t, async (route, body, run) => {
    if (route === "/mongodb/bulk/prepare") throw Object.assign(Error("connection lost before helper ack"), { code: "ECONNRESET", phase: "validation" });
    return run(route, body);
  });
  const lost = await f.call("remote_debug_mongodb_prepare_bulk", chunk);
  const recovered = await inspect(f, lost.payload.error.intentId, "reconcile");
  assert.equal(recovered.payload.state, "uncertain"); assert.equal(recovered.payload.reason, "bulk_prepare_evidence_required");
  assert.equal(recovered.payload.legacy, false);
  assert.equal((await f.call("remote_debug_mongodb_prepare_bulk", chunk)).payload.error.code, "BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
  assert.equal(f.requests.filter((r) => r.path === "/mongodb/bulk/prepare").length, 1);
});

test("wrong chunk evidence and partial seal cannot complete an exact bulk intent", async (t) => {
  const { f, h } = await fixture(t, async (route, body, run) => {
    if (route === "/mongodb/bulk/prepare") { await run(route, body); throw Object.assign(Error("lost"), { code: "ECONNRESET" }); }
    if (route.endsWith("recover-prepare")) return { jobId: body.jobId, chunkIndex: body.chunkIndex, chunkHash: "0".repeat(64), status: "prepared", planHash: "a".repeat(64) };
    return {};
  });
  const lost = await f.call("remote_debug_mongodb_prepare_bulk", chunk);
  assert.equal((await inspect(f, lost.payload.error.intentId, "reconcile")).payload.state, "uncertain");
  // Real helper must also reject a caller-selected digest and seal marker.
  const uploaded = h.read(chunk.jobId, "manifest.json");
  await assert.rejects(h.run({ action: "recoverUpload", jobId: chunk.jobId, database: "business", chunkIndex: 0, chunkHash: "0".repeat(64), endOfUpload: false }), { code: "MONGODB_BULK_RECOVERY_EVIDENCE_MISMATCH" });
  await assert.rejects(h.run({ action: "recoverUpload", jobId: chunk.jobId, database: "business", chunkIndex: 0, chunkHash: uploaded.chunks[0], endOfUpload: true }), { code: "MONGODB_BULK_RECOVERY_EVIDENCE_MISMATCH" });
});

for (const bundled of [false, true]) test(`bulk preparation uses audited ${bundled ? "bundled" : "source"} Manager with exact receipts and durable rejection`, async (t) => {
  const h = bulkSandboxFixture(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rda-bulk-manager-"));
  const registry = new InstanceRegistry({ cwd: root, env: {}, registryPath: path.join(root, "instances.json") });
  registry.create({ id: "isolated", name: "Disposable", host: "fixture.invalid", username: "fixture", privateKeyPath: "/fixture",
    hostKeyFingerprints: ["SHA256:" + "A".repeat(43)], mongodb: h.config });
  const config = loadConfig({}, root); config.agent = { host: "127.0.0.1", port: 0 }; config.runtime.statePath = path.join(root, ".runtime", "state.json");
  const token = localAuth.ensureAuthToken(localAuth.resolveAuthFile(root));
  const service = new PrivacyService({ directory: path.join(root, "storage"), key: randomBytes(32),
    ...(bundled ? { workerPath: path.resolve(import.meta.dirname, "../runtime/agent/privacy-worker.cjs") } : {}) });
  const calls = [];
  const workerManager = { publicInstances: () => registry.list(), callInstance: async (id, route, request) => {
    calls.push({ id, route });
    const normalized = normalizeMongoBulkChunk(request, h.config);
    return { ok: true, jobId: normalized.jobId, chunkIndex: normalized.chunkIndex, chunkHash: normalized.chunkHash, status: "uploading", unitCount: normalized.units.length };
  } };
  const runtime = bundled ? createRequire(import.meta.url)("../runtime/agent/server.cjs") : { createManagerApp };
  const server = http.createServer(runtime.createManagerApp({ config, registry, workerManager, privacyService: service, authToken: token }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  const peer = await mcpPeer(t, { root, url: `http://127.0.0.1:${server.address().port}`, contextFile: path.join(root, "context.json") });
  const bad = structuredClone(chunk); bad.units[0].operations[0].update = { $inc: { "rows.$.value": 1 } };
  const denied = await peer.call("remote_debug_mongodb_prepare_bulk", bad);
  assert.equal(denied.payload.error.code, "MONGODB_BULK_FIELD_REJECTED");
  const recovery = await peer.call("remote_debug_mongodb_recover_operation", { instanceId: "isolated", database: "business", intentId: denied.payload.error.intentId, mode: "reconcile" });
  assert.equal(recovery.payload.state, "rejected_before_dispatch"); assert.equal(calls.length, 0);
  const upload = { ...chunk, units: Array.from({ length: 3 }, (_, i) => ({ unitId: "member-" + i, operations: [{ operation: "insertOne", collection: "orders", document: { _id: "member-" + i, payload: "redacted fixture" } }] })) };
  const uploaded = await peer.call("remote_debug_mongodb_prepare_bulk", upload);
  assert.equal(uploaded.payload.status, "uploading", JSON.stringify(uploaded.payload)); assert.equal(uploaded.payload.unitCount, 3);
  const repeated = await peer.call("remote_debug_mongodb_prepare_bulk", upload);
  assert.equal(repeated.payload.chunkHash, uploaded.payload.chunkHash); assert.equal(calls.length, 1);
});

test("partial seal keeps exact job and uncertain protection without rebuilding or executing", async (t) => {
  const { h, f } = await fixture(t);
  await f.call("remote_debug_mongodb_prepare_bulk", chunk);
  h.rows("business", "orders").get("order-1").count = 8;
  const failed = await f.call("remote_debug_mongodb_prepare_bulk", end);
  assert.equal(failed.payload.error.code, "MONGODB_BULK_ORIGINAL_VALUE_MISMATCH");
  assert.equal(h.read(chunk.jobId, "manifest.json").status, "prepare_failed");
  const recovery = await inspect(f, failed.payload.error.intentId, "reconcile");
  assert.equal(recovery.payload.state, "uncertain"); assert.equal(recovery.payload.reason, "bulk_prepare_evidence_required");
  assert.equal(recovery.payload.recoveryCode, "MONGODB_BULK_PREPARE_UNRESOLVED");
  assert.equal(f.requests.filter((r) => r.path === "/mongodb/bulk/prepare").length, 2);
  assert.equal(h.rows("business", "orders").get("order-1").count, 8);
  assert.equal(h.state.events.some((e) => e.action === "businessWrite"), false);
});

test("a mismatched initial acknowledgement cannot be delivered as prepare success", async (t) => {
  const { f } = await fixture(t, async (route, body, run) => {
    const result = await run(route, body);
    return route === "/mongodb/bulk/prepare" ? { ...result, chunkHash: "0".repeat(64) } : result;
  });
  const response = await f.call("remote_debug_mongodb_prepare_bulk", chunk);
  assert.equal(response.isError, true); assert.equal(response.payload.error.code, "BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
  assert.equal((await inspect(f, response.payload.error.intentId)).payload.state, "uncertain");
  const recovered = await inspect(f, response.payload.error.intentId, "reconcile");
  assert.equal(recovered.payload.state, "complete"); assert.equal(recovered.payload.recoveryCode, undefined);
  assert.equal(f.requests.filter((r) => r.path === "/mongodb/bulk/prepare").length, 1);
});
