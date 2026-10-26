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
import { mcpPeer } from "./helpers/local-mcp.js";
import { businessTargetScope } from "../business-privacy.js";
import { bulkPreparePayload, prepareRequestDigest } from "../prepare-protocol.js";
import localAuth from "../local-auth.cjs";

// Synthetic data only. No authority, receipt, native approval or remote worker.
function fullFirstChunk() {
  const jobId = "synthetic-original";
  return JSON.parse(JSON.stringify(bulkPreparePayload({ instanceId: "isolated", database: "business", jobId, chunkIndex: 0, purpose: "synthetic admission regression", units: [
    { unitId: "group", operations: [{ operation: "updateOne", collection: "groups", id: "fixture-group", expected: { count: { exists: true, value: 0 } }, update: { $inc: { count: 33 } } }] },
    ...Array.from({ length: 33 }, (_, i) => ({ unitId: `member-${i}`, operations: [
      { operation: "updateOne", collection: "members", id: `member-${i}`, expected: { "balances.0.value": { exists: true, value: 0 }, "balances.0.group_id": { exists: true, value: "fixture-group" }, "batches.0": { exists: false } },
        update: { $inc: { "balances.0.value": 3 }, $set: { "batches.0": { _id: `batch-${i}`, date: "2025-10-26", value: 3 } } } },
      ...["earned", "restored"].map(kind => ({ operation: "insertOne", collection: "ledger", document: { _id: `${kind}-${i}`, member_id: `member-${i}`, remediation_job_id: jobId, value: 3, batches: [{ date: "2025-10-26", expiresAt: { $date: "2027-10-26T00:00:00.000Z" }, value: 3 }] } })),
    ] })),
  ] })));
}

