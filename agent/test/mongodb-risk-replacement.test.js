import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { fork } from "node:child_process";
import { riskReplacementFixture, wire } from "./helpers/risk-replacement-fixture.js";
import { privacyRequest, PrivacyService } from "../privacy-service.js";
import { RISK_CONFIRMATION } from "../mongodb-risk-replacement.js";
import { bulkPreparePayload, prepareRequestDigest } from "../../plugins/remote-debug-agent/prepare-protocol.js";
const unixOnly = { skip: process.platform === "win32" };

test("risk review retains real legacy uncertainty and creates no replacement without human confirmation", unixOnly, async t => {
  const f = riskReplacementFixture(t), original = f.call("inspect_operation", { id: f.old.id }), plan = f.prepare();
  assert.equal(plan.historicalOutcome, "unknown"); assert.equal(plan.state, "awaiting_human"); assert.equal(plan.humanConfirmationRequired, true);
  assert.equal(plan.remoteFenceConfirmed, false); assert.equal(plan.canApprove, false);
  assert.equal(plan.binding.originalOperationId, null); assert.equal(plan.binding.planHash, null);
  assert.throws(() => f.create(plan), { code: "BUSINESS_REPLACEMENT_HUMAN_CONFIRMATION_REQUIRED" });
  assert.throws(() => f.approve(plan), { code: "BUSINESS_REPLACEMENT_FENCE_REQUIRED" });
  for (const kind of ["replacement_gate"]) assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind=?").get(kind).n, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 1);
  assert.deepEqual(f.call("inspect_operation", { id: f.old.id }), original);
  assert.equal(f.requests.length, 0);
});

for (const mutation of ["amount", "recipient", "batch_date", "new_unit", "append_preimage", "database", "original_job"]) test(`risk review cannot expand original effects or forge ${mutation}`, unixOnly, t => {
  const f = riskReplacementFixture(t), candidate = structuredClone(f.candidate);
  if (mutation === "amount") candidate.units[0].operations[0].update.$inc.count++;
  if (mutation === "recipient") candidate.units[0].operations[0].id = "another-member";
  if (mutation === "batch_date") candidate.units[0].operations[1].document.restored_batches[0].date = "2026-10-26";
  if (mutation === "new_unit") candidate.units.push({ ...candidate.units[0], unitId: "extra" });
  if (mutation === "append_preimage") candidate.units[0].operations[0].expected.count.exists = false;
  if (mutation === "database") candidate.database = "other";
  if (mutation === "original_job") candidate.jobId = f.original.jobId;
  assert.throws(() => f.prepare(candidate), { code: "BUSINESS_REPLACEMENT_DENIED" });
});

test("identity guards cannot be refreshed while changed scalar preimages need a new exact review", unixOnly, t => {
  const f = riskReplacementFixture(t), original = f.original;
  // Extra expected guards are part of business identity, not mutable preimages.
  const candidate = structuredClone(f.candidate); candidate.units[0].operations[0].expected.group = { exists: true, value: "other" };
  assert.throws(() => f.prepare(candidate), { code: "BUSINESS_REPLACEMENT_DENIED" });
  const a = f.prepare(), refreshed = structuredClone(f.candidate); refreshed.units[0].operations[0].expected.count.value = 1;
  const b = f.prepare(refreshed); assert.notEqual(a.riskPlanId, b.riskPlanId); assert.equal(a.effectDigest, b.effectDigest);
  assert.deepEqual(original.units[0].operations[0].expected.count.value, 0);
});

