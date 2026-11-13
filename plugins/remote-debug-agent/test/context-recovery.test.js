import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { selectContext, validateContext } from "../business-context.js";
import { attachWindowsContext } from "../windows-business-context.js";
import { createBusinessStorage } from "../business-storage.js";
import windowsPrivacy from "../windows-privacy.cjs";
import { localMcp } from "./helpers/local-mcp.js";

const origin = "http://127.0.0.1:4567";
const auth = () => ({ contextId: randomUUID(), capability: randomBytes(32).toString("hex") });
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rda-context-recovery-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, agentUrl: origin, env: {} };
}

test("no selection fails before storage/network; inherited host IDs and cwd do not select a context", async (t) => {
  const settings = fixture(t);
  settings.env = { CODEX_THREAD_ID: randomUUID(), CODEX_SESSION_ID: randomUUID() };
  assert.throws(() => selectContext(settings), { code: "BUSINESS_CONTEXT_SELECTION_REQUIRED" });
  const storage = createBusinessStorage({ privacy: {}, guard: {}, fetchJson: () => assert.fail("no RPC") });
  await assert.rejects(storage.prepare(settings, {}, "scope"), { code: "BUSINESS_CONTEXT_SELECTION_REQUIRED" });
  assert.deepEqual(fs.readdirSync(settings.dataDir), []);
});

test("file selection keeps precedence, ID selection is exact and existing-only; validation rejects origin/version/auth corruption", (t) => {
  const settings = fixture(t), id = randomUUID();
  settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_ID = id;
  assert.equal(selectContext(settings).filename, path.join(settings.dataDir, ".private", "contexts", id + ".json"));
  assert.equal(selectContext(settings).existingOnly, true);
  settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_ID = "../other";
  assert.throws(() => selectContext(settings), { code: "BUSINESS_CONTEXT_DENIED" });
  settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_FILE = path.join(settings.dataDir, "chosen.json");
  assert.equal(selectContext(settings).existingOnly, false);
  for (const value of ["{", JSON.stringify({ version: 2, origin, auth: auth() }), JSON.stringify({ version: 1, origin: "http://other", auth: auth() }), JSON.stringify({ version: 1, origin, auth: {} })]) {
    assert.throws(() => validateContext(value, origin), { code: "BUSINESS_CONTEXT_DENIED" });
  }
});

test("Windows exact recovery rejects missing, corrupt, wrong-origin, mismatched ID and unsafe ACL without creating replacements", { skip: process.platform !== "win32" }, async (t) => {
  const settings = fixture(t), id = randomUUID();
  settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_ID = id;
  const filename = selectContext(settings).filename;
  const noCreate = () => assert.fail("must not create Manager context");
  await assert.rejects(attachWindowsContext(settings, origin, noCreate), { code: "BUSINESS_CONTEXT_MISSING" });
  for (const content of ["{", JSON.stringify({ version: 1, origin: "http://other", auth: auth() }), JSON.stringify({ version: 1, origin, auth: auth() })]) {
    windowsPrivacy.createContext(filename, content);
    await assert.rejects(attachWindowsContext(settings, origin, noCreate), { code: "BUSINESS_CONTEXT_DENIED" });
    assert.equal(windowsPrivacy.readContext(filename), content);
    fs.unlinkSync(filename);
  }
  windowsPrivacy.createContext(filename, JSON.stringify({ version: 1, origin, auth: { ...auth(), contextId: id } }));
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", '$f=New-Object IO.FileInfo($env:RDA_TEST_FILE);$a=$f.GetAccessControl();$s=New-Object Security.Principal.SecurityIdentifier("S-1-1-0");$r=New-Object Security.AccessControl.FileSystemAccessRule($s,"Read","Allow");$a.AddAccessRule($r);$f.SetAccessControl($a)'], { env: { ...process.env, RDA_TEST_FILE: filename }, windowsHide: true, stdio: "ignore" });
  assert.equal((await once(child, "exit"))[0], 0);
  await assert.rejects(attachWindowsContext(settings, origin, noCreate), { code: "BUSINESS_CONTEXT_DENIED" });
});

test("Windows concurrent fresh processes converge on one protected file; separate selected files stay isolated", { skip: process.platform !== "win32" }, async (t) => {
  const settings = fixture(t);
  settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_FILE = path.join(settings.dataDir, "session-a.json");
  const moduleUrl = new URL("../windows-business-context.js", import.meta.url).href;
  const code = `import {attachWindowsContext} from ${JSON.stringify(moduleUrl)}; import {randomUUID,randomBytes} from 'node:crypto'; const a=await attachWindowsContext(JSON.parse(process.argv[1]),process.argv[2],async()=>({contextId:randomUUID(),capability:randomBytes(32).toString('hex')})); console.log(a.contextId);`;
  const run = async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(settings), origin], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", (chunk) => { out += chunk; });
    const [status] = await once(child, "exit"); assert.equal(status, 0); return out.trim();
  };
  const ids = await Promise.all([run(), run(), run()]);
  assert.equal(new Set(ids).size, 1);
  assert.equal(await run(), ids[0]);
  settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_FILE = path.join(settings.dataDir, "session-b.json");
  assert.notEqual(await run(), ids[0]);
});

