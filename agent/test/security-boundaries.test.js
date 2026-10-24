import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import ssh2 from "ssh2";
const { Server, utils } = ssh2;
import localAuth from "../../plugins/remote-debug-agent/local-auth.cjs";
import { createApp, createManagerApp } from "../server.js";
import { InstanceRegistry } from "../instance-registry.js";
import { WorkerManager } from "../worker-manager.js";
import { normalizeHostKeyFingerprints } from "../config.js";
import { validateCommand } from "../security.js";
import { canonicalCommand } from "../ssh.js";
import { SshConnectionSupervisor } from "../ssh-connection-supervisor.js";
import { receiveWorkerAuth } from "../worker-entry.js";
import { EventEmitter } from "node:events";

const token = "b".repeat(64);
const fingerprint = "SHA256:" + "A".repeat(43);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rda-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function listen(t, app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("HTTP authentication and origin checks precede parsing and remote side effects", async (t) => {
  let calls = 0;
  const config = { agent: { host: "127.0.0.1" }, security: { allowedPaths: ["/var/log"], defaultTimeoutMs: 1000, maxTimeoutMs: 1000 }, audit: { logPath: path.join(await fixture(t), "audit.jsonl") }, ssh: {} };
  const base = await listen(t, createApp({ config, authToken: token, runSSH: async () => { calls++; return { stdout: "ok", stderr: "", exitCode: 0 }; } }));
  for (const [headers, status, code] of [
    [{}, 401, "LOCAL_AUTH_REQUIRED"],
    [{ Authorization: "Bearer wrong" }, 401, "LOCAL_AUTH_INVALID"],
    [{ Authorization: `Bearer ${token}`, Origin: "null" }, 403, "LOCAL_ORIGIN_REJECTED"],
    [{ Authorization: `Bearer ${token}`, Origin: "http://untrusted.invalid" }, 403, "LOCAL_ORIGIN_REJECTED"],
  ]) {
    const res = await fetch(base + "/run", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{invalid JSON" });
    assert.equal(res.status, status);
    assert.equal((await res.json()).error.code, code);
  }
  await new Promise((resolve, reject) => {
    const req = http.request(base + "/run", { method: "POST", headers: { Host: "untrusted.invalid", Authorization: `Bearer ${token}` } }, (res) => {
      res.resume(); assert.equal(res.statusCode, 403); res.on("end", resolve);
    }); req.on("error", reject); req.end();
  });
  assert.equal(calls, 0);
  for (const asset of ["/ui.css", "/ui.js", "/workspace.js"]) {
    const assetResponse = await fetch(base + asset);
    assert.equal(assetResponse.status, 200);
    assert.doesNotMatch(await assetResponse.text(), new RegExp(token));
  }
  assert.equal((await fetch(base + "/ui-private.js")).status, 401);
  assert.equal((await fetch(base + "/events")).status, 401);
  assert.equal((await fetch(base + "/api/environment-report")).status, 401);
  assert.equal((await fetch(base + "/status")).status, 401);
  const health = await (await fetch(base + "/health")).json();
  assert.deepEqual(Object.keys(health).sort(), ["apiVersion", "localAuthentication", "name", "ok"]);
  const res = await fetch(base + "/run", { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ cmd: "ps aux" }) });
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  assert.doesNotMatch(await (await fetch(base + "/status", { headers: { Authorization: `Bearer ${token}` } })).text(), new RegExp(token));
});

test("unauthenticated Manager requests cannot modify policies or stop instances", async (t) => {
  const root = await fixture(t);
  const registry = new InstanceRegistry({ cwd: root, env: {}, registryPath: path.join(root, "instances.json") });
  let stopped = 0;
  const base = await listen(t, createManagerApp({ authToken: token, config: { agent: { host: "127.0.0.1" }, ssh: {}, security: {}, runtime: { statePath: path.join(root, ".runtime/state.json") } }, registry, workerManager: { runtimeFor: () => ({ status: "stopped" }) }, shutdownController: { request: async () => stopped++ } }));
  assert.equal((await fetch(base + "/api/instances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "attack", host: "example.test", username: "app", privateKeyPath: "key", approvedCommands: { enabled: true } }) })).status, 401);
  assert.equal((await fetch(base + "/api/shutdown", { method: "POST", headers: { "Content-Type": "text/plain" } })).status, 401);
  assert.equal(registry.list().length, 0);
  assert.equal(stopped, 0);
});

test("credential initialization is atomic across processes and protected", async (t) => {
  const file = path.join(await fixture(t), ".runtime/http-auth.json");
  const module = path.resolve("../plugins/remote-debug-agent/local-auth.cjs");
  const run = promisify(execFile);
  const code = "const a=require(process.argv[1]); process.stdout.write(a.ensureAuthToken(process.argv[2]));";
  const results = await Promise.all(Array.from({ length: 3 }, () => run(process.execPath, ["-e", code, module, file])));
  assert.equal(new Set(results.map((result) => result.stdout)).size, 1);
  assert.equal(localAuth.readAuthToken(file), results[0].stdout);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    await fs.chmod(file, 0o644);
    assert.throws(() => localAuth.readAuthToken(file), { code: "LOCAL_AUTH_STORAGE_UNSAFE" });
  }
});

test("unsafe credentials and remote HTTP URLs fail closed", async (t) => {
  const root = await fixture(t);
  const dir = path.join(root, "credentials"); await fs.mkdir(dir, { mode: 0o700 });
  const target = path.join(root, "outside.json"); await fs.writeFile(target, JSON.stringify({ version: 1, token }), { mode: 0o600 });
  try {
    await fs.symlink(target, path.join(dir, "http-auth.json"));
    assert.throws(() => localAuth.ensureAuthToken(path.join(dir, "http-auth.json")), { code: "LOCAL_AUTH_STORAGE_UNSAFE" });
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    t.diagnostic("Windows symlink fixture requires Developer Mode; the remaining boundary checks still run");
  }
  assert.throws(() => localAuth.validateAgentUrl("http://example.test:4343"));
  assert.throws(() => localAuth.validateAgentUrl("https://user:password@example.test"));
  assert.equal(localAuth.validateAgentUrl("https://example.test").hostname, "example.test");
  assert.equal(localAuth.resolveAuthFile(root, { REMOTE_DEBUG_AUTH_FILE: "credentials/token.json" }), path.join(root, "credentials/token.json"));
  const missing = path.join(dir, "missing.json");
  assert.throws(() => createApp({ config: { agent: {}, auth: { filePath: missing } } }), { code: "LOCAL_AUTH_STORAGE_UNSAFE" });
  await assert.rejects(fs.access(missing));
});

test("file arguments, hidden file options and follow variants cannot bypass read boundaries", () => {
  const policy = { allowedPaths: ["/var/log"] };
  for (const cmd of ["cat /var/log/public.log .env", "tail /var/log/public.log secret", "ls /var/log .", "grep error /var/log/public.log .env", "grep -f .env /var/log/public.log", "grep -r error /var/log", "grep -R error /var/log", "ls -laL /var/log", "ls -R /var/log", "tail -F /var/log/public.log", "tail --follow=name /var/log/public.log", "tail -n 10001 /var/log/public.log", "tail -c1048577 /var/log/public.log", "grep -A10001 error /var/log/public.log"])
    assert.throws(() => validateCommand(cmd, policy), cmd);
  for (const cmd of ["cat -ns /var/log/public.log", "ls -lah /var/log", "tail -n100 /var/log/public.log", "tail --bytes=1024 /var/log/public.log", "grep -in -A3 error /var/log/public.log", "grep -e error /var/log/public.log", "grep -- -error /var/log/public.log"])
    assert.doesNotThrow(() => validateCommand(cmd, policy), cmd);
  assert.deepEqual(validateCommand("grep -e /literal /var/log/public.log", policy).pathTokenIndexes, [3]);
  assert.deepEqual(validateCommand('cat "/var/log/space \' quote.log"', policy).absolutePaths, ["/var/log/space ' quote.log"]);
  assert.deepEqual(validateCommand('grep "server error" /var/log/public.log', policy).tokens, ["grep", "server error", "/var/log/public.log"]);
  assert.throws(() => validateCommand("cat '/var/log/unterminated", policy));
  assert.throws(() => validateCommand('cat "/var/log/x;touch hack"', policy));
});

test("canonical execution quotes real paths and does not read relative secrets", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX remote command quoting is exercised on Unix");
  const root = await fixture(t);
  const allowed = path.join(root, "allowed"); await fs.mkdir(allowed);
  const file = path.join(allowed, "space ' quote.log"); await fs.writeFile(file, "public fixture");
  await fs.writeFile(path.join(root, ".env"), "private fixture");
  const validation = validateCommand(`cat ${allowed}/logical.log`, { allowedPaths: [allowed] });
  const command = canonicalCommand(validation, [file]);
  const output = spawnSync("/bin/sh", ["-c", command], { cwd: root, encoding: "utf8" });
  assert.equal(output.status, 0); assert.equal(output.stdout, "public fixture");
  assert.throws(() => validateCommand(`cat ${allowed}/logical.log .env`, { allowedPaths: [allowed] }));
});

test("instance migration and target changes preserve only explicitly configured trusted keys", async (t) => {
  const root = await fixture(t), file = path.join(root, "instances.json");
  await fs.writeFile(file, JSON.stringify({ version: 3, instances: [{ id: "one", host: "a.test", port: 22, username: "app", privateKeyPath: "key" }] }));
  const registry = new InstanceRegistry({ cwd: root, env: {}, registryPath: file });
  assert.equal(registry.registry.version, 4);
  assert.deepEqual(registry.get("one").hostKeyFingerprints, []);
  registry.update("one", { hostKeyFingerprints: [fingerprint] });
  registry.update("one", { name: "renamed" });
  assert.deepEqual(registry.get("one").hostKeyFingerprints, [fingerprint]);
  registry.update("one", { port: 2222 });
  assert.deepEqual(registry.get("one").hostKeyFingerprints, []);
  assert.throws(() => normalizeHostKeyFingerprints([fingerprint.replace(/A$/, "B")]));
  assert.throws(() => normalizeHostKeyFingerprints(Array(5).fill(fingerprint)));
});

test("worker token arrives only through private IPC and rejects missing or invalid credentials", async () => {
  const processObject = new EventEmitter(); processObject.connected = true;
  const ready = receiveWorkerAuth(processObject);
  processObject.emit("message", { type: "initialize-auth", token });
  assert.equal(await ready, token);
  const invalid = receiveWorkerAuth(processObject);
  processObject.emit("message", { type: "initialize-auth", token: "bad" });
  await assert.rejects(invalid, { code: "LOCAL_AUTH_REQUIRED" });
  await assert.rejects(receiveWorkerAuth(processObject, 1), { code: "LOCAL_AUTH_REQUIRED" });
});

test("real local SSH verifies host identity before authentication", async (t) => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  const good = `SHA256:${createHash("sha256").update(utils.parseKey(privateKey).getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
  let authentications = 0;
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => { authentications++; ctx.accept(); });
  });
  server.on("error", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = { ssh: { host: "127.0.0.1", port: server.address().port, username: "fixture", privateKeyPath: "fixture", readyTimeout: 3000 }, sshNetwork: { reconnectBaseMs: 1 } };
  for (const [pins, code] of [[[], "SSH_HOST_KEY_REQUIRED"], [[fingerprint], "SSH_HOST_KEY_MISMATCH"]]) {
    const supervisor = new SshConnectionSupervisor({ ...base, ssh: { ...base.ssh, hostKeyFingerprints: pins } }, { readFile: async () => privateKey });
    await assert.rejects(supervisor.start(), { code, retriable: false });
    assert.equal(supervisor.state, "blocked"); assert.equal(supervisor.reconnectTimer, null);
    assert.equal(authentications, 0);
    await supervisor.stop();
  }
  const trusted = new SshConnectionSupervisor({ ...base, ssh: { ...base.ssh, hostKeyFingerprints: [good] } }, { readFile: async () => privateKey });
  await trusted.start(); assert.equal(trusted.snapshot().hostVerification.status, "verified"); assert.ok(authentications > 0);
  await trusted.stop();
});

test("a changed host key during reconnect blocks further automatic retries", async () => {
  const keys = [Buffer.from("first host key"), Buffer.from("changed host key")];
  const pin = "SHA256:" + createHash("sha256").update(keys[0]).digest("base64").replace(/=+$/, "");
  const clients = [];
  class Client extends EventEmitter {
    constructor() { super(); clients.push(this); }
    connect(options) {
      const accepted = options.hostVerifier(keys[clients.length - 1]);
      setImmediate(() => accepted ? this.emit("ready") : this.emit("error", new Error("Host denied (verification failed)")));
    }
    end() {}
  }
  const supervisor = new SshConnectionSupervisor({ ssh: { host: "fixture", username: "app", privateKeyPath: "fixture", hostKeyFingerprints: [pin] }, sshNetwork: { reconnectBaseMs: 1, reconnectMaxMs: 1, reconnectJitter: 0 } }, { ClientClass: Client, readFile: async () => "fixture" });
  await supervisor.start();
  const blocked = new Promise((resolve) => supervisor.on("state", (state) => { if (state.transport.status === "blocked") resolve(); }));
  clients[0].emit("close");
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await blocked;
    assert.equal(supervisor.lastError.code, "SSH_HOST_KEY_MISMATCH");
    assert.equal(supervisor.reconnectTimer, null);
    await assert.rejects(supervisor.connectNow(), { code: "SSH_HOST_KEY_MISMATCH", retriable: false });
    assert.equal(clients.length, 2);
  } finally { clearTimeout(keepAlive); await supervisor.stop(); }
});

test("isolated bundled Workers receive private IPC tokens and rotate them on restart", async (t) => {
  const root = await fixture(t);
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  const pin = "SHA256:" + createHash("sha256").update(utils.parseKey(privateKey).getPublicSSH()).digest("base64").replace(/=+$/, "");
  const keyPath = path.join(root, "fixture-key"); await fs.writeFile(keyPath, privateKey, { mode: 0o600 });
  const commands = [];
  const sshServer = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (accept, _reject, info) => { commands.push(info.command); const stream = accept(); stream.write("isolated fixture"); stream.exit(0); stream.end(); });
    }));
  });
  await new Promise((resolve) => sshServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => sshServer.close(resolve)));
  const reserve = http.createServer(); await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const workerPort = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
  const registry = new InstanceRegistry({ cwd: root, env: {}, registryPath: path.join(root, "instances.json") });
  registry.registry.manager.workerPortRange = { start: workerPort, end: workerPort };
  registry.create({ id: "fixture", host: "127.0.0.1", port: sshServer.address().port, username: "fixture", privateKeyPath: keyPath, hostKeyFingerprints: [pin] });
  const manager = new WorkerManager({ registry, cwd: root, workerEntryPath: path.resolve("../plugins/remote-debug-agent/runtime/agent/worker-entry.cjs"), memoryStore: { shouldInitialize: () => false, summary: () => ({ status: "ready" }) } });
  try {
    await manager.startInstance("fixture");
    const oldToken = manager.runtime.get("fixture").authToken;
    const endpoint = `http://127.0.0.1:${workerPort}/run`;
    assert.equal((await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status, 401);
    assert.equal(commands.length, 0);
    const result = await manager.callInstance("fixture", "/run", { cmd: "ps aux" });
    assert.equal(result.stdout, "isolated fixture");
    assert.deepEqual(commands, ["ps aux"]);
    await manager.stopInstance("fixture");
    await manager.startInstance("fixture");
    assert.notEqual(manager.runtime.get("fixture").authToken, oldToken);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${oldToken}` } })).status, 401);
    assert.ok(!JSON.stringify(manager.publicInstances()).includes(oldToken));
  } finally { await manager.shutdownAll(); }
});
