import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  DEFAULT_MONGODB_BULK_ROOT,
  MONGODB_BULK_CONFIRMATION,
  MONGODB_BULK_ROLLBACK_CONFIRMATION,
  MongoBulkJobRunner,
  buildMongoBulkScript,
  normalizeMongoBulkChunk,
  normalizeMongoBulkConfig,
  normalizeMongoBulkStorage,
  runMongoBulk,
} from "../mongodb-bulk.js";
import { MONGODB_RESULT_MARKER } from "../mongodb.js";

const config = {
  bulkEnabled: true,
  writeEnabled: true,
  configPath: "/srv/app/config.json",
  driverPath: "/srv/app/node_modules/mongodb",
  configProfile: "test",
  uriKey: "url",
  database: "testdb",
  allowedDatabases: ["testdb"],
  allowedCollections: ["members", "private", "__remote_debug_bulk_receipts"],
  bulkRoot: DEFAULT_MONGODB_BULK_ROOT,
  bulkBatchDocuments: 500,
  bulkConcurrency: 2,
  bulkRollbackTtlMs: 7 * 24 * 60 * 60 * 1000,
};

function unitUpdate(unitId, id, original) {
  return {
    unitId,
    operations: [{
      operation: "updateOne",
      collection: "members",
      id,
      expected: { field: original },
      update: { $set: { field: "next" } },
    }],
  };
}

function fakeBulkResult(data) {
  return {
    exitCode: 0,
    timedOut: false,
    stdout: `${MONGODB_RESULT_MARKER}BULK:${JSON.stringify({ ok: true, data })}\n`,
    stderr: "",
    timing: { queueMs: 1, connectMs: 2, executionMs: 3 },
  };
}

test("bulk policy is opt-in and requires the technical receipt collection to be allowlisted", () => {
  assert.throws(() => normalizeMongoBulkConfig({ ...config, bulkEnabled: false }), { code: "MONGODB_BULK_DISABLED" });
  assert.throws(() => normalizeMongoBulkConfig({ ...config, writeEnabled: false }), { code: "MONGODB_MUTATIONS_DISABLED" });
  assert.throws(() => normalizeMongoBulkConfig({ ...config, allowedCollections: ["members"] }), { code: "MONGODB_BULK_RECEIPTS_NOT_ALLOWED" });
  assert.throws(() => normalizeMongoBulkConfig({ ...config, bulkRoot: "/" }), { code: "MONGODB_BULK_ROOT_INVALID" });
  assert.throws(() => normalizeMongoBulkConfig({ ...config, bulkConcurrency: 5 }), { code: "MONGODB_BULK_LIMIT_INVALID" });
  assert.equal(normalizeMongoBulkConfig(config).bulkRoot, DEFAULT_MONGODB_BULK_ROOT);
  assert.equal(normalizeMongoBulkStorage({}, config).kind, "bulk_storage");
});

test("disabling bulk blocks new jobs and resume but preserves inspection, pause, and rollback", async () => {
  const disabledConfig = { ...config, bulkEnabled: false };
  const jobId = "job-recovery-1";
  const planHash = "a".repeat(64);
  const calls = [];
  const send = async (_command, options) => {
    calls.push(options.stdin);
    return fakeBulkResult({ jobId, status: "paused", planHash });
  };
  for (const input of [
    { action: "get", jobId },
    { action: "list", limit: 10 },
    { action: "control", command: "pause", jobId, planHash },
    { action: "rollbackStart", jobId, planHash, confirmation: MONGODB_BULK_ROLLBACK_CONFIRMATION },
  ]) {
    await runMongoBulk(input, { config: disabledConfig, runSSH: send });
  }
  for (const action of ["get", "list", "control", "rollbackStart"]) assert.ok(calls.some((script) => script.includes(`"action":"${action}"`)));
  await assert.rejects(runMongoBulk({
    action: "executeStart", jobId, planHash, confirmation: MONGODB_BULK_CONFIRMATION,
  }, { config: disabledConfig, runSSH: send }), { code: "MONGODB_BULK_DISABLED" });

  const runnerCalls = [];
  const runner = new MongoBulkJobRunner({
    config: disabledConfig,
    runMongoBulk: async (input) => {
      runnerCalls.push(input);
      if (input.action === "rollbackStart") return { jobId, planHash, batchCount: 0, mode: "rollback" };
      if (input.action === "get") return { jobId, status: "rolling_back", desiredState: "running", mode: "rollback", batchCount: 0, nextRollbackBatch: null };
      if (input.action === "finish") return { status: "rolled_back" };
      throw new Error(`unexpected action ${input.action}`);
    },
  });
  await assert.rejects(runner.start({ jobId, planHash, confirmation: MONGODB_BULK_CONFIRMATION }), { code: "MONGODB_BULK_DISABLED" });
  await assert.rejects(runner.control({ jobId, planHash, command: "resume" }), { code: "MONGODB_BULK_DISABLED" });
  await runner.start({ jobId, planHash, confirmation: MONGODB_BULK_ROLLBACK_CONFIRMATION }, "rollback");
  await runner.tasks.get(jobId);
  assert.deepEqual(runnerCalls.map((call) => call.action), ["rollbackStart", "get", "finish"]);
});

