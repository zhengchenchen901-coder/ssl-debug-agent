import assert from "node:assert/strict";
import test from "node:test";
import { riskReplacementFixture, wire } from "./helpers/risk-replacement-fixture.js";
import { privacyRequest } from "../privacy-service.js";
import { prepareRequestDigest } from "../../plugins/remote-debug-agent/prepare-protocol.js";
const unix = { skip: process.platform === "win32" };
const setup = async t => { const f = riskReplacementFixture(t, { humanRisk: true }); await f.h.initialize(); return f; };
const create = (f, p, options = f.requestOptions) => privacyRequest(f.service, { action: "disposition", mode: "create_replacement", auth: f.auth, scope: f.scope, riskPlanId: p.riskPlanId, reviewHash: p.reviewHash }, options);

test("independent human review accepts unknown history with no receipt or instance quarantine", unix, async t => {
  const f = await setup(t), before = f.call("inspect_operation", { id: f.old.id }), p = f.prepare();
  assert.equal(p.approvalPolicy, "human-risk-acceptance-v2");
  assert.equal(p.canApprove, true); assert.equal(p.remoteFenceConfirmed, false);
  assert.equal(f.call("inspect_disposition", { dispositionId: f.parent.dispositionId }).state, "review_required");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='disposition_hold'").get().n, 0);
  const approved = f.approve(p);
  const disposition = f.call("inspect_disposition", { dispositionId: f.parent.dispositionId });
  assert.equal(disposition.localContainment, true); assert.equal(disposition.containmentScope, "original_job_managed_admissions");
  assert.equal(approved.acceptedResidualRisk, true); assert.equal(approved.originalTaskState, "terminated_unknown");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 1);
  assert.deepEqual(f.call("inspect_operation", { id: f.old.id }), before);
  const result = await create(f, approved);
  assert.equal(result.result.jobId, f.candidate.jobId);
  assert.deepEqual(f.requests, ["/mongodb/bulk/retire", "/mongodb/bulk/prepare"]);
  const originalRemote = await f.h.run({ action: "get", jobId: f.original.jobId });
  assert.equal(originalRemote.status, "terminated_unknown"); assert.equal(originalRemote.originalJobFound, false);
  assert.equal(originalRemote.replacementJobId, f.candidate.jobId);
  assert.equal(f.h.read(f.candidate.jobId, "manifest.json").riskLineage.originalJobId, f.original.jobId);
  assert.equal(f.h.rows("business", "orders").get("order-1").count, 0);
  assert.equal(f.h.state.events.some(e => e.action === "businessWrite"), false);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='disposition_hold'").get().n, 0);
});

test("proposal cannot upload before review; approval closes only the original job across contexts", unix, async t => {
  const f = await setup(t), p = f.prepare();
  await assert.rejects(create(f, p), { code: "BUSINESS_REPLACEMENT_HUMAN_CONFIRMATION_REQUIRED" });
  assert.throws(() => f.store.execute("assert_instance_admission", { instanceId: f.instance.id, route: "/mongodb/bulk/prepare", request: f.candidate }), { code: "BUSINESS_REPLACEMENT_NOT_ADMITTED" });
  f.approve(p);
  for (const route of ["/mongodb/bulk/prepare", "/mongodb/bulk/execute", "/mongodb/bulk/control", "/mongodb/bulk/rollback"]) {
    assert.throws(() => f.store.execute("assert_instance_admission", { instanceId: f.instance.id, route, request: { jobId: f.original.jobId } }), { code: "BUSINESS_ORIGINAL_JOB_TERMINATED" });
  }
  assert.equal(f.store.execute("assert_instance_admission", { instanceId: f.instance.id, route: "/mongodb/bulk/prepare", request: { jobId: "unrelated" } }).ok, true);
  assert.equal(f.requests.length, 0);
});

test("remote retirement failure keeps original closed and creates no replacement intent or upload", unix, async t => {
  const f = await setup(t), p = f.approve(f.prepare());
  await assert.rejects(create(f, p, { ...f.requestOptions, dispatch: async () => { throw Object.assign(Error("synthetic offline"), { code: "SSH_TRANSPORT_LOST" }); } }), { code: "SSH_TRANSPORT_LOST" });
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 1);
  assert.equal(f.inspect(p).originalTaskState, "terminated_unknown");
  assert.equal(f.h.state.events.some(e => e.action === "businessWrite"), false);
});

test("lost remote retirement response resumes the same termination and unique replacement after restart", unix, async t => {
  const f = await setup(t), p = f.approve(f.prepare()); let lost = true;
  const options = { ...f.requestOptions, dispatch: async (...args) => {
    const result = await f.requestOptions.dispatch(...args);
    if (args[1] === "/mongodb/bulk/retire" && lost) { lost = false; throw Object.assign(Error("synthetic lost reply"), { code: "SSH_TRANSPORT_LOST" }); }
    return result;
  } };
  await assert.rejects(create(f, p, options));
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 1);
  f.reopen();
  const result = await create(f, p, options), again = await create(f, p, options);
  assert.equal(result.result.jobId, again.result.jobId);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 2);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='replacement_gate'").get().n, 1);
  assert.equal(f.requests.filter(x => x === "/mongodb/bulk/prepare").length, 1);
});

