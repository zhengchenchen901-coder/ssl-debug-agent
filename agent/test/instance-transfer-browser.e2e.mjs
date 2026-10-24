import { openInstancePage, openInstanceMenu, openAdministratorSettings } from "./helpers/workspace-browser.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { createManagerApp } from "../server.js";
import { InstanceRegistry } from "../instance-registry.js";
import { MemoryStore } from "../memory-store.js";
import { loadConfig } from "../config.js";
import localAuth from "../../plugins/remote-debug-agent/local-auth.cjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "rda-transfer-browser-"));
const servers = [], managers = [], errors = [];
const password = "browser-fixture-password-123";
let browser, remoteCalls = 0;
async function manager(name) {
  const cwd = path.join(root, name); await fs.mkdir(cwd);
  const registry = new InstanceRegistry({ cwd, env: {} }), memoryStore = new MemoryStore({ cwd });
  const config = loadConfig({}, cwd); config.runtime.statePath = path.join(cwd, ".runtime/state.json");
  const token = localAuth.ensureAuthToken(localAuth.resolveAuthFile(cwd));
  const workerManager = { memoryStore, publicInstances: () => registry.list().map(i => ({ ...i, memory: memoryStore.summary(i), runtime: { status: "stopped" } })),
    runtimeFor: () => ({ status: "stopped" }), callInstance: () => { remoteCalls++; throw new Error("unexpected remote operation"); }, startInstance: () => { remoteCalls++; throw new Error("unexpected worker start"); } };
  const app = createManagerApp({ cwd, config, registry, workerManager, authToken: token }); managers.push(app);
  const server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening"); servers.push(server);
  return { cwd, registry, memoryStore, token, url: `http://127.0.0.1:${server.address().port}` };
}
async function unlock(page, manager) {
  await page.goto(manager.url); await page.locator("#authToken").fill(manager.token); await page.locator("#authForm button").click();
  await page.locator("#authPanel").waitFor({ state: "hidden" });
}
try {
  const from = await manager("source 中文"), to = await manager("destination 空格");
  const key = path.join(from.cwd, "fixture key"); await fs.writeFile(key, "browser-private-key-fixture\r\n");
  from.registry.create({ id: "fixture", name: "浏览器迁移实例", host: "fixture.invalid", username: "fixture", privateKeyPath: key, passphrase: "fixture-ssh-passphrase" });
  await from.memoryStore.upsertNote(from.registry.getInternal("fixture"), { topic: "fixture", summary: "browser memory", facts: ["isolated fixture"] });
  // An existing ID in the destination must survive the failed first import.
  to.registry.create({ id: "fixture", name: "已有实例", host: "existing.invalid", username: "other", privateKeyPath: "existing-key" });
  browser = await chromium.launch({ headless: true, executablePath: process.env.RDA_BROWSER_EXECUTABLE || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined), ...(process.env.RDA_BROWSER_EXECUTABLE || process.platform === "darwin" ? {} : { channel: "chrome" }) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page.on("pageerror", error => errors.push(error.message));
  await unlock(page, from);
  await openInstanceMenu(page, "fixture");
  await page.locator('[data-action="export"][data-id="fixture"]').click();
  await page.locator("#transferPassword").fill(password); await page.locator("#transferConfirm").fill("different-password-123");
  await page.locator("#submitTransferButton").click(); await page.getByText("两次输入的口令不一致。", { exact: true }).waitFor();
  await page.locator("#transferConfirm").fill(password);
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#submitTransferButton").click()]);
  assert.equal(download.suggestedFilename(), "instance-fixture.rda-instance.json");
  const file = path.join(root, download.suggestedFilename()); await download.saveAs(file);
  const bytes = await fs.readFile(file); for (const secret of [password, "fixture-ssh-passphrase", "browser-private-key-fixture", "browser memory"]) assert.ok(!bytes.toString().includes(secret));
  assert.equal(await page.locator("#transferPassword").inputValue(), "");
  await unlock(page, to);
  await page.locator("#importInstanceButton").click();
  await page.locator("#transferFile").setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from("bad json") });
  await page.locator("#transferPassword").fill(password); await page.locator("#submitTransferButton").click();
  await page.getByText("配置文件不是有效 JSON。", { exact: true }).waitFor();
  await page.locator("#transferFile").setInputFiles(file); await page.locator("#transferPassword").fill("wrong-password-123");
  await page.locator("#submitTransferButton").click(); await page.getByText("口令错误或导出包已损坏。", { exact: true }).waitFor();
  await page.locator("#transferPassword").fill(password); await page.locator("#submitTransferButton").click();
  await page.locator("#transferPreview").waitFor({ state: "visible" });
  assert.ok(!(await page.locator("#transferSummary").innerText()).includes("fixture-ssh-passphrase"));
  await page.locator("#submitTransferButton").click(); await page.getByText("实例 ID 或目录已存在（包括仅大小写不同），请修改 ID 后新建。", { exact: true }).waitFor();
  await page.locator("#transferId").fill("copy"); await page.locator("#transferName").fill("导入副本");
  await page.screenshot({ path: process.env.RDA_TRANSFER_SCREENSHOT || path.join(os.tmpdir(), "rda-instance-transfer-ui.png"), fullPage: true });
  await page.locator("#submitTransferButton").click(); await page.locator("#transferBackdrop").waitFor({ state: "hidden" });
  await page.locator('.instance-name-button[data-id="copy"]').waitFor();
  assert.equal(to.registry.getInternal("fixture").host, "existing.invalid");
  assert.equal(to.registry.getInternal("copy").host, "fixture.invalid");
  assert.equal(to.memoryStore.ensureLoaded("copy").sections.notes.fixture.summary, "browser memory");
  assert.equal(await page.locator("#transferPassword").inputValue(), ""); assert.equal(await page.locator("#transferFile").inputValue(), "");
  // Logout while a preview is open must clear the file, password and decrypted summary.
  await page.locator("#importInstanceButton").click(); await page.locator("#transferFile").setInputFiles(file);
  await page.locator("#transferPassword").fill(password); await page.locator("#submitTransferButton").click(); await page.locator("#transferPreview").waitFor({ state: "visible" });
  await page.evaluate(() => document.querySelector("#authLogout").click());
  assert.equal(await page.locator("#transferPassword").inputValue(), ""); assert.equal(await page.locator("#transferFile").inputValue(), "");
  assert.equal(await page.locator("#transferSummary").innerText(), "");
  assert.equal(remoteCalls, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, platform: process.platform, scenarios: ["download", "password-confirmation", "invalid-file", "wrong-password-and-retry", "preview", "ID-conflict-and-rename", "import", "memory-restored", "logout-cleanup"], remoteCalls }));
} finally {
  await browser?.close(); for (const app of managers) app.locals.resourceManager.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.rm(root, { recursive: true, force: true });
}
