import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { PrivacyStore } from "../privacy-store.js";
import { PrivacyService, privacyRequest } from "../privacy-service.js";
import { loadPrivacyKey } from "../privacy-key.js";
import { businessTargetScope } from "../../plugins/remote-debug-agent/business-privacy.js";
import windowsPrivacy from "../../plugins/remote-debug-agent/windows-privacy.cjs";

const DAY = 86400000, alias = () => "rda_ref_v1_" + randomBytes(24).toString("hex");
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rda-encrypted-store-")), key = randomBytes(32);
  let time = Date.now(), store = new PrivacyStore({ directory, key, now: () => time, ...options });
  const auth = store.execute("create"), scope = "PRIVATE_SCOPE_DATABASE";
  const call = (action, input = {}) => store.execute(action, { auth, scope, ...input });
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, key, auth, scope, call, get store() { return store; }, advance: (ms) => { time += ms; },
    beforeCleanup: (fn) => cleanups.push(fn),
    reopen: (extra = {}) => { store.close(); store = new PrivacyStore({ directory, key, now: () => time, ...extra }); return store; },
    commit: (value, extra = {}) => { const ref = alias(); const result = call("commit", { records: [{ ref, scope, value }], ...extra }); return result.aliases[ref]; } };
}

test("encrypted persistence restores every BSON/EJSON width and preserves compound field order after reopen", (t) => {
  const f = fixture(t);
  const values = ["PRIVATE_USER_001", 17, true, { $oid: "507f1f77bcf86cd799439011" }, { $numberLong: "9007199254740993" },
    { $numberInt: "23" }, { $numberDouble: "NaN" }, { $numberDecimal: "123.000" }, { $date: { $numberLong: "1700000000000" } },
    { $binary: { base64: "AP9B", subType: "80" } }, { $timestamp: { t: 5, i: 1 } }, { $regularExpression: { pattern: "private", options: "i" } },
    { $minKey: 1 }, { $maxKey: 1 }, { tenant: "PRIVATE_TENANT", seq: 2 }, { seq: 2, tenant: "PRIVATE_TENANT" }];
  const refs = values.map((value) => f.commit(value));
  assert.notEqual(refs.at(-1), refs.at(-2)); f.reopen();
  const result = f.call("resolve", { refs });
  assert.deepEqual(result.records.map((r) => r.value), values);
  assert.deepEqual(result.records.map((r) => JSON.stringify(r.value)), values.map(JSON.stringify));
  assert.equal(f.store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(f.store.db.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 1);
  for (const filename of fs.readdirSync(f.directory)) {
    const bytes = fs.readFileSync(path.join(f.directory, filename));
    for (const raw of ["PRIVATE_USER_001", "PRIVATE_SCOPE_DATABASE", "PRIVATE_TENANT", "9007199254740993", f.key.toString("hex")]) assert.equal(bytes.includes(Buffer.from(raw)), false, filename);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(f.directory, filename)).mode & 0o077, 0);
  }
  if (process.platform === "win32") windowsPrivacy.protectStoreFiles(f.directory);
});

test("context capability, target database and AAD stop cross-scope resolution and record swapping", (t) => {
  const f = fixture(t), ref = f.commit("PRIVATE_VALUE");
  assert.throws(() => f.call("resolve", { refs: [ref], scope: "other" }), { code: "BUSINESS_REFERENCE_INVALID" });
  const other = f.store.execute("create");
  assert.throws(() => f.call("resolve", { refs: [ref], auth: other }), { code: "BUSINESS_REFERENCE_INVALID" });
  assert.throws(() => f.call("resolve", { refs: [ref], auth: { ...f.auth, capability: randomBytes(32).toString("hex") } }), { code: "BUSINESS_CONTEXT_DENIED" });
  const another = f.commit("PRIVATE_OTHER");
  const envelope = f.store.db.prepare("SELECT envelope FROM records WHERE id=?").get(another).envelope;
  f.store.db.prepare("UPDATE records SET envelope=? WHERE id=?").run(envelope, ref);
  assert.throws(() => f.call("resolve", { refs: [ref] }), { code: "BUSINESS_STORAGE_CORRUPT" });
});

