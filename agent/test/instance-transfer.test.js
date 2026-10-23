import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { InstanceRegistry } from "../instance-registry.js";
import { MemoryStore, targetFingerprint } from "../memory-store.js";
import { InstanceTransfer, encryptTransfer, decryptTransfer, assertPortableId, MAX_TRANSFER_BYTES } from "../instance-transfer.js";
import { createManagerApp } from "../server.js";
import { loadConfig } from "../config.js";
import localAuth from "../../plugins/remote-debug-agent/local-auth.cjs";

const password = "迁移口令-test-123456";
const secret = "fixture-sandbox-password-1234";
const key = Buffer.from("fixture-only-key\r\n中文\n\0original-bytes");
function fixture(t, prefix = "配置 migration ") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const registry = new InstanceRegistry({ cwd, env: {}, registryPath: path.join(cwd, ".remote-debug", "instances.json") });
  const memoryStore = new MemoryStore({ cwd });
  return { cwd, registry, memoryStore, transfer: new InstanceTransfer({ registry, memoryStore }) };
}
async function source(t) {
  const f = fixture(t), keyPath = path.join(f.cwd, "中文 私钥"); fs.writeFileSync(keyPath, key);
  const example = JSON.parse(fs.readFileSync(new URL("../../docs/examples/test-server-be-service.json", import.meta.url)));
  const target = example.profile.target;
  f.registry.create({ id: "test-server", name: "迁移实例", host: target.host, port: target.port, username: target.username,
    privateKeyPath: keyPath, passphrase: "fixture-key-passphrase", hostKeyFingerprints: ["SHA256:" + "A".repeat(43)],
    preferredWorkerPort: 4444, auditLog: path.join(f.cwd, "old audit.jsonl"), approvedCommands: { enabled: true, executionTimeoutMs: 80000, maxExecutionTimeoutMs: 300000 },
    sourceRoots: { app: "/home/github" }, serviceProfiles: { be: example.profile }, logProjects: { backend: { root: "/home/github", directories: ["/home/github/logs"] } },
    manualMongo: { enabled: true, configPath: "/home/github/config.json", driverPath: "/home/github/node_modules/mongodb", configProfile: "test", uriKey: "url", database: "fixture", nodePath: "node", mongoshPath: "mongosh" },
    mongodb: { enabled: true, configPath: "/home/github/config.json", driverPath: "/home/github/node_modules/mongodb", configProfile: "test", database: "fixture", writeEnabled: true, mutationsEnabled: true, bulkEnabled: true,
      allowedDatabases: ["fixture"], allowedCollections: ["Fixture"], sandboxManagementPassword: secret, sandboxDatabase: "plugin_sandbox", sandboxManagementProfile: "sandbox", sandboxManagementUriKey: "url", maxAffectedDocuments: 123 } });
  const instance = f.registry.getInternal("test-server");
  await f.memoryStore.upsertNote(instance, { topic: "topology", summary: "fixture topology", facts: ["仅测试数据"] });
  return f;
}
async function listener(t, f) {
  let remoteCalls = 0;
  const workerManager = { memoryStore: f.memoryStore, publicInstances: () => f.registry.list().map(i => ({ ...i, memory: f.memoryStore.summary(i), runtime: { status: "stopped" } })),
    runtimeFor: () => ({ status: "stopped", pid: null }), callInstance: () => { remoteCalls++; throw new Error("unexpected remote call"); }, startInstance: () => { remoteCalls++; throw new Error("unexpected worker start"); } };
  const config = loadConfig({}, f.cwd); config.runtime.statePath = path.join(f.cwd, ".runtime", "state.json");
  const token = localAuth.ensureAuthToken(localAuth.resolveAuthFile(f.cwd));
  const app = createManagerApp({ cwd: f.cwd, config, registry: f.registry, workerManager, authToken: token });
  const server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { app.locals.resourceManager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body, headers = {}) => {
    const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
    return { response, data: await response.json() };
  };
  return { base, post, calls: () => remoteCalls };
}

