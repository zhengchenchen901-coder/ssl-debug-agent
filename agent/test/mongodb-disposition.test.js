import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { PrivacyStore } from "../privacy-store.js";
import { PrivacyService, privacyRequest, assertMongoDispatchAdmission } from "../privacy-service.js";
import { DISPOSITION_CONFIRMATION } from "../mongodb-disposition.js";
import { bulkPreparePayload, prepareRequestDigest } from "../../plugins/remote-debug-agent/prepare-protocol.js";
import { businessTargetScope } from "../../plugins/remote-debug-agent/business-privacy.js";

function fixture(t, { modern = false, fault } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rda-disposition-")), key = randomBytes(32);
  let clock = Date.now(), store = new PrivacyStore({ directory, key, now: () => clock, fault });
  const auth = store.execute("create"), instance = { id: "isolated", host: "fixture.invalid", mongodb: { database: "business" } }, origin = "http://127.0.0.1:49999";
  const scope = businessTargetScope(origin, instance, "business");
  const request = JSON.parse(JSON.stringify(bulkPreparePayload({ instanceId: instance.id, jobId: "original-job", database: "business", chunkIndex: 0,
    units: [{ unitId: "one", operations: [{ operation: "updateOne", collection: "orders", id: "one", expected: { count: { exists: true, value: 0 } }, update: { $inc: { count: 3 } } }] }], purpose: "original fixture" })));
  const call = (action, input = {}) => store.execute(action, { auth, scope, ...input });
  const intent = call("intent", { route: "/mongodb/bulk/prepare", request, identity: { instanceId: instance.id, jobId: request.jobId, chunkIndex: 0 },
    ...(modern ? { dispatchDigest: prepareRequestDigest(request) } : {}) });
  if (modern) call("claim_bulk_prepare", { id: intent.id, dispatchDigest: prepareRequestDigest(request), attempt: 1, operationId: "original-operation",
    bulkChunk: { jobId: request.jobId, chunkIndex: 0, chunkHash: "c".repeat(64), endOfUpload: false } });
  const prepare = (extra = {}) => call("prepare_disposition", { id: intent.id, request, requestDigest: prepareRequestDigest(request), ...extra });
  const quarantine = (plan, extra = {}) => call("quarantine_disposition", { dispositionId: plan.dispositionId, reviewHash: plan.reviewHash, confirmation: DISPOSITION_CONFIRMATION, ...extra });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, key, auth, scope, instance, origin, request, intent, call, prepare, quarantine,
    get store() { return store; }, advance: n => clock += n,
    reopen: () => { store.close(); store = new PrivacyStore({ directory, key, now: () => clock }); } };
}

test("real legacy envelope has an auditable review without invented operation, chunk or plan proof", t => {
  const f = fixture(t), original = f.call("inspect_operation", { id: f.intent.id });
  const plan = f.prepare();
  assert.deepEqual(plan, f.prepare());
  assert.equal(plan.state, "review_required"); assert.equal(plan.remoteFenceConfirmed, false); assert.equal(plan.replacementAllowed, false);
  assert.equal(plan.binding.contextId, f.auth.contextId); assert.equal(plan.binding.requestDigest, prepareRequestDigest(f.request));
  assert.equal(plan.binding.intentId, f.intent.id); assert.equal(plan.binding.jobId, "original-job"); assert.equal(plan.binding.chunkIndex, 0);
  for (const key of ["originalOperationId", "chunkHash", "planHash"]) assert.equal(plan.binding[key], null);
  assert.ok(plan.missingRequirements.includes("original_operation_identity_unbound"));
  assert.deepEqual(f.call("inspect_operation", { id: f.intent.id }), original);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='event'").get().n, 1);
  assert.equal(f.store.execute("assert_instance_admission", { instanceId: f.instance.id }).ok, true, "review alone does not quarantine");
});