test("tampered ciphertext, wrong key and missing OS credential fail without exporting data", (t) => {
  const f = fixture(t), ref = f.commit("PRIVATE_CORRUPTION_VALUE");
  assert.throws(() => f.reopen({ key: randomBytes(32) }), { code: "BUSINESS_STORAGE_CORRUPT" });
  f.reopen();
  const row = f.store.db.prepare("SELECT envelope FROM records WHERE id=?").get(ref), e = JSON.parse(row.envelope);
  const bytes = Buffer.from(e.c, "base64"); bytes[0] ^= 1; e.c = bytes.toString("base64");
  f.store.db.prepare("UPDATE records SET envelope=? WHERE id=?").run(JSON.stringify(e), ref);
  assert.throws(() => f.call("resolve", { refs: [ref] }), { code: "BUSINESS_STORAGE_CORRUPT" });
  assert.throws(() => loadPrivacyKey(f.directory, { platform: "linux" }), { code: "BUSINESS_KEYSTORE_UNSUPPORTED" });
  let calls = 0;
  assert.throws(() => loadPrivacyKey(f.directory, { platform: "darwin", existing: true, run: () => { calls++; throw Object.assign(new Error("PRIVATE_SYSTEM_ERROR"), { status: 44 }); } }), { code: "BUSINESS_KEYSTORE_UNAVAILABLE" });
  assert.equal(calls, 1, "Never replace the key when a database already exists");
});

test("reverse-index tampering cannot redirect an alias to a different valid ciphertext", (t) => {
  const f = fixture(t), first = f.commit("PRIVATE_FIRST"), second = f.commit("PRIVATE_SECOND");
  const lookup = f.store.db.prepare("SELECT lookup FROM records WHERE id=?").get(first).lookup;
  f.store.db.prepare("UPDATE records SET lookup=? WHERE id=?").run("temporary-index-tamper", first);
  f.store.db.prepare("UPDATE records SET lookup=? WHERE id=?").run(lookup, second);
  assert.throws(() => f.commit("PRIVATE_FIRST"), { code: "BUSINESS_STORAGE_CORRUPT" });
  assert.throws(() => f.call("resolve", { refs: [second] }), { code: "BUSINESS_STORAGE_CORRUPT" });
});

test("concurrent MCP clients get one committed reference through the unique HMAC index", async (t) => {
  const f = fixture(t); f.store.close();
  const service = new PrivacyService({ directory: f.directory, key: f.key, maxQueue: 64 });
  t.after(() => service.close());
  const results = await Promise.all(Array.from({ length: 24 }, () => service.call("commit", { auth: f.auth, scope: f.scope,
    records: [{ ref: alias(), scope: f.scope, value: { z: "PRIVATE_SAME", a: 1 } }] })));
  assert.equal(new Set(results.flatMap((r) => Object.values(r.aliases))).size, 1);
  await service.close(); f.reopen();
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='mapping'").get().n, 1);
});

test("mapping commit is atomic across both crash boundaries and emits no uncommitted aliases", (t) => {
  const f = fixture(t), before = alias(), after = alias();
  f.reopen({ fault: (point) => { if (point === "beforeCommit") throw new Error("simulated crash"); } });
  assert.throws(() => f.call("commit", { records: [{ ref: before, scope: f.scope, value: "PRIVATE_BEFORE" }], tasks: [{ id: "job-1" }] }));
  f.reopen(); assert.throws(() => f.call("resolve", { refs: [before] }), { code: "BUSINESS_REFERENCE_INVALID" });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='task'").get().n, 0);
  f.reopen({ fault: (point) => { if (point === "afterCommit") throw new Error("simulated lost response"); } });
  assert.throws(() => f.call("commit", { records: [{ ref: after, scope: f.scope, value: "PRIVATE_AFTER" }], tasks: [{ id: "job-1" }] }));
  f.reopen(); assert.equal(f.call("resolve", { refs: [after] }).records[0].value, "PRIVATE_AFTER");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM links").get().n, 1);
});

test("intent-before-dispatch survives restart; uncertain writes stay pinned and are never replayable", (t) => {
  const f = fixture(t), request = { mutationId: "m-1", planHash: "a".repeat(64), confirmation: "确认执行" };
  const first = f.call("intent", { route: "/mongodb/mutations/execute", request });
  assert.equal(first.state, "new"); f.reopen();
  const retry = f.call("intent", { route: "/mongodb/mutations/execute", request });
  assert.equal(retry.id, first.id); assert.equal(retry.state, "uncertain");
  f.call("reconcile", { id: first.id, result: { remoteStatus: "committed", lease: "expired" } });
  assert.equal(f.call("intent", { route: "/mongodb/mutations/execute", request }).state, "uncertain");
  f.call("outcome", { id: first.id, result: { status: "committed", affectedCount: 1 } }); f.reopen();
  assert.equal(f.call("intent", { route: "/mongodb/mutations/execute", request }).result.affectedCount, 1);
});