test("encrypted transfer restores all instance settings, raw key bytes and memory in a separate directory", async t => {
  const from = await source(t), to = fixture(t);
  const bundle = await from.transfer.export("test-server", password);
  const serialized = JSON.stringify(bundle);
  for (const sensitive of [secret, "fixture-key-passphrase", "fixture-only-key", "fixture topology", from.cwd, "迁移实例"]) assert.ok(!serialized.includes(sensitive));
  const preview = await to.transfer.preview(bundle, password);
  assert.equal(preview.hasMemory, true); assert.equal(preview.hasPassphrase, true); assert.equal(preview.mongodb.hasSandboxManagementPassword, true);
  assert.ok(!JSON.stringify(preview).includes(secret));
  assert.equal(to.registry.list().length, 0); assert.equal(fs.existsSync(to.memoryStore.root), false);
  const created = await to.transfer.import(bundle, password, "copied", "Windows/macOS 副本");
  assert.equal(created.passphrase, undefined); assert.equal(created.mongodb.sandboxManagementPassword, undefined);
  const restored = new InstanceRegistry({ cwd: to.cwd, env: {}, registryPath: to.registry.registryPath }).getInternal("copied");
  const original = from.registry.getInternal("test-server");
  for (const field of ["enabled", "host", "port", "username", "hostKeyFingerprints", "passphrase", "approvedCommands", "mongodb", "manualMongo", "sourceRoots", "logProjects"]) assert.deepEqual(restored[field], original[field], field);
  assert.deepEqual(restored.serviceProfiles, { be: { ...original.serviceProfiles.be, instanceId: "copied" } });
  assert.deepEqual(fs.readFileSync(restored.privateKeyPath), key);
  assert.equal(restored.auditLog, undefined); assert.equal(restored.preferredWorkerPort, undefined);
  assert.equal(path.dirname(restored.privateKeyPath), path.join(to.memoryStore.root, "copied"));
  const memory = new MemoryStore({ cwd: to.cwd }).ensureLoaded("copied");
  assert.equal(memory.instanceId, "copied"); assert.equal(memory.targetFingerprint, targetFingerprint(restored));
  assert.equal(memory.sections.notes.topology.summary, "fixture topology");
  localAuth.protectOrCheck(path.dirname(restored.privateKeyPath), true, false);
  localAuth.protectOrCheck(restored.privateKeyPath, false, false);
  localAuth.protectOrCheck(to.memoryStore.memoryPath("copied"), false, false);
  localAuth.protectOrCheck(to.registry.registryPath, false, false);
});

test("same-ID, case-only and existing-directory collisions require a different ID and preserve existing data", async t => {
  const from = await source(t), to = fixture(t), bundle = await from.transfer.export("test-server", password);
  await to.transfer.import(bundle, password, "copy", "First");
  const before = fs.readFileSync(to.registry.registryPath);
  assert.equal((await to.transfer.preview(bundle, password)).idConflict, false);
  for (const id of ["copy", "COPY"]) await assert.rejects(to.transfer.import(bundle, password, id, "Second"), { code: "TRANSFER_ID_CONFLICT" });
  fs.mkdirSync(path.join(to.memoryStore.root, "orphan")); fs.writeFileSync(path.join(to.memoryStore.root, "orphan", "keep"), "unchanged");
  await assert.rejects(to.transfer.import(bundle, password, "ORPHAN", "Second"), { code: "TRANSFER_ID_CONFLICT" });
  assert.deepEqual(fs.readFileSync(to.registry.registryPath), before); assert.equal(fs.readFileSync(path.join(to.memoryStore.root, "orphan", "keep"), "utf8"), "unchanged");
  assert.equal((await to.transfer.preview(await to.transfer.export("copy", password), password)).idConflict, true);
});

test("portable IDs reject traversal, Windows device names and invalid characters", () => {
  for (const id of ["../outside", "/absolute", "C:\\key", "CON", "nul", "COM1", "LPT9", "with.dot", "with space", "", "a".repeat(65)]) assert.throws(() => assertPortableId(id), { code: "TRANSFER_ID_INVALID" });
  for (const id of ["copy", "Test_02", "con-server"]) assert.doesNotThrow(() => assertPortableId(id));
});

