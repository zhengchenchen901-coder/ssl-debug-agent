import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { loadPrivacyKey } from "../privacy-key.js";
import { PrivacyStore } from "../privacy-store.js";
import windowsPrivacy from "../../plugins/remote-debug-agent/windows-privacy.cjs";
import { attachWindowsContext } from "../../plugins/remote-debug-agent/windows-business-context.js";
import { fixtureArgs, powershell, nativeFixture, windowsFixture } from "./helpers/windows-privacy-fixture.js";

const windows = { skip: process.platform !== "win32", timeout: 120000 };
const digest = (key) => createHash("sha256").update(key).digest("hex");
test("Windows native helper rejects tampering before launching PowerShell", windows, (t) => {
  const directory = windowsFixture(t), adapter = path.join(directory, "adapter");
  fs.mkdirSync(path.join(adapter, "native"), { recursive: true });
  const plugin = path.resolve(import.meta.dirname, "../../plugins/remote-debug-agent");
  fs.copyFileSync(path.join(plugin, "windows-privacy.cjs"), path.join(adapter, "windows-privacy.cjs"));
  fs.copyFileSync(path.join(plugin, "runtime/agent/runtime-manifest.json"), path.join(adapter, "runtime-manifest.json"));
  fs.writeFileSync(path.join(adapter, "native/windows-privacy.ps1"), fs.readFileSync(path.join(plugin, "native/windows-privacy.ps1"), "utf8") + "\n# synthetic tampering\n");
  const isolated = createRequire(import.meta.url)(path.join(adapter, "windows-privacy.cjs"));
  assert.throws(() => isolated.loadKey(directory, { run: () => assert.fail("Tampered native helper must not run") }), { code: "BUSINESS_STORAGE_INTEGRITY_INVALID" });
});
function childKey(directory) {
  const child = fork(path.join(import.meta.dirname, "helpers/windows-privacy-child.mjs"), { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const done = once(child, "message"); child.send({ directory }); return done.then(([value]) => value);
}
test("Windows native credentials: first creation, reopen and six concurrent processes share one key", windows, async (t) => {
  const directory = windowsFixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => childKey(directory)));
  assert.ok(results.every((result) => result.ok), "native creators must all succeed");
  assert.equal(new Set(results.map((result) => result.digest)).size, 1);
  const key = loadPrivacyKey(directory); assert.equal(key.length, 32);
  assert.equal(digest(key), results[0].digest); key.fill(0);
  const store = new PrivacyStore({ directory }); const auth = store.execute("create");
  store.execute("commit", { auth, scope: "native-test", records: [{ ref: "rda_ref_v1_" + "e".repeat(48), scope: "native-test", value: "SYNTHETIC_WINDOWS_PRIVATE_VALUE" }] }); store.close();
  const reopened = new PrivacyStore({ directory }); assert.equal(reopened.execute("attach", { auth }).contextId, auth.contextId); reopened.close();
  const savedKey = loadPrivacyKey(directory);
  try { for (const name of fs.readdirSync(directory)) {
    const bytes = fs.readFileSync(path.join(directory, name));
    for (const secret of [savedKey, Buffer.from(savedKey.toString("hex")), Buffer.from(savedKey.toString("base64")), Buffer.from("SYNTHETIC_WINDOWS_PRIVATE_VALUE")]) assert.ok(!bytes.includes(secret), "No key or raw business value in storage files");
  } } finally { savedKey.fill(0); }
});
test("Windows initialization lock is released after process death and blocks competing creators", windows, async (t) => {
  const directory = windowsFixture(t);
  const holder = spawn(powershell, fixtureArgs, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const ready = once(holder.stdout, "data");
  holder.stdin.end(JSON.stringify({ action: "hold", directory, target: windowsPrivacy.targetFor(directory) }));
  await ready;
  // A competing initializer has a finite deadline and cannot replace a key.
  const blocked = await childKey(directory); assert.equal(blocked.code, "BUSINESS_KEYSTORE_BUSY");
  const pending = childKey(directory); const exit = once(holder, "exit"); holder.kill("SIGKILL"); await exit;
  assert.equal((await pending).ok, true);
  const key = loadPrivacyKey(directory); assert.equal(key.length, 32); key.fill(0);
});
test("Windows existing SQLite, WAL or SHM without credential never creates a replacement", windows, (t) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const directory = windowsFixture(t);
    fs.writeFileSync(path.join(directory, "privacy.sqlite" + suffix), "synthetic-existing-data");
    assert.throws(() => loadPrivacyKey(directory), { code: "BUSINESS_KEYSTORE_MISSING" });
    assert.equal(nativeFixture("exists", directory), false);
    assert.equal(fs.readFileSync(path.join(directory, "privacy.sqlite" + suffix), "utf8"), "synthetic-existing-data");
  }
});
test("Windows malformed or denied credential never falls back or overwrites", windows, (t) => {
  const directory = windowsFixture(t); nativeFixture("corrupt", directory);
  assert.throws(() => loadPrivacyKey(directory), { code: "BUSINESS_KEYSTORE_UNAVAILABLE" });
  assert.throws(() => loadPrivacyKey(directory), { code: "BUSINESS_KEYSTORE_UNAVAILABLE" });
  assert.throws(() => loadPrivacyKey(directory, { run: () => { throw new Error("access denied"); } }), { code: "BUSINESS_KEYSTORE_UNAVAILABLE" });
});
test("Windows rejects unsafe ACLs, hardlinks, junctions, network, synchronization and plugin cache paths", windows, (t) => {
  const directory = windowsFixture(t);
  const db = path.join(directory, "privacy.sqlite"); fs.writeFileSync(db, "synthetic");
  fs.linkSync(db, path.join(directory, "hardlink"));
  assert.throws(() => windowsPrivacy.prepareStore(directory), { code: "BUSINESS_STORAGE_PATH_INVALID" }); fs.unlinkSync(path.join(directory, "hardlink"));
  nativeFixture("broaden", directory, { filename: db });
  assert.throws(() => windowsPrivacy.prepareStore(directory), { code: "BUSINESS_STORAGE_PATH_INVALID" });
  const link = path.join(directory, "junction"); fs.symlinkSync(directory, link, "junction");
  assert.throws(() => windowsPrivacy.prepareStore(path.join(link, "nested")), { code: "BUSINESS_STORAGE_PATH_INVALID" }); fs.unlinkSync(link);
  for (const invalid of ["\\\\localhost\\c$\\private", path.join(directory, "OneDrive", "data"), path.join(directory, "plugins", "cache", "data")]) {
    assert.throws(() => windowsPrivacy.prepareStore(invalid), { code: "BUSINESS_STORAGE_PATH_INVALID" });
  }
});
test("Windows context CreateNew concurrency, durable reuse, source mismatch, corruption and ACL protection", windows, async (t) => {
  const directory = windowsFixture(t), filename = path.join(directory, "context.json");
  const settings = { dataDir: directory, env: { REMOTE_DEBUG_PRIVACY_CONTEXT_FILE: filename } }, origin = "http://127.0.0.1:12345";
  const auth = { contextId: "12345678-1234-1234-1234-123456789abc", capability: "a".repeat(64) };
  const other = { ...auth, capability: "b".repeat(64) };
  const results = await Promise.all([attachWindowsContext(settings, origin, async () => auth), attachWindowsContext(settings, origin, async () => other)]);
  assert.ok(results[0].capability === results[1].capability);
  const restored = await attachWindowsContext(settings, origin, () => { throw new Error("Must reuse saved context"); });
  assert.ok(restored.capability === results[0].capability);
  await assert.rejects(() => attachWindowsContext(settings, "http://127.0.0.1:54321", async () => auth), { code: "BUSINESS_CONTEXT_DENIED" });
  fs.writeFileSync(filename, "incomplete");
  await assert.rejects(() => attachWindowsContext(settings, origin, async () => auth), { code: "BUSINESS_CONTEXT_DENIED" });
  fs.writeFileSync(filename, JSON.stringify({ version: 1, origin, auth })); nativeFixture("broaden", directory, { filename });
  await assert.rejects(() => attachWindowsContext(settings, origin, async () => auth), { code: "BUSINESS_CONTEXT_DENIED" });
});
