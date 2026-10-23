import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { mutationPrepareHarness } from "./helpers/mutation-prepare-harness.js";

const input = { mode: "prepare", kind: "index", database: "business", collection: "orders", operation: "createIndex",
  name: "idx_customer", key: { tenant: 1, customer: 1 }, options: { unique: false, sparse: false } };
const execution = { intentId: "a".repeat(64), operationId: "execute-fixture" };
const commit = (p) => ({ mode: "commit", mutationId: p.mutationId, planHash: p.planHash, confirmation: "确认执行", _businessExecution: execution });
const recover = (p, ticket = execution) => ({ mode: "recover_execution", database: "business", mutationId: p.mutationId, planHash: p.planHash, _businessExecution: ticket });
const manifest = (h, p) => JSON.parse(fs.readFileSync(path.join(h.root, p.mutationId, "manifest.json")));
const save = (h, p, m) => fs.writeFileSync(path.join(h.root, p.mutationId, "manifest.json"), JSON.stringify(m));

// Exercise generated remote scripts, fsync journals and driver calls, not a
// reimplementation of their state machine. All files and data are disposable.
test("primary metadata reads retry invisibility and persist verified rollback evidence", async (t) => {
  const h = mutationPrepareHarness(t), p = await h.run(input);
  let hidden = 2;
  h.state.afterWrite = () => { h.state.beforeRead = () => hidden-- > 0 ? [{ name: "_id_", key: { _id: 1 } }] : undefined; };
  assert.equal((await h.run(commit(p))).status, "committed");
  assert.equal(h.state.writes, 1); assert.equal(h.state.reads, 5);
  assert.equal(h.state.clientOptions.readPreference, "primary"); assert.equal(h.state.readOptions.readPreference, "primary");
  assert.equal(h.state.commandOptions.readPreference, "primary");
  const m = manifest(h, p); assert.equal(m.indexReceipt.stage, "acknowledged"); assert.equal(m.indexReceipt.owned, true);
  assert.deepEqual(m.afterIndex.key, input.key);
  await h.run(commit(p)); assert.equal(h.state.writes, 1);
  delete h.state.afterWrite; delete h.state.beforeRead;
  assert.equal((await h.run({ ...commit(p), mode: "rollback", confirmation: "确认回滚" })).status, "rolled_back");
  assert.equal(h.state.writes, 2); assert.equal(h.state.indexes.length, 1);
});

test("exhausted verification is unknown; exact recovery completes without another DDL", async (t) => {
  const h = mutationPrepareHarness(t), p = await h.run(input);
  h.state.afterWrite = () => { h.state.beforeRead = () => [{ name: "_id_", key: { _id: 1 } }]; };
  await assert.rejects(h.run(commit(p)), { code: "MONGODB_INDEX_COMMIT_UNKNOWN" });
  assert.equal(manifest(h, p).status, "commit_unknown"); assert.equal(h.state.writes, 1);
  await assert.rejects(h.run(commit(p)), { code: "MONGODB_MUTATION_STATE_INVALID" });
  delete h.state.beforeRead; delete h.state.afterWrite;
  const wrong = await h.run(recover(p, { ...execution, intentId: "b".repeat(64) }));
  assert.equal(wrong.status, "commit_unknown"); assert.equal(wrong.indexRecovery.reason, "legacy_execution_evidence_required");
  await assert.rejects(h.run({ ...recover(p), planHash: "f".repeat(64) }), { code: "MONGODB_MUTATION_PLAN_HASH_MISMATCH" });
  assert.equal((await h.run(recover(p))).status, "committed");
  assert.equal((await h.run(recover(p))).status, "committed"); assert.equal(h.state.writes, 1);
  assert.equal((await h.run({ ...commit(p), mode: "rollback", confirmation: "确认回滚" })).status, "rolled_back");
  assert.equal(h.state.writes, 2);
});

for (const key of ["key", "unique", "sparse", "partialFilterExpression", "expireAfterSeconds", "order"]) test(`same name with different ${key} cannot become verified or rollback-owned`, async (t) => {
  const h = mutationPrepareHarness(t), p = await h.run(input);
  h.state.afterWrite = () => {
    const index = h.state.indexes.at(-1);
    if (key === "key") index.key = { other: 1 };
    else if (key === "order") index.key = { customer: 1, tenant: 1 };
    else index[key] = key === "partialFilterExpression" ? { customer: { $exists: true } } : key === "expireAfterSeconds" ? 60 : true;
  };
  await assert.rejects(h.run(commit(p)), { code: "MONGODB_INDEX_DEFINITION_CONFLICT" });
  assert.equal(manifest(h, p).status, "commit_unknown");
  await assert.rejects(h.run(recover(p)), { code: "MONGODB_INDEX_DEFINITION_CONFLICT" });
  await assert.rejects(h.run({ ...commit(p), mode: "rollback", confirmation: "确认回滚" }), { code: "MONGODB_MUTATION_NOT_COMMITTED" });
  assert.equal(h.state.writes, 1);
});

