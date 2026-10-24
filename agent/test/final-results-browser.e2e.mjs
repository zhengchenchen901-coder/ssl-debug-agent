import { openInstancePage, openInstanceMenu, openAdministratorSettings } from "./helpers/workspace-browser.js";
// Real browser + MCP stdio + authenticated Manager, entirely local fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { chromium } from "playwright-core";
import { createManagerApp } from "../server.js";
import { InstanceRegistry } from "../instance-registry.js";
import { loadConfig } from "../config.js";
import localAuth from "../../plugins/remote-debug-agent/local-auth.cjs";
import { mcpPeer } from "../../plugins/remote-debug-agent/test/helpers/local-mcp.js";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rda-final-browser-"));
let server, browser, app, peer;
const errors = [], hooks = [];
try {
  const registry = new InstanceRegistry({ cwd: directory, env: {}, registryPath: path.join(directory, "instances.json") });
  for (const id of ["first", "second"]) registry.create({ id, name: id === "first" ? "第一实例" : "第二实例", host: "fixture.invalid", username: "ops", privateKeyPath: "/fixture" });
  const token = localAuth.ensureAuthToken(localAuth.resolveAuthFile(directory)), config = loadConfig({}, directory);
  config.agent = { host: "127.0.0.1", port: 0 };
  config.runtime.statePath = path.join(directory, ".runtime", "state.json");
  app = createManagerApp({ config, registry, authToken: token, workerManager: {
    publicInstances: () => registry.list().map((instance) => ({ ...instance, runtime: { status: "running", pid: 1 } })),
    shutdownAll: async () => {}, callInstance: async (id) => ({ ok: true, instanceId: id, stdout: "intermediate", exitCode: 0 }),
  } });
  server = http.createServer(app); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  peer = await mcpPeer({ after: (hook) => hooks.push(hook) }, { root: directory, url });
  await peer.call("remote_debug_run_command", { instanceId: "first", cmd: "pwd" });
  assert.equal((await app.locals.finalResults.listFinalResults({ instanceId: "first" })).total, 0);
  const request = { instanceId: "first", taskId: randomUUID(), title: "第一实例最终报告", status: "completed", final: true,
    artifacts: [{ category: "reports", format: "markdown", name: "最终报告", content: "# 最终报告\n服务健康\npassword=BROWSER_FINAL_SECRET\n<script>window.finalResultXss=true</script>" },
      { category: "exports", format: "csv", name: "汇总", content: "status,count\nhealthy,3\n" },
      { category: "attachments", format: "binary", encoding: "base64", name: "最终附件.pdf", content: Buffer.from("%PDF-1.7\nfinal fixture\n").toString("base64") }] };
  assert.equal((await peer.call("remote_debug_publish_final_result", request)).isError, undefined);
  await peer.call("remote_debug_publish_final_result", { ...request, instanceId: "second", taskId: randomUUID(), title: "第二实例独立报告" });
  await peer.call("remote_debug_publish_final_result", { ...request, instanceId: null, taskId: randomUUID(), title: "Manager 最终报告" });
  const executablePath = process.env.RDA_PREVIEW_BROWSER_EXECUTABLE || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1480, height: 1000 }, acceptDownloads: true });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator("#authToken").fill(token); await page.locator("#authForm button").click();
  await page.waitForFunction(() => document.querySelector("#authPanel").hidden);
  await page.locator('[data-page="environment"]').click(); await page.locator('[data-management-tab="manager"]').click();
  await page.locator("#managerFinalResults").getByText("Manager 最终报告", { exact: true }).waitFor();
  await openInstancePage(page, "first", "results");
  const panel = page.locator("#drawer .final-results");
  await panel.getByText("第一实例最终报告", { exact: true }).waitFor();
  assert.equal(await panel.getByText("第二实例独立报告", { exact: true }).count(), 0);
  await panel.getByRole("button", { name: "预览", exact: true }).first().click();
  await panel.locator(".final-result-preview").first().filter({ hasText: "服务健康" }).waitFor();
  assert.doesNotMatch(await panel.textContent(), /BROWSER_FINAL_SECRET/);
  assert.equal(await page.evaluate(() => window.finalResultXss), undefined);
  const downloadEvent = page.waitForEvent("download"); await panel.getByRole("button", { name: "下载", exact: true }).first().click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), "最终报告.md");
  assert.match(await fs.readFile(await download.path(), "utf8"), /服务健康/);
  const binaryDownloadEvent = page.waitForEvent("download"); await panel.getByRole("button", { name: "下载", exact: true }).last().click();
  const binaryDownload = await binaryDownloadEvent;
  assert.equal(binaryDownload.suggestedFilename(), "最终附件.pdf");
  assert.equal(await fs.readFile(await binaryDownload.path(), "utf8"), "%PDF-1.7\nfinal fixture\n");
  await page.setViewportSize({ width: 420, height: 900 });
  assert.equal(await panel.locator(".task-card").evaluateAll((cards) => cards.every((card) => card.scrollWidth <= card.clientWidth + 1)), true);
  await page.setViewportSize({ width: 1480, height: 1000 });
  const screenshot = path.join(os.tmpdir(), "rda-final-results-dashboard.png"); await page.screenshot({ path: screenshot, fullPage: true });
  await page.reload(); await openInstancePage(page, "first", "results");
  await panel.getByText("第一实例最终报告", { exact: true }).waitFor();
  page.once("dialog", (dialog) => dialog.accept()); await panel.getByRole("button", { name: "删除最终结果", exact: true }).click();
  await panel.getByText("暂无最终结果。任务收尾并发布交付物后显示在这里。", { exact: true }).waitFor();
  await page.locator("#closeDrawerButton").click(); await openInstancePage(page, "second", "results");
  await panel.getByText("第二实例独立报告", { exact: true }).waitFor();
  await page.locator("#closeDrawerButton").click();
  await page.locator("#authLogout").click();
  assert.equal(await page.locator(".final-result-card").count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, screenshot, verified: "final-only MCP publication, authenticated instance/Manager lists, safe preview/download, mobile layout, reload, manual delete, logout" }));
} finally {
  await peer?.stop(); for (const hook of hooks) await hook();
  await browser?.close(); app?.locals.resourceManager.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await fs.rm(directory, { recursive: true, force: true });
}
