import assert from "node:assert/strict";
import test from "node:test";
import { executionRiskFixture } from "./helpers/execution-risk-fixture.js";
import { privacyRequest } from "../privacy-service.js";
import { ManualWorkbench } from "../manual-workbench.js";
import { importHarness } from "./helpers/import-fixture.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { spawn } from "node:child_process";

for (const stage of ["closure", "child"]) test(`remote SIGKILL after durable ${stage} recovers only the same child without clearing dead locks`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rda-execution-risk-crash-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const x = await executionRiskFixture(t, { harness: importHarness({ realFiles: root }) }), p = await x.prepare(); await x.approve(p);
  const reserved = x.f.call("execution_risk_reserve", { riskPlanId: p.riskPlanId, reviewHash: p.reviewHash });
  const request = { mode: "execution_risk_continue", ...reserved, _businessExecution: reserved.binding.execution };
  const file = path.join(root, "synthetic-request.json"); fs.writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, "helpers/execution-risk-crash.mjs"), root, file, stage], { stdio: "ignore" });
  const result = await new Promise((resolve, reject) => { proc.on("error", reject); proc.on("exit", (code, signal) => resolve({ code, signal })); });
  assert.equal(result.signal, "SIGKILL");
  const originalLock = fs.readFileSync(path.join(root, x.batch.mutationId, ".lock"), "utf8");
  x.f.reopen(); const child = await x.continue(p);
  assert.equal(child.mutationId, p.mutationId); assert.equal(child.planHash, p.planHash);
  assert.equal(fs.readFileSync(path.join(root, x.batch.mutationId, ".lock"), "utf8"), originalLock);
  assert.equal(x.f.h.state.rows.size, 0); assert.equal(x.f.call("inspect_operation", { id: x.intent.id }).state, "uncertain");
});

for (const action of ["human_execution_risk_approve", "execution_risk_reserve"])
  for (const boundary of ["beforeCommit", "afterCommit"]) test(`SIGKILL ${boundary} of ${action} recovers its exact durable authorization`, async t => {
    const x = await executionRiskFixture(t, { liveClock: true }), { f } = x, p = await x.prepare();
    if (action === "execution_risk_reserve") await x.approve(p);
    const args = { auth: f.auth, scope: f.scope, targetScope: f.scope, instanceId: f.instance.id,
      riskPlanId: p.riskPlanId, reviewHash: p.reviewHash, confirmation: p.confirmation,
      actor: { username: "synthetic-native-admin", sessionId: "synthetic-native-session", verifiedAt: Date.now() } };
    const child = fork(path.join(import.meta.dirname, "helpers/human-risk-crash.mjs"), { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal })); });
    child.send({ directory: f.directory, key: f.key.toString("hex"), boundary, action, args });
    assert.equal((await exited).signal, "SIGKILL"); f.reopen();
    const state = await x.pub({ mode: "inspect_execution_risk", riskPlanId: p.riskPlanId });
    if (action === "human_execution_risk_approve") assert.equal(state.humanApproved, boundary === "afterCommit");
    else assert.equal(state.state, boundary === "afterCommit" ? "reserved" : "human_approved");
    assert.equal(f.call("inspect_operation", { id: x.intent.id }).state, "uncertain"); assert.equal(f.h.state.rows.size, 0);
    if (!state.humanApproved) await x.approve(p);
    const recovered = await x.continue(p); assert.equal(recovered.mutationId, p.mutationId); assert.equal(recovered.planHash, p.planHash);
  });

test("historical plan without collection UUID is retained; only explicitly reviewed child binds the current UUID", async t => {
  const x = await executionRiskFixture(t, { legacy: true, legacyNoUuid: true });
  const file = "/tmp/remote-debug-agent/mutations/" + x.batch.mutationId + "/manifest.json";
  const originalBytes = x.f.h.files.get(file), p = await x.prepare();
  assert.equal(p.originalCollectionIdentity, null); assert.equal(p.collectionIdentity, "synthetic-uuid-1");
  assert.notEqual(p.planHash, x.batch.planHash); await x.approve(p); const child = await x.continue(p);
  assert.equal(child.binding.planHash, x.batch.planHash); assert.equal(x.f.h.files.get(file), originalBytes);
  assert.equal(child.binding.executionProtocol, null); assert.equal(child.result.requiresConfirmation, true);
});

