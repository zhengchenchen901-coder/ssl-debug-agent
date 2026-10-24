import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import ssh2 from "ssh2";
import { WebSocket } from "ws";
import { InstanceRegistry } from "../instance-registry.js";
import { createApp, createManagerApp } from "../server.js";
import { ManualAdminStore } from "../manual-auth.js";
import { ManualOwnerVerification } from "../manual-owner-verification.js";
import { ManualWorkbench } from "../manual-workbench.js";
import { TEST_AUTH_TOKEN } from "./helpers/http-auth.js";

const PASSWORD = "manual-admin-password-123";
async function fixture(t, options = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "rda-manual-"));
  const registry = new InstanceRegistry({ cwd: directory, env: {}, registryPath: path.join(directory, ".remote-debug", "instances.json") });
  registry.create({ id: "test", name: "测试实例", host: "127.0.0.1", username: "ops", privateKeyPath: path.join(directory, "test-key"), hostKeyFingerprints: ["SHA256:" + "A".repeat(43)] });
  registry.create({ id: "other", name: "其他实例", host: "127.0.0.2", username: "other", privateKeyPath: "/unused/key" });
  let ownerChecks = 0;
  const workbench = new ManualWorkbench({ registry, dataDirectory: directory, ownerVerification: {
    status: () => ({ supported: true, method: "test-native" }), verify: async () => { ownerChecks++; },
  }, ...options });
  t.after(async () => { await workbench.close(); await fsp.rm(directory, { recursive: true, force: true }); });
  return { directory, registry, workbench, ownerChecks: () => ownerChecks };
}
async function request(workbench, route, body, token, headers = {}) {
  const origin = await workbench.start();
  return fetch(origin + route, { method: body === undefined ? "GET" : "POST", headers: {
    ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: origin }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function login(workbench, instanceId = "test") {
  const response = await request(workbench, "/api/login", { username: "admin", password: PASSWORD, instanceId });
  assert.equal(response.status, 200);
  return response.json();
}
async function socket(workbench, origin = workbench.origin, pathname = "/terminal") {
  const ws = new WebSocket(workbench.origin.replace("http:", "ws:") + pathname, { origin });
  await once(ws, "open");
  return ws;
}
function message(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error("terminal message timed out")); }, 3000);
    const listener = (data, binary) => {
      let value;
      try { value = binary ? data.toString() : JSON.parse(data.toString()); } catch { return; }
      if (predicate(value, binary)) { cleanup(); resolve(value); }
    };
    function cleanup() { clearTimeout(timeout); ws.off("message", listener); }
    ws.on("message", listener);
  });
}
function authenticate(ws, ticket, extra = {}) { ws.send(JSON.stringify({ type: "authenticate", ticket, cols: 100, rows: 30, ...extra })); }

test("admin registration requires OS verification and existing administrator authorization; hashes survive reload", async (t) => {
  const { directory, workbench, ownerChecks } = await fixture(t);
  assert.equal(workbench.status().adminCount, 0);
  await workbench.register({ username: "admin", password: PASSWORD });
  assert.equal(ownerChecks(), 1);
  const stored = fs.readFileSync(workbench.store.filePath, "utf8");
  assert.ok(!stored.includes(PASSWORD));
  assert.equal(await new ManualAdminStore(workbench.directory).verify("admin", PASSWORD), true);
  assert.equal(await workbench.store.verify("admin", "wrong-password"), false);
  await assert.rejects(workbench.register({ username: "second", password: PASSWORD }), { code: "ADMIN_LOGIN_FAILED" });
  assert.equal(ownerChecks(), 1);
  await workbench.register({ username: "second", password: PASSWORD, existingUsername: "admin", existingPassword: PASSWORD });
  assert.equal(ownerChecks(), 2);
  assert.equal(workbench.status().adminCount, 2);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(workbench.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(workbench.store.filePath).mode & 0o777, 0o600);
    const fake = path.join(directory, "other-file");
    fs.renameSync(workbench.store.filePath, fake);
    fs.symlinkSync(fake, workbench.store.filePath);
    assert.throws(() => workbench.store.read());
  }
});