test("attached process rejects selection/origin changes including a concurrent change", async (t) => {
  const settings = fixture(t);
  settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_FILE = path.join(settings.dataDir, "session-a.json");
  const storage = createBusinessStorage({ privacy: { attach() {} }, guard: { remember() {} }, fetchJson: async (_s, _p, options) => ({ response: { ok: true }, parsed: { ok: true, result: JSON.parse(options.body).action === "create" ? auth() : {} } }) });
  const first = storage.prepare(settings, {}, "scope");
  const changed = { ...settings, env: { REMOTE_DEBUG_PRIVACY_CONTEXT_FILE: path.join(settings.dataDir, "session-b.json") } };
  await assert.rejects(storage.prepare(changed, {}, "scope"), { code: "BUSINESS_CONTEXT_CHANGED" });
  await first;
  await assert.rejects(storage.prepare({ ...settings, agentUrl: "http://127.0.0.1:4568" }, {}, "scope"), { code: "BUSINESS_CONTEXT_CHANGED" });
});

test("Manager rejection of an existing capability never creates a replacement or attaches privacy state", async (t) => {
  const settings = fixture(t);
  settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_FILE = path.join(settings.dataDir, "existing.json");
  let rejectAttach = false, creates = 0;
  const fetchJson = async (_s, _p, options) => {
    const input = JSON.parse(options.body);
    if (input.action === "create") { creates++; return { response: { ok: true }, parsed: { ok: true, result: auth() } }; }
    return { response: { ok: !rejectAttach }, parsed: rejectAttach ? { ok: false, error: { code: "BUSINESS_CONTEXT_DENIED" } } : { ok: true, result: {} } };
  };
  const first = createBusinessStorage({ privacy: { attach() {} }, guard: { remember() {} }, fetchJson });
  await first.prepare(settings, {}, "scope");
  rejectAttach = true;
  const restored = createBusinessStorage({ privacy: { attach() { assert.fail("rejected capability"); } }, guard: { remember() {} }, fetchJson });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(restored.prepare(settings, {}, "scope"), { code: "BUSINESS_CONTEXT_DENIED" });
  assert.equal(creates, 1);
});

test("real MCP restart with exact legacy ID restores references and original intent; another selection cannot read them", { timeout: 60000 }, async (t) => {
  const instance = { id: "isolated", host: "fixture.invalid", mongodb: { database: "business", configProfile: "fixture" } };
  const f = await localMcp(t, { instance, handler: async (route, input) => route === "/mongodb/query"
    ? { data: [{ _id: "SYNTHETIC_ORDER" }], resultCount: 1 }
    : { database: input.database, mutationId: input._businessPrepare.mutationId, planHash: "a".repeat(64), affectedIds: ["SYNTHETIC_ORDER"], affectedCount: 1 } });
  const query = { operation: "find", collection: "orders" };
  const row = (await f.call("remote_debug_mongodb_query", query)).payload.data[0];
  const plan = await f.call("remote_debug_mongodb_prepare_write", { operation: "updateOne", collection: "orders", filter: { _id: row._id }, update: { $set: { enabled: true } } });
  const intentId = plan.payload.intentId;
  assert.ok(intentId);
  // Only synthetic fixture credentials are read, never emitted or copied.
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, "context.json"), "utf8"));
  fs.renameSync(path.join(f.root, "context.json"), path.join(f.root, ".private", "contexts", saved.auth.contextId + ".json"));
  await f.restart({ contextFile: "", contextId: saved.auth.contextId });
  const before = f.requests.length;
  const recovered = await f.call("remote_debug_mongodb_recover_operation", { instanceId: instance.id, database: "business", intentId });
  assert.equal(recovered.payload.state, "prepared");
  assert.equal(f.requests.length, before, "inspect never replays a write");
  const again = await f.call("remote_debug_mongodb_query", { ...query, filter: { _id: row._id } });
  assert.equal(again.payload.data[0]._id, row._id);
  assert.equal(f.requests.at(-1).input.filter._id, "SYNTHETIC_ORDER");
  await f.restart({ contextFile: path.join(f.root, "other.json"), contextId: "" });
  const invalid = await f.call("remote_debug_mongodb_query", { ...query, filter: { _id: row._id } });
  assert.equal(invalid.payload.error.code, "BUSINESS_REFERENCE_INVALID");
  const denied = await f.call("remote_debug_mongodb_recover_operation", { instanceId: instance.id, database: "business", intentId });
  assert.equal(denied.payload.error.code, "BUSINESS_OPERATION_DENIED");
  const requestCount = f.requests.length;
  await f.restart({ contextFile: "", contextId: "" });
  const unselected = await f.call("remote_debug_mongodb_query", query);
  assert.equal(unselected.payload.error.code, "BUSINESS_CONTEXT_SELECTION_REQUIRED");
  assert.match(unselected.payload.error.message, /REMOTE_DEBUG_PRIVACY_CONTEXT_FILE/);
  await f.restart({ contextId: randomUUID() });
  const missing = await f.call("remote_debug_mongodb_query", query);
  assert.equal(missing.payload.error.code, "BUSINESS_CONTEXT_MISSING");
  assert.equal(f.requests.length, requestCount);
});
