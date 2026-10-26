import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { riskReplacementFixture, wire } from "./helpers/risk-replacement-fixture.js";
import { humanJobTerminationRequest, TERMINATION_CONFIRMATION } from "../mongodb-job-termination.js";
import { privacyRequest } from "../privacy-service.js";

async function setup(t, linked = false) {
  const f = riskReplacementFixture(t, { humanRisk: true });
  await f.h.initialize();
  if (linked) {
    const p = f.approve(f.prepare());
    await f.public({ mode: "create_replacement", riskPlanId: p.riskPlanId, reviewHash: p.reviewHash });
  } else {
    const { instanceId, ...chunk } = f.candidate;
    await f.h.run({ action: "upload", chunk });
  }
  const { instanceId, ...seal } = wire({ ...f.candidate, chunkIndex: 1, units: [], endOfUpload: true });
  const plan = await f.h.run({ action: "upload", chunk: seal });
  const target = { instanceId: f.instance.id, database: "business", jobId: f.candidate.jobId, planHash: plan.planHash, reason: "The immutable guard changed; never retry this task." };
  const requests = [];
  const options = { instance: id => id === f.instance.id ? f.instance : undefined,
    dispatch: async (id, route, request) => {
      assert.equal(id, f.instance.id); requests.push(route);
      if (route === "/mongodb/bulk/job") return { ok: true, ...await f.h.run({ action: "get", jobId: request.jobId }) };
      assert.equal(route, "/mongodb/bulk/terminate");
      return { ok: true, ...await f.h.run({ action: "terminate", ...request }) };
    } };
  const human = (action, input = target, opts = options) => humanJobTerminationRequest(f.service, action, input, opts);
  const approve = (review, opts = options) => human("approve", { instanceId: f.instance.id,
    terminationId: review.terminationId, reviewHash: review.reviewHash, confirmation: TERMINATION_CONFIRMATION,
    actor: { username: "fixture-admin", sessionId: "fixture-session", verifiedAt: f.now } }, opts);
  return Object.defineProperties({ ...f, target, requests, options, human, approveTermination: approve }, {
    store: { get: () => f.store }, now: { get: () => f.now }
  });
}

test("native-reviewed standalone termination closes only this job, retains unknown history and creates no replacement", async t => {
  const f = await setup(t), original = f.call("inspect_operation", { id: f.old.id });
  const beforePlan = f.h.read(f.target.jobId, "plan.json"), beforeRows = structuredClone(f.h.rows("business", "orders"));
  const review = await f.human("review");
  assert.equal(review.managedAdmissionClosed, false);
  const done = await f.approveTermination(review);
  assert.equal(done.state, "terminated_unknown"); assert.equal(done.managedAdmissionClosed, true);
  assert.equal(done.remoteTermination, "recorded"); assert.equal(done.historicalOutcome, "unknown");
  assert.deepEqual(f.h.read(f.target.jobId, "plan.json"), beforePlan);
  assert.deepEqual(f.h.rows("business", "orders"), beforeRows);
  assert.deepEqual(f.call("inspect_operation", { id: f.old.id }), original);
  assert.equal(f.h.state.events.some(e => e.action === "businessWrite"), false);
  assert.ok(f.requests.every(r => !/prepare|execute|rollback/.test(r)));
  for (const route of ["prepare", "execute", "control", "rollback"]) assert.throws(() => f.store.execute("assert_instance_admission", {
    instanceId: f.instance.id, route: "/mongodb/bulk/" + route, request: { jobId: f.target.jobId, planHash: f.target.planHash } }), { code: "BUSINESS_JOB_PERMANENTLY_TERMINATED" });
  assert.equal(f.store.execute("assert_instance_admission", { instanceId: f.instance.id, request: { jobId: "a-future-distinct-job" } }).ok, true);
  assert.equal(f.store.execute("assert_instance_admission", { instanceId: "different-instance", request: { jobId: f.target.jobId } }).ok, true);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='replacement_gate'").get().n, 0);
  const receipt = await f.h.run({ action: "get", jobId: f.target.jobId });
  for (const action of ["executeStart", "resume", "control", "rollbackStart", "sandboxPrepareCleanup"]) await assert.rejects(
    f.h.run({ action, jobId: f.target.jobId, planHash: f.target.planHash, command: "resume" }), { code: "MONGODB_BULK_JOB_RETIRED" });
  assert.equal(receipt.terminationId, done.terminationId);
});

