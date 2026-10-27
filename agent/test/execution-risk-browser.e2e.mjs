// Disposable loopback workbench and real Chromium. Native identity, MongoDB
// and SSH are explicit doubles. No installed Manager or saved instance is used.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { executionRiskFixture } from "./helpers/execution-risk-fixture.js";
import { ManualWorkbench } from "../manual-workbench.js";
const cleanups = [], t = { after: fn => cleanups.push(fn) };
let browser, w;
try {
  const x = await executionRiskFixture(t, { liveClock: true, legacy: true, legacyNoUuid: true }), { f } = x, p = await x.prepare();
  let nativeChecks = 0;
  w = new ManualWorkbench({ registry: { getInternal: () => f.instance }, dataDirectory: f.root,
    ownerVerification: { status: () => ({ supported: true }), verify: async () => { nativeChecks++; } },
    riskReview: (action, input) => f.human(action, input),
    openTerminal: (_i, options) => { queueMicrotask(options.onReady); return { close() {}, write() {}, resize() {}, pause() {}, resume() {} }; } });
  await w.store.register("admin", "disposable-browser-execution-password"); await w.start();
  const output = path.resolve(process.env.RDA_EXECUTION_RISK_BROWSER_OUTPUT || "output/execution-risk-browser"); await fs.mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.RDA_MANUAL_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(w.origin + "/?instanceId=" + f.instance.id);
  await page.locator('[name="username"]').fill("admin"); await page.locator('[name="password"]').fill("disposable-browser-execution-password");
  await page.locator("#loginButton").click(); await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("#riskNav").click(); await page.locator("#riskStage").selectOption("execution");
  await page.locator("#riskPlanId").fill(p.riskPlanId); await page.locator("#riskLoad").click();
  await page.waitForFunction(() => document.getElementById("riskMessage").textContent.includes("请核对"));
  const details = await page.locator("#riskDetails").textContent();
  for (const expected of [x.intent.id, x.batch.planHash, p.planHash, "原集合UUID", "当前集合UUID", "唯一替代谱系", "精确文档含类型及顺序", "synthetic-uuid-1", "迟到提交"])
    assert.ok(details.includes(expected), "actual rendered review must contain " + expected);
  assert.equal(await page.locator("#riskApprove").isDisabled(), true);
  await page.locator("#riskAcknowledgement").check(); await page.locator("#riskConfirmation").fill(x.lineage.confirmation);
  assert.equal(await page.locator("#riskApprove").isDisabled(), true, "old prepare phrase cannot approve execution");
  await page.locator("#riskConfirmation").fill(p.confirmation); assert.equal(await page.locator("#riskApprove").isEnabled(), true);
  await page.screenshot({ path: path.join(output, "execution-review.png"), fullPage: true });
  const operations = f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n;
  await page.locator("#riskApprove").click(); await page.waitForFunction(() => document.getElementById("riskMessage").textContent.includes("已独立接受本次执行未知风险"));
  assert.equal(nativeChecks, 1); assert.equal(f.h.state.rows.size, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, operations);
  assert.equal(await page.locator("#riskApprove").isDisabled(), true);
  await page.screenshot({ path: path.join(output, "execution-approved-no-write.png"), fullPage: true });
  await page.reload(); await page.locator("#loginPanel").waitFor({ state: "visible" });
  await page.locator('[name="username"]').fill("admin"); await page.locator('[name="password"]').fill("disposable-browser-execution-password");
  await page.locator("#loginButton").click(); await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("#riskNav").click(); await page.locator("#riskStage").selectOption("execution");
  await page.locator("#riskPlanId").fill(p.riskPlanId); await page.locator("#riskLoad").click();
  await page.waitForFunction(() => document.getElementById("riskDetails").textContent.includes("human_approved"));
  assert.equal(await page.locator("#riskApprove").isDisabled(), true); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, realBrowser: true, realIndependentAdminHttp: true, nativeOwnerVerification: "explicit test double",
    MongoDB: "synthetic VM", SSH: "synthetic VM", scenarios: ["legacy-no-UUID", "exact-rendered-risk", "old-phrase-rejected", "native-approval", "no-business-write", "reload-persistent-approval"], output }));
} finally {
  await browser?.close(); await w?.close(); for (const cleanup of cleanups.reverse()) await cleanup();
}
