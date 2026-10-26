// Isolated real browser/HTTP verification. The retirement issuer, native owner
// dialog and terminal are explicit test doubles; no business server is used.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { ManualWorkbench } from "../manual-workbench.js";
import { riskReplacementFixture } from "./helpers/risk-replacement-fixture.js";
const cleanups = [], t = { after: fn => cleanups.push(fn) }, f = riskReplacementFixture(t, { liveClock: true });
let workbench, browser, nativePrompts = 0;
try {
  const plan = f.prepare(); f.issue(plan);
  workbench = new ManualWorkbench({ registry: { getInternal: id => id === f.instance.id ? { ...f.instance, enabled: true } : undefined }, dataDirectory: f.root,
    ownerVerification: { status: () => ({ supported: true }), verify: async () => { nativePrompts++; } }, riskReview: (action, input) => f.human(action, input),
    openTerminal: (_instance, options) => { const terminal = { close() {}, write() {}, resize() {}, pause() {}, resume() {} }; queueMicrotask(options.onReady); return terminal; } });
  await workbench.store.register("admin", "isolated-browser-risk-password-123"); await workbench.start();
  const executablePath = process.env.RDA_MANUAL_BROWSER_EXECUTABLE || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(workbench.origin + "/?instanceId=" + f.instance.id);
  await page.locator('[name="username"]').fill("admin"); await page.locator('[name="password"]').fill("isolated-browser-risk-password-123");
  await page.locator("#loginButton").click(); await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("#riskNav").click(); await page.locator("#riskPlanId").fill(plan.riskPlanId); await page.locator("#riskLoad").click();
  await page.waitForFunction(() => document.getElementById("riskMessage").textContent.includes("请核对"));
  assert.equal(await page.locator("#riskApprove").isDisabled(), true);
  await page.locator("#riskAcknowledgement").check(); await page.locator("#riskConfirmation").fill("确认执行");
  assert.equal(await page.locator("#riskApprove").isDisabled(), true);
  await page.locator("#riskConfirmation").fill(plan.confirmation); assert.equal(await page.locator("#riskApprove").isEnabled(), true);
  const output = path.resolve(process.env.RDA_RISK_BROWSER_OUTPUT || "../output/risk-replacement-browser"); await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, "human-review.png"), fullPage: true });
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 1);
  await page.locator("#riskApprove").click();
  await page.waitForFunction(() => document.getElementById("riskMessage").textContent.includes("此计划已获人工批准"));
  assert.equal(nativePrompts, 1); assert.equal(await page.locator("#riskApprove").isDisabled(), true);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 1);
  assert.equal(f.requests.length, 0); assert.equal(f.inspect(plan).humanApproved, true); assert.equal(f.inspect(plan).historicalOutcome, "unknown");
  await page.screenshot({ path: path.join(output, "human-approved-no-job.png"), fullPage: true });
  await page.locator("#logoutButton").click(); await page.locator("#loginPanel").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, realBrowser: true, realIndependentAdminHttp: true, nativeOwnerDialog: "mocked", issuer: "fixture", businessWrites: 0, replacementJobsCreated: 0, output }));
} finally {
  await browser?.close(); await workbench?.close(); for (const cleanup of cleanups.reverse()) await cleanup();
}
