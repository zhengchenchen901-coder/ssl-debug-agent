import { openInstancePage, openInstanceMenu, openAdministratorSettings } from "./helpers/workspace-browser.js";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { chromium } from "playwright-core";
import { createManagerApp } from "../server.js";
import { InstanceRegistry } from "../instance-registry.js";
import { loadConfig } from "../config.js";
import localAuth from "../../plugins/remote-debug-agent/local-auth.cjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rda-service-browser-"));
const example = JSON.parse(await fs.readFile(new URL("../../docs/examples/test-server-be-service.json", import.meta.url)));
let server, browser, resources;
const errors = [], calls = [];
try {
  const registry = new InstanceRegistry({ cwd: dir, env: {} });
  registry.create({ id: "test-server", host: example.profile.target.host, username: "root", privateKeyPath: "/fixture", serviceProfiles: { be: example.profile } });
  registry.create({ id: "empty-fixture", host: "isolated.fixture", username: "ops", privateKeyPath: "/fixture" });
  const token = localAuth.ensureAuthToken(localAuth.resolveAuthFile(dir)), config = loadConfig({}, dir);
  config.runtime.statePath = path.join(dir, ".runtime/state.json");
  const app = createManagerApp({ config, registry, authToken: token, workerManager: {
    publicInstances: () => registry.list().map(instance => ({ ...instance, runtime: { status: "running", pid: 1 } })),
    runtimeFor: () => ({ status: "running" }),
    callInstance: async (id, route, body) => { calls.push({ id, route, body }); return { ok: true, instanceId: id, serviceId: body.serviceId, status: "healthy", persisted: false, unchanged: true }; },
  } });
  resources = app.locals.resourceManager;
  server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  browser = await chromium.launch({ headless: true, executablePath: process.env.RDA_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#authToken").fill(token); await page.locator("#authForm button").click();
  await openInstancePage(page, "test-server", "overview");
  const panel = page.getByRole("heading", { name: "后端服务启动", exact: true }).locator("..");
  await panel.getByRole("button", { name: "检查服务", exact: true }).click();
  await panel.locator("pre").filter({ hasText: '"status": "healthy"' }).waitFor();
  assert.equal(calls.at(-1).route, "/services/inspect"); assert.equal(calls.at(-1).id, "test-server");
  let accepted = false;
  const decline = dialog => { assert.match(dialog.message(), /test-server.*be/); return dialog.dismiss(); };
  page.once("dialog", decline);
  const before = calls.length;
  await panel.getByRole("button", { name: "启动服务", exact: true }).click();
  assert.equal(calls.length, before);
  page.once("dialog", dialog => { accepted = true; return dialog.accept(); });
  await Promise.all([page.waitForResponse(response => response.url().endsWith("/services/start")), panel.getByRole("button", { name: "启动服务", exact: true }).click()]);
  assert.equal(accepted, true); assert.equal(calls.at(-1).body.confirmation, "启动服务");
  assert.equal(calls.at(-1).id, "test-server"); assert.match(calls.at(-1).body.profileHash, /^[a-f0-9]{64}$/);
  await page.locator("#closeDrawerButton").click();
  await openInstancePage(page, "empty-fixture", "overview");
  const empty = page.getByRole("heading", { name: "后端服务启动", exact: true }).locator("..");
  assert.equal(await empty.getByRole("button", { name: "启动服务", exact: true }).isDisabled(), true);
  assert.match(await empty.locator("pre").innerText(), /没有已验证的启动配置/);
  await page.locator("#closeDrawerButton").click();
  await openInstancePage(page, "test-server", "settings");
  await page.locator('[data-settings-tab="services"]').click();
  const profiles = page.locator('#instanceForm textarea[name="serviceProfiles"]');
  assert.equal(JSON.parse(await profiles.inputValue()).be.instanceId, "test-server");
  await profiles.fill("{}");
  await Promise.all([page.waitForResponse(response => response.url().endsWith("/api/instances/test-server") && response.request().method() === "PUT"), page.locator("#instanceForm").getByRole("button", { name: "保存配置", exact: true }).click()]);
  assert.deepEqual(registry.get("test-server").serviceProfiles, {});
  assert.deepEqual(registry.get("empty-fixture").serviceProfiles, {});
  assert.ok(calls.every(call => call.id === "test-server"));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, verified: "authenticated service selection, inspect, explicit confirm/cancel, target/hash binding, disabled unconfigured instance, profile JSON edit/persistence; no remote calls" }));
} finally {
  await browser?.close(); resources?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.rm(dir, { recursive: true, force: true });
}