test("reconciliation accepts only the same remote job, immutable plan and matching terminal state", (t) => {
  const f = fixture(t), identity = { jobId: "job-recovery", planHash: "a".repeat(64) };
  const intent = f.call("intent", { route: "/mongodb/bulk/execute", request: identity, identity });
  for (const result of [{ ok: true, ...identity, status: "running" }, { ok: true, ...identity, planHash: "b".repeat(64), status: "completed" },
    { ok: true, ...identity, jobId: "other", status: "completed" }, { ok: false, ...identity, status: "completed" }]) {
    assert.equal(f.call("reconcile", { id: intent.id, result }).state, "uncertain");
  }
  assert.equal(f.call("reconcile", { id: intent.id, result: { ok: true, ...identity, status: "completed", committedBatchCount: 1 } }).state, "complete");
  f.reopen(); assert.equal(f.call("intent", { route: "/mongodb/bulk/execute", request: identity, identity }).result.committedBatchCount, 1);
});

test("prepare attempts survive restart, reject stale responses and retain the same mutation identity", (t) => {
  const f = fixture(t), request = { instanceId: "local", database: "business", kind: "index", name: "idx" };
  const args = { route: "/mongodb/mutations/prepare", request, identity: { instanceId: "local" }, dispatchDigest: "c".repeat(64) };
  const first = f.call("intent", args);
  assert.equal(first.prepare.attempt, 1); f.reopen();
  const claim = { id: first.id, attempt: 1, dispatchDigest: args.dispatchDigest };
  f.call("claim_prepare", claim);
  assert.throws(() => f.call("claim_prepare", claim), { code: "BUSINESS_OPERATION_RECONCILIATION_REQUIRED" });
  f.call("prepare_result", { id: first.id, prepare: first.prepare, notDispatched: true, result: { ok: false, error: { code: "MONGODB_COLLECTION_NOT_ALLOWED" } } });
  f.reopen();
  const second = f.call("intent", args);
  assert.equal(second.id, first.id); assert.equal(second.prepare.mutationId, first.prepare.mutationId); assert.equal(second.prepare.attempt, 2);
  assert.throws(() => f.call("prepare_result", { id: first.id, prepare: first.prepare, fenced: true }), { code: "BUSINESS_OPERATION_DENIED" });
  const failed = f.call("prepare_result", { id: first.id, prepare: second.prepare, result: { ok: false } });
  assert.equal(failed.state, "uncertain");
  assert.equal(f.call("intent", args).state, "uncertain");
});

test("execute response loss accepts only the same mutation and terminal plan without replay", (t) => {
  const f = fixture(t), identity = { mutationId: "lost-commit", planHash: "a".repeat(64) };
  const args = { route: "/mongodb/mutations/execute", request: identity, identity };
  const intent = f.call("intent", args); f.reopen();
  for (const entry of [{ ...identity, status: "commit_started" }, { ...identity, status: "commit_failed" },
    { ...identity, planHash: "b".repeat(64), status: "committed" }, { ...identity, mutationId: "another", status: "committed" }]) {
    assert.equal(f.call("reconcile", { id: intent.id, result: { ok: true, entries: [entry] } }).state, "uncertain");
  }
  assert.equal(f.call("reconcile", { id: intent.id, result: { ok: true, entries: [{ ...identity, status: "committed" }] } }).state, "complete");
  f.reopen(); assert.equal(f.call("intent", args).result.status, "committed");
});

test("formal recovery inspects legacy intents without accepting caller supplied proof", async (t) => {
  const f = fixture(t), instance = { id: "local", host: "fixture.invalid", mongodb: { database: "business" } }, origin = "http://127.0.0.1:4343";
  const scope = businessTargetScope(origin, instance, "business"), request = { instanceId: "local", database: "business", kind: "index" };
  const intent = f.store.execute("intent", { auth: f.auth, scope, route: "/mongodb/mutations/prepare", request, identity: { instanceId: "local" } });
  const recovered = await privacyRequest({ call: (action, input) => f.store.execute(action, input) },
    { action: "recover_operation", auth: f.auth, scope, id: intent.id, mode: "reconcile", result: { ok: true }, notDispatched: true },
    { instance: () => instance, origin, dispatch: () => assert.fail("Legacy recovery must not dispatch") });
  assert.equal(recovered.state, "uncertain"); assert.equal(recovered.reason, "legacy_evidence_required");
  await assert.rejects(privacyRequest({}, { action: "prepare_result", auth: f.auth, scope, id: intent.id, fenced: true }, { instance: () => instance, origin }), { code: "BUSINESS_STORAGE_ACTION_DENIED" });
});

