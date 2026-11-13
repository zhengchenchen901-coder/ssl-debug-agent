import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createPosixContextAdapter, attachPosixContext } from "../posix-business-context.js";

const origin = "http://127.0.0.1:4567";
const makeAuth = () => ({ contextId: randomUUID(), capability: randomBytes(32).toString("hex") });
const noCreate = () => assert.fail("must reuse original context");

// POSIX filesystem model, including macOS system aliases. No Windows chmod/uid
// emulation and no real credentials are used by these platform-independent tests.
function fixture() {
  const entries = new Map(), descriptors = new Map(); let ino = 0, fd = 10;
  const canonical = (p) => p.replace(/^\/(var|tmp)(\/|$)/, "/private/$1$2");
  const put = (p, kind = "directory", extra = {}) => entries.set(p, { kind, uid: 501, mode: kind === "directory" ? 0o700 : 0o600, ino: ++ino, dev: 1, content: "", ...extra });
  for (const p of ["/", "/private", "/private/var", "/private/tmp", "/private/var/rda"]) put(p);
  put("/var", "symlink", { target: "/private/var" }); put("/tmp", "symlink", { target: "/private/tmp" });
  const error = (code) => Object.assign(new Error("synthetic filesystem failure"), { code });
  const entry = (p) => { const e = entries.get(canonical(p)); if (!e) throw error("ENOENT"); return e; };
  const stat = (e) => ({ ...e, size: Buffer.byteLength(e.content), isFile: () => e.kind === "file", isDirectory: () => e.kind === "directory", isSymbolicLink: () => e.kind === "symlink" });
  const filesystem = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 131072 },
    existsSync: (p) => entries.has(canonical(p)),
    lstatSync: (p) => stat(entries.get(p)?.kind === "symlink" ? entries.get(p) : entry(p)),
    realpathSync: (p) => entries.get(p)?.target || canonical(p),
    mkdirSync(p) { if (this.existsSync(p)) return; this.mkdirSync(path.posix.dirname(p)); put(canonical(p)); },
    openSync(p, flags, mode) {
      if (flags === "wx") { if (this.existsSync(p)) throw error("EEXIST"); put(canonical(p), "file", { mode }); }
      const e = entry(p); if (e.kind === "symlink") throw error("ELOOP");
      descriptors.set(++fd, e); return fd;
    },
    closeSync: (fd) => descriptors.delete(fd),
    fstatSync: (fd) => stat(descriptors.get(fd)),
    readFileSync: (fd) => descriptors.get(fd).content,
    writeFileSync(fd, content) { descriptors.get(fd).content = content; },
    fsyncSync() {},
    linkSync(from, to) { if (this.existsSync(to)) throw error("EEXIST"); entries.set(canonical(to), entry(from)); },
    unlinkSync(p) { if (!entries.delete(canonical(p))) throw error("ENOENT"); },
  };
  const settings = { dataDir: "/var/rda", env: { REMOTE_DEBUG_PRIVACY_CONTEXT_FILE: "/var/rda/task.json" } };
  const adapter = () => createPosixContextAdapter({ filesystem, paths: path.posix, platform: "darwin", getuid: () => 501 });
  return { filesystem, entries, entry, put, settings, adapter };
}

test("macOS model: first create is private and restart/file or exact ID restores original identity", async () => {
  const f = fixture(), auth = makeAuth();
  assert.deepEqual(await f.adapter()(f.settings, origin, async () => auth), auth);
  assert.equal(f.entry("/var/rda/task.json").mode, 0o600);
  assert.equal(f.entry("/var/rda/.private/contexts").mode, 0o700);
  assert.deepEqual(await f.adapter()(f.settings, origin, noCreate), auth);
  f.entries.set(`/private/var/rda/.private/contexts/${auth.contextId}.json`, f.entry("/var/rda/task.json"));
  f.settings.env = { REMOTE_DEBUG_PRIVACY_CONTEXT_ID: auth.contextId };
  assert.deepEqual(await f.adapter()(f.settings, origin, noCreate), auth);
});

test("macOS model: concurrent creators see only complete files and different tasks remain isolated", async () => {
  const f = fixture();
  const values = await Promise.all(Array.from({ length: 8 }, () => f.adapter()(f.settings, origin, async () => makeAuth())));
  assert.equal(new Set(values.map((a) => a.contextId)).size, 1);
  assert.equal([...f.entries.keys()].some((p) => p.endsWith(".tmp")), false);
  f.settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_FILE = "/var/rda/other.json";
  assert.notEqual((await f.adapter()(f.settings, origin, async () => makeAuth())).contextId, values[0].contextId);
});

test("macOS model: standard /tmp alias works and file reads use O_NOFOLLOW", async (t) => {
  const f = fixture();
  f.put("/private/tmp/rda");
  f.settings = { dataDir: "/tmp/rda", env: { REMOTE_DEBUG_PRIVACY_CONTEXT_FILE: "/tmp/rda/task.json" } };
  const open = f.filesystem.openSync;
  let protectedReads = 0;
  t.mock.method(f.filesystem, "openSync", function (p, flags, mode) {
    if (typeof flags === "number") { assert.ok(flags & f.filesystem.constants.O_NOFOLLOW); protectedReads++; }
    return open.call(this, p, flags, mode);
  });
  const auth = await f.adapter()(f.settings, origin, async () => makeAuth());
  assert.deepEqual(await f.adapter()(f.settings, origin, noCreate), auth);
  assert.equal(protectedReads, 2);
});

