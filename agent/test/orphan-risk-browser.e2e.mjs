// Disposable independent workbench + real browser. Native OS verification,
// Mongo and SSH are explicit doubles; no configured instance is contacted.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { ManualWorkbench } from "../manual-workbench.js";
import { orphanRiskFixture } from "./helpers/orphan-risk-fixture.js";
const cleanups = [], f = orphanRiskFixture({ after: fn => cleanups.push(fn) }, { liveClock: true });
let browser, workbench, nativePrompts = 0;
try {
  const plan = await f.prepare();
  workbench = new ManualWorkbench({ registry: { getInternal: id => id === f.instance.id ? f.instance : undefined }, dataDirectory: f.root,
    ownerVerification: { status: () => ({ supported: true }), verify: async () => { nativePrompts++; } }, riskReview: (action, input) => f.human(action, input),
    openTerminal: (_instance, options) => { const terminal = { close() {}, write() {}, resize() {}, pause() {}, resume() {} }; queueMicrotask(options.onReady); return terminal; } });
  await workbench.store.register("admin", "isolated-orphan-browser-123"); await workbench.start();
  const executablePath = process.env.RDA_MANUAL_BROWSER_EXECUTABLE || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(workbench.origin + "/?instanceId=test-server");
  await page.locator('[name="username"]').fill("admin"); await page.locator('[name="password"]').fill("isolated-orphan-browser-123");
  await page.locator("#loginButton").click(); await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("#riskNav").click(); await page.locator("#riskStage").selectOption("orphan");
  await page.locator("#riskPlanId").fill(plan.riskPlanId); await page.locator("#riskLoad").click();
  await page.waitForFunction(() => document.getElementById("riskMessage").textContent.includes("请核对"));
  const details = await page.locator("#riskDetails").textContent();
  for (const value of ["test-server", "yennefer", f.input.originalOperationId, f.input.requestDigest, f.original.importId, f.candidate.importId, "unresolved", "unknown", "回滚"]) assert.ok(details.includes(value), value);
  assert.equal(await page.locator("#riskApprove").isDisabled(), true);
  await page.locator("#riskAcknowledgement").check(); await page.locator("#riskConfirmation").fill("确认执行"); assert.equal(await page.locator("#riskApprove").isDisabled(), true);
  await page.locator("#riskConfirmation").fill(plan.confirmation); assert.equal(await page.locator("#riskApprove").isEnabled(), true);
  const output = path.resolve(process.env.RDA_ORPHAN_BROWSER_OUTPUT || "output/orphan-risk-browser"); await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, "review.png"), fullPage: true });
  await page.locator("#riskApprove").click(); await page.waitForFunction(() => document.getElementById("riskMessage").textContent.includes("此计划已获人工批准"));
  assert.equal(nativePrompts, 1); assert.equal((await f.inspect(plan)).originalStatus, "unresolved"); assert.equal((await f.inspect(plan)).historicalOutcome, "unknown");
  assert.equal(f.requests.length, 0); assert.equal(f.h.state.insert, 0); assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 1);
  await page.screenshot({ path: path.join(output, "approved-no-dispatch.png"), fullPage: true });
  await page.locator("#riskStage").selectOption("execution"); assert.equal(await page.locator("#riskApprove").isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, realBrowser: true, realIndependentAdminHttp: true, nativeOwnerDialog: "mocked", businessWrites: 0, followupDispatches: 0, output }));
} finally { await browser?.close(); await workbench?.close(); for (const fn of cleanups.reverse()) await fn(); }