for (const bundled of [false, true]) test(`full insertOne first chunk admits risk review through public stdio MCP and ${bundled ? "candidate runtime" : "source"} Manager`, { skip: process.platform === "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rda-risk-input-")); fs.chmodSync(root, 0o700);
  const directory = path.join(root, "storage"), key = randomBytes(32);
  const registry = new InstanceRegistry({ cwd: root, env: {}, registryPath: path.join(root, "instances.json") });
  registry.create({ id: "isolated", host: "fixture.invalid", username: "fixture", privateKeyPath: "/nonexistent-fixture-key", hostKeyFingerprints: ["SHA256:" + "A".repeat(43)],
    mongodb: { enabled: true, writeEnabled: true, bulkEnabled: true, database: "business", allowedDatabases: ["business"], allowedCollections: ["groups", "members", "ledger"], configPath: "/fixture/config.json", driverPath: "/fixture/mongodb", configProfile: "fixture", uriKey: "url" } });
  const instance = registry.getInternal("isolated"), config = loadConfig({}, root), token = localAuth.ensureAuthToken(localAuth.resolveAuthFile(root));
  config.agent = { host: "127.0.0.1", port: 0 }; config.runtime.statePath = path.join(root, ".runtime", "state.json");
  const service = new PrivacyService({ directory, key, fenceAuthority: {}, ...(bundled ? { workerPath: path.resolve(import.meta.dirname, "../runtime/agent/privacy-worker.cjs") } : {}) });
  const calls = [];
  const workerManager = { publicInstances: () => registry.list(), callInstance: async (...args) => { if (args[1] !== "/mongodb/bulk/job") calls.push(args); throw Error("Remote dispatch forbidden in admission fixture"); } };
  const runtime = bundled ? createRequire(import.meta.url)("../runtime/agent/server.cjs") : { createManagerApp };
  const app = runtime.createManagerApp({ config, registry, workerManager, privacyService: service, authToken: token });
  const server = http.createServer(app); await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { await app.locals.manualWorkbench.close(); await service.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, scope = businessTargetScope(origin, instance, "business"), original = fullFirstChunk();
  const store = new PrivacyStore({ directory, key }), auth = store.execute("create");
  const old = store.execute("intent", { auth, scope, route: "/mongodb/bulk/prepare", request: original, identity: { instanceId: instance.id, jobId: original.jobId, chunkIndex: 0 } }); store.close();
  const contextFile = path.join(root, "synthetic-context.json"); fs.writeFileSync(contextFile, JSON.stringify({ version: 1, origin, auth }), { mode: 0o600 });
  const peer = await mcpPeer(t, { root, url: origin, contextFile });
  const disposition = args => peer.call("remote_debug_mongodb_disposition", { instanceId: instance.id, database: "business", ...args });
  const prepared = await disposition({ mode: "prepare", intentId: old.id, originalRequest: original });
  assert.notEqual(prepared.isError, true, JSON.stringify(prepared)); const base = prepared.payload;
  const inspected = await disposition({ mode: "inspect", dispositionId: base.dispositionId });
  assert.equal(inspected.payload.state, "review_required");
  const candidate = structuredClone(original); candidate.jobId = "synthetic-replacement";
  for (const unit of candidate.units) for (const operation of unit.operations) if (operation.document) operation.document.remediation_job_id = candidate.jobId;
  const propose = (replacementRequest = candidate, originalRequest = original) => disposition({ mode: "prepare_risk", dispositionId: base.dispositionId, reviewHash: base.reviewHash, originalRequest, replacementRequest });
  const proposed = await propose(); assert.notEqual(proposed.isError, true, JSON.stringify(proposed)); const plan = proposed.payload;
  assert.match(plan.riskPlanId, /^[a-f0-9]{64}$/); assert.equal(plan.operationCount, 100); assert.equal(plan.unitCount, 34);
  assert.equal(plan.replacementRequestDigest, prepareRequestDigest(candidate));
  const read = await disposition({ mode: "inspect_risk", riskPlanId: plan.riskPlanId });
  assert.notEqual(read.isError, true, JSON.stringify(read));
  for (const state of [plan, read.payload]) {
    assert.equal(state.historicalOutcome, "unknown"); assert.equal(state.state, "awaiting_human");
    assert.equal(state.fenceReason, "human_risk_acceptance_no_external_attestation"); assert.equal(state.remoteFenceConfirmed, false);
    assert.equal(state.humanApproved, false); assert.equal(state.humanConfirmationRequired, true); assert.equal(state.canApprove, true); assert.equal(state.replacementAllowed, false);
    assert.equal(state.binding.requestDigest, prepareRequestDigest(original));
  }
  assert.equal((await propose()).payload.riskPlanId, plan.riskPlanId);
  for (const mutation of ["amount", "recipient", "date", "extra-unit", "identity-guard", "missing-array-guard", "changed-original", "redacted-original", "unsafe-key", "document-shape"]) {
    const changed = structuredClone(candidate), exact = structuredClone(original);
    const operations = changed.units[1].operations;
    if (mutation === "amount") operations[1].document.value++;
    if (mutation === "recipient") operations[1].document.member_id = "someone-else";
    if (mutation === "date") operations[1].document.batches[0].date = "2026-10-26";
    if (mutation === "extra-unit") changed.units.push({ ...changed.units[1], unitId: "extra-unit" });
    if (mutation === "identity-guard") operations[0].expected["balances.0.group_id"].value = "other-group";
    if (mutation === "missing-array-guard") delete operations[0].expected["batches.0"];
    if (mutation === "changed-original") exact.purpose = "different-original";
    if (mutation === "redacted-original") exact.purpose = "password=synthetic-sensitive-value";
    if (mutation === "unsafe-key") Object.defineProperty(operations[1].document, "__proto__", { enumerable: true, value: { fixture: true } });
    if (mutation === "document-shape") operations[1].document = ["synthetic-sensitive-value"];
    const denied = await propose(changed, exact); assert.equal(denied.isError, true, mutation);
    assert.equal(denied.payload.error.code, ["unsafe-key", "document-shape", "missing-array-guard"].includes(mutation) ? "BUSINESS_DISPOSITION_INPUT_INVALID" : mutation === "redacted-original" ? "BUSINESS_DISPOSITION_ORIGINAL_BYTES_REQUIRED" : "BUSINESS_REPLACEMENT_DENIED", mutation);
    assert.equal(JSON.stringify(denied).includes("synthetic-sensitive-value"), false);
  }
  assert.deepEqual(calls, []);
  const oldState = await peer.call("remote_debug_mongodb_recover_operation", { instanceId: instance.id, database: "business", intentId: old.id });
  assert.equal(oldState.payload.state, "uncertain");
  assert.equal((await disposition({ mode: "inspect", dispositionId: base.dispositionId })).payload.state, "review_required");
  t.diagnostic(JSON.stringify({ riskPlanId: plan.riskPlanId, unitCount: plan.unitCount, operationCount: plan.operationCount, fenceReason: plan.fenceReason, canApprove: plan.canApprove, replacementAllowed: plan.replacementAllowed, remoteDispatches: calls.length }));
});
