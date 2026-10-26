import assert from "node:assert/strict";
import test from "node:test";
import { ManualWorkbench } from "../manual-workbench.js";
import { riskReplacementFixture } from "./helpers/risk-replacement-fixture.js";
const PASSWORD = "isolated-risk-admin-password-123";
const unixOnly = { skip: process.platform === "win32" };
async function fixture(t, options = {}) {
  const f = riskReplacementFixture(t, { liveClock: true, humanRisk: options.humanRisk }), plan = f.prepare(); if (!options.humanRisk) f.issue(plan);
  let nativeChecks = 0, nativeAction = async () => {};
  const registry = { getInternal: id => id === f.instance.id ? { ...f.instance, enabled: true } : undefined };
  const workbench = new ManualWorkbench({ registry, dataDirectory: f.root,
    ownerVerification: { status: () => ({ supported: true }), verify: async () => { nativeChecks++; await nativeAction(); } },
    riskReview: (action, input) => f.human(action, input) });
  await workbench.store.register("admin", PASSWORD);
  const login = await workbench.login({ username: "admin", password: PASSWORD, instanceId: f.instance.id });
  await workbench.start(); t.after(() => workbench.close());
  const api = async (route, body, token = login.token, origin = workbench.origin) => {
    const response = await fetch(workbench.origin + route, { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const review = () => api("/api/risk-replacement/review", { riskPlanId: plan.riskPlanId });
  const approve = r => api("/api/risk-replacement/approve", { riskPlanId: r.riskPlanId, reviewHash: r.reviewHash, confirmation: r.confirmation });
  return { ...f, workbench, login, api, review, approveUI: approve, get nativeChecks() { return nativeChecks; }, set nativeAction(value) { nativeAction = value; } };
}

test("final risk approval requires independent admin login, same-origin review and fresh native owner verification", unixOnly, async t => {
  const f = await fixture(t), read = await f.review();
  assert.equal(read.status, 200); assert.equal(read.body.canApprove, true);
  for (const token of ["a".repeat(64), f.auth.capability]) assert.equal((await f.api("/api/risk-replacement/review", { riskPlanId: read.body.riskPlanId }, token)).status, 401);
  assert.equal((await f.api("/api/risk-replacement/approve", { riskPlanId: read.body.riskPlanId, reviewHash: read.body.reviewHash, confirmation: read.body.confirmation }, f.login.token, "http://evil.test")).status, 403);
  assert.equal(f.nativeChecks, 0);
  const result = await f.approveUI(read.body); assert.equal(result.status, 200); assert.equal(result.body.humanApproved, true);
  assert.equal(f.nativeChecks, 1); assert.equal(f.requests.length, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 1);
  assert.equal((await f.approveUI(read.body)).status, 409);
});

test("knowing an MCP plan hash without reading it in the human session cannot approve", unixOnly, async t => {
  const f = await fixture(t), plan = f.inspect(f.prepare());
  assert.equal((await f.approveUI(plan)).status, 409); assert.equal(f.nativeChecks, 0);
});

test("cancelled native approval, session logout during prompt and changed evidence create no replacement", unixOnly, async t => {
  const f = await fixture(t); let read = (await f.review()).body;
  f.nativeAction = async () => { throw Object.assign(Error("cancelled"), { code: "OWNER_VERIFICATION_FAILED" }); };
  assert.equal((await f.approveUI(read)).status, 400); assert.equal(f.inspect(read).humanApproved, false);
  read = (await f.review()).body;
  f.nativeAction = async () => { f.issue(read, { receiptId: "changed-during-native-prompt" }); };
  assert.equal((await f.approveUI(read)).status, 409); assert.equal(f.inspect(read).humanApproved, false);
  read = (await f.review()).body;
  f.nativeAction = async () => { f.workbench.revoke(f.login.token); };
  assert.equal((await f.approveUI(read)).status, 401);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 1);
});

test("risk review displays exact immutable plan and never exposes business preimages or authority key", unixOnly, async t => {
  const f = await fixture(t), response = await f.review(), text = JSON.stringify(response.body);
  assert.ok(!text.includes("BEGIN PUBLIC KEY")); assert.ok(!text.includes("restored_batches")); assert.ok(!text.includes("compensation-1"));
  assert.equal(response.body.operationCount, 2); assert.equal(response.body.unitCount, 1);
  assert.equal(response.body.historicalOutcome, "unknown"); assert.equal(response.body.binding.intentId, f.old.id);
  assert.equal(response.body.binding.originalOperationId, null);
});

test("v2 human workbench can approve without an external receipt or whole-instance quarantine", unixOnly, async t => {
  const f = await fixture(t, { humanRisk: true }), review = await f.review();
  assert.equal(review.body.canApprove, true); assert.equal(review.body.remoteFenceConfirmed, false);
  assert.equal(review.body.approvalPolicy, "human-risk-acceptance-v2");
  assert.equal(review.body.legacyInFlightOutcome, "unknown");
  const result = await f.approveUI(review.body);
  assert.equal(result.status, 200); assert.equal(result.body.acceptedResidualRisk, true);
  assert.equal(result.body.originalTaskState, "terminated_unknown"); assert.equal(f.nativeChecks, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='disposition_hold'").get().n, 0);
  assert.equal(f.requests.length, 0);
});

test("v2 native prompt cannot approve after the enrolled target changes", unixOnly, async t => {
  const f = await fixture(t, { humanRisk: true }), review = await f.review();
  f.nativeAction = async () => { f.instance.host = "changed.fixture.invalid"; };
  const result = await f.approveUI(review.body);
  assert.equal(result.status, 401); assert.equal(result.body.error.code, "MANUAL_SESSION_EXPIRED"); assert.equal(f.inspect(review.body).humanApproved, false);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='risk_job_retirement'").get().n, 0);
});
