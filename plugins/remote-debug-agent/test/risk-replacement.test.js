import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import { PrivacyStore } from "../../../agent/privacy-store.js";
import { PrivacyService } from "../../../agent/privacy-service.js";
import { createManagerApp } from "../../../agent/server.js";
import { InstanceRegistry } from "../../../agent/instance-registry.js";
import { loadConfig } from "../../../agent/config.js";
import { bulkSandboxFixture } from "../../../agent/test/helpers/bulk-sandbox-fixture.js";
import { FENCE_COVERAGE, digest } from "../../../agent/mongodb-fence-authority.js";
import { mcpPeer } from "./helpers/local-mcp.js";
import { businessTargetScope } from "../business-privacy.js";
import { bulkPreparePayload } from "../prepare-protocol.js";
import localAuth from "../local-auth.cjs";
const wire = v => JSON.parse(JSON.stringify(bulkPreparePayload(v)));

for (const bundled of [false, true]) test(`public MCP and ${bundled ? "bundled" : "source"} Manager require human approval before any replacement upload`, { skip: process.platform === "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rda-risk-mcp-")); fs.chmodSync(root, 0o700);
  const directory = path.join(root, "storage"), key = randomBytes(32), trustFile = path.join(root, "authority.json"), receiptDirectory = path.join(root, "receipts");
  fs.mkdirSync(receiptDirectory, { mode: 0o700 });
  const authority = generateKeyPairSync("ed25519");
  fs.writeFileSync(trustFile, JSON.stringify({ version: 1, issuer: "fixture-authority", boundaryType: "externally-enforced-legacy-retirement-v1", publicKey: authority.publicKey.export({ type: "spki", format: "pem" }) }), { mode: 0o600 });
  const h = bulkSandboxFixture(t); await h.initialize();
  const registry = new InstanceRegistry({ cwd: root, env: {}, registryPath: path.join(root, "instances.json") });
  registry.create({ id: "isolated", host: "fixture.invalid", username: "fixture", privateKeyPath: "/fixture", hostKeyFingerprints: ["SHA256:" + "A".repeat(43)], mongodb: h.config });
  const instance = registry.getInternal("isolated"), config = loadConfig({}, root), token = localAuth.ensureAuthToken(localAuth.resolveAuthFile(root));
  config.agent = { host: "127.0.0.1", port: 0 }; config.runtime.statePath = path.join(root, ".runtime", "state.json");
  const service = new PrivacyService({ directory, key, fenceAuthority: { trustFile, receiptDirectory }, ...(bundled ? { workerPath: path.resolve(import.meta.dirname, "../runtime/agent/privacy-worker.cjs") } : {}) });
  const calls = []; let nativeChecks = 0;
  const workerManager = { publicInstances: () => registry.list(), callInstance: async (id, route, request) => {
    if (route === "/mongodb/bulk/job") return { ok: true, ...await h.run({ action: "get", jobId: request.jobId }) };
    calls.push(route);
    if (route === "/mongodb/bulk/retire") { const { operationId, timeoutMs, deadlineAt, ...body } = request; return { ok: true, ...await h.run({ action: "retire", ...body }) }; }
    assert.equal(route, "/mongodb/bulk/prepare", "only approved preparation is dispatched");
    const { operationId, timeoutMs, deadlineAt, ...chunk } = request;
    return { ok: true, instanceId: id, ...await h.run({ action: "upload", chunk }) };
  } };
  const runtime = bundled ? createRequire(import.meta.url)("../runtime/agent/server.cjs") : { createManagerApp };
  const app = runtime.createManagerApp({ config, registry, workerManager, privacyService: service, authToken: token,
    manualOptions: { ownerVerification: { status: () => ({ supported: true }), verify: async () => { nativeChecks++; } } } });
  const server = http.createServer(app); await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { await app.locals.manualWorkbench.close(); await service.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, scope = businessTargetScope(origin, instance, "business");
  const original = wire({ instanceId: instance.id, database: "business", jobId: "old-job", chunkIndex: 0, purpose: "isolated test", units: [
    { unitId: "one", operations: [{ operation: "updateOne", collection: "orders", id: "order-1", expected: { count: { exists: true, value: 0 } }, update: { $inc: { count: 3 } } }] },
  ] });
  const oldStore = new PrivacyStore({ directory, key }), auth = oldStore.execute("create");
  const old = oldStore.execute("intent", { auth, scope, route: "/mongodb/bulk/prepare", request: original, identity: { instanceId: instance.id, jobId: original.jobId, chunkIndex: 0 } }); oldStore.close();
  const contextFile = path.join(root, "context.json"); fs.writeFileSync(contextFile, JSON.stringify({ version: 1, origin, auth }), { mode: 0o600 });
  const peer = await mcpPeer(t, { root, url: origin, contextFile });
  const target = { instanceId: instance.id, database: "business" }, disposition = args => peer.call("remote_debug_mongodb_disposition", { ...target, ...args });
  const base = (await disposition({ mode: "prepare", intentId: old.id, originalRequest: original })).payload;
  await disposition({ mode: "quarantine", dispositionId: base.dispositionId, reviewHash: base.reviewHash, confirmation: "确认隔离原意图" });
  const replacement = { ...original, jobId: "new-approved-job" };
  const proposal = await disposition({ mode: "prepare_risk", dispositionId: base.dispositionId, reviewHash: base.reviewHash, originalRequest: original, replacementRequest: replacement });
  assert.notEqual(proposal.isError, true, JSON.stringify(proposal)); const plan = proposal.payload;
  assert.equal(plan.humanConfirmationRequired, true); assert.equal(plan.remoteFenceConfirmed, false); assert.equal(calls.length, 0);
  assert.equal(plan.approvalPolicy, "human-risk-acceptance-v2");
  assert.equal(plan.canApprove, true);
  const unapproved = await disposition({ mode: "create_replacement", riskPlanId: plan.riskPlanId, reviewHash: plan.reviewHash });
  assert.equal(unapproved.payload.error.code, "BUSINESS_REPLACEMENT_HUMAN_CONFIRMATION_REQUIRED");
  for (const extra of [{ humanApproved: true }, { actor: { username: "admin" } }, { fenceReceipt: {} }]) {
    assert.equal((await disposition({ mode: "create_replacement", riskPlanId: plan.riskPlanId, reviewHash: plan.reviewHash, ...extra })).isError, true);
  }
  const updated = (await disposition({ mode: "inspect_risk", riskPlanId: plan.riskPlanId })).payload;
  assert.equal(updated.canApprove, true); assert.equal(updated.remoteFenceConfirmed, false); assert.equal(updated.humanApproved, false);
  assert.equal((await disposition({ mode: "create_replacement", riskPlanId: plan.riskPlanId, reviewHash: updated.reviewHash })).isError, true);
  const workbench = app.locals.manualWorkbench;
  await workbench.store.register("admin", "isolated-risk-mcp-password-123");
  const admin = await workbench.login({ username: "admin", password: "isolated-risk-mcp-password-123", instanceId: instance.id }); await workbench.start();
  const human = async (route, body) => { const response = await fetch(workbench.origin + route, { method: "POST", headers: { Authorization: `Bearer ${admin.token}`, Origin: workbench.origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, value: await response.json() }; };
  const reviewed = await human("/api/risk-replacement/review", { riskPlanId: plan.riskPlanId }); assert.equal(reviewed.status, 200);
  const approved = await human("/api/risk-replacement/approve", { riskPlanId: plan.riskPlanId, reviewHash: reviewed.value.reviewHash, confirmation: reviewed.value.confirmation });
  assert.equal(approved.status, 200, JSON.stringify(approved)); assert.equal(nativeChecks, 1); assert.equal(calls.length, 0);
  const created = await disposition({ mode: "create_replacement", riskPlanId: plan.riskPlanId, reviewHash: approved.value.reviewHash });
  assert.notEqual(created.isError, true, JSON.stringify(created)); assert.equal(created.payload.result.jobId, replacement.jobId);
  assert.equal(created.payload.historicalOutcome, "unknown"); assert.equal(created.payload.humanApproved, true);
  await disposition({ mode: "create_replacement", riskPlanId: plan.riskPlanId, reviewHash: approved.value.reviewHash });
  assert.deepEqual(calls, ["/mongodb/bulk/retire", "/mongodb/bulk/prepare", "/mongodb/bulk/retire"]);
  const sealed = await peer.call("remote_debug_mongodb_prepare_bulk", { ...replacement, chunkIndex: 1, units: [], endOfUpload: true });
  assert.notEqual(sealed.isError, true, JSON.stringify(sealed)); assert.equal(sealed.payload.status, "prepared");
  const state = (await disposition({ mode: "inspect_risk", riskPlanId: plan.riskPlanId })).payload;
  assert.equal(state.state, "prepared"); assert.equal(state.planHash, sealed.payload.planHash);
  const deniedOld = await peer.call("remote_debug_mongodb_prepare_bulk", original);
  assert.equal(deniedOld.payload.error.code, "BUSINESS_ORIGINAL_JOB_TERMINATED");
  assert.equal(h.rows("business", "orders").get("order-1").count, 0); assert.equal(h.state.events.some(x => x.action === "businessWrite"), false);
  const oldState = await peer.call("remote_debug_mongodb_recover_operation", { ...target, intentId: old.id });
  assert.equal(oldState.payload.state, "uncertain");
});