test("bulk chunk normalization preserves missing versus null preconditions and hashes stable content", () => {
  const input = {
    jobId: "member-sync-01",
    chunkIndex: 0,
    units: [
      unitUpdate("unit-1", "member-1", { exists: false }),
      unitUpdate("unit-2", "member-2", { exists: true, value: null }),
    ],
  };
  const chunk = normalizeMongoBulkChunk(input, config);
  assert.deepEqual(chunk.units[0].operations[0].expected.field, { exists: false });
  assert.deepEqual(chunk.units[1].operations[0].expected.field, { exists: true, value: null });
  assert.equal(chunk.operationCount, 2);
  assert.equal(normalizeMongoBulkChunk(input, config).chunkHash, chunk.chunkHash);
  assert.throws(() => normalizeMongoBulkChunk({ ...input, chunkHash: "0".repeat(64) }, config), { code: "MONGODB_BULK_CHUNK_HASH_MISMATCH" });
});

test("bulk validator rejects unapproved targets, incomplete originals, duplicate update paths, and unsafe operators", () => {
  const base = { jobId: "job-1", chunkIndex: 0, units: [unitUpdate("unit-1", "id-1", { exists: true, value: "old" })] };
  assert.throws(() => normalizeMongoBulkChunk({ ...base, units: [unitUpdate("unit-1", "id-1", { exists: true, value: "old" })], database: "other" }, config), { code: "MONGODB_DATABASE_NOT_ALLOWED" });
  assert.throws(() => normalizeMongoBulkChunk({ ...base, units: [{ unitId: "unit-1", operations: [{ operation: "insertOne", collection: "forbidden", document: { _id: "x" } }] }] }, config), { code: "MONGODB_COLLECTION_NOT_ALLOWED" });
  assert.throws(() => normalizeMongoBulkChunk({ ...base, units: [{ unitId: "unit-1", operations: [{ operation: "updateOne", collection: "members", id: "id-1", update: { $set: { field: "new" } } }] }] }, config), { code: "MONGODB_BULK_EXPECTED_REQUIRED" });
  assert.throws(() => normalizeMongoBulkChunk({ ...base, units: [{ unitId: "unit-1", operations: [{ operation: "updateOne", collection: "members", id: "id-1", expected: { a: { exists: true, value: 1 } }, update: { $set: { a: 1, "a.b": 2 } } }] }] }, config), { code: "MONGODB_BULK_UPDATE_INVALID" });
  assert.throws(() => normalizeMongoBulkChunk({ ...base, units: [{ unitId: "unit-1", operations: [{ operation: "updateOne", collection: "members", id: "id-1", expected: { field: { exists: true, value: "old" } }, update: { $where: "return true" } }] }] }, config), { code: "MONGODB_BULK_UPDATE_INVALID" });
  assert.throws(() => normalizeMongoBulkChunk({ ...base, units: [{ unitId: "unit-1", operations: Array.from({ length: 21 }, () => ({ operation: "insertOne", collection: "members", document: { _id: "x" } })) }] }, config), { code: "MONGODB_BULK_UNIT_SIZE_INVALID" });
});

test("bulk helper is fixed Node code, bounded, and parses with legacy target syntax", () => {
  const chunk = normalizeMongoBulkChunk({ jobId: "job-1", chunkIndex: 0, units: [unitUpdate("unit-1", "id-1", { exists: true, value: "old" })] }, config);
  const script = buildMongoBulkScript({ action: "upload", chunk }, config);
  assert.doesNotMatch(script, /\?\.|\?\?/);
  assert.doesNotMatch(script, /mongodb:\/\//i);
  assert.doesNotMatch(script, /node_modules\/\.bin/);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /bulkWrite/);
  assert.match(script, /\.worker-lease\.json/);
});