for (const failure of ["signature", "issuer", "challenge", "coverage", "credentials", "sessions", "inflight", "restart", "expired", "symlink", "permissions"]) test(`fence receipt ${failure} failure cannot be overridden by human confirmation`, unixOnly, t => {
  const f = riskReplacementFixture(t), plan = f.prepare(), overrides = {};
  if (failure === "issuer") overrides.issuer = "untrusted";
  if (failure === "challenge") overrides.challengeDigest = "0".repeat(64);
  if (failure === "coverage") overrides.coverage = ["dispatch"];
  if (failure === "credentials") overrides.legacyCredentialsRevoked = false;
  if (failure === "sessions") overrides.oldSessionsDrained = false;
  if (failure === "inflight") overrides.inFlightTransactions = "unknown";
  if (failure === "restart") overrides.restartSafe = false;
  if (failure === "expired") overrides.validUntil = f.now;
  f.issue(plan, overrides, failure === "signature" ? generateKeyPairSync("ed25519").privateKey : undefined);
  if (failure === "permissions") fs.chmodSync(f.receiptPath(plan), 0o644);
  if (failure === "symlink") { fs.renameSync(f.receiptPath(plan), f.receiptPath(plan) + ".old"); fs.symlinkSync(f.receiptPath(plan) + ".old", f.receiptPath(plan)); }
  const read = f.inspect(plan); assert.equal(read.remoteFenceConfirmed, false); assert.equal(read.canApprove, false);
  assert.throws(() => f.approve(read), { code: "BUSINESS_REPLACEMENT_FENCE_REQUIRED" });
});

test("verified external authority plus native approval only creates the exact replacement, never executes", unixOnly, async t => {
  const f = riskReplacementFixture(t); await f.h.initialize();
  const before = f.call("inspect_operation", { id: f.old.id }), plan = f.prepare(); f.issue(plan);
  const reviewed = f.inspect(plan); assert.equal(reviewed.canApprove, true); assert.equal(reviewed.remoteFenceConfirmed, true);
  assert.throws(() => f.create(reviewed), { code: "BUSINESS_REPLACEMENT_HUMAN_CONFIRMATION_REQUIRED" });
  assert.throws(() => f.approve(reviewed, { confirmation: "确认执行" }), { code: "BUSINESS_REPLACEMENT_DENIED" });
  const approved = f.approve(reviewed);
  assert.equal(approved.state, "human_approved"); assert.equal(f.requests.length, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 1);
  const created = await f.public({ mode: "create_replacement", riskPlanId: approved.riskPlanId, reviewHash: approved.reviewHash });
  assert.equal(created.result.ok, true); assert.equal(created.result.jobId, f.candidate.jobId);
  assert.deepEqual(f.requests, ["/mongodb/bulk/prepare"]);
  const again = await f.public({ mode: "create_replacement", riskPlanId: approved.riskPlanId, reviewHash: approved.reviewHash });
  assert.equal(again.result.jobId, f.candidate.jobId); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.call("inspect_operation", { id: f.old.id }), before);
  const seal = wire({ ...f.candidate, chunkIndex: 1, units: [], endOfUpload: true });
  const options = f.requestOptions;
  const intent = await privacyRequest(f.service, { action: "intent", auth: f.auth, scope: f.scope, route: "/mongodb/bulk/prepare", request: seal,
    identity: { instanceId: f.instance.id, jobId: seal.jobId, chunkIndex: 1 }, dispatchDigest: prepareRequestDigest(seal) }, options);
  const sealed = await privacyRequest(f.service, { action: "dispatch_prepare", auth: f.auth, scope: f.scope, id: intent.id, attempt: 1, request: seal }, options);
  assert.equal(sealed.status, "prepared");
  const risk = f.inspect(plan); assert.equal(risk.state, "prepared"); assert.equal(risk.planHash, sealed.planHash);
  assert.equal(f.store.execute("assert_instance_admission", { instanceId: f.instance.id, route: "/mongodb/bulk/execute", request: { jobId: seal.jobId, planHash: sealed.planHash } }).ok, true);
  assert.throws(() => f.store.execute("assert_instance_admission", { instanceId: f.instance.id, route: "/mongodb/bulk/execute", request: { jobId: seal.jobId, planHash: "0".repeat(64) } }), { code: "BUSINESS_DISPOSITION_QUARANTINED" });
  assert.equal(f.h.rows("business", "orders").get("order-1").count, 0); assert.equal(f.h.state.events.some(e => e.action === "businessWrite"), false);
  assert.throws(() => f.call("intent", { route: "/mongodb/bulk/prepare", request: f.original, identity: { instanceId: f.instance.id, jobId: f.original.jobId }, dispatchDigest: prepareRequestDigest(f.original) }), { code: "BUSINESS_DISPOSITION_QUARANTINED" });
});