test("definite create failure is failed, does not acquire ownership or permit replay", async (t) => {
  const h = mutationPrepareHarness(t), p = await h.run(input);
  h.state.commandError = Object.assign(Error("duplicate key"), { name: "MongoServerError", code: 11000 });
  await assert.rejects(h.run(commit(p)), { code: 11000 });
  assert.equal(manifest(h, p).status, "commit_failed"); assert.equal(manifest(h, p).indexReceipt.stage, "rejected");
  assert.equal((await h.run(recover(p))).indexRecovery.reason, "execution_acknowledgement_required");
  await assert.rejects(h.run(commit(p)), { code: "MONGODB_MUTATION_STATE_INVALID" });
  assert.equal(h.state.writes, 1); assert.equal(h.state.indexes.length, 1);
});

for (const code of ["ETIMEDOUT", "ECONNRESET"]) test(`${code} after DDL never infers ownership from matching catalog`, async (t) => {
  const h = mutationPrepareHarness(t), p = await h.run(input);
  h.state.afterWrite = () => { throw Object.assign(Error("lost acknowledgement"), { code, retriable: true }); };
  await assert.rejects(h.run(commit(p)), (e) => e.code === code && e.retriable === false);
  assert.equal(manifest(h, p).status, "commit_unknown");
  const r = await h.run(recover(p)); assert.equal(r.status, "commit_unknown"); assert.equal(r.indexRecovery.reason, "execution_acknowledgement_required");
  await assert.rejects(h.run(commit(p)), { code: "MONGODB_MUTATION_STATE_INVALID" }); assert.equal(h.state.writes, 1);
});

test("concurrent same-spec no-op acknowledgement never transfers rollback ownership", async (t) => {
  const h = mutationPrepareHarness(t), p = await h.run(input); h.state.concurrentIndex = true;
  await assert.rejects(h.run(commit(p)), { code: "MONGODB_INDEX_OWNERSHIP_UNKNOWN" });
  assert.equal(manifest(h, p).status, "commit_unknown"); assert.equal(manifest(h, p).indexReceipt.owned, false);
  assert.equal((await h.run(recover(p))).status, "commit_unknown"); assert.equal(h.state.writes, 1);
});

test("historical failed journal plus matching index is insufficient evidence", async (t) => {
  const h = mutationPrepareHarness(t), p = await h.run(input); await h.run(commit(p));
  const m = manifest(h, p); m.status = "commit_failed"; delete m.execution; delete m.indexReceipt; delete m.committedAt; save(h, p, m);
  assert.equal((await h.run(recover(p))).indexRecovery.reason, "legacy_execution_evidence_required");
  assert.equal(manifest(h, p).status, "commit_failed"); assert.equal(h.state.writes, 1);
});

test("missing journal and stale lock cannot be bypassed by recovery", async (t) => {
  const h = mutationPrepareHarness(t), p = await h.run(input);
  const lock = path.join(h.root, p.mutationId, ".lock"); fs.writeFileSync(lock, "123"); fs.utimesSync(lock, 1, 1);
  await assert.rejects(h.run(recover(p)), { code: "MONGODB_MUTATION_BUSY" }); assert.equal(h.state.writes, 0);
  fs.unlinkSync(lock); fs.unlinkSync(path.join(h.root, p.mutationId, "manifest.json"));
  await assert.rejects(h.run(recover(p)), { code: "MONGODB_MUTATION_NOT_FOUND" }); assert.equal(h.state.writes, 0);
});

test("rollback verification loss recovers only its acknowledgement without repeating DDL", async (t) => {
  const h = mutationPrepareHarness(t), p = await h.run(input); await h.run(commit(p));
  const ticket = { intentId: "c".repeat(64), operationId: "rollback-fixture" }, before = structuredClone(h.state.indexes);
  h.state.afterWrite = () => { h.state.beforeRead = () => before; };
  await assert.rejects(h.run({ ...commit(p), mode: "rollback", confirmation: "确认回滚", _businessExecution: ticket }), { code: "MONGODB_INDEX_COMMIT_UNKNOWN" });
  assert.equal(manifest(h, p).status, "rollback_unknown"); assert.equal(h.state.writes, 2);
  delete h.state.beforeRead; delete h.state.afterWrite;
  assert.equal((await h.run(recover(p, ticket))).status, "rolled_back"); assert.equal(h.state.writes, 2);
});

test("an index appearing before dispatch is rejected without issuing DDL", async (t) => {
  const h = mutationPrepareHarness(t), p = await h.run(input);
  h.state.indexes.push({ name: input.name, key: input.key });
  await assert.rejects(h.run(commit(p)), { code: "MONGODB_INDEX_CONFLICT" });
  assert.equal(h.state.writes, 0); assert.equal(manifest(h, p).status, "commit_failed");
  assert.equal((await h.run(recover(p))).indexRecovery.reason, "execution_acknowledgement_required");
});

test("lost metadata connection is retried read-only and may complete", async (t) => {
  const h = mutationPrepareHarness(t), p = await h.run(input); let failures = 2;
  h.state.afterWrite = () => { h.state.beforeRead = () => { if (failures-- > 0) throw Object.assign(Error("metadata disconnect"), { code: "ECONNRESET" }); }; };
  assert.equal((await h.run(commit(p))).status, "committed"); assert.equal(h.state.writes, 1);
});