test("failed local prepare outcome commit leaves a recoverable uncertain intent", (t) => {
  let fail = false;
  const f = fixture(t, { fault: (boundary) => { if (fail && boundary === "beforeCommit") throw Error("Simulated storage failure"); } });
  const args = { route: "/mongodb/mutations/prepare", request: { kind: "index" }, dispatchDigest: "e".repeat(64) };
  const intent = f.call("intent", args);
  fail = true;
  assert.throws(() => f.call("prepare_result", { id: intent.id, prepare: intent.prepare,
    result: { ok: true, mutationId: intent.prepare.mutationId, planHash: "f".repeat(64) } }));
  fail = false; f.reopen();
  assert.equal(f.call("intent", args).state, "uncertain");
  assert.equal(f.call("prepare_result", { id: intent.id, prepare: intent.prepare,
    result: { ok: true, mutationId: intent.prepare.mutationId, planHash: "f".repeat(64) } }).state, "prepared");
});

test("active jobs pin mappings beyond cache and expiry; terminal rollback retention and cleanup are bounded", (t) => {
  const f = fixture(t), active = f.commit("PRIVATE_ACTIVE", { tasks: [{ id: "job-active", status: "running" }] });
  const stale = Array.from({ length: 6 }, (_, i) => f.commit(`PRIVATE_EXPIRED_${i}`));
  f.advance(31 * DAY);
  assert.equal(f.call("resolve", { refs: [active] }).records[0].value, "PRIVATE_ACTIVE");
  assert.throws(() => f.call("resolve", { refs: [stale[0]] }), { code: "BUSINESS_REFERENCE_INVALID" });
  assert.equal(f.call("cleanup", { limit: 2 }).removed, 2);
  f.call("commit", { records: [], refs: [active], tasks: [{ id: "job-active", status: "completed" }] });
  f.advance(31 * DAY);
  for (let i = 0; i < 30; i++) assert.ok(f.call("cleanup", { limit: 2 }).removed <= 2);
  assert.throws(() => f.call("resolve", { refs: [active] }), { code: "BUSINESS_REFERENCE_INVALID" });
});

test("private service validates current instance/profile and refuses arbitrary actions", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rda-privacy-service-"));
  const service = new PrivacyService({ directory, key: randomBytes(32) });
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const instance = { id: "local", host: "127.0.0.1", mongodb: { database: "business", configProfile: "fixture" } }, origin = "http://127.0.0.1:45000";
  const options = { instance: () => instance, origin };
  const auth = await privacyRequest(service, { action: "create" }, options), scope = businessTargetScope(origin, instance, "business");
  await privacyRequest(service, { action: "commit", auth, scope, records: [] }, options);
  instance.mongodb.configProfile = "other";
  await assert.rejects(privacyRequest(service, { action: "resolve", auth, scope, refs: [] }, options), { code: "BUSINESS_REFERENCE_INVALID" });
  await assert.rejects(privacyRequest(service, { action: "sql", auth, query: "SELECT * FROM records" }, options), { code: "BUSINESS_STORAGE_ACTION_DENIED" });
});

for (const boundary of ["beforeCommit", "afterCommit"]) test(`SQLite recovers atomically after actual process SIGKILL ${boundary}`, async (t) => {
  const f = fixture(t), ref = alias(); f.store.close();
  const child = fork(path.resolve(import.meta.dirname, "helpers/privacy-store-crash.mjs"), { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  if (process.platform === "win32") child.once("message", (message) => { assert.equal(message.boundary, boundary); child.kill("SIGKILL"); });
  const done = once(child, "exit"); child.send({ directory: f.directory, key: f.key.toString("hex"), auth: f.auth, scope: f.scope, ref, boundary });
  const [code, signal] = await done; assert.equal(code, null); assert.equal(signal, "SIGKILL"); f.reopen();
  if (boundary === "beforeCommit") {
    assert.throws(() => f.call("resolve", { refs: [ref] }), { code: "BUSINESS_REFERENCE_INVALID" });
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM links").get().n, 0);
  } else {
    assert.equal(f.call("resolve", { refs: [ref] }).records[0].value, "PRIVATE_CRASH_ATOMICITY");
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM links").get().n, 1);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='delivery'").get().n, 1);
  }
});

