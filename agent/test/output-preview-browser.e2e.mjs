// Isolated end-to-end: real MCP stdio -> Manager cache/SSE -> real browser.
// No remote server, production registry, credentials or shell commands.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { createManagerApp } from "../server.js";
import { InstanceRegistry } from "../instance-registry.js";
import { loadConfig } from "../config.js";
import localAuth from "../../plugins/remote-debug-agent/local-auth.cjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rda-preview-browser-"));
let browser, server, child;
const errors = [], requests = [];
try {
  const registry = new InstanceRegistry({ cwd: directory, env: {}, registryPath: path.join(directory, ".remote-debug", "instances.json") });
  for (const id of ["test", "other"]) registry.create({ id, name: id === "test" ? "开发环境" : "独立实例", host: "fixture.invalid", username: "ops", privateKeyPath: "/fixture", hostKeyFingerprints: ["SHA256:" + "A".repeat(43)] });
  const authFile = localAuth.resolveAuthFile(directory), token = localAuth.ensureAuthToken(authFile);
  const config = loadConfig({}, directory);
  config.agent = { host: "127.0.0.1", port: 0 };
  config.runtime.statePath = path.join(directory, ".runtime", "state.json");
  const outputs = {
    first: "第一条输出\npassword=PREVIEW_PRIVATE_FIXTURE\n" + "诊断行：服务运行正常\n".repeat(80),
    second: "第二条输出：运行正常", third: "第三条输出：更新完成", other: "其他实例的独立输出", unsafe: "<img src=x onerror=alert(1)>\n纯文本",
  };
  const app = createManagerApp({ config, registry, authToken: token, workerManager: {
    publicInstances: () => registry.list().map((instance) => ({ ...instance, runtime: { status: "stopped" } })),
    runtimeFor: () => ({ status: "stopped" }), shutdownAll: async () => {},
    callInstance: async (id, _route, input) => ({ instanceId: id, stdout: outputs[input.cmd], stderr: "", exitCode: 0, timedOut: false }),
  } });
  server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const wire = [], waiters = new Map(); let buffer = "", sequence = 0;
  child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../plugins/remote-debug-agent/mcp-server.js")], {
    env: { ...process.env, REMOTE_DEBUG_DATA_DIR: directory, REMOTE_DEBUG_PROJECT_ROOT: "", REMOTE_DEBUG_INSTANCE_REGISTRY: registry.registryPath,
      REMOTE_DEBUG_ENV_PATH: path.join(directory, "config.env"), REMOTE_DEBUG_AUTH_FILE: authFile, REMOTE_DEBUG_AGENT_URL: base },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString(); let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const body = buffer.slice(0, end); buffer = buffer.slice(end + 1); wire.push(body);
      const message = JSON.parse(body); waiters.get(message.id)?.(message); waiters.delete(message.id);
    }
  });
  async function call(cmd, instanceId = "test", toolName = "remote_debug_run_command") {
    const id = ++sequence;
    const response = new Promise((resolve, reject) => { waiters.set(id, resolve); setTimeout(() => reject(new Error("MCP fixture timeout")), 10000).unref(); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: toolName, arguments: toolName === "remote_debug_run_command" ? { cmd, instanceId } : {} } }) + "\n");
    return response;
  }
  const executablePath = process.env.RDA_PREVIEW_BROWSER_EXECUTABLE || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.url().includes("/api/output-preview/")) requests.push(request.url()); });
  await page.goto(base);
  await page.locator("#authToken").fill(token); await page.locator("#authForm button").click();
  await page.locator('[data-action="preview"][data-id="test"]').click();
  const panels = page.locator(".output-preview-row .output-preview");
  const panel = panels.nth(0), body = panel.locator(".output-preview-body");
  await call("first");
  await body.filter({ hasText: "第一条输出" }).waitFor();
  assert.doesNotMatch(await body.textContent(), /PREVIEW_PRIVATE_FIXTURE/);
  assert.match(await body.textContent(), /REDACTED/);
  await call("second"); await body.filter({ hasText: "第二条输出" }).waitFor();
  await panel.locator(".output-preview-item").nth(1).click(); await body.filter({ hasText: "第一条输出" }).waitFor();
  await body.evaluate((node) => { node.scrollTop = 100; window.previewBodyFixture = node; });
  await page.locator("#reloadButton").click();
  assert.equal(await body.evaluate((node) => node === window.previewBodyFixture), true);
  assert.equal(await body.evaluate((node) => node.scrollTop), 100);
  await panel.getByRole("button", { name: "暂停显示", exact: true }).click();
  await call("third");
  await page.waitForFunction(() => document.querySelector('[data-action="preview"][data-id="test"]').textContent.includes("(3)"));
  assert.match(await body.textContent(), /第一条输出/);
  assert.equal(await panel.locator(".output-preview-item").count(), 2);
  await panel.getByRole("button", { name: "继续显示", exact: true }).click();
  assert.equal(await panel.locator(".output-preview-item").count(), 3);
  await panel.getByLabel("跟随最新").check(); await body.filter({ hasText: "第三条输出" }).waitFor();
  await call("other", "other");
  await page.waitForFunction(() => document.querySelector('[data-action="preview"][data-id="other"]').textContent.includes("(1)"));
  assert.doesNotMatch(await body.textContent(), /其他实例/);
  await page.locator('[data-action="preview"][data-id="other"]').click();
  await panels.nth(1).locator(".output-preview-body").filter({ hasText: "其他实例的独立输出" }).waitFor();
  await call("unsafe"); await body.filter({ hasText: "<img" }).waitFor();
  assert.equal(await panel.locator("img").count(), 0);
  await panel.getByRole("button", { name: "查看协议消息", exact: true }).click(); await body.filter({ hasText: '"jsonrpc"' }).waitFor();
  await panel.getByRole("button", { name: "复制完整内容", exact: true }).click();
  await panel.locator(".output-preview-meta").filter({ hasText: "完整内容已复制" }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), wire.at(-1));
  await panel.getByRole("button", { name: "展开大窗口", exact: true }).click();
  const screenshot = path.resolve(process.env.RDA_PREVIEW_BROWSER_OUTPUT || "/tmp/rda-output-preview.png");
  await page.screenshot({ path: screenshot });
  await page.keyboard.press("Escape");
  assert.equal(await panel.evaluate((node) => node.classList.contains("output-preview-expanded")), false);
  await call(null, null, "remote_debug_list_instances");
  await page.locator("#globalOutputButton").click();
  await page.locator("#globalOutputPreview .output-preview-body").filter({ hasText: '"instances"' }).waitFor();
  // A stale response after logout must not restore content or credentials.
  let releaseRead, markReadStarted;
  const delayedRead = new Promise((resolve) => { releaseRead = resolve; });
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  await page.route("**/api/output-preview/records/*", async (route) => {
    markReadStarted();
    await delayedRead;
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, record: app.locals.outputPreview.get(id) }) }).catch(() => {});
  });
  await panel.locator(".output-preview-item").nth(1).click();
  await readStarted;
  await page.locator("#authLogout").click();
  releaseRead();
  await page.unrouteAll({ behavior: "wait" });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.locator(".output-preview-body").evaluateAll((nodes) => nodes.every((node) => node.textContent === "面板已锁定")), true);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("remote-debug-auth")), null);
  await page.locator("#authToken").fill(token); await page.locator("#authForm button").click();
  await page.locator('[data-action="preview"][data-id="test"]').click();
  await body.filter({ hasText: '"jsonrpc"' }).waitFor();
  const cached = app.locals.outputPreview.snapshot().records;
  assert.equal(cached.length, wire.length);
  for (let i = 0; i < cached.length; i++) assert.equal(app.locals.outputPreview.get(cached[i].id).wireMessage, wire[i]);
  assert.ok(requests.some((url) => url.includes("/events")) && requests.some((url) => /\/records\//.test(url)));
  assert.ok(requests.every((url) => !url.includes(token)));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, records: cached.length, screenshot, verified: "MCP wire equality, SSE, instance isolation, XSS, DOM/scroll retention, pause/follow, copy, global output and logout/reconnect" }));
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await fs.rm(directory, { recursive: true, force: true });
}