for (const legacy of [true, false]) test(`${legacy ? "legacy .2" : "v2 unknown"} execution gets independent human review and one same-import immutable child`, async t => {
  const x = await executionRiskFixture(t, { legacy }), { f } = x;
  const original = f.call("inspect_operation", { id: x.intent.id });
  const p = await x.prepare();
  assert.equal(p.kind, "import_execution"); assert.equal(p.binding.execution.operationId, "synthetic-original-execute");
  assert.equal(p.binding.attempt, legacy ? null : 1); assert.equal(p.humanApproved, false);
  assert.notEqual(p.planHash, x.batch.planHash); assert.notEqual(p.mutationId, x.batch.mutationId);
  assert.equal(p.binding.importId, f.candidate.importId); assert.equal(p.historicalOutcome, "unknown");
  await assert.rejects(x.continue(p), { code: "BUSINESS_EXECUTION_RISK_HUMAN_REQUIRED" });
  for (const mode of ["approve_execution_risk", "human_execution_risk_approve"])
    await assert.rejects(f.pub({ mode, riskPlanId: p.riskPlanId }), { code: "BUSINESS_DISPOSITION_DENIED" });
  const human = await f.human("human_execution_risk_view", { riskPlanId: p.riskPlanId, instanceId: f.instance.id });
  assert.equal(human.orderedDocuments, JSON.stringify(f.candidate.documents.slice(0, 2)));
  assert.equal(human.knownExecution.execution.operationId, x.execution.operationId);
  const approved = await x.approve(p); assert.equal(approved.humanApproved, true);
  f.reopen();
  const child = await x.continue(approved); assert.equal(child.state, "prepared");
  assert.equal(child.result.importId, f.candidate.importId); assert.equal(f.h.state.rows.size, 0);
  assert.deepEqual(await x.continue(approved), child);
  assert.deepEqual(f.call("inspect_operation", { id: x.intent.id }), original);
  assert.throws(() => f.call("intent", { route: "/mongodb/mutations/execute", request: x.request, identity: original.identity }), { code: "BUSINESS_EXECUTION_ORIGINAL_PROTECTED" });
  const r = { mutationId: child.mutationId, planHash: child.planHash, confirmation: "确认执行" };
  await assert.rejects(f.h.run({ ...r, mode: "commit" }), { code: "MONGODB_EXECUTION_IDENTITY_INVALID" });
  const next = f.call("intent", { route: "/mongodb/mutations/execute", request: r, identity: { instanceId: f.instance.id, mutationId: r.mutationId, planHash: r.planHash } });
  const ticket = f.call("claim_execution", { id: next.id, operationId: "synthetic-child-execute", attempt: next.executionAttempt });
  assert.equal((await f.h.run({ ...r, mode: "commit", _businessExecution: ticket })).status, "committed");
  assert.equal(f.h.state.rows.size, 2); assert.deepEqual(f.call("inspect_operation", { id: x.intent.id }), original);
  assert.equal((await x.pub({ mode: "inspect_execution_risk", riskPlanId: p.riskPlanId })).historicalOutcome, "unknown");
});

test("old prepare approval, caller proof and cross-context requests cannot authorize execution risk", async t => {
  const x = await executionRiskFixture(t), { f } = x, p = await x.prepare();
  await assert.rejects(x.continue({ ...p, reviewHash: x.lineage.reviewHash }), { code: "BUSINESS_EXECUTION_RISK_HUMAN_REQUIRED" });
  await assert.rejects(privacyRequest(f.service, { action: "human_execution_risk_approve", ...f.auth, scope: f.scope }, x.requestOptions), { code: "BUSINESS_STORAGE_ACTION_DENIED" });
  await assert.rejects(x.pub({ mode: "prepare_execution_risk", id: x.intent.id, riskPlanId: x.lineage.riskPlanId, proof: { safe: true } }), { code: "BUSINESS_DISPOSITION_DENIED" });
  const auth = f.store.execute("create");
  await assert.rejects(privacyRequest(f.service, { action: "disposition", mode: "prepare_execution_risk", auth, scope: f.scope, id: x.intent.id, riskPlanId: x.lineage.riskPlanId }, x.requestOptions));
  await assert.rejects(f.human("human_execution_risk_approve", { riskPlanId: p.riskPlanId, instanceId: f.instance.id, reviewHash: p.reviewHash,
    confirmation: x.lineage.confirmation, actor: { username: "a", sessionId: "b", verifiedAt: f.now } }));
  assert.equal(f.h.state.rows.size, 0);
});