for (const changed of ["amount", "job", "chunk", "purpose", "database", "instance", "digest", "context", "scope"]) test(`disposition refuses forged ${changed} binding`, t => {
  const f = fixture(t), request = structuredClone(f.request), extra = {};
  if (changed === "amount") request.units[0].operations[0].update.$inc.count++;
  if (changed === "job") request.jobId = "new-job";
  if (changed === "chunk") request.chunkIndex++;
  if (changed === "purpose") request.purpose = "different";
  if (changed === "database") request.database = "other";
  if (changed === "instance") request.instanceId = "other";
  if (changed === "digest") extra.requestDigest = "e".repeat(64);
  if (changed === "context") extra.auth = f.store.execute("create");
  if (changed === "scope") extra.scope = businessTargetScope(f.origin, f.instance, "other");
  assert.throws(() => f.prepare({ request, requestDigest: prepareRequestDigest(request), ...extra }), { code: "BUSINESS_DISPOSITION_DENIED" });
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind IN ('disposition','disposition_hold')").get().n, 0);
  assert.equal(f.call("inspect_operation", { id: f.intent.id }).state, "uncertain");
});

test("quarantine needs exact review and confirmation; stale and expired reviews fail closed", t => {
  const f = fixture(t), plan = f.prepare();
  for (const extra of [{ confirmation: "确认执行" }, { reviewHash: "0".repeat(64) }, { auth: f.store.execute("create") }, { scope: businessTargetScope(f.origin, f.instance, "other") }]) {
    assert.throws(() => f.quarantine(plan, extra), { code: "BUSINESS_DISPOSITION_DENIED" });
  }
  f.advance(86400000);
  assert.throws(() => f.quarantine(plan), { code: "BUSINESS_DISPOSITION_REVIEW_EXPIRED" });
  assert.equal(f.store.execute("assert_instance_admission", { instanceId: f.instance.id }).ok, true);
  const renewed = f.prepare();
  assert.equal(renewed.dispositionId, plan.dispositionId); assert.notEqual(renewed.reviewHash, plan.reviewHash);
  assert.throws(() => f.quarantine(plan), { code: "BUSINESS_DISPOSITION_DENIED" });
  assert.equal(f.quarantine(renewed).state, "quarantined");
});

test("recovery racing a reviewed quarantine invalidates the review instead of modifying resolved evidence", t => {
  const f = fixture(t), plan = f.prepare();
  f.call("historical_bulk_result", { id: f.intent.id, request: f.request, requestDigest: prepareRequestDigest(f.request),
    chunk: { jobId: f.request.jobId, chunkIndex: 0, chunkHash: "c".repeat(64), endOfUpload: false },
    result: { ok: true, jobId: f.request.jobId, chunkIndex: 0, chunkHash: "c".repeat(64), status: "uploading" } });
  assert.throws(() => f.quarantine(plan), { code: "BUSINESS_DISPOSITION_STALE" });
  assert.equal(f.call("inspect_operation", { id: f.intent.id }).state, "complete");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='disposition_hold'").get().n, 0);
});

test("quarantine is durable and idempotent, preserving the exact original record and all pins", t => {
  const f = fixture(t), original = f.call("inspect_operation", { id: f.intent.id }), plan = f.prepare(), result = f.quarantine(plan);
  assert.equal(result.localContainment, true); assert.equal(result.remoteFenceConfirmed, false); assert.equal(result.historicalOutcome, "unknown");
  assert.equal(result.containmentScope, "instance_all_mongodb_write_admissions");
  f.reopen(); f.advance(400 * 86400000);
  // Context expiry does not remove the global Manager gate.
  assert.throws(() => f.store.execute("assert_instance_admission", { instanceId: f.instance.id }), { code: "BUSINESS_DISPOSITION_QUARANTINED" });
  const scoped = f.store.hash("scope", f.scope);
  assert.deepEqual(f.store.get("operation", f.intent.id, f.auth.contextId, scoped), (({ id, ...r }) => r)(original));
  for (const row of f.store.db.prepare("SELECT pinned FROM records WHERE kind IN ('disposition','disposition_hold','operation','task','event')").all()) assert.equal(row.pinned, 1);
});