test("expired risk approval does not obstruct terminating its established replacement", async t => {
  const f = await setup(t, true);
  f.advance(3600001);
  const review = await f.human("review"), done = await f.approveTermination(review);
  assert.equal(done.state, "terminated_unknown");
  const parent = await f.h.run({ action: "get", jobId: f.original.jobId });
  assert.equal(parent.status, "terminated_unknown"); assert.equal(parent.historicalOutcome, "unknown");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='replacement_gate'").get().n, 1);
});

test("changed state, wrong hash, expired review and forged caller evidence cannot terminate", async t => {
  const f = await setup(t);
  await assert.rejects(f.human("review", { ...f.target, planHash: "a".repeat(64) }));
  let review = await f.human("review");
  const manifest = f.h.read(f.target.jobId, "manifest.json"); manifest.updatedAt = "changed-after-review"; f.h.write(f.target.jobId, "manifest.json", manifest);
  await assert.rejects(f.approveTermination(review), { code: "BUSINESS_TERMINATION_REVIEW_STALE" });
  review = await f.human("review"); f.advance(300001);
  await assert.rejects(f.approveTermination(review), { code: "BUSINESS_TERMINATION_REVIEW_STALE" });
  for (const action of ["human_job_termination_prepare", "human_job_termination_approve", "human_job_termination_record", "human_job_termination_dispatch"]) {
    await assert.rejects(privacyRequest(f.service, { action, auth: f.auth, scope: f.scope, result: { ok: true } }, f.requestOptions), { code: "BUSINESS_STORAGE_ACTION_DENIED" });
  }
  assert.equal((await f.h.run({ action: "get", jobId: f.target.jobId })).status, "prepared");
  assert.equal(f.requests.includes("/mongodb/bulk/terminate"), false);
});

test("lost remote reply retains permanent gate and same termination can finish after restart", async t => {
  const f = await setup(t), review = await f.human("review");
  let lost = true;
  const options = { ...f.options, dispatch: async (...args) => {
    const r = await f.options.dispatch(...args);
    if (lost && args[1] === "/mongodb/bulk/terminate") { lost = false; throw Object.assign(Error("synthetic loss"), { code: "SSH_TRANSPORT_LOST" }); }
    return r;
  } };
  const pending = await f.approveTermination(review, options);
  assert.equal(pending.state, "termination_pending"); assert.equal(pending.managedAdmissionClosed, true);
  f.reopen(); f.advance(86400000);
  const reread = await f.human("review"), done = await f.approveTermination(reread);
  assert.equal(done.state, "terminated_unknown"); assert.equal(done.terminationId, review.terminationId);
  assert.equal(f.h.read(f.target.jobId, "retirement.json").terminationId, done.terminationId);
  assert.equal(f.h.state.events.some(e => e.action === "businessWrite"), false);
});

test("remote failure before tombstone never reopens the approved local gate", async t => {
  const f = await setup(t), review = await f.human("review");
  const pending = await f.approveTermination(review, { ...f.options, dispatch: async (...args) => {
    if (args[1] === "/mongodb/bulk/terminate") throw Object.assign(Error("offline"), { code: "SSH_TRANSPORT_LOST" });
    return f.options.dispatch(...args);
  } });
  assert.equal(pending.state, "termination_pending"); assert.equal(pending.managedAdmissionClosed, true);
  assert.equal((await f.h.run({ action: "get", jobId: f.target.jobId })).status, "prepared");
  assert.throws(() => f.store.execute("assert_instance_admission", { instanceId: f.instance.id, request: { jobId: f.target.jobId } }), { code: "BUSINESS_JOB_PERMANENTLY_TERMINATED" });
  assert.equal((await f.approveTermination(await f.human("review"))).state, "terminated_unknown");
});