test("worker queue overload is bounded and returns a redacted busy error", async (t) => {
  const f = fixture(t); f.store.close(); const service = new PrivacyService({ directory: f.directory, key: f.key, maxQueue: 2 });
  f.beforeCleanup(() => service.close());
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => service.call("attach", { auth: f.auth })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  for (const r of results.filter((r) => r.status === "rejected")) assert.equal(r.reason.code, "BUSINESS_STORAGE_BUSY");
});

test("claimed executions reconcile only the exact original intent and operation", async (t) => {
  const f = fixture(t), identity = { mutationId: "bound-commit", planHash: "a".repeat(64) };
  const intent = f.call("intent", { route: "/mongodb/mutations/execute", request: identity, identity });
  const execution = f.call("claim_execution", { id: intent.id, operationId: "commit-operation" });
  f.reopen();
  assert.throws(() => f.call("claim_execution", { id: intent.id, operationId: "second-operation" }), { code: "BUSINESS_OPERATION_RECONCILIATION_REQUIRED" });
  for (const wrong of [undefined, { ...execution, intentId: "b".repeat(64) }, { ...execution, operationId: "other" }]) {
    assert.equal(f.call("reconcile", { id: intent.id, result: { ok: true, entries: [{ ...identity, execution: wrong, status: "committed" }] } }).state, "uncertain");
  }
  assert.equal(f.call("reconcile", { id: intent.id, result: { ok: true, entries: [{ ...identity, execution, status: "committed" }] } }).state, "complete");
  assert.ok(f.store.db.prepare("SELECT pinned FROM records WHERE kind='task'").all().every((r) => r.pinned === 0), "Resolved intent no longer pins its synthetic task indefinitely");
});

test("public privacy RPC rejects caller-supplied reconciliation evidence", async (t) => {
  const f = fixture(t), instance = { id: "local", mongodb: { database: "business" } }, origin = "http://127.0.0.1:4343";
  const scope = businessTargetScope(origin, instance, "business");
  await assert.rejects(privacyRequest({}, { action: "reconcile", auth: f.auth, scope, result: { ok: true } },
    { instance: () => instance, origin }), { code: "BUSINESS_STORAGE_ACTION_DENIED" });
});

test("bulk legacy envelopes and modern missing evidence are distinguished without accepting caller proof", async (t) => {
  const f = fixture(t), instance = { id: "isolated", host: "fixture.invalid", mongodb: { database: "business" } }, origin = "http://127.0.0.1:4343";
  const scope = businessTargetScope(origin, instance, "business");
  const old = f.store.execute("intent", { auth: f.auth, scope, route: "/mongodb/bulk/prepare", request: { jobId: "old-job" }, identity: { instanceId: instance.id, jobId: "old-job" } });
  const service = { call: (action, input) => f.store.execute(action, input) };
  const options = { instance: () => instance, origin, dispatch: () => assert.fail("unbound legacy recovery must not dispatch") };
  const recovered = await privacyRequest(service, { action: "recover_operation", auth: f.auth, scope, id: old.id, mode: "reconcile", result: { ok: true }, notDispatched: true }, options);
  assert.equal(recovered.state, "uncertain"); assert.equal(recovered.legacy, true); assert.equal(recovered.reason, "bulk_prepare_identity_required");
  for (const action of ["claim_bulk_prepare", "bulk_prepare_result", "outcome"]) {
    await assert.rejects(privacyRequest(service, { action, auth: f.auth, scope, id: old.id, result: { ok: true }, notDispatched: true }, options), { code: action === "outcome" ? "BUSINESS_OPERATION_DENIED" : "BUSINESS_STORAGE_ACTION_DENIED" });
  }
});