test("decryption rejects wrong password, tampering, versions and hostile KDF parameters", async t => {
  const f = await source(t), bundle = await f.transfer.export("test-server", password);
  await assert.rejects(decryptTransfer(bundle, "wrong-password-123"), { code: "TRANSFER_DECRYPT_FAILED" });
  for (const field of ["data", "tag", "iv", "salt"]) {
    const changed = structuredClone(bundle), owner = field === "data" ? changed : field === "salt" ? changed.kdf : changed.cipher;
    const bytes = Buffer.from(owner[field], "base64"); bytes[0] ^= 1; owner[field] = bytes.toString("base64");
    await assert.rejects(decryptTransfer(changed, password), { code: "TRANSFER_DECRYPT_FAILED" });
  }
  await assert.rejects(decryptTransfer({ ...bundle, version: 999 }, password), { code: "TRANSFER_VERSION_UNSUPPORTED" });
  await assert.rejects(decryptTransfer({ ...bundle, kdf: { ...bundle.kdf, N: 2 ** 28 } }, password), { code: "TRANSFER_INVALID" });
  await assert.rejects(decryptTransfer({ ...bundle, data: "invalid!" }, password), { code: "TRANSFER_INVALID" });
  await assert.rejects(encryptTransfer({}, "too-short"), { code: "TRANSFER_PASSWORD_INVALID" });
  await assert.rejects(encryptTransfer({ text: "x".repeat(MAX_TRANSFER_BYTES) }, password), { code: "TRANSFER_TOO_LARGE" });
});

test("missing memory is allowed; unreadable keys and corrupted/mismatched memory fail explicitly", async t => {
  const f = await source(t), memoryFile = f.memoryStore.memoryPath("test-server");
  fs.unlinkSync(memoryFile); assert.equal((await f.transfer.preview(await f.transfer.export("test-server", password), password)).hasMemory, false);
  fs.writeFileSync(memoryFile, "bad JSON"); await assert.rejects(f.transfer.export("test-server", password), { code: "TRANSFER_MEMORY_INVALID" });
  fs.writeFileSync(memoryFile, JSON.stringify({ version: 1, instanceId: "different", sections: {} }));
  await assert.rejects(f.transfer.export("test-server", password), { code: "TRANSFER_MEMORY_INVALID" });
  fs.unlinkSync(f.registry.getInternal("test-server").privateKeyPath);
  await assert.rejects(f.transfer.export("test-server", password), { code: "TRANSFER_SOURCE_UNREADABLE" });
});

test("malformed decrypted configuration and mismatched memory cannot create files", async t => {
  const f = await source(t), to = fixture(t), payload = await decryptTransfer(await f.transfer.export("test-server", password), password);
  const invalid = structuredClone(payload); invalid.instance.serviceProfiles.be.target.host = "different.invalid";
  await assert.rejects(to.transfer.import(await encryptTransfer(invalid, password), password, "copy", "Copy"), { code: "TRANSFER_INVALID" });
  const mismatch = structuredClone(payload); mismatch.memory.targetFingerprint = "changed";
  await assert.rejects(to.transfer.import(await encryptTransfer(mismatch, password), password, "copy", "Copy"), { code: "TRANSFER_MEMORY_INVALID" });
  const hostile = JSON.parse(JSON.stringify(payload)); hostile.instance.unknown = { path: "../../outside" };
  await assert.rejects(to.transfer.import(await encryptTransfer(hostile, password), password, "copy", "Copy"), { code: "TRANSFER_INVALID" });
  assert.equal(fs.existsSync(to.memoryStore.root), false); assert.equal(to.registry.list().length, 0);
});

test("registry save failure rolls back files and in-memory state", async t => {
  const from = await source(t), to = fixture(t), bundle = await from.transfer.export("test-server", password);
  const originalSave = to.registry.save;
  to.registry.save = () => { throw new Error("private internal failure"); };
  await assert.rejects(to.transfer.import(bundle, password, "copy", "Copy"), { code: "TRANSFER_STORAGE_UNSAFE" });
  assert.deepEqual(fs.readdirSync(to.memoryStore.root), []); assert.equal(to.registry.list().length, 0); assert.equal(to.registry.registry.defaultInstanceId, "");
  to.registry.save = originalSave;
  await to.transfer.import(bundle, password, "copy", "Copy"); assert.equal(to.registry.list().length, 1);
});

