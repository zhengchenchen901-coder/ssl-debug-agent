// Standalone local browser check using only synthetic storage, a simulated
// driver and a mocked native owner verifier. No installed Manager or SSH target.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { riskReplacementFixture, wire } from "./helpers/risk-replacement-fixture.js";
import { ManualWorkbench } from "../manual-workbench.js";
import { humanJobTerminationRequest, TERMINATION_CONFIRMATION } from "../mongodb-job-termination.js";

const cleanups = [], t = { after: fn => cleanups.push(fn) };
const output = process.env.RDA_TERMINATION_BROWSER_OUTPUT || path.join(os.tmpdir(), "rda-job-termination-browser");
await fs.mkdir(output, { recursive: true });
let browser, workbench;
try {
  const f = riskReplacementFixture(t, { humanRisk: true, liveClock: true });
  Object.assign(f.instance, { enabled: true, name: "Synthetic isolated instance", port: 22, username: "synthetic-ops" });
  await f.h.initialize();
  const { instanceId, ...chunk } = f.candidate;
  await f.h.run({ action: "upload", chunk });
  const { instanceId: _id, ...seal } = wire({ ...f.candidate, chunkIndex: 1, units: [], endOfUpload: true });
  const plan = await f.h.run({ action: "upload", chunk: seal });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rda-termination-ui-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  let ownerChecks = 0;
  workbench = new ManualWorkbench({ registry: { getInternal: id => id === f.instance.id ? f.instance : undefined },
    openTerminal: (_instance, options) => {
      queueMicrotask(options.onReady);
      return { write() {}, resize() {}, pause() {}, resume() {}, close() {} };
    },
    dataDirectory: directory, ownerVerification: { status: () => ({ supported: true }), verify: async () => { ownerChecks++; } },
    jobTermination: (action, input) => humanJobTerminationRequest(f.service, action, input, {
      instance: id => id === f.instance.id ? f.instance : undefined,
      dispatch: async (_id, route, request) => ({ ok: true, ...await f.h.run(route.endsWith("/job")
        ? { action: "get", jobId: request.jobId } : { action: "terminate", ...request }) })
    }) });
  await workbench.store.register("synthetic-admin", "synthetic-ui-password-123");
  const origin = await workbench.start();
  browser = await chromium.launch({ headless: true, executablePath: process.env.RDA_MANUAL_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--disable-background-networking", "--disable-sync"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(origin + "/?instanceId=" + f.instance.id);
  await page.locator('[name="username"]').fill("synthetic-admin");
  await page.locator('[name="password"]').fill("synthetic-ui-password-123");
  await page.locator("#loginButton").click();
  await page.waitForFunction(() => !document.getElementById("workspace").hidden ||
    (document.getElementById("loginMessage").textContent && document.getElementById("loginMessage").textContent !== "正在验证…"));
  assert.equal(await page.locator("#workspace").isVisible(), true, JSON.stringify({ pageErrors: errors, message: await page.locator("#loginMessage").textContent() }));
  await page.locator("#terminationNav").waitFor({ state: "visible" });
  await page.locator("#terminationNav").click();
  await page.locator("#terminationDatabase").fill("business");
  await page.locator("#terminationJobId").fill(f.candidate.jobId);
  await page.locator("#terminationPlanHash").fill(plan.planHash);
  await page.locator("#terminationReason").fill("合成演示：原守卫发生变化，永久终止并保留未知历史。");
  await page.locator("#terminationLoad").click();
  await page.waitForFunction(() => document.getElementById("terminationDetails").textContent.includes("awaiting_human"));
  assert.equal(await page.locator("#terminationApprove").isDisabled(), true);
  await page.locator("#terminationAcknowledgement").check();
  await page.locator("#terminationConfirmation").fill(TERMINATION_CONFIRMATION);
  await page.waitForFunction(() => !document.getElementById("terminationApprove").disabled);
  await page.screenshot({ path: path.join(output, "review.png"), fullPage: true });
  await page.locator("#terminationReason").fill("合成演示：再次核对守卫变化后永久停止。");
  assert.equal(await page.locator("#terminationApprove").isDisabled(), true);
  await page.locator("#terminationLoad").click();
  await page.waitForFunction(() => document.getElementById("terminationMessage").textContent.includes("请核对具体任务"));
  await page.locator("#terminationAcknowledgement").check();
  await page.locator("#terminationConfirmation").fill(TERMINATION_CONFIRMATION);
  await page.locator("#terminationApprove").click();
  await page.waitForFunction(() => document.getElementById("terminationMessage").textContent.includes("远端终止记录已核验"));
  assert.equal(ownerChecks, 1);
  assert.equal(await page.locator("#terminationApprove").isDisabled(), true);
  await page.screenshot({ path: path.join(output, "terminated.png"), fullPage: true });
  assert.equal((await f.h.run({ action: "get", jobId: f.candidate.jobId })).status, "terminated_unknown");
  assert.equal(f.h.state.events.some(e => e.action === "businessWrite"), false);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ status: "passed", synthetic: true, ownerChecks,
    nativeOwner: "mocked", driver: "simulated", businessWrites: 0, pageErrors: errors,
    assertions: ["login and termination navigation", "review exact job and immutable plan", "phrase and acknowledgement required", "editing invalidates review", "fresh native verification", "permanent local gate and independent remote readback", "no business writes or replacement"] }, null, 2));
  console.log("Standalone synthetic browser verification passed; native verifier mocked; no production actions.");
} finally {
  await browser?.close(); await workbench?.close();
  for (const cleanup of cleanups.reverse()) await cleanup();
}