test("quarantine closes new jobs, other contexts/databases/tools and delayed claims/results", t => {
  const f = fixture(t, { modern: true }), plan = f.prepare();
  const original = f.call("inspect_operation", { id: f.intent.id }); f.quarantine(plan);
  assert.equal(plan.binding.originalOperationId, "original-operation"); assert.equal(plan.binding.chunkHash, "c".repeat(64));
  for (const route of ["/mongodb/bulk/prepare", "/mongodb/bulk/execute", "/mongodb/bulk/control", "/mongodb/mutations/prepare", "/mongodb/mutations/execute", "/mongodb/imports/prepare", "/mongodb/future-write"]) {
    assert.throws(() => f.call("intent", { route, request: { jobId: "replacement" }, identity: { instanceId: f.instance.id } }), { code: "BUSINESS_DISPOSITION_QUARANTINED" });
    assert.throws(() => f.call("intent", { route, auth: f.store.execute("create"), scope: businessTargetScope(f.origin, f.instance, "other"), request: {}, identity: { instanceId: f.instance.id } }), { code: "BUSINESS_DISPOSITION_QUARANTINED" });
  }
  for (const action of ["claim_bulk_prepare", "claim_execution", "bulk_prepare_result", "historical_bulk_result", "outcome", "reconcile"]) {
    assert.throws(() => f.call(action, { id: f.intent.id, result: { ok: true, status: "committed", notDispatched: true } }), { code: "BUSINESS_DISPOSITION_QUARANTINED" });
  }
  assert.deepEqual(f.call("inspect_operation", { id: f.intent.id }), original);
  assert.equal(f.store.execute("assert_instance_admission", { instanceId: "another-isolated-instance" }).ok, true);
});

for (const boundary of ["beforeCommit", "afterCommit"]) test(`actual SIGKILL at quarantine ${boundary} preserves atomic hold/audit and allows exact retry`, async t => {
  const f = fixture(t), plan = f.prepare(), original = f.call("inspect_operation", { id: f.intent.id }); f.store.close();
  const child = fork(path.join(import.meta.dirname, "helpers/disposition-crash.mjs"), { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  if (process.platform === "win32") child.once("message", () => child.kill("SIGKILL"));
  const done = once(child, "exit");
  child.send({ directory: f.directory, key: f.key.toString("hex"), auth: f.auth, scope: f.scope, plan, boundary });
  const [code, signal] = await done; assert.equal(code, null); assert.equal(signal, "SIGKILL"); f.reopen();
  assert.deepEqual(f.call("inspect_operation", { id: f.intent.id }), original);
  const count = kind => f.store.db.prepare("SELECT count(*) n FROM records WHERE kind=?").get(kind).n;
  assert.equal(count("disposition_hold"), boundary === "afterCommit" ? 1 : 0);
  assert.equal(count("event"), boundary === "afterCommit" ? 2 : 1);
  const held = f.quarantine(plan); assert.deepEqual(f.quarantine(plan), held);
  assert.equal(count("disposition_hold"), 1); assert.equal(count("event"), 2);
});

test("concurrent Managers apply one quarantine and one audit; denied admission is also idempotent", async t => {
  const f = fixture(t), plan = f.prepare(); f.store.close();
  const services = [0, 1].map(() => new PrivacyService({ directory: f.directory, key: f.key }));
  t.after(() => Promise.all(services.map(s => s.close())));
  const input = { auth: f.auth, scope: f.scope, dispositionId: plan.dispositionId, reviewHash: plan.reviewHash, confirmation: DISPOSITION_CONFIRMATION };
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => services[i % 2].call("quarantine_disposition", input)));
  for (const result of results) assert.deepEqual(result, results[0]);
  const denials = await Promise.all(services.map(s => s.call("admit_disposition", input)));
  assert.deepEqual(denials[0], denials[1]); assert.equal(denials[0].admission, "blocked");
  assert.equal(denials[0].replacementAllowed, false); assert.equal(denials[0].remoteFenceConfirmed, false);
  await Promise.all(services.map(s => s.close())); f.reopen();
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='event'").get().n, 3);
});