test("file write failure cleans partially written staging files", async t => {
  const from = await source(t), to = fixture(t), bundle = await from.transfer.export("test-server", password);
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (target, ...args) => {
    if (typeof target === "number") throw Object.assign(new Error("occupied fixture"), { code: "EBUSY" });
    return write(target, ...args);
  });
  await assert.rejects(to.transfer.import(bundle, password, "copy", "Copy"), { code: "TRANSFER_STORAGE_UNSAFE" });
  assert.deepEqual(fs.readdirSync(to.memoryStore.root), []); assert.equal(to.registry.list().length, 0);
});

test("ACL/permission failure happens before secret bytes are written and cleans staging", async t => {
  const from = await source(t), to = fixture(t), bundle = await from.transfer.export("test-server", password);
  const writes = []; const originalWrite = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (...args) => { writes.push(args[0]); return originalWrite(...args); });
  const unsafe = new InstanceTransfer({ registry: to.registry, memoryStore: to.memoryStore,
    protect: (file, directory, protect) => { if (!directory) throw new Error("ACL fixture failed"); localAuth.protectOrCheck(file, directory, protect); } });
  await assert.rejects(unsafe.import(bundle, password, "copy", "Copy"), { code: "TRANSFER_STORAGE_UNSAFE" });
  assert.deepEqual(writes, []); assert.deepEqual(fs.readdirSync(to.memoryStore.root), []); assert.equal(to.registry.list().length, 0);
});

test("symlink/junction destination root and symlink keys are rejected", async t => {
  const from = await source(t), to = fixture(t), bundle = await from.transfer.export("test-server", password);
  const outside = path.join(to.cwd, "outside"); fs.mkdirSync(outside); fs.mkdirSync(path.dirname(to.memoryStore.root), { recursive: true });
  fs.symlinkSync(outside, to.memoryStore.root, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(to.transfer.import(bundle, password, "copy", "Copy"), { code: "TRANSFER_STORAGE_UNSAFE" }); assert.deepEqual(fs.readdirSync(outside), []);
  if (process.platform !== "win32") {
    const original = from.registry.getInternal("test-server").privateKeyPath, linked = original + ".link"; fs.symlinkSync(original, linked);
    from.registry.update("test-server", { privateKeyPath: linked });
    await assert.rejects(from.transfer.export("test-server", password), { code: "TRANSFER_STORAGE_UNSAFE" });
  }
});

test("concurrent transfers fail boundedly rather than queueing unbounded KDF work", async t => {
  const f = await source(t);
  const first = f.transfer.export("test-server", password);
  await assert.rejects(f.transfer.export("test-server", password), { code: "TRANSFER_BUSY" });
  await first;
});

test("authenticated HTTP download/preview/import stays local, private and stopped", async t => {
  const from = await source(t), to = fixture(t), a = await listener(t, from), b = await listener(t, to);
  const denied = await a.post("/api/instances/test-server/export", { password }, { Authorization: "" }); assert.equal(denied.response.status, 401);
  const exported = await a.post("/api/instances/test-server/export", { password });
  assert.equal(exported.response.status, 200); assert.match(exported.response.headers.get("content-disposition"), /attachment.*rda-instance\.json/); assert.equal(exported.response.headers.get("cache-control"), "no-store");
  const bundle = exported.data;
  for (const route of ["/api/instances/import/preview", "/api/instances/import"]) {
    assert.equal((await b.post(route, { bundle, password, id: "copy", name: "Copy" }, { Authorization: "" })).response.status, 401);
    const wrong = await b.post(route, { bundle, password: "wrong-password-123", id: "copy", name: "Copy" });
    assert.equal(wrong.data.error.code, "TRANSFER_DECRYPT_FAILED"); assert.ok(!JSON.stringify(wrong.data).includes(secret));
  }
  assert.equal((await b.post("/api/instances/import/preview", { bundle, password })).data.preview.hasMemory, true);
  const imported = await b.post("/api/instances/import", { bundle, password, id: "copy", name: "Copy" });
  assert.equal(imported.response.status, 201); assert.equal(imported.data.runtime.status, "stopped");
  assert.ok(!JSON.stringify(imported.data).includes(secret));
  const conflict = await b.post("/api/instances/import", { bundle, password, id: "COPY", name: "Duplicate" }); assert.equal(conflict.response.status, 409);
  assert.equal(a.calls(), 0); assert.equal(b.calls(), 0);
  const invalid = await fetch(b.base + "/api/instances/import", { method: "POST", headers: { Authorization: `Bearer ${localAuth.readAuthToken(localAuth.resolveAuthFile(to.cwd))}`, "Content-Type": "application/json" }, body: "{bad" });
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, "TRANSFER_INVALID");
  const oversized = await b.post("/api/instances/import", { padding: "x".repeat(12 * 1024 * 1024) }); assert.equal(oversized.response.status, 413);
});