test("macOS model: missing ID, corrupt data, origin/ID mismatch and unsafe owner/mode fail without replacement", async () => {
  const f = fixture(), auth = makeAuth();
  f.settings.env = { REMOTE_DEBUG_PRIVACY_CONTEXT_ID: auth.contextId };
  await assert.rejects(f.adapter()(f.settings, origin, noCreate), { code: "BUSINESS_CONTEXT_MISSING" });
  const filename = `/private/var/rda/.private/contexts/${auth.contextId}.json`;
  for (const content of ["{", JSON.stringify({ version: 1, origin: "http://other", auth }), JSON.stringify({ version: 1, origin, auth: makeAuth() })]) {
    f.put(filename, "file", { content });
    await assert.rejects(f.adapter()(f.settings, origin, noCreate), { code: "BUSINESS_CONTEXT_DENIED" });
    assert.equal(f.entry(filename).content, content);
  }
  for (const unsafe of [{ mode: 0o644 }, { uid: 502 }]) {
    f.put(filename, "file", { content: JSON.stringify({ version: 1, origin, auth }), ...unsafe });
    await assert.rejects(f.adapter()(f.settings, origin, noCreate), { code: "BUSINESS_CONTEXT_DENIED" });
  }
});

test("macOS model: reject custom aliases, forged system aliases, replaced files and unsafe context directory", async (t) => {
  const f = fixture();
  f.put("/private/var/rda/.private", "symlink", { target: "/elsewhere" });
  await assert.rejects(f.adapter()(f.settings, origin, noCreate), { code: "BUSINESS_CONTEXT_DENIED" });
  f.entries.delete("/private/var/rda/.private");
  f.entries.get("/var").target = "/elsewhere";
  await assert.rejects(f.adapter()(f.settings, origin, noCreate), { code: "BUSINESS_CONTEXT_DENIED" });
  f.entries.get("/var").target = "/private/var";
  await f.adapter()(f.settings, origin, async () => makeAuth());
  const old = f.filesystem.fstatSync;
  const mock = t.mock.method(f.filesystem, "fstatSync", (fd) => ({ ...old(fd), ino: 999 }));
  await assert.rejects(f.adapter()(f.settings, origin, noCreate), { code: "BUSINESS_CONTEXT_DENIED" });
  mock.mock.restore();
  f.entry("/var/rda/.private/contexts").mode = 0o755;
  await assert.rejects(f.adapter()(f.settings, origin, noCreate), { code: "BUSINESS_CONTEXT_DENIED" });
});

test("macOS model: filesystem access/flush failures are actionable and do not overwrite the original", async (t) => {
  for (const method of ["openSync", "fsyncSync"]) {
    const f = fixture();
    t.mock.method(f.filesystem, method, () => { throw Object.assign(new Error("PRIVATE_NATIVE_DETAIL"), { code: "EACCES" }); });
    await assert.rejects(f.adapter()(f.settings, origin, async () => makeAuth()), (error) => error.code === "BUSINESS_CONTEXT_DENIED" && !error.message.includes("PRIVATE_NATIVE_DETAIL"));
    assert.equal([...f.entries.keys()].some((p) => p.endsWith(".tmp")), false);
  }
});

test("native POSIX: real processes recover one 0600 context concurrently with isolated identities", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rda-posix-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = { dataDir: root, env: { REMOTE_DEBUG_PRIVACY_CONTEXT_FILE: path.join(root, "task.json") } };
  const url = new URL("../posix-business-context.js", import.meta.url).href;
  const code = `import {attachPosixContext} from ${JSON.stringify(url)};import {randomUUID,randomBytes} from 'node:crypto';const auth=await attachPosixContext(JSON.parse(process.argv[1]),process.argv[2],async()=>({contextId:randomUUID(),capability:randomBytes(32).toString('hex')}));console.log(auth.contextId);`;
  const run = async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(settings), origin], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { err += b; });
    assert.equal((await once(child, "exit"))[0], 0, err); return out.trim();
  };
  const ids = await Promise.all([run(), run(), run()]);
  assert.equal(new Set(ids).size, 1); assert.equal(await run(), ids[0]);
  assert.equal(fs.statSync(settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_FILE).mode & 0o777, 0o600);
  const original = settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_FILE;
  fs.renameSync(original, path.join(root, ".private/contexts", ids[0] + ".json"));
  settings.env = { REMOTE_DEBUG_PRIVACY_CONTEXT_ID: ids[0] };
  assert.equal(await run(), ids[0]);
  settings.env = { REMOTE_DEBUG_PRIVACY_CONTEXT_FILE: path.join(root, "other.json") };
  assert.notEqual(await run(), ids[0]);
  fs.chmodSync(settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_FILE, 0o644);
  await assert.rejects(attachPosixContext(settings, origin, noCreate), { code: "BUSINESS_CONTEXT_DENIED" });
});