test("UUID change, duplicates and expiry never silently change approved plan; expired drafts retain revisions", async t => {
  const x = await executionRiskFixture(t), { f } = x, p = await x.prepare(); await x.approve(p);
  f.h.state.collectionUuid = "new-after-review";
  await assert.rejects(x.continue(p), { code: "MONGODB_EXECUTION_REVIEW_CONFLICT" });
  assert.equal((await x.pub({ mode: "inspect_execution_risk", riskPlanId: p.riskPlanId })).state, "reserved");
  assert.equal(f.call("inspect_operation", { id: x.intent.id }).state, "uncertain");
  const y = await executionRiskFixture(t), draft = await y.prepare(); y.f.advance(900001);
  await assert.rejects(y.approve(draft));
  const fresh = await y.prepare(); assert.equal(fresh.riskPlanId, draft.riskPlanId); assert.notEqual(fresh.reviewHash, draft.reviewHash);
  assert.equal(y.f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='execution_risk_revision'").get().n, 1);
});

test("lost remote reply and concurrent consumption recover the one durable reservation after restart", async t => {
  const x = await executionRiskFixture(t), { f } = x, p = await x.prepare(); await x.approve(p);
  let lose = true;
  const opts = { ...x.requestOptions, dispatch: async (...args) => { const r = await x.requestOptions.dispatch(...args);
    if (lose && args[1].endsWith("execution-continue")) { lose = false; throw Error("synthetic lost reply"); } return r; } };
  await assert.rejects(privacyRequest(f.service, { action: "disposition", mode: "continue_execution", auth: f.auth, scope: f.scope, riskPlanId: p.riskPlanId, reviewHash: p.reviewHash }, opts));
  f.reopen();
  const results = await Promise.allSettled([x.continue(p), x.continue(p)]);
  assert.ok(results.some(r => r.status === "fulfilled"));
  const child = await x.continue(p); assert.equal(child.mutationId, p.mutationId); assert.equal(child.planHash, p.planHash);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='execution_risk'").get().n, 1);
  assert.equal(f.h.state.rows.size, 0);
});

test("late machine evidence stays separate and closes child admission; unknown child cannot get another review", async t => {
  const x = await executionRiskFixture(t), { f } = x, p = await x.prepare(); await x.approve(p); const child = await x.continue(p);
  const old = f.call("inspect_operation", { id: x.intent.id });
  f.call("outcome", { id: x.intent.id, result: { ok: true, status: "committed" } });
  assert.deepEqual(f.call("inspect_operation", { id: x.intent.id }), old);
  const entry = { mutationId: x.batch.mutationId, planHash: x.batch.planHash, status: "committed", execution: x.execution,
    importExecution: { version: 2, execution: x.execution, stage: "acknowledged", mutationId: x.batch.mutationId, planHash: x.batch.planHash,
      database: "test", collection: "members", mode: "commit", confirmation: "确认执行" } };
  f.call("reconcile", { id: x.intent.id, result: { ok: true, entries: [entry] } });
  assert.deepEqual(f.call("inspect_operation", { id: x.intent.id }), old);
  const late = await x.pub({ mode: "inspect_execution_risk", riskPlanId: p.riskPlanId });
  assert.equal(late.lateOriginalCommitObserved, true); assert.equal(late.lateObservation.exactAcknowledgedCommit, true);
  await assert.rejects(x.continue(p), { code: "BUSINESS_EXECUTION_RISK_STALE" });
  assert.throws(() => f.call("intent", { route: "/mongodb/mutations/execute", request: child.result,
    identity: { instanceId: f.instance.id, mutationId: child.mutationId, planHash: child.planHash } }));
});

test("execution workbench uses separate review session, rejects Manager/context tokens, and verifies native identity freshly", async t => {
  const x = await executionRiskFixture(t, { liveClock: true }), { f } = x, p = await x.prepare();
  let checks = 0, cancel = false;
  const w = new ManualWorkbench({ registry: { getInternal: () => f.instance }, dataDirectory: f.root,
    ownerVerification: { status: () => ({ supported: true }), verify: async () => { checks++; if (cancel) throw Error("cancel"); } },
    riskReview: (action, input) => f.human(action, input) });
  await w.store.register("admin", "disposable-execution-risk-password");
  const login = await w.login({ username: "admin", password: "disposable-execution-risk-password", instanceId: f.instance.id });
  await w.start(); t.after(() => w.close());
  const api = async (route, body, token = login.token, origin = w.origin) => {
    const r = await fetch(w.origin + route, { method: "POST", headers: { Authorization: "Bearer " + token, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const args = { riskPlanId: p.riskPlanId, reviewHash: p.reviewHash, confirmation: p.confirmation };
  assert.equal((await api("/api/execution-risk/approve", args)).status, 409);
  for (const token of ["a".repeat(64), f.auth.capability]) assert.equal((await api("/api/execution-risk/review", { riskPlanId: p.riskPlanId }, token)).status, 401);
  assert.equal((await api("/api/execution-risk/review", { riskPlanId: p.riskPlanId }, login.token, "http://evil.invalid")).status, 403);
  const reviewed = await api("/api/execution-risk/review", { riskPlanId: p.riskPlanId }); assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.orderedDocuments, JSON.stringify(f.candidate.documents.slice(0, 2)));
  cancel = true; assert.notEqual((await api("/api/execution-risk/approve", args)).status, 200);
  assert.equal((await x.pub({ mode: "inspect_execution_risk", riskPlanId: p.riskPlanId })).humanApproved, false);
  cancel = false;
  assert.equal((await api("/api/execution-risk/approve", args)).status, 200); assert.equal(checks, 2);
  assert.equal((await api("/api/execution-risk/approve", args)).status, 409); assert.equal(f.h.state.rows.size, 0);
});

test("remote original closure survives child manifest I/O failure and recovers only the identical reserved child", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rda-execution-risk-io-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let armed = false;
  const h = importHarness({ realFiles: root, beforeRename: (tmp, file) => {
    if (armed && file.endsWith("/manifest.json") && JSON.parse(fs.readFileSync(tmp)).executionContinuation) {
      armed = false; throw Object.assign(Error("synthetic disk fault before child manifest"), { code: "EIO" });
    }
  } });
  const x = await executionRiskFixture(t, { harness: h }), p = await x.prepare(); await x.approve(p); armed = true;
  await assert.rejects(x.continue(p));
  assert.ok(fs.existsSync(path.join(root, x.batch.mutationId, "execution-continuation.json")));
  assert.equal(fs.existsSync(path.join(root, p.mutationId, "manifest.json")), false);
  x.f.reopen(); const child = await x.continue(p); assert.equal(child.planHash, p.planHash); assert.equal(h.state.rows.size, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, child.mutationId, "manifest.json"))).status, "planned");
});

