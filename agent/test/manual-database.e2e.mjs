// Explicit opt-in isolated integration. Never read the user's registry or production profiles.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import ssh2 from "ssh2";
import { chromium } from "playwright-core";
import { InstanceRegistry } from "../instance-registry.js";
import { loadConfig } from "../config.js";
import { ManualWorkbench } from "../manual-workbench.js";
import { openManualTerminal } from "../manual-terminal.js";
import { manualMongoCommand, openManualDatabase } from "../manual-mongodb.js";

const uri = process.env.RDA_MANUAL_TEST_MONGO_URI;
const driverPath = process.env.RDA_MANUAL_TEST_DRIVER_PATH;
const mongoshPath = process.env.RDA_MANUAL_TEST_MONGOSH_PATH;
if (!uri || !driverPath || !mongoshPath || !/^mongodb:\/\/(?:[^@/]+@)?127\.0\.0\.1:\d+/.test(uri)) throw new Error("Set RDA_MANUAL_TEST_MONGO_URI (loopback only), RDA_MANUAL_TEST_DRIVER_PATH and RDA_MANUAL_TEST_MONGOSH_PATH for the isolated test.");
const require = createRequire(import.meta.url), mongo = require(driverPath);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rda-manual-mongo-e2e-"));
const databaseName = "rda_manual_" + Date.now();
const admin = new mongo.MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
const hostKey = ssh2.utils.generateKeyPairSync("ed25519"), userKey = ssh2.utils.generateKeyPairSync("ed25519");
const fingerprint = "SHA256:" + createHash("sha256").update(ssh2.utils.parseKey(hostKey.private).getPublicSSH()).digest("base64").replace(/=+$/, "");
const sockets = new Set(), children = new Set();
// Give the real mongosh a controlling PTY even though the SSH fixture itself uses pipes.
const localPty = `import os, pty, sys, select, signal, fcntl, termios, struct
pid, master = pty.fork()
if pid == 0:
    os.execl("/bin/sh", "sh", "-c", sys.argv[1])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
def stop(signum, frame):
    try: os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
while True:
    readable, _, _ = select.select([master, 0], [], [])
    if master in readable:
        try: data = os.read(master, 65536)
        except OSError: break
        if not data: break
        os.write(1, data)
    if 0 in readable:
        data = os.read(0, 65536)
        if not data: stop(0, None)
        os.write(master, data)
os.waitpid(pid, 0)
`;
const sshServer = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
  sockets.add(client); client.on("close", () => sockets.delete(client)); client.on("error", () => {});
  client.on("authentication", (context) => context.method === "publickey" ? context.accept() : context.reject());
  client.on("ready", () => client.on("session", (accept) => {
    const session = accept(); let pty = false;
    session.on("pty", (acceptPty) => { pty = true; acceptPty(); });
    session.on("window-change", (acceptResize) => acceptResize?.());
    session.on("shell", (acceptShell) => { const channel = acceptShell(); channel.write("isolated-ssh-ready\r\n"); channel.on("data", (data) => channel.write(data)); });
    session.on("exec", (acceptExec, _reject, info) => {
      const channel = acceptExec();
      const child = pty
        ? spawn("python3", ["-u", "-c", localPty, info.command], { env: process.env })
        : spawn("/bin/sh", ["-c", info.command], { env: process.env });
      children.add(child); child.on("close", (code) => { children.delete(child); channel.exit(code || 0); channel.end(); });
      child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr, { end: false });
      channel.on("data", (data) => child.stdin.write(data));
      channel.on("close", () => { child.stdin.end(); child.kill("SIGTERM"); });
      child.on("error", () => { channel.exit(1); channel.end(); });
    });
  }));
});
let workbench, browser, structured, bundledApp;
const useBundled = process.env.RDA_MANUAL_TEST_BUNDLED === "1";
const configPath = path.join(directory, "profiles.json"), privateKeyPath = path.join(directory, "ssh-key");
const profileUri = (username, password) => uri.replace(/\/\/[^@/]+@/, `//${username}:${password}@`).replace(/\/[^/?]*(\?|$)/, `/${databaseName}$1`).replace("authSource=admin", `authSource=${databaseName}`);
const writerPassword = "isolated-writer-password", readerPassword = "isolated-reader-password";
let writeUri, readUri;
try {
  await admin.connect();
  const db = admin.db(databaseName);
  await db.command({ createUser: "manual_writer", pwd: writerPassword, roles: [{ role: "readWrite", db: databaseName }] });
  await db.command({ createUser: "manual_reader", pwd: readerPassword, roles: [{ role: "read", db: databaseName }] });
  writeUri = profileUri("manual_writer", writerPassword); readUri = profileUri("manual_reader", readerPassword);
  const probe = new mongo.MongoClient(writeUri); await probe.connect(); await probe.close();
  const seedId = new mongo.ObjectId();
  const documents = Array.from({ length: 75 }, (_, index) => ({ _id: index === 0 ? seedId : new mongo.ObjectId(), order: index,
    date: new Date("2026-10-18T01:02:03Z"), price: mongo.Decimal128.fromString("123456789.123456789"),
    long: mongo.Long.fromString("9007199254740993"), binary: new mongo.Binary(Buffer.from([0, 255, 1])), marker: "<script>no-html</script>" }));
  await db.collection("records").insertMany(documents);
  await db.collection("large").insertOne({ payload: "x".repeat(400 * 1024) });
  await fs.writeFile(configPath, JSON.stringify({ human: { url: writeUri, database: databaseName } }), { mode: 0o600 });
  await fs.writeFile(privateKeyPath, userKey.private, { mode: 0o600 });
  await new Promise((resolve) => sshServer.listen(0, "127.0.0.1", resolve));
  const registry = new InstanceRegistry({ cwd: directory, env: {}, registryPath: path.join(directory, "instances.json") });
  const instance = { id: "isolated", name: "MongoDB 第二阶段隔离验证", host: "127.0.0.1", port: sshServer.address().port, username: "fixture", privateKeyPath, hostKeyFingerprints: [fingerprint],
    manualMongo: { enabled: true, configPath, driverPath, configProfile: "human", uriKey: "url", database: databaseName, mongoshPath, nodePath: process.execPath } };
  registry.create(instance);
  // Exercise actual SSH, driver, BSON, cursor, CAS, privilege and fingerprint behavior before browser steps.
  structured = openManualDatabase(registry.getInternal(instance.id));
  const connected = await structured.request({ operation: "connect" });
  assert.equal(connected.users[0].user, "manual_writer");
  const query = { operation: "find", database: databaseName, collection: "records", filter: {}, sort: { order: 1 }, pageSize: 10 };
  let page = await structured.request(query);
  assert.equal(page.data.length, 10); assert.equal(page.hasMore, true);
  assert.equal(page.data[0]._id.$oid, seedId.toHexString()); assert.equal(page.data[0].price.$numberDecimal, "123456789.123456789");
  assert.equal(page.data[0].long.$numberLong, "9007199254740993"); assert.equal(page.data[0].date.$date.$numberLong, String(documents[0].date.getTime()));
  assert.equal(page.data[0].binary.$binary.base64, "AP8B");
  const original = page.data[0], replacement = { ...original, edited: "structured" };
  let total = page.data.length;
  while (page.hasMore) { page = await structured.request({ operation: "next", cursor: page.cursor }); total += page.data.length; }
  assert.equal(total, 75);
  const result = await structured.request({ operation: "replaceOne", database: databaseName, collection: "records", original, replacement });
  assert.equal(result.matchedCount, 1);
  assert.equal((await db.collection("records").findOne({ _id: seedId })).long.toString(), "9007199254740993");
  await assert.rejects(structured.request({ operation: "replaceOne", database: databaseName, collection: "records", original, replacement }), { code: "MANUAL_DB_WRITE_CONFLICT" });
  await assert.rejects(structured.request({ ...query, collection: "large" }), { code: "MANUAL_DB_DOCUMENT_LIMIT" });
  const filtered = await structured.request({ ...query, filter: { _id: { $oid: seedId.toHexString() } } });
  assert.equal(filtered.data.length, 1);
  await fs.writeFile(configPath, JSON.stringify({ human: { url: readUri, database: databaseName } }));
  await assert.rejects(structured.request({ operation: "check" }), { code: "MANUAL_DB_TARGET_CHANGED" });
  structured.close(); structured = openManualDatabase(registry.getInternal(instance.id)); await structured.request({ operation: "connect" });
  await assert.rejects(structured.request({ operation: "replaceOne", database: databaseName, collection: "records", original: replacement, replacement: { ...replacement, edited: "forbidden" } }), { code: "MANUAL_DB_PERMISSION_DENIED" });
  structured.close(); structured = null;
  const wrongHost = openManualDatabase({ ...registry.getInternal(instance.id), hostKeyFingerprints: ["SHA256:" + "A".repeat(43)] });
  await assert.rejects(wrongHost.request({ operation: "connect" }), { code: "MANUAL_DB_HOST_KEY_MISMATCH" }); wrongHost.close();
  await fs.writeFile(configPath, JSON.stringify({ human: { url: writeUri, database: databaseName } }));
  // Missing client is a real failed exec, with an explicit configuration message.
  await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => { shell.close(); reject(new Error("missing-client test timed out")); }, 10000);
    const missing = { ...registry.getInternal(instance.id), manualMongo: { ...registry.getInternal(instance.id).manualMongo, mongoshPath: "/missing-rda-test-mongosh" } };
    const shell = openManualTerminal(missing, { cols: 100, rows: 30, command: manualMongoCommand(missing, connected.fingerprint),
      onData: (data) => { output += data.toString(); }, onReady() {}, onError: (code) => reject(new Error(code)),
      onClose() { clearTimeout(timeout); try { assert.ok(output.includes("MANUAL_DB_MONGOSH_REQUIRED")); resolve(); } catch (error) { reject(error); } },
    });
  });
  if (useBundled) {
    const { createManagerApp } = require("../../plugins/remote-debug-agent/runtime/agent/server.cjs");
    const config = loadConfig({}, directory);
    config.runtime = { ...config.runtime, statePath: path.join(directory, ".runtime", "agent-state.json") };
    bundledApp = createManagerApp({ config, registry, cwd: directory, authToken: "b".repeat(64),
      workerManager: { publicInstances: () => registry.list(), runtimeFor: () => ({ status: "stopped" }), shutdownAll: async () => {} },
    });
    workbench = bundledApp.locals.manualWorkbench;
  } else workbench = new ManualWorkbench({ registry, dataDirectory: directory });
  await workbench.store.register("admin", "isolated-admin-password");
  await workbench.start();
  const executablePath = process.env.RDA_MANUAL_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1080 } });
  const browserPage = await context.newPage(), errors = [];
  browserPage.on("pageerror", (error) => errors.push(error.message));
  await browserPage.goto(`${workbench.origin}/?instanceId=isolated`);
  await browserPage.locator('[name="username"]').fill("admin"); await browserPage.locator('[name="password"]').fill("isolated-admin-password"); await browserPage.locator("#loginButton").click();
  await browserPage.waitForFunction(() => document.getElementById("connectionStatus").textContent === "已连接");
  await browserPage.locator("#databaseNav").click(); await browserPage.locator("#dbConnect").click();
  await browserPage.waitForFunction(() => document.getElementById("dbStatus").textContent === "已连接");
  assert.ok((await browserPage.locator("#dbTarget").textContent()).includes("manual_writer"));
  assert.ok(!(await browserPage.locator("body").textContent()).includes(writerPassword));
  await browserPage.getByRole("button", { name: databaseName, exact: true }).click();
  await browserPage.getByRole("button", { name: "records", exact: true }).click();
  try { await browserPage.locator("#dbDocuments .db-document").first().waitFor({ timeout: 5000 }); }
  catch (error) { console.log("GUI diagnostic", await browserPage.locator("#dbMessage").textContent(), await browserPage.locator("#dbPageInfo").textContent()); throw error; }
  assert.equal(await browserPage.locator("#dbDocuments .db-document").count(), 30);
  await browserPage.locator("#dbNext").click(); await browserPage.waitForFunction(() => document.getElementById("dbPageInfo").textContent.includes("第 2 页"));
  await browserPage.locator("#dbIndexes").click();
  await browserPage.waitForFunction(() => document.getElementById("dbPageInfo").textContent.includes("索引"));
  await browserPage.locator("#dbDocuments .db-document").first().click(); assert.equal(await browserPage.locator("#dbEditor").isEditable(), false);
  await browserPage.locator("#dbFilter").fill(JSON.stringify({ _id: { $oid: seedId.toHexString() } })); await browserPage.locator("#dbFind").click();
  await browserPage.waitForFunction(() => document.getElementById("dbDocuments").children.length === 1);
  await browserPage.locator("#dbDocuments .db-document").click();
  const edited = JSON.parse(await browserPage.locator("#dbEditor").inputValue()); edited.edited = "browser";
  await browserPage.locator("#dbEditor").fill(JSON.stringify(edited, null, 2));
  browserPage.once("dialog", async (dialog) => { assert.ok(dialog.message().includes(databaseName + ".records") && dialog.message().includes("replaceOne")); await dialog.accept(); });
  await browserPage.locator("#dbPrepare").click(); await browserPage.waitForFunction(() => document.getElementById("dbMessage").textContent.includes("替换已完成"));
  assert.equal((await db.collection("records").findOne({ _id: seedId })).edited, "browser");
  await browserPage.locator("#dbShellConnect").click();
  await browserPage.waitForFunction(() => document.getElementById("dbShellHint").textContent.includes("通道已启动"));
  const shellText = () => browserPage.locator("#dbTerminal .xterm-screen").textContent();
  await browserPage.locator("#dbTerminal .xterm-helper-textarea").focus();
  await browserPage.keyboard.type('print("real-mongosh-ok"); db.records.countDocuments({})'); await browserPage.keyboard.press("Enter");
  await browserPage.waitForFunction(() => Array.from(document.querySelectorAll("#dbTerminal .xterm-rows > div")).some((row) => row.textContent.trim() === "75"), { timeout: 20000 });
  await browserPage.keyboard.type('db.records.updateOne({edited:"browser"},{$set:{shellEdited:true}})'); await browserPage.keyboard.press("Enter");
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await db.collection("records").findOne({ _id: seedId })).shellEdited) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!(await db.collection("records").findOne({ _id: seedId })).shellEdited) console.log("shell diagnostic", await browserPage.locator("#dbTerminal .xterm-rows").textContent());
  assert.equal((await db.collection("records").findOne({ _id: seedId })).shellEdited, true);
  await browserPage.locator("#sshNav").click();
  assert.equal(await browserPage.locator("#connectionStatus").textContent(), "已连接");
  await browserPage.locator("#databaseNav").click(); assert.ok((await shellText()).includes("real-mongosh-ok"));
  await browserPage.locator("#dbFind").click(); await browserPage.locator("#dbDocuments .db-document").first().waitFor();
  await browserPage.locator("#dbDocuments .db-document").first().click();
  const output = path.resolve(process.env.RDA_MANUAL_BROWSER_OUTPUT || fileURLToPath(new URL("../../output/manual-database", import.meta.url))); await fs.mkdir(output, { recursive: true });
  await browserPage.screenshot({ path: path.join(output, "database.png"), fullPage: true });
  await fs.writeFile(configPath, JSON.stringify({ human: { url: readUri, database: databaseName } }));
  await browserPage.locator("#dbFind").click();
  await browserPage.waitForFunction(() => document.getElementById("dbStatus").textContent === "未连接");
  assert.equal(await browserPage.locator("#dbDocuments").textContent(), "");
  assert.equal(workbench.sessions.values().next().value.database, null);
  await browserPage.locator("#sshNav").click(); assert.equal(await browserPage.locator("#connectionStatus").textContent(), "已连接");
  await browserPage.locator("#logoutButton").click(); await browserPage.locator("#loginPanel").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, bundledRuntime: useBundled, realMongoDB: "4.4.30", driver: "6.21.0", mongosh: "2.13.0", missingClient: true, hostKeyMismatch: true, remoteChangeRevoked: true, realDriver: true, realMongosh: true, realSSH: true, bson: true, pages: 8, casConflict: true, readOnlyDenied: true, screenshots: output }));
} finally {
  structured?.close();
  await browser?.close();
  await workbench?.close();
  bundledApp?.locals.lifecycle.stop(); bundledApp?.locals.resourceManager.close();
  for (const child of children) child.kill("SIGTERM");
  for (const socket of sockets) socket.end();
  await new Promise((resolve) => sshServer.close(resolve));
  await admin.db(databaseName).command({ dropAllUsersFromDatabase: 1 }).catch(() => {});
  await admin.db(databaseName).dropDatabase().catch(() => {}); await admin.close().catch(() => {});
  await fs.rm(directory, { recursive: true, force: true });
}