test("storage failure before commit leaves no partial quarantine, receipt or new admission permission", t => {
  let armed = false;
  const f = fixture(t, { fault: boundary => { if (armed && boundary === "beforeCommit") throw Error("fixture I/O failure"); } }), plan = f.prepare();
  armed = true; assert.throws(() => f.quarantine(plan), /fixture I\/O failure/); armed = false;
  assert.equal(f.call("inspect_disposition", { dispositionId: plan.dispositionId }).state, "review_required");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='disposition_hold'").get().n, 0);
  assert.equal(f.call("inspect_operation", { id: f.intent.id }).state, "uncertain");
  const denied = f.call("admit_disposition", { dispositionId: plan.dispositionId, reviewHash: plan.reviewHash });
  assert.equal(denied.admission, "blocked"); assert.equal(denied.replacementAllowed, false);
});

test("public storage cannot submit proof, risk takeover, internal gate commands or reconstructed credential bytes", async t => {
  const f = fixture(t), service = { call: (action, input) => Promise.resolve(f.store.execute(action, input)) };
  const opts = { instance: () => f.instance, origin: f.origin, dispatch: () => assert.fail("no remote request allowed") };
  for (const action of ["prepare_disposition", "quarantine_disposition", "admit_disposition", "assert_instance_admission"]) {
    await assert.rejects(privacyRequest(service, { action, auth: f.auth, scope: f.scope }, opts), { code: "BUSINESS_STORAGE_ACTION_DENIED" });
  }
  for (const forged of [{ evidence: { notDispatched: true } }, { riskAccepted: true }, { binding: {} }, { mode: "cancel" }]) {
    await assert.rejects(privacyRequest(service, { action: "disposition", mode: "prepare", auth: f.auth, scope: f.scope, id: f.intent.id, originalRequest: f.request, ...forged }, opts), { code: "BUSINESS_DISPOSITION_DENIED" });
  }
  for (const secret of ["[REDACTED]", "private-password"]) {
    const request = structuredClone(f.request); request.units[0].operations[0].document = { password: secret };
    await assert.rejects(privacyRequest(service, { action: "disposition", mode: "prepare", auth: f.auth, scope: f.scope, id: f.intent.id, originalRequest: request }, opts), { code: "BUSINESS_DISPOSITION_ORIGINAL_BYTES_REQUIRED" });
  }
  const plan = f.prepare(); f.quarantine(plan);
  for (const route of ["/mongodb/bulk/prepare", "/mongodb/bulk/control", "/mongodb/bulk/rollback", "/mongodb/sandbox/access/execute", "/mongodb/unknown"]) await assert.rejects(assertMongoDispatchAdmission(service, f.instance.id, route), { code: "BUSINESS_DISPOSITION_QUARANTINED" });
  for (const route of ["/mongodb/query", "/mongodb/bulk/job", "/mongodb/bulk/recover-prepare", "/mongodb/mutations/recover-execution"]) await assertMongoDispatchAdmission(service, f.instance.id, route);
});

test("cross-process positive receipt versus quarantine race has one atomic winner", async t => {
  const f = fixture(t, { modern: true }), plan = f.prepare(); f.store.close();
  const a = new PrivacyService({ directory: f.directory, key: f.key }), b = new PrivacyService({ directory: f.directory, key: f.key });
  t.after(async () => { await a.close(); await b.close(); });
  const results = await Promise.allSettled([
    a.call("quarantine_disposition", { auth: f.auth, scope: f.scope, dispositionId: plan.dispositionId, reviewHash: plan.reviewHash, confirmation: DISPOSITION_CONFIRMATION }),
    b.call("bulk_prepare_result", { auth: f.auth, scope: f.scope, id: f.intent.id, bulkPrepare: f.intent.bulkPrepare,
      result: { ok: true, jobId: f.request.jobId, chunkIndex: 0, chunkHash: "c".repeat(64), status: "uploading" } }),
  ]);
  await a.close(); await b.close(); f.reopen();
  const final = f.call("inspect_operation", { id: f.intent.id });
  const holds = f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='disposition_hold'").get().n;
  if (results[0].status === "fulfilled") {
    assert.equal(holds, 1); assert.equal(final.state, "uncertain");
    assert.equal(results[1].status, "rejected"); assert.equal(results[1].reason.code, "BUSINESS_DISPOSITION_QUARANTINED");
  } else {
    assert.equal(results[0].reason.code, "BUSINESS_DISPOSITION_STALE"); assert.equal(holds, 0);
    assert.equal(results[1].status, "fulfilled"); assert.equal(final.state, "complete");
  }
});
