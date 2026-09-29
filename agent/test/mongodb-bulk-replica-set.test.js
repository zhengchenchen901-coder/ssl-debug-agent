import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { MongoBulkJobRunner, buildMongoBulkScript, normalizeMongoBulkChunk } from "../mongodb-bulk.js";

const replicaSetUri = process.env.MONGODB_BULK_TEST_URI;
const driverPath = process.env.MONGODB_BULK_TEST_DRIVER;
const integrationEnabled = typeof replicaSetUri === "string" && replicaSetUri.length > 0 &&
  typeof driverPath === "string" && driverPath.length > 0;

test("MongoDB bulk executes and rolls back a cross-collection transaction on a real replica set", { skip: !integrationEnabled }, async (t) => {
  const token = crypto.randomUUID().replace(/-/g, "");
  const bulkRoot = path.posix.join("/tmp", `rda-bulk-${token}`);
  const nativeRoot = path.resolve(bulkRoot);
  const configPath = path.join(os.tmpdir(), `rda-bulk-${token}.json`);
  const permissions = new Map();
  const directoryFds = new Set();
  let nextFakeFd = -100;
  const remoteFs = Object.create(fs);
  remoteFs.lstatSync = (filePath) => {
    const stat = fs.lstatSync(filePath);
    return new Proxy(stat, {
      get(target, property) {
        if (property === "mode" && permissions.has(String(filePath))) return (target.mode & ~0o777) | permissions.get(String(filePath));
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  remoteFs.chmodSync = (filePath, mode) => {
    permissions.set(String(filePath), mode & 0o777);
    return fs.chmodSync(filePath, mode);
  };
  remoteFs.renameSync = (from, to) => {
    fs.renameSync(from, to);
    if (permissions.has(String(from))) {
      permissions.set(String(to), permissions.get(String(from)));
      permissions.delete(String(from));
    }
  };
  remoteFs.unlinkSync = (filePath) => {
    fs.unlinkSync(filePath);
    permissions.delete(String(filePath));
  };
  remoteFs.openSync = (filePath, flags, mode) => {
    if (flags === "r") {
      try {
        if (fs.lstatSync(filePath).isDirectory()) {
          const fd = nextFakeFd--;
          directoryFds.add(fd);
          return fd;
        }
      } catch {}
    }
    return fs.openSync(filePath, flags, mode);
  };
  remoteFs.fsyncSync = (fd) => directoryFds.has(fd) ? undefined : fs.fsyncSync(fd);
  remoteFs.closeSync = (fd) => {
    if (directoryFds.has(fd)) { directoryFds.delete(fd); return; }
    return fs.closeSync(fd);
  };

  fs.mkdirSync(nativeRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(nativeRoot, 0o700);
  permissions.set(bulkRoot, 0o700);
  const storageMarkerPath = path.posix.join(bulkRoot, ".storage-v1.json");
  fs.writeFileSync(storageMarkerPath, JSON.stringify({ schemaVersion: 1, database: "testdb", receiptsCollection: "__remote_debug_bulk_receipts" }), { mode: 0o600 });
  permissions.set(storageMarkerPath, 0o600);
  fs.writeFileSync(configPath, JSON.stringify({ integration: { url: replicaSetUri } }), { mode: 0o600 });
  const config = {
    bulkEnabled: true,
    writeEnabled: true,
    configPath,
    driverPath,
    configProfile: "integration",
    uriKey: "url",
    database: "testdb",
    allowedDatabases: ["testdb"],
    allowedCollections: ["members", "private", "__remote_debug_bulk_receipts"],
    bulkRoot,
    bulkBatchDocuments: 500,
    bulkConcurrency: 2,
    bulkRollbackTtlMs: 7 * 24 * 60 * 60 * 1000,
  };
  const driverRequire = createRequire(path.join(driverPath, "package.json"));
  const driver = driverRequire(driverPath);
  const client = new driver.MongoClient(replicaSetUri, { serverSelectionTimeoutMS: 10_000 });
  t.after(async () => {
    try { await client.close(); } catch {}
    try { fs.rmSync(nativeRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(configPath, { force: true }); } catch {}
  });
  await client.connect();
  const db = client.db("testdb");
  const receipts = db.collection("__remote_debug_bulk_receipts");
  await receipts.createIndex({ expiresAt: 1 }, { name: "remote_debug_bulk_receipt_expiry", expireAfterSeconds: 0 });
  await receipts.replaceOne({ _id: "__remote_debug_bulk_storage_v1" }, { _id: "__remote_debug_bulk_storage_v1", schemaVersion: 1, database: "testdb", receiptsCollection: "__remote_debug_bulk_receipts" }, { upsert: true });
  await db.createCollection("private").catch((error) => { if (error.code !== 48) throw error; });

  const memberId = `member-${token}`;
  const privateId = `private-${token}`;
  await db.collection("members").insertOne({ _id: memberId, field: null, protected: "keep" });
  let loseCommitReply = false;
  const requestCounts = Object.create(null);
  const countedMethods = new Set(["find", "findOne", "bulkWrite", "insertOne", "updateOne", "deleteOne", "replaceOne"]);
  class InstrumentedMongoClient extends driver.MongoClient {
    db(...args) {
      const database = super.db(...args);
      return new Proxy(database, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== "collection" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
          return (...collectionArgs) => {
            const collection = value.apply(target, collectionArgs);
            return new Proxy(collection, {
              get(collectionTarget, method) {
                const methodValue = Reflect.get(collectionTarget, method, collectionTarget);
                if (typeof methodValue !== "function") return methodValue;
                return (...methodArgs) => {
                  if (countedMethods.has(String(method))) requestCounts[method] = (requestCounts[method] || 0) + 1;
                  return methodValue.apply(collectionTarget, methodArgs);
                };
              },
            });
          };
        },
      });
    }
  }
  const emit = async (input) => {
    const remoteDriver = { ...driver, MongoClient: InstrumentedMongoClient };
    if (loseCommitReply) {
      class CommitReplyLossMongoClient extends InstrumentedMongoClient {
        startSession(...args) {
          const session = super.startSession(...args);
          const commit = session.commitTransaction.bind(session);
          session.commitTransaction = async (...commitArgs) => {
            const result = await commit(...commitArgs);
            if (loseCommitReply) {
              loseCommitReply = false;
              throw new Error("injected lost commit reply after the server committed");
            }
            return result;
          };
          return session;
        }
      }
      remoteDriver.MongoClient = CommitReplyLossMongoClient;
    }
    let stdout = "";
    const remoteProcess = { pid: process.pid, exitCode: 0, stdout: { write(value) { stdout += value; } } };
    const remoteRequire = (specifier) => {
      if (specifier === "fs") return remoteFs;
      if (specifier === "path") return path.posix;
      if (specifier === "crypto") return crypto;
      if (specifier === driverPath) return remoteDriver;
      return driverRequire(specifier);
    };
    remoteRequire.resolve = driverRequire.resolve.bind(driverRequire);
    const request = input.action === "upload" ? { ...input, chunk: normalizeMongoBulkChunk(input.chunk, config) } : input;
    const script = buildMongoBulkScript(request, config).replace(/\n__bulkMain\(\);\s*$/, "\nglobalThis.__bulkDone = __bulkMain();");
    const context = { require: remoteRequire, process: remoteProcess, Buffer, setInterval, clearInterval, setTimeout };
    vm.runInNewContext(script, context);
    await context.__bulkDone;
    const marker = stdout.split(/\r?\n/).findLast((line) => line.startsWith("__REMOTE_DEBUG_MONGODB_RESULT__BULK:"));
    assert.ok(marker, "remote helper returned its structured response");
    const result = JSON.parse(marker.slice("__REMOTE_DEBUG_MONGODB_RESULT__BULK:".length));
    assert.equal(result.ok, true, result.error?.message);
    return result.data;
  };

  const jobId = `job-${token}`;
  const units = [{
    unitId: "member-private-link",
    operations: [
      { operation: "updateOne", collection: "members", id: memberId, expected: { field: { exists: true, value: null } }, update: { $set: { field: "updated" } } },
      { operation: "insertOne", collection: "private", document: { _id: privateId, owner: memberId } },
    ],
  }];
  const uploaded = await emit({ action: "upload", chunk: { jobId, database: "testdb", chunkIndex: 0, purpose: "replica-set integration", units } });
  assert.equal(uploaded.status, "uploading");
  const endChunk = { jobId, database: "testdb", chunkIndex: 1, purpose: "replica-set integration", units: [], endOfUpload: true };
  const [prepared, concurrentRetry] = await Promise.all([
    emit({ action: "upload", chunk: endChunk }),
    emit({ action: "upload", chunk: endChunk }),
  ]);
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.operationCount, 2);
  assert.equal(concurrentRetry.planHash, prepared.planHash);
  assert.equal((await emit({ action: "upload", chunk: { jobId, database: "testdb", chunkIndex: 1, purpose: "replica-set integration", units: [], endOfUpload: true } })).duplicate, true);

  const leaseId = crypto.randomBytes(32).toString("hex");
  await emit({ action: "executeStart", jobId, planHash: prepared.planHash, confirmation: "确认执行", leaseId });
  const dispatched = await emit({ action: "dispatch", jobId, planHash: prepared.planHash, leaseId, phase: "execute", batchIndexes: [0] });
  assert.deepEqual(dispatched.activeBatchIndexes, [0]);
  assert.equal(dispatched.queuedBatchCount, 0);
  loseCommitReply = true;
  const committed = await emit({ action: "executeBatch", jobId, planHash: prepared.planHash, leaseId, batchIndex: 0 });
  await emit({ action: "dispatch", jobId, planHash: prepared.planHash, leaseId, phase: "execute", batchIndexes: [] });
  assert.equal(committed.committedBatchCount, 1);
  assert.equal(committed.committed.inserted, 1);
  assert.equal(committed.committed.matched, 1);
  assert.equal(loseCommitReply, false);
  const memberAfter = await db.collection("members").findOne({ _id: memberId });
  assert.deepEqual({ field: memberAfter.field, protected: memberAfter.protected }, { field: "updated", protected: "keep" });
  assert.equal((await db.collection("private").findOne({ _id: privateId })).owner, memberId);

  await emit({ action: "verifyBatch", jobId, planHash: prepared.planHash, leaseId, batchIndex: 0 });
  const complete = await emit({ action: "finish", jobId, planHash: prepared.planHash, leaseId, mode: "execute" });
  assert.equal(complete.status, "completed");
  const rollbackLease = crypto.randomBytes(32).toString("hex");
  await emit({ action: "rollbackStart", jobId, planHash: prepared.planHash, confirmation: "确认回滚", leaseId: rollbackLease });
  await emit({ action: "rollbackBatch", jobId, planHash: prepared.planHash, leaseId: rollbackLease, batchIndex: 0 });
  const rolledBack = await emit({ action: "finish", jobId, planHash: prepared.planHash, leaseId: rollbackLease, mode: "rollback" });
  assert.equal(rolledBack.status, "rolled_back");
  const memberRestored = await db.collection("members").findOne({ _id: memberId });
  assert.deepEqual({ field: memberRestored.field, protected: memberRestored.protected }, { field: null, protected: "keep" });
  assert.equal(await db.collection("private").findOne({ _id: privateId }), null);

  if (process.env.MONGODB_BULK_PERFORMANCE === "1") {
    const counts = () => ({ ...requestCounts });
    const clearCounts = () => { for (const key of Object.keys(requestCounts)) delete requestCounts[key]; };
    const countTotal = (snapshot) => Object.values(snapshot).reduce((total, count) => total + count, 0);
    const jobBytes = (directory) => fs.readdirSync(directory).reduce((total, name) => {
      const entry = path.join(directory, name);
      const stat = fs.statSync(entry);
      return total + (stat.isDirectory() ? jobBytes(entry) : stat.size);
    }, 0);
    const runScenario = async ({ label, unitCount, paired }) => {
      const prefix = `${token}-${label}`;
      const jobId = `job-${prefix}`;
      const units = Array.from({ length: unitCount }, (_value, index) => {
        const memberKey = `${prefix}-member-${index}`;
        const operations = [{
          operation: "updateOne", collection: "members", id: memberKey,
          expected: { value: { exists: true, value: 0 } },
          update: { $set: { value: index + 1 } },
        }];
        if (paired) operations.push({ operation: "insertOne", collection: "private", document: { _id: `${prefix}-private-${index}`, owner: memberKey } });
        return { unitId: `${label}-unit-${index}`, operations };
      });
      for (let offset = 0; offset < unitCount; offset += 2000) {
        const seed = units.slice(offset, offset + 2000).map((unit) => ({ _id: unit.operations[0].id, value: 0, protected: "unchanged" }));
        await db.collection("members").insertMany(seed, { ordered: false });
      }

      clearCounts();
      const scenarioStart = performance.now();
      const prepareStart = performance.now();
      let chunkIndex = 0;
      for (let offset = 0; offset < units.length; offset += 1000) {
        const chunkUnits = units.slice(offset, offset + 1000);
        await emit({ action: "upload", chunk: { jobId, database: "testdb", chunkIndex, purpose: `synthetic-${label}`, units: chunkUnits } });
        chunkIndex += 1;
      }
      const plan = await emit({ action: "upload", chunk: { jobId, database: "testdb", chunkIndex, purpose: `synthetic-${label}`, units: [], endOfUpload: true } });
      const prepareMs = Math.round(performance.now() - prepareStart);
      assert.equal(plan.status, "prepared");
      const batchCount = plan.batchCount;
      if (paired) assert.equal(batchCount, 76);
      else assert.equal(batchCount, 2);
      const prepareCounts = counts();
      const preparedLogBytes = jobBytes(path.join(nativeRoot, jobId));

      clearCounts();
      const runner = new MongoBulkJobRunner({ config, runMongoBulk: emit });
      const executeStart = performance.now();
      await runner.start({ jobId, planHash: plan.planHash, confirmation: "确认执行" });
      await runner.tasks.get(jobId);
      const executeMs = Math.round(performance.now() - executeStart);
      const afterExecute = await emit({ action: "get", jobId });
      assert.equal(afterExecute.status, "completed");
      const executeCounts = counts();
      const executedLogBytes = jobBytes(path.join(nativeRoot, jobId));

      clearCounts();
      const rollbackStart = performance.now();
      await runner.start({ jobId, planHash: plan.planHash, confirmation: "确认回滚" }, "rollback");
      await runner.tasks.get(jobId);
      const rollbackMs = Math.round(performance.now() - rollbackStart);
      const afterRollback = await emit({ action: "get", jobId });
      assert.equal(afterRollback.status, "rolled_back");
      const rollbackCounts = counts();
      const totalMs = Math.round(performance.now() - scenarioStart);
      const result = {
        workload: label,
        units: unitCount,
        operations: unitCount * (paired ? 2 : 1),
        batches: batchCount,
        configuredAndEffectiveConcurrency: 2,
        elapsedMs: totalMs,
        prepareMs,
        executeAndVerifyMs: executeMs,
        rollbackMs,
        databaseCollectionCalls: {
          prepare: { byMethod: prepareCounts, total: countTotal(prepareCounts) },
          executeAndVerify: { byMethod: executeCounts, total: countTotal(executeCounts) },
          rollback: { byMethod: rollbackCounts, total: countTotal(rollbackCounts) },
        },
        persistentJobBytes: { afterPrepare: preparedLogBytes, peakAfterExecution: executedLogBytes },
        peakRollbackLogBytesPerBatch: Math.max(...plan.batches.map((batch) => batch.rollbackBytes)),
      };
      await db.collection("private").deleteMany({ _id: { $regex: `^${prefix}-private-` } });
      await db.collection("members").deleteMany({ _id: { $regex: `^${prefix}-member-` } });
      return result;
    };
    const performanceReport = {
      driver: driverRequire(path.join(driverPath, "package.json")).version,
      server: "MongoDB 4.2.24 single-node replica set",
      legacyTransactionCapacityEstimate: {
        crossCollectionTransactionsAt20Operations: Math.ceil((18854 * 2) / 20),
        updateTransactionsAt20Operations: Math.ceil(668 / 20),
        note: "Capacity estimate only; the legacy workflow elapsed time and wire request count were not replayed.",
      },
      workloads: [
        await runScenario({ label: "cross-collection-18854", unitCount: 18854, paired: true }),
        await runScenario({ label: "distinct-updates-668", unitCount: 668, paired: false }),
      ],
    };
    console.log(`BULK_PERFORMANCE_REPORT ${JSON.stringify(performanceReport)}`);
  }
});