test("bulk intent interrupted before claim can be atomically fenced, preserving identity and blocking a delayed dispatch", async (t) => {
  const f = fixture(t), instance = { id: "isolated", host: "fixture.invalid", mongodb: { database: "business" } }, origin = "http://127.0.0.1:4343";
  const scope = businessTargetScope(origin, instance, "business");
  const args = { auth: f.auth, scope, route: "/mongodb/bulk/prepare", request: { jobId: "fixed-job" }, identity: { instanceId: instance.id, jobId: "fixed-job" }, dispatchDigest: "e".repeat(64) };
  const intent = f.store.execute("intent", args); f.reopen();
  const recovered = await privacyRequest({ call: (action, input) => f.store.execute(action, input) },
    { action: "recover_operation", auth: f.auth, scope, id: intent.id, mode: "reconcile" },
    { instance: () => instance, origin, dispatch: () => assert.fail("unclaimed intent recovery must not dispatch") });
  assert.equal(recovered.state, "rejected_before_dispatch"); assert.equal(recovered.reason, "old_attempt_fenced"); assert.equal(recovered.legacy, false);
  assert.throws(() => f.store.execute("claim_bulk_prepare", { auth: f.auth, scope, id: intent.id, attempt: 1, dispatchDigest: args.dispatchDigest }), { code: "BUSINESS_OPERATION_RECONCILIATION_REQUIRED" });
  const next = f.store.execute("intent", args);
  assert.equal(next.id, intent.id); assert.equal(next.bulkPrepare.attempt, 2);
  assert.throws(() => f.store.execute("bulk_prepare_result", { auth: f.auth, scope, id: intent.id, bulkPrepare: intent.bulkPrepare, notDispatched: true }), { code: "BUSINESS_OPERATION_DENIED" });
});

test("bulk recovery cannot fence a claimed attempt using a stale unclaimed observation", (t) => {
  const f = fixture(t), args = { route: "/mongodb/bulk/prepare", request: {}, dispatchDigest: "a".repeat(64) };
  const intent = f.call("intent", args);
  f.call("claim_bulk_prepare", { id: intent.id, attempt: 1, dispatchDigest: args.dispatchDigest, bulkChunk: { jobId: "job", chunkIndex: 0, chunkHash: "b".repeat(64), endOfUpload: false } });
  const saved = f.call("bulk_prepare_result", { id: intent.id, bulkPrepare: intent.bulkPrepare, unclaimed: true, result: { ok: false, error: { code: "MONGODB_PREPARE_FENCED" } } });
  assert.equal(saved.state, "uncertain");
  assert.equal(f.call("intent", args).state, "uncertain");
});

test("bulk local receipt commit failure remains pinned until exact positive evidence is persisted", (t) => {
  let fail = false;
  const f = fixture(t, { fault: (boundary) => { if (fail && boundary === "beforeCommit") throw Error("injected commit failure"); } });
  const intent = f.call("intent", { route: "/mongodb/bulk/prepare", request: {}, dispatchDigest: "a".repeat(64) });
  const bulkChunk = { jobId: "job", chunkIndex: 0, chunkHash: "b".repeat(64), endOfUpload: false };
  f.call("claim_bulk_prepare", { id: intent.id, attempt: 1, dispatchDigest: "a".repeat(64), bulkChunk });
  const receipt = { id: intent.id, bulkPrepare: intent.bulkPrepare, result: { ok: true, jobId: bulkChunk.jobId, chunkIndex: 0, chunkHash: bulkChunk.chunkHash, status: "uploading" } };
  fail = true;
  assert.throws(() => f.call("bulk_prepare_result", receipt));
  fail = false; f.reopen();
  assert.equal(f.call("inspect_operation", { id: intent.id }).state, "uncertain");
  assert.equal(f.call("bulk_prepare_result", { ...receipt, unclaimed: true, result: { ok: false } }).state, "uncertain");
  assert.equal(f.call("bulk_prepare_result", receipt).state, "complete");
  f.reopen(); assert.equal(f.call("inspect_operation", { id: intent.id }).result.chunkHash, bulkChunk.chunkHash);
});

test("redacted bulk request collisions cannot return a receipt for different original bytes", (t) => {
  const f = fixture(t), args = { route: "/mongodb/bulk/prepare", request: { jobId: "fixed-job", secret: "[REDACTED]" }, dispatchDigest: "a".repeat(64) };
  const intent = f.call("intent", args);
  f.call("claim_bulk_prepare", { id: intent.id, attempt: 1, dispatchDigest: args.dispatchDigest, bulkChunk: { jobId: "fixed-job", chunkIndex: 0, chunkHash: "b".repeat(64), endOfUpload: false } });
  f.call("bulk_prepare_result", { id: intent.id, bulkPrepare: intent.bulkPrepare, result: { ok: true, jobId: "fixed-job", chunkIndex: 0, chunkHash: "b".repeat(64) } });
  assert.throws(() => f.call("intent", { ...args, dispatchDigest: "c".repeat(64) }), { code: "BUSINESS_OPERATION_CONTENT_CONFLICT" });
  assert.equal(f.call("intent", args).state, "complete");
});