test("changed authority evidence, stale review, foreign context and expired approval prevent creation", unixOnly, t => {
  const f = riskReplacementFixture(t), plan = f.prepare(); f.issue(plan); const review = f.inspect(plan);
  assert.throws(() => f.approve({ ...review, reviewHash: "f".repeat(64) }), { code: "BUSINESS_REPLACEMENT_STALE" });
  const approved = f.approve(review);
  assert.throws(() => f.call("create_risk_replacement", { riskPlanId: approved.riskPlanId, reviewHash: approved.reviewHash, auth: f.store.execute("create") }), { code: "BUSINESS_REPLACEMENT_DENIED" });
  f.issue(plan, { receiptId: "changed-receipt" });
  assert.throws(() => f.create(approved), { code: "BUSINESS_REPLACEMENT_APPROVAL_EXPIRED" });
  f.issue(plan); f.advance(900001);
  assert.throws(() => f.create(approved), { code: "BUSINESS_REPLACEMENT_APPROVAL_EXPIRED" });
  const renewed = f.prepare(); assert.equal(renewed.riskPlanId, plan.riskPlanId); assert.equal(renewed.humanApproved, false);
  f.issue(renewed); assert.equal(f.approve(f.inspect(renewed)).state, "human_approved");
});

test("MCP/storage cannot grant native approval, submit evidence or forge an actor", unixOnly, async t => {
  const f = riskReplacementFixture(t), plan = f.prepare(); f.issue(plan);
  for (const action of ["human_risk_approve", "human_risk_view", "human_risk_context", "create_risk_replacement", "prepare_risk_replacement"]) {
    await assert.rejects(privacyRequest(f.service, { action, auth: f.auth, scope: f.scope, riskPlanId: plan.riskPlanId }, f.requestOptions), { code: "BUSINESS_STORAGE_ACTION_DENIED" });
  }
  for (const extra of [{ actor: { username: "admin" } }, { humanApproved: true }, { evidence: {} }, { trustFile: f.trustFile }]) {
    await assert.rejects(f.public({ mode: "create_replacement", riskPlanId: plan.riskPlanId, reviewHash: plan.reviewHash, ...extra }), { code: "BUSINESS_DISPOSITION_DENIED" });
  }
});

for (const boundary of ["beforeCommit", "afterCommit"]) test(`actual crash at replacement creation ${boundary} is atomic and recoverable`, unixOnly, async t => {
  const f = riskReplacementFixture(t), plan = f.prepare(); f.issue(plan); const approved = f.approve(f.inspect(plan)); f.store.close();
  const child = fork(path.join(import.meta.dirname, "helpers/risk-replacement-crash.mjs"), { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit");
  child.send({ directory: f.directory, key: f.key.toString("hex"), fenceAuthority: f.fenceAuthority, auth: f.auth, scope: f.scope, plan: approved, boundary });
  const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, "SIGKILL"); f.reopen();
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='replacement_gate'").get().n, boundary === "afterCommit" ? 1 : 0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, boundary === "afterCommit" ? 2 : 1);
  const result = f.create(approved); assert.equal(result.intent.id, f.create(approved).intent.id);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 2);
  assert.equal(f.call("inspect_operation", { id: f.old.id }).state, "uncertain");
});

