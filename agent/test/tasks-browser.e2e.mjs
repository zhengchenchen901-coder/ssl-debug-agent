import { openInstancePage, openInstanceMenu, openAdministratorSettings } from "./helpers/workspace-browser.js";
import assert from "node:assert/strict";
import { once } from "node:events";
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

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rda-tasks-browser-"));
let server, browser, resources;
const errors = [];
try {
  const registry = new InstanceRegistry({ cwd: dir, env: {}, registryPath: path.join(dir, "instances.json") });
  for (const id of ["first", "second"]) registry.create({ id, name: id === "first" ? "生产连接" : "测试连接", host: "shared.fixture", username: "ops", privateKeyPath: "/fixture" });
  const token = localAuth.ensureAuthToken(localAuth.resolveAuthFile(dir)), config = loadConfig({}, dir);
  config.runtime.statePath = path.join(dir, ".runtime/state.json");
  const app = createManagerApp({ config, registry, authToken: token, workerManager: {
    publicInstances: () => registry.list().map((instance) => ({ ...instance, runtime: { status: "running", pid: 1 } })),
    runtimeFor: () => ({ status: "running" }), shutdownAll: async () => {},
  } });
  resources = app.locals.resourceManager;
  const report = (id, frame) => {
    if (frame.type === "resource_budget") setImmediate(() => resources.report(id, `epoch-${id}`, { ...resources.tasks.get(frame.taskId), appliedRevision: frame.revision }));
  };
  resources.attach("first", "epoch-first", (f) => report("first", f)); resources.attach("second", "epoch-second", (f) => report("second", f));
  resources.sample("first", "epoch-first", { cpuCores: 4, cpuBusyRatio: 0.1, memoryAvailableBytes: 6 * 1024 ** 3, totalMemoryBytes: 8 * 1024 ** 3, load1: 0.1, ioWaitRatio: 0 });
  const id = randomUUID(), other = randomUUID(), query = randomUUID();
  resources.report("first", "epoch-first", { taskId: id, type: "log_search", status: "running", phase: "scanning", label: "历史归档查询", progress: { completedFiles: 2, totalFiles: 5, scannedBytes: 4 * 1024 ** 3, matchedLines: 12000 }, capabilities: [] });
  resources.report("first", "epoch-first", { taskId: query, type: "mongo_read", status: "running", phase: "executing", label: "普通查询", capabilities: [] });
  resources.report("second", "epoch-second", { taskId: other, type: "mongo_bulk", status: "running", label: "批量数据库修改", capabilities: [] });
  server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  browser = await chromium.launch({ headless: true, executablePath: process.env.RDA_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#authToken").fill(token); await page.locator("#authForm button").click();
  await openInstancePage(page, "first", "tasks");
  await page.getByText("历史归档查询", { exact: true }).waitFor();
  assert.equal(await page.getByText("批量数据库修改", { exact: true }).count(), 0);
  assert.equal(await page.locator(".task-card").filter({ hasText: "普通查询" }).getByRole("button", { name: "手动最高档" }).count(), 0);
  await page.getByRole("button", { name: "手动最高档", exact: true }).click();
  await page.getByRole("button", { name: "恢复自动", exact: true }).waitFor();
  assert.equal(await page.locator(".task-card").evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth + 1)), true);
  await page.setViewportSize({ width: 420, height: 900 });
  assert.equal(await page.locator(".task-card").evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth + 1)), true);
  await page.setViewportSize({ width: 1480, height: 1000 });
  assert.equal(resources.tasks.get(id).resourceMode, "manual_max");
  await page.reload(); await openInstancePage(page, "first", "tasks");
  await page.getByRole("button", { name: "恢复自动", exact: true }).waitFor();
  const screenshot = "/tmp/rda-task-dashboard.png"; await page.screenshot({ path: screenshot, fullPage: true });
  await page.getByRole("button", { name: "恢复自动", exact: true }).click();
  await page.getByRole("button", { name: "手动最高档", exact: true }).waitFor();
  assert.equal(resources.tasks.get(id).resourceMode, "auto");
  await page.locator("#closeDrawerButton").click();
  await openInstancePage(page, "second", "tasks");
  await page.getByText("批量数据库修改", { exact: true }).waitFor();
  assert.equal(await page.getByText("历史归档查询", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, screenshot, verified: "authenticated task lists, instance isolation, bulk-only boost, backend persistence across reload, restore auto" }));
} finally {
  await browser?.close(); resources?.close(); if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  await fs.rm(dir, { recursive: true, force: true });
}
