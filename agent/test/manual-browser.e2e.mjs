import { openInstancePage, openInstanceMenu, openAdministratorSettings } from "./helpers/workspace-browser.js";
// Isolated browser integration: no production registry, credentials or server.
// Native OS prompts are mocked here; the actual native helper is checked separately.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import ssh2 from "ssh2";
import { chromium } from "playwright-core";
import { InstanceRegistry } from "../instance-registry.js";
import { startServer } from "../server.js";
import { loadConfig } from "../config.js";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rda-browser-"));
const hostKey = ssh2.utils.generateKeyPairSync("ed25519");
const userKey = ssh2.utils.generateKeyPairSync("ed25519");
const fingerprint = "SHA256:" + createHash("sha256").update(ssh2.utils.parseKey(hostKey.private).getPublicSSH()).digest("base64").replace(/=+$/, "");
const token = "b".repeat(64), password = "browser-admin-password-123";
let browser, manager, received = "", verifications = 0;
const connections = new Set();
const sshServer = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
  connections.add(client); client.on("close", () => connections.delete(client)); client.on("error", () => {});
  client.on("authentication", (context) => context.method === "publickey" ? context.accept() : context.reject());
  client.on("ready", () => client.on("session", (accept) => {
    const session = accept();
    session.on("pty", (acceptPty) => acceptPty());
    session.on("window-change", (acceptResize) => acceptResize?.());
    session.on("shell", (acceptShell) => {
      const channel = acceptShell();
      channel.write("Connected to isolated SSH fixture\r\nops@fixture:~$ ");
      channel.on("data", (data) => { received += data.toString(); channel.write(data); });
    });
  }));
});
const errors = [];
try {
  await new Promise((resolve) => sshServer.listen(0, "127.0.0.1", resolve));
  const keyPath = path.join(directory, "test-key");
  await fs.writeFile(keyPath, userKey.private, { mode: 0o600 });
  const registry = new InstanceRegistry({ cwd: directory, env: {}, registryPath: path.join(directory, ".remote-debug", "instances.json") });
  registry.create({ id: "test", name: "开发服务器 · 隔离验证", host: "127.0.0.1", port: sshServer.address().port, username: "ops", privateKeyPath: keyPath, hostKeyFingerprints: [fingerprint] });
  const config = loadConfig({}, directory);
  config.agent = { host: "127.0.0.1", port: 0 };
  config.runtime = { ...config.runtime, statePath: path.join(directory, ".runtime", "state.json") };
  manager = startServer(config, {
    registry, authToken: token, installSignalHandlers: false,
    manualOptions: { ownerVerification: { status: () => ({ supported: true, message: "测试系统认证适配器" }), verify: async () => { verifications++; } } },
    workerManager: { publicInstances: () => registry.list().map((instance) => ({ ...instance, runtime: { status: "stopped" } })), runtimeFor: () => ({ status: "stopped" }), shutdownAll: async () => {} },
  });
  await new Promise((resolve) => manager.listening ? resolve() : manager.once("listening", resolve));
  const executablePath = process.env.RDA_MANUAL_BROWSER_EXECUTABLE || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  context.on("page", (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      // Existing environment report probes before dashboard unlock; 401 is expected.
      if (message.type() === "error" && !(message.text().includes("401") && message.location().url.endsWith("/api/environment-report"))) errors.push(message.text());
    });
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${manager.address().port}/`);
  await page.locator("#authToken").fill(token);
  await page.locator("#authForm button").click();
  await openInstancePage(page, "test", "settings");
  await page.locator('[data-settings-tab="database"]').click(); await page.locator('[data-database-tab="manual"]').click();
  await page.locator('[name="manualMongoEnabled"]').check();
  await page.locator('[name="manualMongoConfigPath"]').fill("/isolated/profiles.json");
  await page.locator('[name="manualMongoDriverPath"]').fill("/isolated/node_modules/mongodb");
  await page.locator('[name="manualMongoConfigProfile"]').fill("manualAdmin");
  await page.locator("#saveInstanceButton").click();
  await page.locator("#modalBackdrop").waitFor({ state: "hidden" });
  assert.equal(registry.getInternal("test").manualMongo.configProfile, "manualAdmin");
  assert.equal(registry.getInternal("test").mongodb, undefined);
  await openInstancePage(page, "test", "settings");
  await page.locator('[data-settings-tab="database"]').click(); await page.locator('[data-database-tab="manual"]').click();
  assert.equal(await page.locator('[name="manualMongoConfigPath"]').inputValue(), "/isolated/profiles.json");
  await page.locator("#cancelModalButton").click();
  await openAdministratorSettings(page);
  await page.locator("#registerAdminButton").click();
  await page.locator("#saveAdminButton").waitFor({ state: "visible" });
  await page.locator('#adminForm input[name="username"]').fill("admin");
  await page.locator('#adminForm input[name="password"]').fill(password);
  await page.locator('#adminForm input[name="confirmPassword"]').fill(password);
  await page.locator("#saveAdminButton").click();
  await page.waitForFunction(() => document.getElementById("adminMessage").textContent.includes("注册成功"));
  assert.equal(verifications, 1);
  await page.locator("#closeAdminButton").click();
  await openInstancePage(page, "test");
  const popupEvent = page.waitForEvent("popup");
  await page.getByRole("button", { name: "手动工作台", exact: true }).click();
  const popup = await popupEvent;
  await popup.waitForURL(/127\.0\.0\.1:\d+\/\?instanceId=test/);
  assert.notEqual(new URL(popup.url()).port, String(manager.address().port));
  assert.equal(await popup.evaluate(() => window.opener), null);
  await popup.locator('input[name="username"]').fill("admin");
  await popup.locator('input[name="password"]').fill(password);
  await popup.locator("#loginButton").click();
  await popup.waitForFunction(() => document.getElementById("connectionStatus").textContent === "已连接");
  await popup.locator(".xterm-helper-textarea").focus();
  await popup.keyboard.type("echo browser-terminal-ok");
  await popup.keyboard.press("Enter");
  await popup.keyboard.press("Control+C");
  await popup.waitForFunction(() => {
    for (let i = 0; i < terminal.buffer.active.length; i++) {
      if (terminal.buffer.active.getLine(i)?.translateToString().includes("browser-terminal-ok")) return true;
    }
    return false;
  });
  assert.ok(received.includes("echo browser-terminal-ok\r") && received.includes("\u0003"));
  assert.equal(await popup.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await popup.setViewportSize({ width: 1100, height: 820 });
  await popup.setViewportSize({ width: 1440, height: 960 });
  await popup.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const output = path.resolve(process.env.RDA_MANUAL_BROWSER_OUTPUT || "../output/manual-workbench");
  await fs.mkdir(output, { recursive: true });
  await popup.screenshot({ path: path.join(output, "workbench.png"), fullPage: true });
  await popup.locator("#disconnectButton").click();
  await popup.locator("#connectButton").click();
  await popup.waitForFunction(() => document.getElementById("connectionStatus").textContent === "已连接");
  const loggedOut = popup.waitForResponse((response) => response.url().endsWith("/api/logout") && response.request().method() === "POST");
  await popup.locator("#logoutButton").click();
  await loggedOut;
  await popup.locator("#loginPanel").waitFor({ state: "visible" });
  assert.equal(manager.managerLifecycle.publicStatus().activeLeaseCount, 0);
  await openAdministratorSettings(page);
  await page.locator("#registerAdminButton").click();
  await page.locator("#adminResetMode").click();
  await page.locator('#adminForm input[name="username"]').fill("admin");
  await page.locator('#adminForm input[name="password"]').fill("new-browser-password-123");
  await page.locator('#adminForm input[name="confirmPassword"]').fill("new-browser-password-123");
  await page.locator("#saveAdminButton").click();
  await page.waitForFunction(() => document.getElementById("adminMessage").textContent.includes("密码已重置"));
  assert.equal(verifications, 2);
  await page.screenshot({ path: path.join(output, "administrator.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, nativePrompts: "mocked", realSsh: true, screenshots: output }));
} finally {
  await browser?.close();
  await manager?.gracefulShutdown("browser-test-complete");
  for (const connection of connections) connection.end();
  if (sshServer.address()) await new Promise((resolve) => sshServer.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