test("a successful command reply without matching independent readback stays pending", async t => {
  const f = await setup(t), review = await f.human("review");
  const pending = await f.approveTermination(review, { ...f.options, dispatch: async (...args) => {
    if (args[1] === "/mongodb/bulk/terminate") return { ok: true, status: "terminated_unknown" };
    return f.options.dispatch(...args);
  } });
  assert.equal(pending.state, "termination_pending"); assert.equal(pending.managedAdmissionClosed, true);
  assert.equal(pending.recoveryCode, "BUSINESS_TERMINATION_ACK_REQUIRED");
  assert.equal((await f.h.run({ action: "get", jobId: f.target.jobId })).status, "prepared");
});

test("target configuration changes and foreign instances cannot consume a termination review", async t => {
  const f = await setup(t), review = await f.human("review");
  await assert.rejects(f.human("approve", { instanceId: "foreign", terminationId: review.terminationId }), { code: "BUSINESS_TERMINATION_TARGET_CHANGED" });
  const options = { ...f.options, instance: id => id === f.instance.id ? { ...f.instance, host: "changed.invalid" } : undefined };
  await assert.rejects(f.approveTermination(review, options), { code: "BUSINESS_TERMINATION_TARGET_CHANGED" });
  assert.equal(f.requests.includes("/mongodb/bulk/terminate"), false);
});

for (const boundary of ["beforeCommit", "afterCommit"]) test(`SIGKILL ${boundary} preserves atomic permanent admission and restart recovery`, async t => {
  const f = await setup(t), review = await f.human("review");
  const context = await f.service.call("human_job_termination_context", { instanceId: f.instance.id, terminationId: review.terminationId });
  const args = { instanceId: f.instance.id, terminationId: review.terminationId, reviewHash: review.reviewHash,
    targetScope: context.targetScope, confirmation: TERMINATION_CONFIRMATION, observations: review.observations,
    actor: { username: "fixture-admin", sessionId: "fixture-session", verifiedAt: f.now } };
  f.store.close();
  const child = fork(path.join(import.meta.dirname, "helpers/human-risk-crash.mjs"), { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit"); child.send({ directory: f.directory, key: f.key.toString("hex"), action: "human_job_termination_approve", args, boundary });
  const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, "SIGKILL");
  f.reopen();
  const state = await f.service.call("human_job_termination_view", { instanceId: f.instance.id, terminationId: review.terminationId });
  assert.equal(state.managedAdmissionClosed, boundary === "afterCommit");
  const done = await f.approveTermination(await f.human("review"));
  assert.equal(done.state, "terminated_unknown");
  assert.equal(f.h.state.events.some(e => e.action === "businessWrite"), false);
});

test("permanent gate marks existing tasks inactive and read-only observations cannot reactivate them", async t => {
  const f = await setup(t), ref = "rda_ref_v1_" + "f".repeat(48);
  f.call("commit", { records: [{ ref, scope: f.scope, value: "synthetic-customer-id" }], tasks: [{ id: f.target.jobId, status: "paused" }] });
  const done = await f.approveTermination(await f.human("review"));
  f.call("commit", { records: [], tasks: [{ id: f.target.jobId, status: "paused" }] });
  const taskId = f.store.hash("task", f.auth.contextId, f.scope, f.target.jobId);
  const task = f.store.get("task", taskId, f.auth.contextId, f.store.hash("scope", f.scope));
  assert.equal(task.active, false); assert.equal(task.status, "terminated_unknown"); assert.equal(task.terminationId, done.terminationId);
  assert.equal(f.call("resolve", { refs: [ref] }).records.length, 1);
});
