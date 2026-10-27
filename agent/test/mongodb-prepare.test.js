import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { mutationPrepareHarness } from "./helpers/mutation-prepare-harness.js";
import { WorkerManager, workerConfigFingerprint } from "../worker-manager.js";

const ticket = { mutationId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", binding: "b".repeat(64), requestDigest: "c".repeat(64), attempt: 1 };
const input = { mode: "prepare", kind: "index", database: "business", collection: "orders", operation: "createIndex",
  name: "idx_compound", key: { groupId: 1, restaurantId: 1 }, options: { unique: false, sparse: false }, _businessPrepare: ticket };
const recover = { mode: "recover_prepare", database: "business", _businessPrepare: ticket };

test("prepare reply loss recovers the same hashed plan, with zero business writes", async (t) => {
  const h = mutationPrepareHarness(t); h.state.dropReply = true;
  await assert.rejects(h.run(input), { code: "ECONNRESET" });
  const found = await h.run(recover);
  assert.equal(found.recovery, "prepared"); assert.equal(found.mutationId, ticket.mutationId); assert.equal(found.status, "planned");
  const repeated = await h.run(input);
  assert.equal(repeated.planHash, found.planHash); assert.equal(h.state.reads, 1); assert.equal(h.state.writes, 0);
  await assert.rejects(h.run({ ...recover, _businessPrepare: { ...ticket, binding: "d".repeat(64) } }), { code: "MONGODB_PREPARE_RECEIPT_CONFLICT" });
  await assert.rejects(h.run({ ...recover, _businessPrepare: { ...ticket, requestDigest: "e".repeat(64) } }), { code: "MONGODB_PREPARE_RECEIPT_CONFLICT" });
});

test("absence is fenced before retry; delayed original prepare cannot create a plan", async (t) => {
  const h = mutationPrepareHarness(t);
  h.state.beforeRead = () => { throw Error("prepare interrupted before manifest"); };
  await assert.rejects(h.run(input)); delete h.state.beforeRead;
  assert.equal((await h.run(recover)).recovery, "fenced");
  await assert.rejects(h.run(input), { code: "MONGODB_PREPARE_FENCED" });
  assert.equal(h.state.reads, 1); assert.equal(h.state.writes, 0);
  const next = await h.run({ ...input, _businessPrepare: { ...ticket, attempt: 2 } });
  assert.equal(next.mutationId, ticket.mutationId); assert.equal(next.status, "planned");
  await assert.rejects(h.run(input), { code: "MONGODB_PREPARE_RECEIPT_CONFLICT" });
  assert.equal(h.state.reads, 2);
});

test("a missing remote receipt is never taken as proof that preparation did not run", async (t) => {
  const h = mutationPrepareHarness(t);
  await assert.rejects(h.run(recover), { code: "MONGODB_PREPARE_RECEIPT_INVALID" });
  assert.equal(h.state.reads, 0); assert.equal(h.state.writes, 0);
});

test("a deleted manifest after plan reservation is not reported as an unprepared attempt", async (t) => {
  const h = mutationPrepareHarness(t), plan = await h.run(input);
  fs.unlinkSync(path.join(h.root, plan.mutationId, "manifest.json"));
  await assert.rejects(h.run(recover), { code: "MONGODB_PREPARE_RECEIPT_INVALID" });
  await assert.rejects(h.run(input), { code: "MONGODB_PREPARE_RECEIPT_INVALID" });
  assert.equal(h.state.reads, 1); assert.equal(h.state.writes, 0);
});

test("recovery never ages out a live or crashed prepare lock", async (t) => {
  const h = mutationPrepareHarness(t), dir = path.join(h.root, ticket.mutationId);
  fs.mkdirSync(dir); const lock = path.join(dir, ".lock"); fs.writeFileSync(lock, "123"); fs.utimesSync(lock, 1, 1);
  await assert.rejects(h.run(recover), { code: "MONGODB_MUTATION_BUSY" });
  assert.equal(fs.readFileSync(lock, "utf8"), "123"); assert.equal(h.state.reads, 0);
});

test("running prepare and recovery serialize; recovery cannot report false absence", async (t) => {
  const h = mutationPrepareHarness(t); let release, entered;
  const waiting = new Promise((r) => { release = r; }); const ready = new Promise((r) => { entered = r; });
  h.state.beforeRead = async () => { entered(); await waiting; };
  const running = h.run(input); await ready;
  try { await assert.rejects(h.run(recover), { code: "MONGODB_MUTATION_BUSY" }); }
  finally { release(); }
  const plan = await running;
  assert.equal((await h.run(recover)).planHash, plan.planHash);
});

test("index created with an uncertain result is not executed again or inferred from its name", async (t) => {
  const h = mutationPrepareHarness(t), plan = await h.run(input);
  h.state.afterWrite = () => { throw Error("Lost index acknowledgment"); };
  const execute = { mode: "commit", mutationId: plan.mutationId, planHash: plan.planHash, confirmation: "确认执行" };
  await assert.rejects(h.run(execute));
  assert.equal(h.state.writes, 1);
  const found = await h.run(recover); assert.equal(found.status, "commit_unknown");
  await assert.rejects(h.run(execute), { code: "MONGODB_MUTATION_STATE_INVALID" });
  assert.equal(h.state.writes, 1);
});

test("corrupt or missing receipts and changed policy fail closed", async (t) => {
  const h = mutationPrepareHarness(t), plan = await h.run(input), dir = path.join(h.root, plan.mutationId);
  await assert.rejects(h.run(recover, { ...h.config, allowedCollections: ["another"] }), { code: "MONGODB_MUTATION_POLICY_CHANGED" });
  fs.writeFileSync(path.join(dir, "prepare.json"), "invalid");
  await assert.rejects(h.run(recover), { code: "MONGODB_PREPARE_RECEIPT_INVALID" });
  fs.unlinkSync(path.join(dir, "prepare.json"));
  await assert.rejects(h.run(recover), { code: "MONGODB_PREPARE_RECEIPT_INVALID" });
  assert.equal(h.state.writes, 0);
});

test("new prepare hashes preserve compound index field order and connection identity", async (t) => {
  const h = mutationPrepareHarness(t), plan = await h.run(input);
  await assert.rejects(h.run({ mode: "get", mutationId: plan.mutationId, planHash: plan.planHash },
    { ...h.config, configProfile: "another" }), { code: "MONGODB_MUTATION_POLICY_CHANGED" });
  const file = path.join(h.root, plan.mutationId, "manifest.json"), manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.request.key = { restaurantId: 1, groupId: 1 };
  fs.writeFileSync(file, JSON.stringify(manifest));
  await assert.rejects(h.run(recover), { code: "MONGODB_PREPARE_RECEIPT_CONFLICT" });
  assert.equal(h.state.writes, 0);
});

test("worker transport preserves an explicit preflight rejection instead of making it an uncertain transport failure", async () => {
  const instance = { id: "isolated" }, policy = { host: "127.0.0.1", sshNetwork: {} };
  const manager = {
    cwd: "/isolated", registry: { getInternal: () => instance },
    resolveInstanceId: (id) => id,
    runtime: new Map([["isolated", { status: "running", workerPort: 4400, authToken: "a".repeat(64), configFingerprint: workerConfigFingerprint(instance, policy, "/isolated") }]]),
    managerConfig: () => policy,
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: { code: "MONGODB_COLLECTION_NOT_ALLOWED",
      message: "Structured MongoDB operation failed", layer: "mongodb-mutation", phase: "validation", retriable: false, dispatchState: "not_dispatched" } }), { status: 403 }),
  };
  await assert.rejects(WorkerManager.prototype.callInstance.call(manager, "isolated", "/mongodb/mutations/prepare", {}),
    { code: "MONGODB_COLLECTION_NOT_ALLOWED", phase: "validation", retriable: false, dispatchState: "not_dispatched" });
});
