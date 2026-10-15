import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import crypto from "node:crypto";
import posixPath from "node:path/posix";
import { buildMongoMutationScript, normalizeMongoIndexChange, normalizeMongoMutation, normalizeMongoImport, normalizeMongoTransaction, runMongoMutation } from "../mongodb-mutations.js";
import { buildMongoBulkScript, normalizeMongoBulkConfig, normalizeMongoBulkStorage } from "../mongodb-bulk.js";
import { MONGODB_TECHNICAL_RECEIPTS_COLLECTION as receipts } from "../mongodb-ttl-policy.js";

const config = {
  enabled: true, writeEnabled: true, bulkEnabled: true,
  configPath: "/home/app/config.json", driverPath: "/home/app/node_modules/mongodb",
  configProfile: "test", uriKey: "url", database: "test",
  allowedDatabases: ["test"], allowedCollections: ["orders", receipts],
  bulkRoot: "/var/lib/remote-debug-agent/bulk-jobs",
};
const indexRequest = { operation: "createIndex", collection: "orders", name: "created_index", key: { createdAt: 1 } };
const clone = (value) => JSON.parse(JSON.stringify(value));
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

// Runs the complete fixed remote mutation helper with persistent in-memory
// journals and a MongoDB double. No server, database or local disk is touched.
function harness({ indexes = [], documents = [], namespaceType = "collection" } = {}) {
  const state = { indexes: clone(indexes), documents: clone(documents), events: [], dbCalls: 0 };
  const files = new Map([[config.configPath, JSON.stringify({ test: { url: "fixture-uri" } })]]);
  const directories = new Set();
  const handles = new Map();
  let sequence = 0;
  const fs = {
    constants: { O_CREAT: 1, O_APPEND: 2, O_WRONLY: 4 },
    existsSync: (name) => files.has(name) || directories.has(name),
    lstatSync: (name) => ({ isSymbolicLink: () => false, isDirectory: () => directories.has(name), isFile: () => files.has(name), mode: directories.has(name) ? 0o700 : 0o600, mtimeMs: Date.now() }),
    statSync: () => ({ mtimeMs: Date.now() }),
    mkdirSync(name) { for (let current = name; current !== "/"; current = posixPath.dirname(current)) directories.add(current); },
    chmodSync() {}, fsyncSync() {},
    openSync(name, flags) {
      if (flags === "wx" && files.has(name)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      if (flags === "w" || flags === "wx") files.set(name, "");
      const handle = ++sequence; handles.set(handle, { name, append: typeof flags === "number" }); return handle;
    },
    closeSync: (handle) => handles.delete(handle),
    readFileSync(name) { if (!files.has(name)) throw new Error("fixture file missing"); return files.get(name); },
    writeFileSync(handle, body) { const entry = handles.get(handle); files.set(entry.name, (entry.append ? files.get(entry.name) || "" : "") + body); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    unlinkSync: (name) => files.delete(name),
    readdirSync: (name) => [...directories].filter((item) => posixPath.dirname(item) === name).map((item) => posixPath.basename(item)),
  };
  const collection = {
    listIndexes() { return { toArray: async () => clone(state.indexes) }; },
    async createIndex(key, options) { state.events.push({ action: "createIndex", key: clone(key), options: clone(options) }); state.indexes.push({ key: clone(key), ...clone(options) }); return options.name; },
    async dropIndex(name) { state.events.push({ action: "dropIndex", name }); state.indexes = state.indexes.filter((item) => item.name !== name); },
    async findOne(filter) { return clone((Object.hasOwn(filter, "_id") ? state.documents.find((item) => item._id === filter._id) : state.documents[0]) || null); },
    async insertOne(document) { state.events.push({ action: "insertOne", document: clone(document) }); state.documents.push(clone(document)); },
  };
  class MongoClient {
    async connect() { state.dbCalls++; }
    async close() {}
    db() { return { collection: () => collection, listCollections: ({ name }) => ({ toArray: async () => state.documents.length || state.indexes.length || namespaceType !== "collection" ? [{ name, type: namespaceType }] : [] }) }; }
  }
  const require = (name) => {
    if (name === "fs") return fs;
    if (name === "path") return posixPath;
    if (name === "crypto") return crypto;
    if (name === config.driverPath) return { MongoClient };
    throw new Error("unexpected require in fixture: " + name);
  };
  require.resolve = () => { throw new Error("no BSON fixture dependency"); };
  async function execute(script) {
    let stdout = "";
    const process = { pid: 123, exitCode: 0, stdout: { write: (value) => { stdout += value; } } };
    await new vm.Script(script).runInNewContext({ require, process, Buffer });
    return { stdout, stderr: "", exitCode: process.exitCode, timedOut: false };
  }
  return {
    state, files,
    run: (request, policy = config) => runMongoMutation(request, { config: policy, runSSH: (_command, { stdin }) => execute(stdin) }),
    async raw(request, policy = config) {
      const result = await execute(buildMongoMutationScript(request, policy));
      return JSON.parse(result.stdout.split("__REMOTE_DEBUG_MONGODB_RESULT__")[1]);
    },
    async bulkFunctions(body, policy = config) {
      const script = buildMongoBulkScript({ action: "list" }, policy);
      const definitions = script.slice(0, script.lastIndexOf("__bulkMain();"));
      return new vm.Script(definitions + body).runInNewContext({ require, process: { pid: 123 }, Buffer });
    },
    installLegacy(manifest) {
      const plan = clone(manifest);
      plan.planHash = hash(Object.fromEntries(["schemaVersion", "mutationId", "operationId", "kind", "request", "before", "beforeIndex", "beforeOperations"].map((key) => [key, plan[key]])));
      const dir = `/tmp/remote-debug-agent/mutations/${plan.mutationId}`;
      fs.mkdirSync(dir); files.set(dir + "/manifest.json", JSON.stringify(plan));
      return plan;
    },
  };
}

function legacyPlan(operation, { ttl = true, status = "planned", kind = "index", collection = "orders" } = {}) {
  const index = { name: "created_index", key: { createdAt: 1 }, ...(ttl ? { expireAfterSeconds: 0 } : {}) };
  return {
    schemaVersion: 1, mutationId: "legacy-plan", operationId: "legacy-operation", kind,
    request: { database: "test", collection, operation, name: index.name, key: index.key, options: ttl && operation === "createIndex" ? { expireAfterSeconds: 0 } : {} },
    status, rollbackMode: "compensating", riskLevel: "medium", createdAt: new Date().toISOString(), rollbackExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    before: [], beforeIndex: operation === "dropIndex" ? index : null, beforeOperations: [], afterIndex: operation === "createIndex" ? index : null,
    affectedCount: 1, changedFields: ["createdAt"], affectedIds: [],
  };
}

test("generic index preparation rejects every TTL value before opening SSH", async () => {
  let calls = 0;
  for (const value of [0, 604800, -1, null, false, "0"]) {
    const request = { ...indexRequest, options: { expireAfterSeconds: value } };
    assert.throws(() => normalizeMongoIndexChange(request, config), { code: "MONGODB_TTL_INDEX_REJECTED" });
    await assert.rejects(runMongoMutation({ ...request, kind: "index" }, { config, runSSH: async () => { calls++; } }), { code: "MONGODB_TTL_INDEX_REJECTED" });
  }
  assert.equal(calls, 0);
  assert.deepEqual(normalizeMongoIndexChange({ ...indexRequest, options: { unique: true, sparse: true } }, config).options, { unique: true, sparse: true });
});

test("remote prepare and commit recheck TTL policy even for old validly hashed plans", async () => {
  const h = harness();
  const raw = await h.raw({ mode: "prepare", kind: "index", mutationId: "direct-ttl", mutation: { ...indexRequest, database: "test", rollbackTtlMs: 3600000, options: { expireAfterSeconds: 0 } } });
  assert.equal(raw.error.code, "MONGODB_TTL_INDEX_REJECTED");
  const plan = h.installLegacy(legacyPlan("createIndex"));
  await assert.rejects(h.run({ mode: "commit", mutationId: plan.mutationId, planHash: plan.planHash, confirmation: "确认执行" }), { code: "MONGODB_TTL_INDEX_REJECTED" });
  assert.equal(h.state.events.length, 0);
  assert.equal(JSON.parse(h.files.get(`/tmp/remote-debug-agent/mutations/${plan.mutationId}/manifest.json`)).status, "planned");
});

test("TTL drops cannot create a new misleading rollback promise or restore a legacy deleted TTL index", async () => {
  const index = { name: "created_index", key: { createdAt: 1 }, expireAfterSeconds: 0 };
  const h = harness({ indexes: [index] });
  await assert.rejects(h.run({ kind: "index", operation: "dropIndex", collection: "orders", name: index.name }), { code: "MONGODB_TTL_INDEX_REJECTED" });
  const drop = h.installLegacy(legacyPlan("dropIndex"));
  await assert.rejects(h.run({ mode: "commit", mutationId: drop.mutationId, planHash: drop.planHash, confirmation: "确认执行" }), { code: "MONGODB_TTL_INDEX_REJECTED" });
  const restored = harness();
  const committed = restored.installLegacy(legacyPlan("dropIndex", { status: "committed" }));
  await assert.rejects(restored.run({ mode: "rollback", mutationId: committed.mutationId, planHash: committed.planHash, confirmation: "确认回滚" }), { code: "MONGODB_TTL_INDEX_REJECTED" });
  assert.equal(h.state.events.length + restored.state.events.length, 0);
  assert.equal(restored.state.dbCalls, 0, "unsafe rollback is rejected before connecting to MongoDB");
});

test("rollback of an old TTL creation can still remove the index and never claims document recovery", async () => {
  const h = harness({ indexes: [{ name: "created_index", key: { createdAt: 1 }, expireAfterSeconds: 0 }] });
  const plan = h.installLegacy(legacyPlan("createIndex", { status: "committed" }));
  const result = await h.run({ mode: "rollback", mutationId: plan.mutationId, planHash: plan.planHash, confirmation: "确认回滚" });
  assert.equal(result.status, "rolled_back");
  assert.equal(result.rollbackRestoresDocuments, false);
  assert.deepEqual(h.state.events, [{ action: "dropIndex", name: "created_index" }]);
});

test("ordinary indexes can still prepare, commit and roll back", async () => {
  const h = harness();
  const plan = await h.run({ ...indexRequest, kind: "index", options: { sparse: true } });
  const committed = await h.run({ mode: "commit", mutationId: plan.mutationId, planHash: plan.planHash, confirmation: "确认执行" });
  assert.equal(committed.status, "committed");
  const rolledBack = await h.run({ mode: "rollback", mutationId: plan.mutationId, planHash: plan.planHash, confirmation: "确认回滚" });
  assert.equal(rolledBack.status, "rolled_back");
  assert.deepEqual(h.state.events.map((event) => event.action), ["createIndex", "dropIndex"]);
});

test("technical TTL targets cannot be redirected to a business collection", async () => {
  const policy = { ...config, bulkReceiptsCollection: "orders" };
  assert.throws(() => normalizeMongoBulkConfig(policy), { code: "MONGODB_BULK_RECEIPTS_RESERVED" });
  assert.throws(() => normalizeMongoBulkStorage({}, policy), { code: "MONGODB_BULK_RECEIPTS_RESERVED" });
  const h = harness();
  const plan = h.installLegacy({ ...legacyPlan("initializeBulkStorage", { kind: "bulk_storage" }), request: { database: "test", collection: "orders", operation: "initializeBulkStorage", storageRoot: config.bulkRoot } });
  await assert.rejects(h.run({ mode: "commit", mutationId: plan.mutationId, planHash: plan.planHash, confirmation: "确认执行" }, policy), { code: "MONGODB_BULK_RECEIPTS_RESERVED" });
  assert.equal(h.state.events.length, 0);
});

test("ordinary writes and indexes cannot pollute the reserved technical receipt collection", () => {
  const writes = [
    () => normalizeMongoMutation({ operation: "insertOne", collection: receipts, document: { _id: "business-data" } }, config),
    () => normalizeMongoImport({ collection: receipts, importId: "import", documents: [{ _id: "business-data" }] }, config),
    () => normalizeMongoTransaction({ operations: [{ operation: "insertOne", collection: receipts, document: { _id: "business-data" } }] }, config),
    () => normalizeMongoIndexChange({ ...indexRequest, collection: receipts }, config),
  ];
  for (const write of writes) assert.throws(write, { code: "MONGODB_BULK_RESERVED_COLLECTION" });
});

test("both technical initialization helpers check ownership before creating the fixed TTL index", async () => {
  for (const entry of ["mutation", "bulk"]) {
    const h = harness();
    if (entry === "mutation") {
      const plan = await h.run({ kind: "bulk_storage" });
      assert.equal((await h.run({ mode: "commit", mutationId: plan.mutationId, planHash: plan.planHash, confirmation: "确认执行" })).status, "committed");
    } else {
      await h.bulkFunctions("__bulkInitializeReceiptCollection(new (require(__driverPath).MongoClient)());");
    }
    assert.deepEqual(h.state.events.map((event) => event.action), ["insertOne", "createIndex"]);
    assert.equal(h.state.documents[0].receiptsCollection, receipts);
    assert.deepEqual(h.state.events[1], { action: "createIndex", key: { expiresAt: 1 }, options: { name: "remote_debug_bulk_receipt_expiry", expireAfterSeconds: 0 } });
    // An owned existing collection with receipts can be reused without another index write.
    h.state.documents.push({ _id: "receipt", expiresAt: new Date().toISOString() });
    await h.bulkFunctions("__bulkInitializeReceiptCollection(new (require(__driverPath).MongoClient)());");
    assert.equal(h.state.events.length, 2);
  }
});

test("technical TTL initialization refuses non-empty unowned collections and foreign markers", async () => {
  for (const documents of [[{ _id: "business-order", expiresAt: "2020-01-01" }], [{ _id: "__remote_debug_bulk_storage_v1", schemaVersion: 1, database: "other", receiptsCollection: receipts }]]) {
    for (const entry of ["mutation", "bulk"]) {
      const h = harness({ documents });
      if (entry === "mutation") {
        const plan = await h.run({ kind: "bulk_storage" });
        await assert.rejects(h.run({ mode: "commit", mutationId: plan.mutationId, planHash: plan.planHash, confirmation: "确认执行" }), { code: "MONGODB_BULK_STORAGE_CONFLICT" });
      } else {
        await assert.rejects(h.bulkFunctions("__bulkInitializeReceiptCollection(new (require(__driverPath).MongoClient)());"), { code: "MONGODB_BULK_STORAGE_CONFLICT" });
      }
      assert.equal(h.state.events.length, 0);
    }
  }
});

test("technical cleanup rejects views, missing markers and altered TTL index definitions", async () => {
  const view = harness({ namespaceType: "view" });
  await assert.rejects(view.bulkFunctions("__bulkInitializeReceiptCollection(new (require(__driverPath).MongoClient)());"), { code: "MONGODB_BULK_STORAGE_CONFLICT" });
  const index = { name: "remote_debug_bulk_receipt_expiry", key: { expiresAt: 1 }, expireAfterSeconds: 0 };
  const missing = harness({ indexes: [index] });
  await assert.rejects(missing.bulkFunctions("__bulkCheckStorageCollection(new (require(__driverPath).MongoClient)());"), { code: "MONGODB_BULK_STORAGE_NOT_INITIALIZED" });
  const marker = { _id: "__remote_debug_bulk_storage_v1", schemaVersion: 1, database: "test", receiptsCollection: receipts };
  for (const override of [{ key: { expiresAt: 1, other: 1 } }, { expireAfterSeconds: 3600 }, { partialFilterExpression: { kind: "business" } }, { unique: true }]) {
    const changed = harness({ documents: [marker], indexes: [{ ...index, ...override }] });
    await assert.rejects(changed.bulkFunctions("__bulkInitializeReceiptCollection(new (require(__driverPath).MongoClient)());"), { code: "MONGODB_BULK_STORAGE_CONFLICT" });
    assert.equal(changed.state.events.length, 0);
  }
});