test("runMongoBulk forwards a fixed helper with the exact confirmation and uses the bulk channel", async () => {
  const calls = [];
  const accepted = await runMongoBulk({
    action: "executeStart", jobId: "job-1", planHash: "a".repeat(64), confirmation: MONGODB_BULK_CONFIRMATION,
  }, {
    config,
    runSSH: async (command, options) => {
      calls.push({ command, options });
      return fakeBulkResult({ jobId: "job-1", accepted: true });
    },
  });
  assert.equal(accepted.jobId, "job-1");
  assert.equal(calls[0].command, "node");
  assert.equal(calls[0].options.priority, "interactive");
  assert.match(calls[0].options.stdin, /executeStart/);
  await assert.rejects(runMongoBulk({ action: "executeStart", jobId: "job-1", planHash: "a".repeat(64), confirmation: "wrong" }, {
    config,
    runSSH: async () => fakeBulkResult({}),
  }), { code: "MONGODB_BULK_CONFIRMATION_REQUIRED" });
  await assert.rejects(runMongoBulk({ action: "rollbackStart", jobId: "job-1", planHash: "a".repeat(64), confirmation: MONGODB_BULK_CONFIRMATION }, {
    config,
    runSSH: async () => fakeBulkResult({}),
  }), { code: "MONGODB_BULK_ROLLBACK_CONFIRMATION_REQUIRED" });
  assert.equal(MONGODB_BULK_ROLLBACK_CONFIRMATION, "确认回滚");
});

test("job runner runs bounded concurrent waves and waits for every started transaction", async () => {
  const committed = new Set();
  const verified = new Set();
  const callLog = [];
  let activeBatches = 0;
  let maximumActive = 0;
  const nextMissing = (set, count) => {
    let index = 0;
    while (set.has(index) && index < count) index += 1;
    return index;
  };
  const runner = new MongoBulkJobRunner({
    config,
    runMongoBulk: async (input) => {
      callLog.push({ ...input });
      if (input.action === "executeStart") return { jobId: input.jobId, planHash: input.planHash, batchCount: 4, mode: "execute", effectiveConcurrency: 2 };
      if (input.action === "dispatch") return { activeBatchIndexes: input.batchIndexes, queuedBatchCount: 4 - input.batchIndexes.length };
      if (input.action === "get") return {
        jobId: input.jobId, status: "running", desiredState: "running", mode: "execute", batchCount: 4,
        nextBatch: nextMissing(committed, 4), nextVerifyBatch: nextMissing(verified, 4),
      };
      if (input.action === "executeBatch" || input.action === "verifyBatch") {
        activeBatches += 1;
        maximumActive = Math.max(maximumActive, activeBatches);
        await new Promise((resolve) => setTimeout(resolve, 10));
        (input.action === "executeBatch" ? committed : verified).add(input.batchIndex);
        activeBatches -= 1;
        return { batchIndex: input.batchIndex };
      }
      if (input.action === "finish") return { status: "completed" };
      if (input.action === "heartbeat") return { status: "running" };
      throw new Error(`unexpected action ${input.action}`);
    },
  });
  const accepted = await runner.start({ jobId: "job-1", planHash: "a".repeat(64), confirmation: MONGODB_BULK_CONFIRMATION });
  assert.equal(accepted.effectiveConcurrency, 2);
  await runner.tasks.get("job-1");
  assert.deepEqual([...committed].sort(), [0, 1, 2, 3]);
  assert.deepEqual([...verified].sort(), [0, 1, 2, 3]);
  assert.equal(maximumActive, 2);
  assert.equal(callLog.at(-1).action, "finish");
});

test("job runner pauses only after the other in-flight batch settles", async () => {
  let active = 0;
  let completed = 0;
  let pauseObservedCompleted = 0;
  const runner = new MongoBulkJobRunner({
    config,
    runMongoBulk: async (input) => {
      if (input.action === "executeStart") return { jobId: input.jobId, planHash: input.planHash, batchCount: 2, mode: "execute" };
      if (input.action === "dispatch") return { activeBatchIndexes: input.batchIndexes };
      if (input.action === "get") return { status: "running", desiredState: "running", mode: "execute", batchCount: 2, nextBatch: 0, nextVerifyBatch: 0 };
      if (input.action === "executeBatch") {
        active += 1;
        await new Promise((resolve) => setTimeout(resolve, input.batchIndex === 0 ? 5 : 25));
        active -= 1;
        completed += 1;
        if (input.batchIndex === 0) throw Object.assign(new Error("conflict"), { code: "MONGODB_BULK_CONFLICT" });
        return {};
      }
      if (input.action === "pause") {
        assert.equal(active, 0);
        pauseObservedCompleted = completed;
        return { status: "paused" };
      }
      if (input.action === "heartbeat") return { status: "running" };
      throw new Error(`unexpected action ${input.action}`);
    },
  });
  await runner.start({ jobId: "job-2", planHash: "b".repeat(64), confirmation: MONGODB_BULK_CONFIRMATION });
  await runner.tasks.get("job-2");
  assert.equal(pauseObservedCompleted, 2);
});
