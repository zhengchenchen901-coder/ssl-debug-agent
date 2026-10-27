import assert from "node:assert/strict";
import test from "node:test";
import { importRiskFixture } from "./helpers/import-risk-fixture.js";
import { privacyRequest } from "../privacy-service.js";
import { ManualWorkbench } from "../manual-workbench.js";
const count = (f, kind) => f.store.db.prepare("SELECT count(*) n FROM records WHERE kind=?").get(kind).n;

test("import human risk review binds historical bytes, exact batches, observations and preserves original uncertainty", async t => {
  const f = importRiskFixture(t), before = f.call("inspect_operation", { id: f.old.id }), plan = await f.prepare();
  assert.equal(plan.kind, "import"); assert.equal(plan.approvalPolicy, "human-risk-acceptance-v2");
  assert.equal(plan.canApprove, true); assert.equal(plan.binding.importId, f.original.importId);
  assert.deepEqual(plan.originalBatches.map(b => b.documentCount), [2, 1]);
  assert.equal(plan.observations.source, "manager_remote_import_batch_read");
  assert.deepEqual(plan.observations.batches.map(b => b.status), ["missing", "missing"]);
  assert.equal(plan.historicalOutcome, "unknown"); assert.equal(plan.atomicity, "per_batch");
  assert.equal(JSON.stringify(plan).includes("synthetic-a"), false);
  const approved = f.approve(plan); assert.equal(approved.humanApproved, true);
  const disposition = f.call("inspect_disposition", { dispositionId: plan.dispositionId });
  assert.equal(disposition.replacementImportId, f.candidate.importId); assert.equal(disposition.historicalOutcome, "unknown");
  assert.equal(count(f, "operation"), 1); assert.equal(count(f, "disposition_hold"), 0);
  assert.deepEqual(f.call("inspect_operation", { id: f.old.id }), before);
  const result = await f.create(approved);
  assert.equal(result.result.status, "prepared"); assert.equal(result.result.importId, f.candidate.importId);
  assert.equal(result.result.batches.length, 2); assert.equal(f.h.state.insert, 0); assert.equal(f.h.state.rows.size, 0);
  assert.deepEqual(f.call("inspect_operation", { id: f.old.id }), before);
  assert.equal(count(f, "operation"), 2); assert.equal(count(f, "risk_import_gate"), 1);
  const saved = f.inspect(plan); assert.equal(saved.state, "prepared"); assert.equal(saved.batches.length, 2);
  for (const batch of result.result.batches) {
    const manifest = JSON.parse(f.h.files.get(batch.journalPath + "/manifest.json"));
    assert.equal(manifest.riskLineage.originalImportId, f.original.importId);
    assert.equal(manifest.riskLineage.riskPlanId, plan.riskPlanId);
    assert.equal(f.store.execute("assert_instance_admission", { instanceId: f.instance.id, route: "/mongodb/mutations/execute", request: { mutationId: batch.mutationId, planHash: batch.planHash } }).ok, true);
    assert.throws(() => f.store.execute("assert_instance_admission", { instanceId: f.instance.id, route: "/mongodb/mutations/execute", request: { mutationId: batch.mutationId, planHash: "f".repeat(64) } }));
  }
});

test("import proposal rejects payload, order, BSON field order, collection, target and batching changes", async t => {
  const f = importRiskFixture(t);
  for (const edit of [r => r.documents.reverse(), r => r.documents[0].nested = { a: 2, z: 1 }, r => r.documents[0].nested.a++,
    r => r.documents.push({ _id: "extra" }), r => r.collection = "other", r => r.database = "other", r => r.instanceId = "other",
    r => r.batchSize = 1, r => r.rollbackTtlMs = 60000, r => r.purpose = "changed", r => r.jobId = "fake-bulk"]) {
    const request = structuredClone(f.candidate); edit(request);
    await assert.rejects(f.prepare(request));
  }
  assert.equal(count(f, "risk_replacement"), 0); assert.equal(f.h.state.insert, 0);
  const changed = structuredClone(f.original); changed.documents.reverse();
  await assert.rejects(f.pub({ mode: "prepare", id: f.old.id, originalRequest: changed }));
});