test("cancelled native verification cannot create an account and unknown request fields are rejected", async (t) => {
  const { workbench } = await fixture(t, { ownerVerification: { status: () => ({ supported: true }), verify: async () => { throw new Error("cancelled"); } } });
  await assert.rejects(workbench.register({ username: "admin", password: PASSWORD }));
  assert.equal(workbench.store.read().length, 0);
  await assert.rejects(workbench.register({ username: "admin", password: PASSWORD, verified: true }), { code: "MANUAL_REQUEST_INVALID" });
});

test("a Windows logon rejection is actionable and never creates an administrator", async (t) => {
  const ownerVerification = new ManualOwnerVerification("unused", { platform: "win32", execute: async (_command, args) => {
    throw Object.assign(new Error("private native diagnostic"), { code: 1,
      stdout: JSON.stringify({ verified: false, nonce: args.at(-1), reason: "logon-error", nativeError: 1326 }) });
  } });
  const { workbench } = await fixture(t, { ownerVerification });
  await assert.rejects(workbench.register({ username: "admin", password: PASSWORD }),
    (error) => error.code === "OWNER_WINDOWS_LOGON_FAILED" && error.message.includes("1326") && !error.message.includes("private native diagnostic"));
  assert.equal(workbench.store.read().length, 0);
});

test("native password recovery revokes old sessions and replaces the stored password", async (t) => {
  const { workbench, ownerChecks } = await fixture(t);
  await workbench.store.register("admin", PASSWORD);
  const { token } = await login(workbench);
  await workbench.resetAdmin({ username: "admin", password: "replacement-password-123" });
  assert.equal(ownerChecks(), 1);
  assert.equal(workbench.sessions.size, 0);
  assert.equal((await request(workbench, "/api/session", undefined, token)).status, 401);
  assert.equal(await workbench.store.verify("admin", PASSWORD), false);
  assert.equal(await workbench.store.verify("admin", "replacement-password-123"), true);
});

test("native verification cannot be reused by concurrent registrations and cancelled recovery changes nothing", async (t) => {
  let complete;
  const { workbench } = await fixture(t, { ownerVerification: { status: () => ({ supported: true }), verify: () => new Promise((resolve) => { complete = resolve; }) } });
  const first = workbench.register({ username: "admin", password: PASSWORD });
  await assert.rejects(workbench.register({ username: "other", password: PASSWORD }), { code: "ADMIN_REGISTRATION_BUSY" });
  complete();
  await first;
  const { token } = await login(workbench);
  workbench.ownerVerification.verify = async () => { throw new Error("cancelled"); };
  await assert.rejects(workbench.resetAdmin({ username: "admin", password: "replacement-password-123" }));
  assert.equal(await workbench.store.verify("admin", PASSWORD), true);
  assert.equal((await request(workbench, "/api/session", undefined, token)).status, 200);
});

test("password recovery rejects an old-password check that was already in flight", async (t) => {
  const { workbench } = await fixture(t);
  await workbench.store.register("admin", PASSWORD);
  let finish;
  workbench.store.verify = () => new Promise((resolve) => { finish = resolve; });
  const pending = workbench.login({ username: "admin", password: PASSWORD, instanceId: "test" });
  await workbench.resetAdmin({ username: "admin", password: "replacement-password-123" });
  finish(true);
  await assert.rejects(pending, { code: "ADMIN_LOGIN_FAILED" });
  assert.equal(workbench.sessions.size, 0);
});

test("native owner verification binds the proof to its invocation and rejects unsupported platforms", async () => {
  const verifier = new ManualOwnerVerification("unused", { platform: process.getuid ? "darwin" : "win32", execute: async (_command, args) => ({ stdout: JSON.stringify({ verified: true, nonce: args.at(-1), uid: process.getuid?.() }) }) });
  verifier.macHelper = async () => "/test/native-helper";
  await verifier.verify();
  verifier.execute = async () => ({ stdout: JSON.stringify({ verified: true, nonce: "replayed", uid: process.getuid?.() }) });
  await assert.rejects(verifier.verify(), { code: "OWNER_VERIFICATION_FAILED" });
  await assert.rejects(new ManualOwnerVerification("unused", { platform: "linux" }).verify(), { code: "OWNER_VERIFICATION_UNSUPPORTED" });
});