test("remote old-journal lock rejection releases the separate global lock without clearing the old lock", async t => {
  const x = await executionRiskFixture(t), p = await x.prepare(); await x.approve(p);
  const lock = "/tmp/remote-debug-agent/mutations/" + x.batch.mutationId + "/.lock";
  x.f.h.files.set(lock, "synthetic-live-owner");
  await assert.rejects(x.continue(p), { code: "MONGODB_MUTATION_BUSY" });
  assert.equal(x.f.h.files.get(lock), "synthetic-live-owner");
  assert.equal(x.f.h.files.has("/tmp/remote-debug-agent/mutations/import-control-lock/.lock"), false);
  assert.equal((await x.pub({ mode: "inspect_execution_risk", riskPlanId: p.riskPlanId })).state, "reserved");
});

test("duplicate prerequisites, wrong execution operation and changed UUID cannot enter human approval", async t => {
  const x = await executionRiskFixture(t), { f } = x;
  f.h.state.rows.set(f.h.key(f.candidate.documents[0]._id), f.candidate.documents[0]);
  await assert.rejects(x.prepare(), { code: "MONGODB_MUTATION_TARGET_EXISTS" }); f.h.state.rows.clear();
  const context = f.call("execution_risk_context", { id: x.intent.id, riskPlanId: x.lineage.riskPlanId });
  const b = context.binding;
  await assert.rejects(f.h.run({ mode: "execution_risk_review", binding: b, _businessExecution: { ...b.execution, operationId: "different-operation" } }), { code: "MONGODB_EXECUTION_REVIEW_CONFLICT" });
  const p = await x.prepare(); await x.approve(p);
  // UUID is a prerequisite, never silently changed under an approved hash.
  f.h.state.collectionUuid = "recreated-after-approval";
  await assert.rejects(x.continue(p), { code: "MONGODB_EXECUTION_REVIEW_CONFLICT" }); assert.equal(f.h.state.rows.size, 0);
});
