import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import test from "node:test";
import { localMcp } from "./helpers/local-mcp.js";
import { runMongoQuery } from "../../../agent/mongodb.js";
import { runMongoMutation } from "../../../agent/mongodb-mutations.js";
import { runMongoBulk } from "../../../agent/mongodb-bulk.js";

// Explicit opt-in, dedicated disposable loopback replica set only. Never reads
// the user's instance registry, SSH settings, or application connection profile.
const uri = process.env.RDA_PRIVACY_TEST_URI, driverPath = process.env.RDA_PRIVACY_TEST_DRIVER;
const helperContainer = process.env.RDA_PRIVACY_TEST_CONTAINER;
if (helperContainer && !/^rda-win-privacy-[a-f0-9]+$/.test(helperContainer)) throw new Error("Disposable helper container name required");
if (!uri || !/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !uri.includes("directConnection=true") || !driverPath) {
  throw new Error("Set RDA_PRIVACY_TEST_URI to a dedicated disposable loopback replica set with directConnection=true, and RDA_PRIVACY_TEST_DRIVER to its local driver.");
}

test("real isolated MongoDB: persistent MCP references, restart, write/transaction/import/index/bulk, uncertain receipt recovery and rollback", { timeout: helperContainer ? 300000 : 120000 }, async (t) => {
  const suffix = randomUUID().replaceAll("-", ""), database = `privacy_${suffix}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rda-privacy-db-"));
  const remoteRoot = helperContainer ? `/tmp/rda-privacy-fixture-${suffix}` : root;
  const rollbackRoot = `/tmp/remote-debug-agent/privacy-${suffix}`;
  const driver = createRequire(import.meta.url)(driverPath);
  const configFile = helperContainer ? `${remoteRoot}/config.json` : path.join(root, "config.json");
  const config = { enabled: true, writeEnabled: true, bulkEnabled: true, configPath: `/home/app/privacy-${suffix}.json`,
    driverPath: "/home/app/node_modules/mongodb", configProfile: "isolated", uriKey: "url", database, sandboxDatabase: `remote_debug_agent_${suffix}`,
    allowedDatabases: [database], allowedCollections: ["orders", "links", "imports"], rollbackRoot,
    rollbackTtlMs: 3600000, bulkRoot: helperContainer ? `${remoteRoot}/bulk` : path.join(root, "bulk"), bulkBatchDocuments: 2, bulkConcurrency: 1 };
  const remoteDriver = process.env.RDA_PRIVACY_TEST_REMOTE_DRIVER || driverPath;
  if (helperContainer) {
    const setup = `const fs=require('fs');fs.mkdirSync(${JSON.stringify(config.bulkRoot)},{recursive:true,mode:0o700});fs.writeFileSync(${JSON.stringify(configFile)},${JSON.stringify(JSON.stringify({ isolated: { url: process.env.RDA_PRIVACY_TEST_REMOTE_URI } }))},{mode:0o600});`;
    execFileSync("docker", ["exec", "-i", helperContainer, "node"], { input: setup, stdio: ["pipe", "pipe", "pipe"] });
  } else {
    await fs.mkdir(config.bulkRoot, { mode: 0o700 });
    await fs.writeFile(configFile, JSON.stringify({ isolated: { url: uri } }), { mode: 0o600 });
  }
  const client = await driver.MongoClient.connect(uri, { serverSelectionTimeoutMS: 5000 });
  t.after(async () => {
    try { await client.db(database).dropDatabase(); await client.db(config.sandboxDatabase).dropDatabase(); }
    finally { await client.close(); await fs.rm(root, { recursive: true, force: true }); if (!helperContainer) await fs.rm(rollbackRoot, { recursive: true, force: true }); }
  });
  const db = client.db(database);
  for (const collection of config.allowedCollections) await db.createCollection(collection);
  const raw = { _id: new driver.ObjectId(), userId: driver.Long.fromString("9007199254740993"), businessKey: `private-key-${suffix}`, count: 0, status: "new" };
  await db.collection("orders").insertOne(raw);
  const compoundId = { tenant: "private-compound-tenant", sequence: 2 };
  await db.collection("orders").insertOne({ _id: compoundId, count: 0 });
  const options = { config: { mongodb: config }, runSSH: async (_command, { stdin }) => {
    return new Promise((resolve, reject) => {
      const child = helperContainer ? spawn("docker", ["exec", "-i", helperContainer, "node"], { stdio: ["pipe", "pipe", "pipe"] }) : spawn(process.execPath, [], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject); child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode, timedOut: false }));
      // Translate the fixed remote config/driver names into this test's local
      // files without creating /home/app or relaxing production path policies.
      const prelude = `const __testRequire = require; const __testFs = Object.create(require("node:fs"));
        for (const method of ["readFileSync", "statSync", "lstatSync", "existsSync", "realpathSync"]) __testFs[method] = (file, ...args) => __testRequire("node:fs")[method](file === ${JSON.stringify(config.configPath)} ? ${JSON.stringify(configFile)} : file, ...args);
        require = (name) => name === "fs" ? __testFs : __testRequire(name === ${JSON.stringify(config.driverPath)} ? ${JSON.stringify(helperContainer ? remoteDriver : driverPath)} : name);
        require.resolve = (name) => __testRequire.resolve(name === ${JSON.stringify(config.driverPath)} ? ${JSON.stringify(helperContainer ? remoteDriver : driverPath)} : name, { paths: [${JSON.stringify(helperContainer ? remoteDriver : driverPath)}] });\n`;
      child.stdin.end(prelude + stdin);
    });
  } };
  const bulk = (input) => runMongoBulk(input, options);
  const clean = ({ instanceId, operationId, deadlineAt, ...input }) => input;
  const instance = { id: "isolated-local", host: "127.0.0.1", port: 22, mongodb: config };
  const f = await localMcp(t, { instance, nativeKey: process.platform === "win32", pluginRoot: process.env.RDA_PRIVACY_TEST_PLUGIN_ROOT, handler: async (route, body) => {
    const input = clean(body);
    if (route === "/mongodb/query") return runMongoQuery(input, options);
    if (route === "/mongodb/mutations/prepare") return runMongoMutation({ ...input, mode: "prepare" }, options);
    if (route === "/mongodb/imports/prepare") return runMongoMutation({ ...input, kind: "import_plan", mode: "prepare" }, options);
    if (route === "/mongodb/mutations/execute") return runMongoMutation({ ...input, mode: "commit" }, options);
    if (route === "/mongodb/mutations/rollback") return runMongoMutation({ ...input, mode: "rollback" }, options);
    if (route === "/mongodb/bulk/storage/prepare") return runMongoMutation({ ...input, kind: "bulk_storage", mode: "prepare" }, options);
    if (route === "/mongodb/bulk/prepare") return bulk({ action: "upload", chunk: input });
    if (route === "/mongodb/bulk/job") return bulk({ ...input, action: "get" });
    if (route === "/mongodb/bulk/execute" || route === "/mongodb/bulk/rollback") {
      const mode = route.endsWith("/rollback") ? "rollback" : "execute", leaseId = (mode === "rollback" ? "b" : "a").repeat(64);
      const initial = await bulk({ ...input, leaseId, action: mode === "rollback" ? "rollbackStart" : "executeStart" });
      const state = { jobId: input.jobId, planHash: input.planHash, leaseId };
      const indexes = Array.from({ length: initial.batchCount }, (_, index) => index);
      if (mode === "rollback") indexes.reverse();
      for (const batchIndex of indexes) {
        await bulk({ ...state, action: mode === "rollback" ? "rollbackBatch" : "executeBatch", batchIndex });
        if (mode !== "rollback") await bulk({ ...state, action: "verifyBatch", batchIndex });
      }
      return bulk({ ...state, action: "finish", mode });
    }
    throw Object.assign(new Error("Unexpected isolated route"), { code: "FIXTURE_ROUTE" });
  } });
  async function call(name, input = {}) {
    const result = await f.call(name, input);
    assert.notEqual(result.isError, true, JSON.stringify(result.payload));
    assert.equal(result.payload.ok, true);
    return result.payload;
  }
  const commit = (plan) => call("remote_debug_mongodb_execute_mutation", { mutationId: plan.mutationId, planHash: plan.planHash, confirmation: "确认执行" });
  const rollback = (plan) => call("remote_debug_mongodb_rollback_mutation", { mutationId: plan.mutationId, planHash: plan.planHash, confirmation: "确认回滚" });
  const found = await call("remote_debug_mongodb_query", { operation: "findOne", collection: "orders", filter: {} });
  const row = found.data; assert.match(row._id, /^rda_ref_v1_/); assert.match(row.userId, /^rda_ref_v1_/); assert.match(row.businessKey, /^rda_ref_v1_/);
  await f.restart();
  const selected = await call("remote_debug_mongodb_query", { operation: "find", collection: "orders", filter: { _id: row._id, userId: row.userId } });
  assert.equal(selected.resultCount, 1); assert.equal(selected.data[0]._id, row._id);
  const compound = await call("remote_debug_mongodb_query", { operation: "findOne", collection: "orders", filter: { _id: compoundId } });
  const compoundAgain = await call("remote_debug_mongodb_query", { operation: "findOne", collection: "orders", filter: { _id: compound.data._id } });
  assert.equal(compoundAgain.data._id, compound.data._id);
  const write = await call("remote_debug_mongodb_prepare_write", { operation: "updateOne", collection: "orders", filter: { _id: row._id }, update: { $set: { buyerId: row.userId } } });
  assert.equal(write.affectedIds[0], row._id);
  const refused = await f.call("remote_debug_mongodb_execute_mutation", { mutationId: write.mutationId, planHash: write.planHash, confirmation: "wrong" });
  assert.equal(refused.payload.error.code, "MONGODB_MUTATION_CONFIRMATION_REQUIRED");
  await commit(write); assert.equal((await db.collection("orders").findOne({ _id: raw._id }, { promoteLongs: false })).buyerId.toString(), "9007199254740993"); await rollback(write);
  const transaction = await call("remote_debug_mongodb_prepare_transaction", { operations: [
    { operation: "updateOne", collection: "orders", filter: { _id: row._id }, update: { $inc: { count: 1 } } },
    { operation: "insertOne", collection: "links", document: { _id: row._id, userId: row.userId, businessKey: row.businessKey } },
  ] });
  await commit(transaction); assert.equal((await db.collection("links").findOne({ _id: raw._id })).businessKey, raw.businessKey); await rollback(transaction);
  const imported = await call("remote_debug_mongodb_prepare_import", { importId: `import-${suffix}`, collection: "imports", documents: [{ _id: row._id, userId: row.userId }] });
  for (const batch of imported.batches) await commit(batch);
  assert.equal(await db.collection("imports").countDocuments({ _id: raw._id }), 1);
  for (const batch of imported.batches) await rollback(batch);
  const index = await call("remote_debug_mongodb_prepare_index", { operation: "createIndex", collection: "orders", name: "privacy_business_idx", key: { userId: 1, businessKey: 1 } });
  await commit(index); assert.ok((await db.collection("orders").indexes()).some((item) => item.name === "privacy_business_idx")); await rollback(index);
  const storage = await call("remote_debug_mongodb_prepare_bulk_storage"); await commit(storage);
  const jobId = `privacy-${suffix}`;
  const uploaded = await call("remote_debug_mongodb_prepare_bulk", { jobId, chunkIndex: 0, units: [{ unitId: "unit-1", operations: [{ operation: "updateOne", collection: "orders", id: row._id,
    expected: { count: { exists: true, value: 0 } }, update: { $inc: { count: 1 } } }] }] });
  assert.match(uploaded.chunkHash, /^[a-f0-9]{64}$/);
  const plan = await call("remote_debug_mongodb_prepare_bulk", { jobId, chunkIndex: 1, units: [], endOfUpload: true });
  assert.equal(plan.batches[0].sampleIds[0].id, row._id);
  f.dropNextReply("/mongodb/bulk/execute");
  const execution = { jobId, planHash: plan.planHash, confirmation: "确认执行" };
  const lost = await f.call("remote_debug_mongodb_execute_bulk", execution);
  assert.equal(lost.isError, true); assert.equal((await db.collection("orders").findOne({ _id: raw._id })).count, 1);
  await f.restart();
  const retry = await f.call("remote_debug_mongodb_execute_bulk", execution);
  if (process.platform === "win32") {
    // The existing recovery dispatch includes fields the strict bulk/get route
    // rejects. Preserve this fail-closed behavior rather than changing shared
    // recovery code in a platform-storage patch. A separate read below checks
    // the terminal job; the original uncertain intent must remain protected.
    assert.equal(retry.payload.error?.code, "BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
    const recovery = await call("remote_debug_mongodb_recover_operation", { intentId: retry.payload.error.intentId, mode: "inspect" });
    assert.equal(recovery.state, "uncertain");
  } else {
    assert.notEqual(retry.isError, true, JSON.stringify(retry.payload)); assert.equal(retry.payload.status, "completed", "Exact remote job + plan terminal evidence reconciles the lost acknowledgment");
  }
  assert.equal((await db.collection("orders").findOne({ _id: raw._id })).count, 1, "Uncertain retry must not replay the increment");
  assert.equal(f.requests.filter((request) => request.path === "/mongodb/bulk/execute").length, 1, "Reconciliation must not dispatch execute a second time");
  const done = await call("remote_debug_mongodb_get_bulk_job", { jobId });
  assert.equal(done.status, "completed"); assert.equal((await db.collection("orders").findOne({ _id: raw._id })).count, 1);
  const completed = await call("remote_debug_mongodb_get_bulk_job", { jobId, includeDifferences: true });
  assert.equal(completed.status, "completed"); assert.equal(completed.planHash, plan.planHash);
  const completedId = completed.planPreview[0].sampleIds[0].id; assert.equal(completedId, row._id);
  const followup = await call("remote_debug_mongodb_prepare_write", { operation: "updateOne", collection: "orders", filter: { _id: completedId }, update: { $set: { status: "checked" } } });
  await commit(followup); assert.equal((await db.collection("orders").findOne({ _id: raw._id })).status, "checked"); await rollback(followup);
  const undone = await call("remote_debug_mongodb_rollback_bulk_job", { jobId, planHash: plan.planHash, confirmation: "确认回滚" });
  assert.equal(undone.status, "rolled_back"); assert.equal((await db.collection("orders").findOne({ _id: raw._id })).count, 0);
  const delivered = f.wire.join("") + f.diagnostics.join("") + JSON.stringify(f.previews);
  for (const value of [raw._id.toHexString(), raw.userId.toString(), raw.businessKey]) assert.ok(!delivered.includes(value), "Raw business identifier must not reach MCP output, diagnostics or preview");
  assert.equal(await db.collection("links").countDocuments({}), 0); assert.equal(await db.collection("imports").countDocuments({}), 0);
});