test("remote retirement binds exact lineage, rejects conflict and persists across helper restarts", unix, async t => {
  const f = await setup(t), p = f.approve(f.prepare());
  await create(f, p);
  const command = f.call("risk_handoff_context", { riskPlanId: p.riskPlanId, reviewHash: p.reviewHash }).request;
  await assert.rejects(f.h.run({ ...command, action: "retire", replacementJobId: "different" }), { code: "MONGODB_BULK_RETIREMENT_CONFLICT" });
  for (const action of ["upload", "executeStart", "resume", "control", "rollbackStart", "sandboxPrepareCleanup"]) {
    const { instanceId, ...originalChunk } = f.original;
    const input = action === "upload" ? { action, chunk: originalChunk } : { action, jobId: f.original.jobId, planHash: "1".repeat(64), command: "resume" };
    await assert.rejects(f.h.run(input), { code: "MONGODB_BULK_JOB_RETIRED" });
  }
});

test("remote acknowledgment is mandatory; public caller cannot inject a termination result", unix, async t => {
  const f = await setup(t), p = f.approve(f.prepare());
  assert.throws(() => f.create(p), { code: "BUSINESS_REPLACEMENT_TERMINATION_REQUIRED" });
  await assert.rejects(f.public({ mode: "create_replacement", riskPlanId: p.riskPlanId, reviewHash: p.reviewHash, result: { managedAdmissionClosed: true } }), { code: "BUSINESS_DISPOSITION_DENIED" });
  await assert.rejects(privacyRequest(f.service, { action: "record_risk_retirement", auth: f.auth, scope: f.scope }, f.requestOptions), { code: "BUSINESS_STORAGE_ACTION_DENIED" });
  await assert.rejects(create(f, p, { ...f.requestOptions, dispatch: async () => ({ ok: true, managedAdmissionClosed: true, status: "terminated_unknown", jobId: "different" }) }), { code: "BUSINESS_REPLACEMENT_TERMINATION_REQUIRED" });
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 1);
});

test("human-created replacement seals normally, admits only its immutable plan, never reopens original", unix, async t => {
  const f = await setup(t), p = f.approve(f.prepare()); await create(f, p);
  const seal = wire({ ...f.candidate, chunkIndex: 1, units: [], endOfUpload: true });
  const intent = await privacyRequest(f.service, { action: "intent", auth: f.auth, scope: f.scope, route: "/mongodb/bulk/prepare", request: seal,
    identity: { instanceId: f.instance.id, jobId: seal.jobId, chunkIndex: 1 }, dispatchDigest: prepareRequestDigest(seal) }, f.requestOptions);
  const result = await privacyRequest(f.service, { action: "dispatch_prepare", auth: f.auth, scope: f.scope, id: intent.id, attempt: 1, request: seal }, f.requestOptions);
  assert.equal(result.status, "prepared");
  assert.equal(f.store.execute("assert_instance_admission", { instanceId: f.instance.id, route: "/mongodb/bulk/execute", request: { jobId: seal.jobId, planHash: result.planHash } }).ok, true);
  assert.throws(() => f.store.execute("assert_instance_admission", { instanceId: f.instance.id, route: "/mongodb/bulk/execute", request: { jobId: seal.jobId, planHash: "f".repeat(64) } }), { code: "BUSINESS_REPLACEMENT_NOT_ADMITTED" });
  assert.equal(f.h.rows("business", "orders").get("order-1").count, 0);
});

test("two proposals cannot both be human-approved for one original; expiry requires fresh review", unix, async t => {
  const f = await setup(t), a = f.prepare(), other = structuredClone(f.candidate);
  other.jobId = "other-replacement"; other.units[0].operations[1].document.remediation_job_id = other.jobId;
  const b = f.prepare(other), approved = f.approve(a);
  assert.throws(() => f.approve(b));
  f.advance(900001);
  await assert.rejects(create(f, approved), { code: "BUSINESS_REPLACEMENT_APPROVAL_EXPIRED" });
  const renewed = f.prepare(); assert.equal(renewed.riskPlanId, a.riskPlanId); assert.equal(renewed.humanApproved, false);
  const again = f.approve(renewed); await create(f, again);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 2);
});