test("import candidates and originals are gated across contexts; human approval creates no replacement", async t => {
  const f = importRiskFixture(t), plan = await f.prepare();
  await assert.rejects(f.create(plan), { code: "BUSINESS_REPLACEMENT_HUMAN_CONFIRMATION_REQUIRED" });
  assert.throws(() => f.store.execute("assert_instance_admission", { instanceId: f.instance.id, route: "/mongodb/imports/prepare", request: f.candidate }));
  f.approve(plan); assert.equal(count(f, "operation"), 1);
  assert.throws(() => f.store.execute("assert_instance_admission", { instanceId: f.instance.id, route: "/mongodb/imports/prepare", request: f.original }), { code: "BUSINESS_ORIGINAL_JOB_TERMINATED" });
  for (const batch of plan.originalBatches) assert.throws(() => f.store.execute("assert_instance_admission", { instanceId: f.instance.id, route: "/mongodb/mutations/execute", request: { mutationId: batch.mutationId, planHash: "a".repeat(64) } }), { code: "BUSINESS_ORIGINAL_JOB_TERMINATED" });
  assert.equal(f.store.execute("assert_instance_admission", { instanceId: f.instance.id, route: "/mongodb/imports/prepare", request: { ...f.original, importId: "unrelated" } }).ok, true);
});

test("import retirement and lost preparation replies resume only the one replacement after restart", async t => {
  const f = importRiskFixture(t), p = f.approve(await f.prepare()); let lostRetirement = true, lostPrepare = true;
  const options = { ...f.requestOptions, dispatch: async (...args) => {
    const result = await f.requestOptions.dispatch(...args);
    if (args[1] === "/mongodb/imports/retire" && lostRetirement) { lostRetirement = false; throw Error("lost retirement reply"); }
    if (args[1] === "/mongodb/imports/prepare" && lostPrepare) { lostPrepare = false; throw Error("lost prepare reply"); }
    return result;
  } };
  const create = () => privacyRequest(f.service, { action: "disposition", auth: f.auth, scope: f.scope, mode: "create_replacement", riskPlanId: p.riskPlanId, reviewHash: p.reviewHash }, options);
  await assert.rejects(create()); assert.equal(count(f, "operation"), 1); f.reopen();
  const uncertain = await create(); assert.equal(uncertain.result.intentState, "uncertain"); assert.equal(count(f, "operation"), 2);
  f.reopen(); const recovered = await create();
  assert.equal(recovered.result.state, "complete"); assert.equal(recovered.result.result.status, "prepared");
  const again = await create(); assert.equal(again.result.importId, f.candidate.importId);
  assert.equal(count(f, "operation"), 2); assert.equal(count(f, "risk_import_gate"), 1);
  assert.equal(f.requests.filter(r => r === "/mongodb/imports/prepare").length, 1);
});

test("missing terminal import receipt stays uncertain and cannot replay preparation", async t => {
  const f = importRiskFixture(t), p = f.approve(await f.prepare());
  const options = { ...f.requestOptions, dispatch: async (...args) => args[1] === "/mongodb/imports/prepare" ? (() => { throw Error("lost before any evidence"); })() : f.requestOptions.dispatch(...args) };
  const create = () => privacyRequest(f.service, { action: "disposition", auth: f.auth, scope: f.scope, mode: "create_replacement", riskPlanId: p.riskPlanId, reviewHash: p.reviewHash }, options);
  assert.equal((await create()).result.intentState, "uncertain");
  assert.equal((await create()).result.state, "uncertain"); assert.equal(f.h.state.insert, 0);
});

test("import approval expires, competing proposal is rejected, exact identity can be reviewed again", async t => {
  const f = importRiskFixture(t), p = f.approve(await f.prepare());
  await assert.rejects(f.prepare({ ...f.candidate, importId: "another-replacement" }), { code: "BUSINESS_REPLACEMENT_JOB_CONFLICT" });
  f.advance(900001); await assert.rejects(f.create(p), { code: "BUSINESS_REPLACEMENT_APPROVAL_EXPIRED" });
  const renewed = await f.prepare(); assert.equal(renewed.riskPlanId, p.riskPlanId); assert.equal(renewed.humanApproved, false);
  await f.create(f.approve(renewed)); assert.equal(count(f, "operation"), 2);
});

test("import public API cannot supply approval, evidence or direct store actions", async t => {
  const f = importRiskFixture(t), p = await f.prepare();
  for (const extra of [{ actor: { username: "invented" } }, { approved: true }, { result: { ok: true } }]) await assert.rejects(f.pub({ mode: "create_replacement", riskPlanId: p.riskPlanId, reviewHash: p.reviewHash, ...extra }), { code: "BUSINESS_DISPOSITION_DENIED" });
  await assert.rejects(privacyRequest(f.service, { action: "human_risk_approve", auth: f.auth, scope: f.scope }, f.requestOptions), { code: "BUSINESS_STORAGE_ACTION_DENIED" });
  assert.equal(count(f, "operation"), 1);
});