test("concurrent creators share one intent, gate and audit across store workers and restart", unixOnly, async t => {
  const f = riskReplacementFixture(t), plan = f.prepare(); f.issue(plan); const approved = f.approve(f.inspect(plan)); f.store.close();
  const services = [0, 1].map(() => new PrivacyService({ directory: f.directory, key: f.key, fenceAuthority: f.fenceAuthority }));
  t.after(() => Promise.all(services.map(s => s.close())));
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => services[i % 2].call("create_risk_replacement", { auth: f.auth, scope: f.scope, riskPlanId: approved.riskPlanId, reviewHash: approved.reviewHash })));
  assert.equal(new Set(results.map(r => r.intent.id)).size, 1); assert.equal(new Set(results.map(r => r.risk.creationAuditId)).size, 1);
  await Promise.all(services.map(s => s.close())); f.reopen();
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='replacement_gate'").get().n, 1);
  assert.equal(f.create(approved).intent.id, results[0].intent.id);
});

test("two approved proposals for one original intent cannot create two replacement jobs", unixOnly, t => {
  const f = riskReplacementFixture(t), a = f.prepare(), other = structuredClone(f.candidate); other.jobId = "another-proposed-job"; other.units[0].operations[1].document.remediation_job_id = other.jobId;
  const b = f.prepare(other); f.issue(a); f.issue(b);
  const aa = f.approve(f.inspect(a)), bb = f.approve(f.inspect(b));
  f.create(aa);
  assert.equal(f.call("inspect_disposition", { dispositionId: f.parent.dispositionId }).state, "retired_unknown");
  assert.throws(() => f.create(bb), { code: "BUSINESS_REPLACEMENT_QUARANTINE_REQUIRED" });
  assert.equal(f.inspect(b).replacementAllowed, false);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='replacement_gate'").get().n, 1);
});

test("approval renewal after creation preserves the one replacement identity and its audit lineage", unixOnly, t => {
  const f = riskReplacementFixture(t), p = f.prepare(); f.issue(p);
  const first = f.approve(f.inspect(p)), created = f.create(first); f.advance(900001);
  const renewed = f.prepare(); f.issue(renewed); const second = f.approve(f.inspect(renewed));
  assert.notEqual(first.approvalAuditId, second.approvalAuditId);
  assert.equal(f.create(second).intent.id, created.intent.id);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 2);
});

test("loss of a replacement upload reply reconciles the same intent without another upload", unixOnly, async t => {
  const f = riskReplacementFixture(t); await f.h.initialize(); const p = f.prepare(); f.issue(p); const approved = f.approve(f.inspect(p));
  const routes = []; let lost = true;
  const options = { ...f.requestOptions, dispatch: async (id, route, input) => {
    routes.push(route); const { operationId, timeoutMs, deadlineAt, ...chunk } = input;
    if (route === "/mongodb/bulk/prepare") {
      const result = await f.h.run({ action: "upload", chunk });
      if (lost) { lost = false; throw Object.assign(Error("fixture response lost"), { code: "SSH_TRANSPORT_LOST" }); }
      return { ok: true, ...result };
    }
    assert.equal(route, "/mongodb/bulk/recover-prepare"); return { ok: true, ...await f.h.run({ ...chunk, action: "recoverUpload" }) };
  } };
  const args = { action: "disposition", mode: "create_replacement", auth: f.auth, scope: f.scope, riskPlanId: approved.riskPlanId, reviewHash: approved.reviewHash };
  const lostResult = await privacyRequest(f.service, args, options); assert.equal(lostResult.result.ok, false);
  const recovered = await privacyRequest(f.service, args, options); assert.equal(recovered.result.state, "complete");
  assert.deepEqual(routes, ["/mongodb/bulk/prepare", "/mongodb/bulk/recover-prepare"]);
  assert.equal(f.h.state.events.some(x => x.action === "businessWrite"), false);
});

test("job association rebinding cannot change job_id inside a compound recipient identity", unixOnly, t => {
  const f = riskReplacementFixture(t, { editOriginal: request => { request.units[0].operations[0].id = { tenant: "fixture", job_id: request.jobId }; } });
  const candidate = structuredClone(f.candidate); candidate.units[0].operations[0].id.job_id = candidate.jobId;
  assert.throws(() => f.prepare(candidate), { code: "BUSINESS_REPLACEMENT_DENIED" });
  assert.equal(f.prepare().humanApproved, false);
});