test("manual listener rejects cross-origin requests and Manager tokens; no credentials enter URLs or static assets", async (t) => {
  const { workbench } = await fixture(t);
  await workbench.store.register("admin", PASSWORD);
  const origin = await workbench.start();
  assert.equal((await request(workbench, "/api/session", undefined, TEST_AUTH_TOKEN)).status, 401);
  assert.equal((await request(workbench, "/api/login", { username: "admin", password: PASSWORD, instanceId: "test" }, undefined, { Origin: "http://evil.example" })).status, 403);
  assert.equal((await fetch(origin + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
  const rejectedHost = await new Promise((resolve, reject) => {
    const request = http.get(origin + "/", { headers: { Host: "evil.example" } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
  });
  assert.equal(rejectedHost, 403);
  const result = await login(workbench);
  assert.equal(result.target.username, "ops");
  assert.ok(!JSON.stringify(result.target).includes("privateKey"));
  assert.equal((await request(workbench, "/api/session", undefined, result.token)).status, 200);
  assert.equal((await request(workbench, "/assets/../manual-auth.js")).status, 404);
  for (const asset of ["ui.css", "ui.js", "manual.css", "manual.js"]) {
    const response = await fetch(origin + "/assets/" + asset);
    assert.equal(response.status, 200);
    const contents = await response.text();
    assert.ok(!contents.includes(PASSWORD) && !contents.includes(result.token));
  }
  const page = await (await fetch(origin + "/")).text();
  assert.ok(!page.includes(PASSWORD) && !page.includes(result.token));
  const badSocket = new WebSocket(origin.replace("http:", "ws:") + "/terminal", { origin: "http://evil.example" });
  await assert.rejects(once(badSocket, "open"), /403/);
  const querySocket = new WebSocket(origin.replace("http:", "ws:") + "/terminal?token=" + result.token, { origin });
  await assert.rejects(once(querySocket, "open"), /403/);
});

test("one-time terminal tickets are bound to one instance; input and resize work without command allowlists", async (t) => {
  const calls = [];
  const { workbench } = await fixture(t, { openTerminal: (instance, options) => {
    calls.push({ instance, options, writes: [], sizes: [] });
    setImmediate(() => options.onReady());
    return { write: (data) => calls[0].writes.push(data), resize: (cols, rows) => {
      calls[0].sizes.push([cols, rows]); options.onData(Buffer.from("manual-output"));
    }, close() {}, pause() {}, resume() {} };
  } });
  await workbench.store.register("admin", PASSWORD);
  const { token } = await login(workbench);
  const { ticket } = await (await request(workbench, "/api/terminal-ticket", {}, token)).json();
  const ws = await socket(workbench);
  const ready = message(ws, (value) => value.type === "ready");
  authenticate(ws, ticket);
  await ready;
  assert.equal(calls[0].instance.id, "test");
  const output = message(ws, (value, binary) => binary && value === "manual-output");
  ws.send(JSON.stringify({ type: "input", data: "sudo systemctl restart app\r" }));
  ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
  await output;
  assert.deepEqual(calls[0].writes, ["sudo systemctl restart app\r"]);
  assert.deepEqual(calls[0].sizes, [[120, 40]]);
  const replay = await socket(workbench);
  const rejected = message(replay, (value) => value.type === "error");
  authenticate(replay, ticket);
  await rejected;
  assert.equal(calls.length, 1);
  const closed = once(ws, "close");
  await request(workbench, "/api/logout", {}, token);
  await closed;
  assert.equal((await request(workbench, "/api/terminal-ticket", {}, token)).status, 401);
  const audit = fs.readFileSync(path.join(workbench.directory, "sessions.jsonl"), "utf8");
  for (const secret of [PASSWORD, token, ticket, "sudo systemctl", "manual-output"]) assert.ok(!audit.includes(secret));
});

test("a terminal handshake cannot change instance or connection settings", async (t) => {
  let opened = 0;
  const { workbench } = await fixture(t, { openTerminal: () => { opened++; } });
  await workbench.store.register("admin", PASSWORD);
  const { token } = await login(workbench);
  const { ticket } = await (await request(workbench, "/api/terminal-ticket", {}, token)).json();
  const ws = await socket(workbench);
  const rejected = message(ws, (value) => value.type === "error");
  authenticate(ws, ticket, { instanceId: "other", host: "evil" });
  await rejected;
  assert.equal(opened, 0);
});

test("SSH output pauses until the browser confirms rendering, without extending input idle time", async (t) => {
  let handlers, paused = false, finishResume;
  const { workbench } = await fixture(t, { openTerminal: (_instance, options) => {
    handlers = options;
    setImmediate(options.onReady);
    return { write() {}, resize() {}, close() {}, pause() { paused = true; }, resume() { if (paused) { paused = false; finishResume?.(); } } };
  } });
  await workbench.store.register("admin", PASSWORD);
  const { token } = await login(workbench);
  const lastInputAt = workbench.getSession(token).lastInputAt;
  const { ticket } = await (await request(workbench, "/api/terminal-ticket", {}, token)).json();
  const ws = await socket(workbench);
  const ready = message(ws, (value) => value.type === "ready");
  authenticate(ws, ticket); await ready;
  const bytes = 600 * 1024;
  const output = message(ws, (value, binary) => binary && value.length === bytes);
  handlers.onData(Buffer.alloc(bytes, "x"));
  await output;
  assert.equal(paused, true);
  const resumed = new Promise((resolve) => { finishResume = resolve; });
  ws.send(JSON.stringify({ type: "output-ack", bytes }));
  await resumed;
  assert.equal(paused, false);
  assert.equal(workbench.getSession(token).lastInputAt, lastInputAt);
});

test("an expired terminal ticket cannot open a connection", async (t) => {
  let now = Date.now(), opened = 0;
  const { workbench } = await fixture(t, { now: () => now, openTerminal: () => { opened++; } });
  await workbench.store.register("admin", PASSWORD);
  const { token } = await login(workbench);
  const { ticket } = await (await request(workbench, "/api/terminal-ticket", {}, token)).json();
  now += 10_001;
  const ws = await socket(workbench);
  const rejected = message(ws, (value) => value.type === "error");
  authenticate(ws, ticket);
  await rejected;
  assert.equal(opened, 0);
});

test("idle expiry, absolute expiry, logout and configuration changes revoke authorization", async (t) => {
  let now = Date.now();
  const { workbench, registry } = await fixture(t, { now: () => now, idleMs: 1000, maxSessionMs: 3000 });
  await workbench.store.register("admin", PASSWORD);
  let result = await login(workbench);
  now += 1001;
  assert.equal((await request(workbench, "/api/session", undefined, result.token)).status, 401);
  result = await login(workbench);
  now += 900;
  workbench.getSession(result.token).lastInputAt = now;
  now += 2200;
  workbench.sessions.get(result.token).lastInputAt = now;
  assert.equal((await request(workbench, "/api/session", undefined, result.token)).status, 401);
  result = await login(workbench);
  registry.update("test", { username: "changed" });
  assert.equal((await request(workbench, "/api/terminal-ticket", {}, result.token)).status, 401);
  result = await login(workbench);
  registry.delete("test");
  assert.equal((await request(workbench, "/api/session", undefined, result.token)).status, 401);
});

test("login throttling limits password guesses", async (t) => {
  const { workbench } = await fixture(t);
  await workbench.store.register("admin", PASSWORD);
  for (let i = 0; i < 5; i++) {
    assert.equal((await request(workbench, "/api/login", { username: "admin", password: "wrong", instanceId: "test" })).status, 401);
  }
  assert.equal((await request(workbench, "/api/login", { username: "admin", password: PASSWORD, instanceId: "test" })).status, 429);
});

test("Manager routes need local authorization and editing an instance immediately closes its human session", async (t) => {
  const { workbench, directory, registry, ownerChecks } = await fixture(t);
  const app = createManagerApp({ authToken: TEST_AUTH_TOKEN, config: { agent: { host: "127.0.0.1", port: 0 }, ssh: {}, runtime: { statePath: path.join(directory, ".runtime", "state.json") } },
    registry, manualWorkbench: workbench, workerManager: { publicInstances: () => [], runtimeFor: () => ({ status: "stopped" }) } });
  const manager = http.createServer(app);
  await new Promise((resolve) => manager.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => manager.close(resolve)));
  const url = `http://127.0.0.1:${manager.address().port}`;
  const options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: PASSWORD }) };
  assert.equal((await fetch(url + "/api/manual/register", options)).status, 401);
  assert.equal(ownerChecks(), 0);
  assert.equal((await fetch(url + "/api/manual/register", { ...options, headers: { ...options.headers, Authorization: `Bearer ${TEST_AUTH_TOKEN}` } })).status, 201);
  const result = await login(workbench);
  const response = await fetch(url + "/api/instances/test", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_AUTH_TOKEN}` }, body: JSON.stringify({ name: "新名称" }) });
  assert.equal(response.status, 200);
  assert.equal(workbench.sessions.size, 0);
  assert.equal((await request(workbench, "/api/session", undefined, result.token)).status, 401);
});

test("automatic Worker exposes no manual administration, login or terminal routes", async (t) => {
  const { directory } = await fixture(t);
  const config = { agent: { host: "127.0.0.1", port: 0 }, ssh: {}, security: { allowedPaths: [] },
    audit: { logPath: path.join(directory, "audit.jsonl") }, runtime: { statePath: path.join(directory, ".runtime", "state.json") } };
  const server = http.createServer(createApp({ config, authToken: TEST_AUTH_TOKEN }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const route of ["/api/manual/register", "/api/manual/reset", "/api/manual/open", "/api/login", "/api/terminal-ticket"]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: "POST",
      headers: { Authorization: `Bearer ${TEST_AUTH_TOKEN}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 404);
  }
});