test("independent import workbench requires same-session review and fresh native verification; cancellation is not approval", async t => {
  const f = importRiskFixture(t, { liveClock: true }), plan = await f.prepare(); let verifications = 0, cancelled = true;
  const workbench = new ManualWorkbench({ registry: { getInternal: f.requestOptions.instance }, dataDirectory: f.root,
    ownerVerification: { status: () => ({ supported: true }), verify: async () => { verifications++; if (cancelled) throw Object.assign(Error("cancelled"), { code: "OWNER_VERIFICATION_FAILED" }); } },
    riskReview: f.human });
  await workbench.store.register("admin", "disposable-import-password-123");
  const login = await workbench.login({ username: "admin", password: "disposable-import-password-123", instanceId: f.instance.id });
  await workbench.start(); t.after(() => workbench.close());
  const api = async (route, body, token = login.token) => { const r = await fetch(workbench.origin + route, { method: "POST", headers: { Authorization: "Bearer " + token, Origin: workbench.origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const approval = { riskPlanId: plan.riskPlanId, reviewHash: plan.reviewHash, confirmation: plan.confirmation };
  assert.equal((await api("/api/risk-replacement/approve", approval)).status, 409);
  assert.equal((await api("/api/risk-replacement/review", { riskPlanId: plan.riskPlanId }, f.auth.capability)).status, 401);
  const review = await api("/api/risk-replacement/review", { riskPlanId: plan.riskPlanId });
  assert.equal(review.status, 200); assert.equal(review.body.kind, "import");
  assert.equal((await api("/api/risk-replacement/approve", approval)).status, 400);
  assert.equal(f.inspect(plan).humanApproved, false); cancelled = false;
  assert.equal((await api("/api/risk-replacement/approve", approval)).status, 200);
  assert.equal(verifications, 2); assert.equal(count(f, "operation"), 1); assert.equal(f.h.state.insert, 0);
});


test("import approval renewal after creation retains exact lineage and terminal receipt", async t => {
  const f = importRiskFixture(t), p = f.approve(await f.prepare());
  const first = await f.create(p); f.advance(900001);
  const renewed = f.approve(await f.prepare()), again = await f.create(renewed);
  assert.equal(again.result.importId, first.result.importId);
  assert.equal(count(f, "operation"), 2); assert.equal(count(f, "risk_import_gate"), 1);
  assert.equal(f.h.state.insert, 0);
});

test("import batch review reports committed and unknown receipts without discharging historical intent", async t => {
  const f = importRiskFixture(t);
  const prior = await f.h.run({ ...f.original, kind: "import_plan", mode: "prepare" });
  await f.h.run({ mode: "commit", mutationId: prior.batches[0].mutationId, planHash: prior.batches[0].planHash, confirmation: "确认执行" });
  f.h.state.loseCommitReply = true;
  await assert.rejects(f.h.run({ mode: "commit", mutationId: prior.batches[1].mutationId, planHash: prior.batches[1].planHash, confirmation: "确认执行" }));
  const p = await f.prepare(); assert.deepEqual(p.observations.batches.map(b => b.status), ["committed", "commit_unknown"]);
  assert.equal(f.call("inspect_operation", { id: f.old.id }).state, "uncertain");
  await f.create(f.approve(p));
  const originalManifestPath = prior.batches[0].journalPath + "/manifest.json", originalManifest = f.h.files.get(originalManifestPath);
  await assert.rejects(f.h.run({ mode: "commit", mutationId: prior.batches[0].mutationId, planHash: prior.batches[0].planHash, confirmation: "确认执行" }), { code: "MONGODB_IMPORT_RETIRED" });
  await assert.rejects(f.h.run({ mode: "rollback", mutationId: prior.batches[0].mutationId, planHash: prior.batches[0].planHash, confirmation: "确认回滚" }), { code: "MONGODB_IMPORT_RETIRED" });
  assert.equal(f.h.files.get(originalManifestPath), originalManifest, "rejected admissions must not edit historical journals");
  await assert.rejects(f.h.run({ ...f.original, kind: "import_plan", mode: "prepare" }), { code: "MONGODB_IMPORT_RETIRED" });
});

test("existing remote replacement manifests cannot be adopted, even with identical documents", async t => {
  const f = importRiskFixture(t), p = f.approve(await f.prepare());
  await f.h.run({ ...f.candidate, kind: "import_plan", mode: "prepare" });
  await assert.rejects(f.create(p), { code: "MONGODB_IMPORT_RETIREMENT_CONFLICT" });
  assert.equal(count(f, "operation"), 1);
});

test("import receipt target mismatch, corruption or a partial batch list cannot be reported as complete preparation", async t => {
  for (const edit of [r => r.database = "wrong", r => r.batches.pop(), r => r.importReceipt.batchesDigest = "f".repeat(64)]) {
    const f = importRiskFixture(t), p = f.approve(await f.prepare());
    const options = { ...f.requestOptions, dispatch: async (...args) => {
      const result = await f.requestOptions.dispatch(...args);
      if (args[1] === "/mongodb/imports/prepare") edit(result);
      return result;
    } };
    const result = await privacyRequest(f.service, { action: "disposition", auth: f.auth, scope: f.scope, mode: "create_replacement", riskPlanId: p.riskPlanId, reviewHash: p.reviewHash }, options);
    assert.equal(result.result.intentState, "uncertain"); assert.equal(f.h.state.insert, 0);
  }
});


import { once } from "node:events";
import { fork } from "node:child_process";
import path from "node:path";
for (const action of ["human_risk_approve", "create_risk_replacement"]) for (const boundary of ["beforeCommit", "afterCommit"]) {
  test(`import SIGKILL ${action} ${boundary} preserves one lineage and historical bytes`, { skip: process.platform === "win32" }, async t => {
    const f = importRiskFixture(t, { liveClock: true }), p = await f.prepare();
    const before = f.call("inspect_operation", { id: f.old.id });
    let args = { riskPlanId: p.riskPlanId, instanceId: f.instance.id, targetScope: f.scope, reviewHash: p.reviewHash,
      confirmation: p.confirmation, actor: { username: "synthetic-admin", sessionId: "synthetic-session", verifiedAt: Date.now() } };
    if (action === "create_risk_replacement") {
      f.approve(p);
      const handoff = f.call("risk_handoff_context", { riskPlanId: p.riskPlanId, reviewHash: p.reviewHash });
      const result = await f.requestOptions.dispatch(f.instance.id, handoff.route, handoff.request);
      f.call("record_risk_retirement", { riskPlanId: p.riskPlanId, reviewHash: p.reviewHash, result });
      args = { auth: f.auth, scope: f.scope, riskPlanId: p.riskPlanId, reviewHash: p.reviewHash };
    }
    f.store.close();
    const child = fork(path.join(import.meta.dirname, "helpers/human-risk-crash.mjs"), { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const exited = once(child, "exit"); child.send({ directory: f.directory, key: f.key.toString("hex"), action, args, boundary });
    const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, "SIGKILL"); f.reopen();
    if (action === "human_risk_approve") { assert.equal(f.inspect(p).humanApproved, boundary === "afterCommit"); f.approve(p); }
    await f.create(f.inspect(p));
    assert.equal(count(f, "operation"), 2); assert.equal(count(f, "risk_import_gate"), 1);
    assert.deepEqual(f.call("inspect_operation", { id: f.old.id }), before); assert.equal(f.h.state.insert, 0);
  });
}

test("new import protocol can retry exact pre-SSH rejection without a human risk override", async t => {
  const f = importRiskFixture(t), request = { ...f.original, importId: "normal-new-import" };
  const intentInput = { auth: f.auth, scope: f.scope, route: "/mongodb/imports/prepare", request, dispatchDigest: f.digest(request),
    identity: { instanceId: f.instance.id, database: request.database, collection: request.collection, importId: request.importId } };
  let intent = f.call("intent", intentInput);
  const config = f.instance.mongodb; f.instance.mongodb = { ...config, allowedCollections: ["other"] };
  const dispatch = () => privacyRequest(f.service, { action: "dispatch_prepare", auth: f.auth, scope: f.scope, id: intent.id, attempt: intent.importPrepare.attempt, request }, f.requestOptions);
  const rejected = await dispatch(); assert.equal(rejected.intentState, "rejected_before_dispatch"); assert.equal(f.requests.length, 0);
  f.instance.mongodb = config; const again = f.call("intent", intentInput);
  assert.equal(again.id, intent.id); assert.equal(again.importPrepare.attempt, 2); intent = again;
  assert.equal((await dispatch()).status, "prepared"); assert.equal(f.h.state.insert, 0);
});

import { importHarness } from "./helpers/import-fixture.js";
test("partial import preparation continues the same batches and archives its terminal prefix evidence", async t => {
  let injected = false;
  // Preflight has its own read-only client. Inject at the business boundary:
  // first batch manifest durably saved, before the second batch connects.
  const h = importHarness({ cleanup: () => {
    if (!injected && [...h.files.keys()].some(p => p.endsWith("/manifest.json"))) { injected = true; h.state.failConnect = true; }
  } });
  const f = importRiskFixture(t, { harness: h }), p = f.approve(await f.prepare());
  const partial = await f.create(p); assert.equal(partial.result.status, "prepare_partial"); assert.equal(partial.result.batches.length, 1);
  assert.equal(f.inspect(p).state, "prepare_partial"); h.state.failConnect = false;
  const completed = await f.create(p);
  assert.equal(completed.result.status, "prepared"); assert.equal(completed.result.batches.length, 2);
  assert.equal(completed.result.batches[0].planHash, partial.result.batches[0].planHash);
  assert.equal(count(f, "operation"), 2); assert.equal(count(f, "import_prepare_evidence"), 1); assert.equal(h.state.insert, 0);
});