test("a junction/symlink in the private-storage parent cannot redirect an import", async t => {
  const from = await source(t), to = fixture(t), bundle = await from.transfer.export("test-server", password);
  const outside = path.join(to.cwd, "outside"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.dirname(to.memoryStore.root), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(to.transfer.import(bundle, password, "copy", "Copy"), { code: "TRANSFER_STORAGE_UNSAFE" });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("source Windows paths are metadata and never become destination paths", async t => {
  const from = await source(t), to = fixture(t), bundle = await from.transfer.export("test-server", password);
  const payload = await decryptTransfer(bundle, password);
  payload.instance.privateKeyPath = "C:\\Users\\中文 用户\\.ssh\\private_key";
  payload.instance.auditLog = "D:\\old computer\\audit.jsonl";
  payload.manager.workerPortRange = { start: 5000, end: 5100 };
  const portable = await encryptTransfer(payload, password);
  assert.equal((await to.transfer.preview(portable, password)).managerSettingsDiffer, true);
  await to.transfer.import(portable, password, "copy", "Copy");
  const actual = to.registry.getInternal("copy");
  assert.deepEqual(fs.readFileSync(actual.privateKeyPath), key); assert.equal(actual.auditLog, undefined);
  assert.equal(actual.mongodb.configPath, payload.instance.mongodb.configPath);
});

test("oversized private keys and unknown instances cannot be exported", async t => {
  const f = await source(t);
  fs.writeFileSync(f.registry.getInternal("test-server").privateKeyPath, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(f.transfer.export("test-server", password), { code: "TRANSFER_TOO_LARGE" });
  await assert.rejects(f.transfer.export("missing", password), { code: "INSTANCE_NOT_FOUND" });
});

test("real registry rename failure preserves the old file and removes the newly published instance directory", async t => {
  const from = await source(t), to = fixture(t), bundle = await from.transfer.export("test-server", password);
  to.registry.create({ id: "existing", name: "Existing", host: "existing.invalid", username: "fixture", privateKeyPath: "keep-existing-key" });
  const before = fs.readFileSync(to.registry.registryPath), state = structuredClone(to.registry.registry);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, destination) => {
    if (destination === to.registry.registryPath) throw Object.assign(new Error("fixture file locked"), { code: "EACCES" });
    return rename(source, destination);
  });
  await assert.rejects(to.transfer.import(bundle, password, "copy", "Copy"), { code: "TRANSFER_STORAGE_UNSAFE" });
  assert.deepEqual(fs.readFileSync(to.registry.registryPath), before);
  assert.deepEqual(to.registry.registry, state); assert.deepEqual(fs.readdirSync(to.memoryStore.root), []);
  assert.ok(!fs.readdirSync(path.dirname(to.registry.registryPath)).some(name => name.endsWith(".tmp")));
});

test("multi-megabyte ciphertext remains portable and bounded without regex stack exhaustion", async () => {
  const payload = { text: "中文 fixture ".repeat(160000) };
  const bundle = await encryptTransfer(payload, password);
  assert.deepEqual(await decryptTransfer(bundle, password), payload);
});

test("relative source key paths resolve from the worker working directory", async t => {
  const from = await source(t), to = fixture(t);
  const original = from.registry.getInternal("test-server").privateKeyPath;
  from.registry.update("test-server", { privateKeyPath: path.relative(from.cwd, original) });
  await to.transfer.import(await from.transfer.export("test-server", password), password, "copy", "Copy");
  assert.deepEqual(fs.readFileSync(to.registry.getInternal("copy").privateKeyPath), key);
});