test("real SSH PTY transports input, output, resizing and interruption; host-key mismatch never opens a shell", async (t) => {
  const hostKey = ssh2.utils.generateKeyPairSync("ed25519");
  const userKey = ssh2.utils.generateKeyPairSync("ed25519");
  const publicKey = ssh2.utils.parseKey(hostKey.private).getPublicSSH();
  const fingerprint = "SHA256:" + createHash("sha256").update(publicKey).digest("base64").replace(/=+$/, "");
  const observed = { shells: 0, received: "", sizes: [] }, connections = new Set();
  const sshServer = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
    connections.add(client); client.on("close", () => connections.delete(client)); client.on("error", () => {});
    client.on("authentication", (context) => context.method === "publickey" && context.username === "ops" ? context.accept() : context.reject());
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty, _reject, size) => { observed.sizes.push([size.cols, size.rows]); acceptPty(); });
      session.on("window-change", (acceptWindow, _reject, size) => { observed.sizes.push([size.cols, size.rows]); acceptWindow?.(); });
      session.on("shell", (acceptShell) => {
        observed.shells++;
        const channel = acceptShell();
        channel.write("test-pty>\r\n");
        channel.on("data", (data) => { observed.received += data.toString(); channel.write(data); });
      });
    }));
  });
  await new Promise((resolve) => sshServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const client of connections) client.end(); await new Promise((resolve) => sshServer.close(resolve)); });
  const { directory, workbench, registry } = await fixture(t);
  fs.writeFileSync(path.join(directory, "test-key"), userKey.private, { mode: 0o600 });
  registry.update("test", { port: sshServer.address().port, hostKeyFingerprints: [fingerprint] });
  await workbench.store.register("admin", PASSWORD);
  let result = await login(workbench);
  let issued = await (await request(workbench, "/api/terminal-ticket", {}, result.token)).json();
  const ws = await socket(workbench);
  const ready = message(ws, (value) => value.type === "ready");
  const prompt = message(ws, (value, binary) => binary && value.includes("test-pty>"));
  authenticate(ws, issued.ticket);
  await ready; await prompt;
  const echo = message(ws, (value, binary) => binary && value.includes("\u0003"));
  ws.send(JSON.stringify({ type: "resize", cols: 140, rows: 45 }));
  ws.send(JSON.stringify({ type: "input", data: "echo local-test\r\u0003" }));
  await echo;
  assert.equal(observed.received, "echo local-test\r\u0003");
  assert.ok(observed.sizes.some(([cols, rows]) => cols === 140 && rows === 45));
  const closed = once(ws, "close");
  await request(workbench, "/api/logout", {}, result.token); await closed;
  registry.update("test", { hostKeyFingerprints: ["SHA256:" + "A".repeat(43)] });
  result = await login(workbench);
  issued = await (await request(workbench, "/api/terminal-ticket", {}, result.token)).json();
  const bad = await socket(workbench);
  const mismatch = message(bad, (value) => value.code === "SSH_HOST_KEY_MISMATCH");
  authenticate(bad, issued.ticket);
  await mismatch;
  assert.equal(observed.shells, 1);
});