import { once } from "node:events";
import { fork } from "node:child_process";
import path from "node:path";
for (const action of ["human_risk_approve", "create_risk_replacement"]) for (const boundary of ["beforeCommit", "afterCommit"]) {
  test(`v2 actual SIGKILL ${action} ${boundary} preserves atomic termination and one lineage`, unix, async t => {
    const f = await setup(t), p = f.prepare();
    let args = { riskPlanId: p.riskPlanId, reviewHash: p.reviewHash, instanceId: f.instance.id, targetScope: f.scope,
      confirmation: p.confirmation, actor: { username: "synthetic-admin", sessionId: "synthetic-session", verifiedAt: f.now } };
    if (action === "create_risk_replacement") {
      f.approve(p);
      const command = f.call("risk_handoff_context", { riskPlanId: p.riskPlanId, reviewHash: p.reviewHash }).request;
      const result = { ok: true, ...await f.h.run({ action: "retire", ...command }) };
      f.call("record_risk_retirement", { riskPlanId: p.riskPlanId, reviewHash: p.reviewHash, result });
      args = { auth: f.auth, scope: f.scope, riskPlanId: p.riskPlanId, reviewHash: p.reviewHash };
    }
    f.store.close();
    const child = fork(path.join(import.meta.dirname, "helpers/human-risk-crash.mjs"), { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const exited = once(child, "exit"); child.send({ directory: f.directory, key: f.key.toString("hex"), action, args, boundary });
    const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, "SIGKILL");
    f.reopen();
    if (action === "human_risk_approve") {
      assert.equal(f.inspect(p).humanApproved, boundary === "afterCommit");
      assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='risk_job_retirement'").get().n, boundary === "afterCommit" ? 1 : 0);
      f.approve(p);
    } else {
      assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='replacement_gate'").get().n, boundary === "afterCommit" ? 1 : 0);
      const one = f.create(p), two = f.create(p); assert.equal(one.intent.id, two.intent.id);
    }
    assert.equal(f.call("inspect_operation", { id: f.old.id }).state, "uncertain");
  });
}

test("review memo is hash-bound, remote read failures are facts and public input cannot masquerade as evidence", unix, async t => {
  const f = await setup(t);
  const args = { mode: "prepare_risk", dispositionId: f.parent.dispositionId, reviewHash: f.parent.reviewHash, originalRequest: f.original, replacementRequest: f.candidate };
  const a = await f.public({ ...args, reviewMemo: "Synthetic evidence: no persisted compensation observed; history unknown." });
  assert.equal(a.canApprove, true); assert.equal(a.observations.code, "MONGODB_BULK_JOB_NOT_FOUND");
  assert.equal(a.memoSource, "caller_statement_not_verified_evidence");
  const b = await f.public({ ...args, reviewMemo: "Different synthetic review summary" });
  assert.notEqual(a.riskPlanId, b.riskPlanId); assert.equal(f.inspect(a).canApprove, false);
  assert.throws(() => f.approve(a), { code: "BUSINESS_REPLACEMENT_STALE" });
  await assert.rejects(f.public({ ...args, observations: { status: "not_executed" } }), { code: "BUSINESS_DISPOSITION_DENIED" });
});

test("existing remote replacement jobs are not silently adopted by a handoff", unix, async t => {
  const f = await setup(t), { instanceId, ...chunk } = f.candidate;
  await f.h.run({ action: "upload", chunk });
  const p = f.approve(f.prepare());
  await assert.rejects(create(f, p), { code: "MONGODB_BULK_RETIREMENT_CONFLICT" });
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='replacement_gate'").get().n, 0);
  assert.equal(f.h.state.events.some(e => e.action === "businessWrite"), false);
});

test("cooperative helper aborts a transaction if retirement arrives before its commit", unix, async t => {
  const f = await setup(t), { instanceId, ...chunk } = f.original;
  await f.h.run({ action: "upload", chunk });
  const prepared = await f.h.run({ action: "upload", chunk: { ...chunk, chunkIndex: 1, units: [], endOfUpload: true } });
  const leaseId = "4".repeat(64);
  await f.h.run({ action: "executeStart", jobId: chunk.jobId, planHash: prepared.planHash, leaseId });
  const push = f.h.state.events.push.bind(f.h.state.events); let injected = false;
  f.h.state.events.push = event => {
    const count = push(event);
    if (!injected && event.action === "insert" && event.name === "__remote_debug_bulk_receipts") {
      injected = true;
      f.h.write(chunk.jobId, "retirement.json", { version: 1, jobId: chunk.jobId, database: "business", status: "terminated_unknown", replacementJobId: "synthetic-next", riskPlanId: "1".repeat(64) });
    }
    return count;
  };
  await assert.rejects(f.h.run({ action: "executeBatch", jobId: chunk.jobId, planHash: prepared.planHash, leaseId, batchIndex: 0 }), { code: "MONGODB_BULK_JOB_RETIRED" });
  assert.equal(injected, true);
  assert.equal(f.h.rows("business", "orders").get("order-1").count, 0);
  assert.equal(f.h.rows("business", "orders").has("compensation-1"), false);
});

test("concurrent approved creators cannot establish a second replacement", unix, async t => {
  const f = await setup(t), p = f.approve(f.prepare());
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => create(f, p)));
  assert.ok(results.some(r => r.status === "fulfilled"));
  await create(f, p);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='replacement_gate'").get().n, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 2);
  assert.equal(f.h.read(f.candidate.jobId, "manifest.json").riskLineage.originalJobId, f.original.jobId);
  assert.equal(f.h.rows("business", "orders").get("order-1").count, 0);
});
