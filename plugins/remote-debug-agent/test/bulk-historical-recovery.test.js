import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { localMcp } from "./helpers/local-mcp.js";
import { PrivacyStore } from "../../../agent/privacy-store.js";
import { bulkSandboxFixture } from "../../../agent/test/helpers/bulk-sandbox-fixture.js";
import { bulkPreparePayload } from "../prepare-protocol.js";
import { businessTargetScope } from "../business-privacy.js";
import { createOutputGuard } from "../output-guard.js";

const base = { instanceId: "isolated", jobId: "historical-job", database: "business", chunkIndex: 0,
  units: [{ unitId: "unit-1", operations: [{ operation: "updateOne", collection: "orders", id: "order-1",
    expected: { count: { exists: true, value: 0 } }, update: { $inc: { count: 3 } } }] }], purpose: "legacy fixture" };
const wire = (value) => JSON.parse(JSON.stringify(bulkPreparePayload(value)));

async function fixture(t, { seal = false, remote = "present", original = base, reply, diagnosticAudit = false } = {}) {
  const h = bulkSandboxFixture(t); await h.initialize();
  const { instanceId, ...dataChunk } = original;
  if (remote === "present") await h.run({ action: "upload", chunk: dataChunk });
  const candidate = seal ? { ...original, chunkIndex: 1, units: [], endOfUpload: true } : original;
  if (seal && remote === "present") await h.run({ action: "upload", chunk: (({ instanceId, ...chunk }) => chunk)(candidate) });
  const instance = { id: "isolated", host: "fixture.invalid", mongodb: h.config };
  let auth, id, scope;
  const f = await localMcp(t, { instance,
    beforePeer: ({ directory, key, root, origin }) => {
      const store = new PrivacyStore({ directory, key });
      auth = store.execute("create"); scope = businessTargetScope(origin, instance, "business");
      const request = createOutputGuard().sanitize(wire(candidate)).value;
      // The real old intent protocol: no dispatch digest, prepare ticket or
      // patched row. This fixture only initializes its own disposable database.
      id = store.execute("intent", { auth, scope, route: "/mongodb/bulk/prepare", request,
        identity: { instanceId: instance.id, jobId: candidate.jobId, chunkIndex: candidate.chunkIndex } }).id;
      store.close();
      fs.writeFileSync(path.join(root, "context.json"), JSON.stringify({ version: 1, origin, auth }), { mode: 0o600 });
      if (diagnosticAudit) {
        const time = new Date().toISOString(), operationId = "old-failed-operation", toolName = "remote_debug_mongodb_prepare_bulk";
        fs.mkdirSync(path.join(root, "logs"), { recursive: true, mode: 0o700 });
        fs.mkdirSync(path.join(root, ".remote-debug", "instances", instance.id), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(root, "logs", "mcp-error.log"), [
          { time, code: "MCP_TOOLS_CALL_STARTED", operationId, toolName, arguments: { instanceId: instance.id, jobId: candidate.jobId, chunkIndex: candidate.chunkIndex } },
          { time, code: "MCP_TOOLS_CALL_FAILED", operationId, toolName, error: { code: "MONGODB_BULK_FIELD_REJECTED" } },
        ].map(x => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
        fs.writeFileSync(path.join(root, ".remote-debug", "instances", instance.id, "audit.jsonl"), JSON.stringify({ time, tool: "mongodb-bulk-upload", operationId,
          ok: false, errorCode: "MONGODB_BULK_FIELD_REJECTED", errorLayer: "mongodb-bulk", errorPhase: "validation",
          intentId: id, requestDigest: "a".repeat(64), dispatchState: "not_dispatched" }) + "\n", { mode: 0o600 });
      }
    },
    handler: async (route, body) => {
      if (route !== "/mongodb/bulk/recover-prepare") throw Error("historical recovery must not call upload or execute: " + route);
      const result = await h.run({ ...body, action: "recoverUpload" });
      return reply ? reply(result) : result;
    },
  });
  const inspect = () => f.call("remote_debug_mongodb_recover_operation", { instanceId: "isolated", database: "business", intentId: id });
  const history = (request = candidate, extra = {}) => f.call("remote_debug_mongodb_recover_operation", {
    instanceId: "isolated", database: "business", intentId: id, mode: "historical", ...(request ? { originalRequest: request } : {}), ...extra,
  });
  return { h, f, id, candidate, inspect, history };
}

for (const seal of [false, true]) test(`legacy ${seal ? "seal" : "chunk"} recovers the original keyed intent from exact durable evidence without replay`, async (t) => {
  const { f, h, id, inspect, history, candidate } = await fixture(t, { seal });
  assert.equal((await inspect()).payload.legacy, true);
  const recovered = await history();
  assert.equal(recovered.payload.state, "complete", JSON.stringify(recovered.payload));
  assert.equal(recovered.payload.intentId, id); assert.equal(recovered.payload.legacy, true);
  assert.equal(recovered.payload.history.requestMatched, true);
  assert.equal(recovered.payload.history.evidence, "exact_remote_chunk");
  assert.equal(recovered.payload.result.status, seal ? "prepared" : "uploading");
  await f.restart();
  assert.equal((await history()).payload.state, "complete");
  const cached = await f.call("remote_debug_mongodb_prepare_bulk", candidate);
  assert.equal(cached.payload.chunkHash, recovered.payload.result.chunkHash);
  assert.deepEqual(f.requests.map(r => r.path), ["/mongodb/bulk/recover-prepare"]);
  assert.equal(h.rows("business", "orders").get("order-1").count, 0);
  assert.equal(h.state.events.some(e => e.action === "businessWrite"), false);
});

test("plain historical audit and a missing job leave the exact protected record unchanged even with matching input", async (t) => {
  const { history, inspect, f } = await fixture(t, { remote: "absent", diagnosticAudit: true });
  const before = await history(null);
  assert.equal(before.payload.reason, "historical_request_required");
  const recovered = await history();
  assert.equal(recovered.payload.state, "uncertain");
  assert.equal(recovered.payload.reason, "historical_dispatch_evidence_required");
  assert.equal(recovered.payload.history.requestMatched, true);
  assert.equal(recovered.payload.history.remoteEvidenceCode, "MONGODB_BULK_JOB_NOT_FOUND");
  assert.equal(recovered.payload.history.diagnostics.worker.matches[0].validationRejected, true);
  assert.equal(recovered.payload.history.diagnostics.intentBound, false);
  const after = await history(null);
  assert.equal(after.payload.history.recordFingerprint, before.payload.history.recordFingerprint);
  assert.equal((await inspect()).payload.state, "uncertain");
  assert.equal(f.requests.every(r => r.path === "/mongodb/bulk/recover-prepare"), true);
});

for (const mutation of ["amount", "job", "chunk", "purpose", "database", "instance"]) test(`legacy candidate ${mutation} mismatch cannot become recovery evidence`, async (t) => {
  const { history, f, candidate } = await fixture(t);
  const changed = structuredClone(candidate);
  if (mutation === "amount") changed.units[0].operations[0].update.$inc.count++;
  if (mutation === "job") changed.jobId = "replacement-job";
  if (mutation === "chunk") changed.chunkIndex++;
  if (mutation === "purpose") changed.purpose += " changed";
  if (mutation === "database") changed.database = "other";
  if (mutation === "instance") changed.instanceId = "other";
  const r = await history(changed);
  if (["database", "instance"].includes(mutation)) assert.equal(r.payload.error.code, "BUSINESS_OPERATION_DENIED");
  else { assert.equal(r.payload.state, "uncertain"); assert.equal(r.payload.reason, "historical_request_mismatch"); }
  assert.equal(f.requests.length, 0);
});

for (const field of ["jobId", "chunkHash", "chunkIndex"]) test(`legacy remote ${field} mismatch cannot discharge the original intent`, async (t) => {
  const { history, inspect } = await fixture(t, { reply: (r) => ({ ...r, [field]: field === "chunkIndex" ? 8 : "0".repeat(64) }) });
  const before = await history(null), r = await history();
  assert.equal(r.payload.state, "uncertain"); assert.equal(r.payload.reason, "historical_dispatch_evidence_required");
  assert.equal((await history(null)).payload.history.recordFingerprint, before.payload.history.recordFingerprint);
  assert.equal((await inspect()).payload.state, "uncertain");
});

test("legacy identity that lost credential bytes cannot adopt a matching redacted request", async (t) => {
  const original = structuredClone(base);
  original.units[0].operations.push({ operation: "insertOne", collection: "orders", document: { _id: "secret-row", password: "fixture-password" } });
  const { history, f } = await fixture(t, { original });
  const r = await history();
  assert.equal(r.payload.state, "uncertain"); assert.equal(r.payload.reason, "historical_original_bytes_unbound");
  assert.equal(f.requests.length, 0);
});

test("legacy recovery cannot accept a caller proof or create a replacement job by unknown request fields", async (t) => {
  const { history, candidate, f } = await fixture(t);
  const r = await history({ ...candidate, notDispatched: true, result: { ok: true } });
  assert.equal(r.isError, true); assert.equal(r.payload.error.code, "BUSINESS_OPERATION_DENIED");
  assert.equal(f.requests.length, 0);
});

test("completed historical recovery still rejects a different candidate and a different context scope", async (t) => {
  const { history, candidate, f, id } = await fixture(t);
  assert.equal((await history()).payload.state, "complete");
  const changed = structuredClone(candidate); changed.units[0].operations[0].update.$inc.count = 9;
  assert.equal((await history(changed)).payload.error.code, "BUSINESS_OPERATION_DENIED");
  const wrongScope = await f.call("remote_debug_mongodb_recover_operation", { instanceId: "isolated", database: "other", intentId: id, mode: "historical" });
  assert.equal(wrongScope.payload.error.code, "BUSINESS_OPERATION_DENIED");
  assert.equal(f.requests.length, 1);
});

for (const bundled of [false, true]) test(`original legacy envelope recovers through real ${bundled ? "bundled" : "source"} Manager route and store`, async (t) => {
  const { createManagerApp } = await import("../../../agent/server.js");
  const { InstanceRegistry } = await import("../../../agent/instance-registry.js");
  const { loadConfig } = await import("../../../agent/config.js");
  const { PrivacyService } = await import("../../../agent/privacy-service.js");
  const { randomBytes } = await import("node:crypto"), { createRequire } = await import("node:module");
  const http = await import("node:http"), os = await import("node:os");
  const { mcpPeer } = await import("./helpers/local-mcp.js"), { default: localAuth } = await import("../local-auth.cjs");
  const h = bulkSandboxFixture(t); await h.initialize();
  await h.run({ action: "upload", chunk: (({ instanceId, ...chunk }) => chunk)(base) });
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rda-history-manager-")), directory = path.join(root, "storage"), key = randomBytes(32);
  const registry = new InstanceRegistry({ cwd: root, env: {}, registryPath: path.join(root, "instances.json") });
  registry.create({ id: "isolated", name: "Disposable", host: "fixture.invalid", username: "fixture", privateKeyPath: "/fixture", hostKeyFingerprints: ["SHA256:" + "A".repeat(43)], mongodb: h.config });
  const instance = registry.getInternal("isolated"), config = loadConfig({}, root);
  config.agent = { host: "127.0.0.1", port: 0 }; config.runtime.statePath = path.join(root, ".runtime", "state.json");
  const authToken = localAuth.ensureAuthToken(localAuth.resolveAuthFile(root));
  const service = new PrivacyService({ directory, key, ...(bundled ? { workerPath: path.resolve(import.meta.dirname, "../runtime/agent/privacy-worker.cjs") } : {}) });
  const calls = [];
  const workerManager = { publicInstances: () => registry.list(), callInstance: async (id, route, request) => {
    assert.equal(route, "/mongodb/bulk/recover-prepare"); calls.push(route);
    return { ok: true, instanceId: id, ...await h.run({ ...request, action: "recoverUpload" }) };
  } };
  const runtime = bundled ? createRequire(import.meta.url)("../runtime/agent/server.cjs") : { createManagerApp };
  const server = http.createServer(runtime.createManagerApp({ config, registry, workerManager, privacyService: service, authToken }));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.promises.rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, scope = businessTargetScope(origin, instance, "business");
  const old = new PrivacyStore({ directory, key }), auth = old.execute("create"), request = wire(base);
  const intent = old.execute("intent", { auth, scope, route: "/mongodb/bulk/prepare", request, identity: { instanceId: instance.id, jobId: base.jobId, chunkIndex: 0 } });
  old.close(); const contextFile = path.join(root, "context.json"); fs.writeFileSync(contextFile, JSON.stringify({ version: 1, origin, auth }), { mode: 0o600 });
  const peer = await mcpPeer(t, { root, url: origin, contextFile });
  const result = await peer.call("remote_debug_mongodb_recover_operation", { instanceId: instance.id, database: "business", intentId: intent.id, mode: "historical", originalRequest: base });
  assert.equal(result.payload.state, "complete", JSON.stringify(result.payload)); assert.equal(result.payload.intentId, intent.id);
  assert.equal(result.payload.history.requestMatched, true); assert.equal(result.payload.history.diagnostics.mcp.status, "read");
  assert.equal(result.payload.history.diagnostics.candidateCount, 0, "current MCP startup logs are not old dispatch evidence");
  assert.deepEqual(calls, ["/mongodb/bulk/recover-prepare"]); assert.equal(h.rows("business", "orders").get("order-1").count, 0);
});

test("a literal redaction placeholder cannot stand in for lost historical credential bytes", async (t) => {
  const original = structuredClone(base);
  original.units[0].operations.push({ operation: "insertOne", collection: "orders", document: { _id: "private-row", password: "original-private-bytes" } });
  const { history, candidate, f } = await fixture(t, { original, remote: "absent" });
  const redacted = structuredClone(candidate); redacted.units[0].operations[1].document.password = "[REDACTED]";
  const r = await history(redacted);
  assert.equal(r.payload.history.requestMatched, true, "legacy redacted identity is intentionally non-injective");
  assert.equal(r.payload.state, "uncertain"); assert.equal(r.payload.reason, "historical_original_bytes_unbound");
  assert.equal(f.requests.length, 0, "cannot query or adopt a chunk using guessed redacted original bytes");
});
