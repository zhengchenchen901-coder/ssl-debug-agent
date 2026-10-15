import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { buildMongoBulkScript, normalizeMongoBulkChunk } from "../../mongodb-bulk.js";

export function bulkSandboxFixture(t) {
  const nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bulk-sandbox-"));
  t.after(() => fs.rmSync(nativeRoot, { recursive: true, force: true }));
  const root = "/var/lib/remote-debug-agent/bulk-jobs";
  const config = { enabled: true, writeEnabled: true, bulkEnabled: true, configPath: "/home/app/config.json", driverPath: "/home/app/node_modules/mongodb", configProfile: "business", uriKey: "url", database: "business", sandboxDatabase: "remote_debug_agent", sandboxManagementProfile: "manager", allowedDatabases: ["business"], allowedCollections: ["orders"], bulkRoot: root, bulkBatchDocuments: 2, bulkConcurrency: 1 };
  const state = { collections: new Map(), indexes: new Map(), events: [], rejectReceipt: false, loseReply: false, unsafeManager: false };
  const translate = (name) => name === config.configPath ? path.join(nativeRoot, "config.json") : name.startsWith(root) ? path.join(nativeRoot, "jobs", name.slice(root.length)) : name;
  fs.mkdirSync(translate(root), { mode: 0o700 });
  fs.writeFileSync(translate(config.configPath), JSON.stringify({ business: { url: "mongodb://business:fixture@127.0.0.1:27017/?replicaSet=fixture" }, manager: { url: "mongodb://manager:fixture@127.0.0.1:27017/?replicaSet=fixture" } }));
  const remoteFs = Object.create(fs);
  for (const method of ["existsSync", "lstatSync", "statSync", "mkdirSync", "chmodSync", "readFileSync", "readdirSync", "unlinkSync", "rmdirSync", "utimesSync"]) remoteFs[method] = (name, ...args) => fs[method](translate(name), ...args);
  if (process.platform === "win32") {
    remoteFs.lstatSync = (name) => {
      const stat = fs.lstatSync(translate(name));
      return new Proxy(stat, { get(target, property) { if (property === "mode") return (target.mode & ~0o777) | (target.isDirectory() ? 0o700 : 0o600); const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value; } });
    };
  }
  remoteFs.renameSync = (from, to) => fs.renameSync(translate(from), translate(to));
  remoteFs.realpathSync = (name) => {
    const result = fs.realpathSync(translate(name));
    const relative = path.relative(path.join(nativeRoot, "jobs"), result);
    return relative.startsWith("..") ? "/outside/" + relative.replaceAll(path.sep, "/") : root + (relative ? "/" + relative.replaceAll(path.sep, "/") : "");
  };
  const directoryFds = new Set(); let fakeFd = -1;
  remoteFs.openSync = (name, flags, mode) => {
    if (flags === "r" && fs.lstatSync(translate(name)).isDirectory()) { const fd = fakeFd--; directoryFds.add(fd); return fd; }
    return fs.openSync(translate(name), flags, mode);
  };
  remoteFs.fsyncSync = (fd) => directoryFds.has(fd) ? undefined : fs.fsyncSync(fd);
  remoteFs.closeSync = (fd) => directoryFds.has(fd) ? directoryFds.delete(fd) : fs.closeSync(fd);
  const clone = (value) => structuredClone(value);
  const match = (document, filter) => Object.entries(filter).every(([key, expected]) => {
    const actual = document[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected) && !Object.prototype.toString.call(expected).includes("Date")) {
      if (expected.$exists !== undefined && Object.hasOwn(document, key) !== expected.$exists) return false;
      if (Object.hasOwn(expected, "$eq")) return JSON.stringify(actual) === JSON.stringify(expected.$eq);
      if (expected.$exists !== undefined) return true;
      if (expected.$in) return expected.$in.includes(actual);
      if (expected.$lte) return new Date(actual).getTime() <= new Date(expected.$lte).getTime();
    }
    return JSON.stringify(actual) === JSON.stringify(expected);
  });
  const rows = (db, name, session) => {
    const key = db + "/" + name, store = session?.snapshot || state.collections;
    if (!store.has(key)) store.set(key, new Map());
    return store.get(key);
  };
  function collection(db, name) {
    return {
      async findOne(filter, options = {}) { return clone([...rows(db, name, options.session).values()].find((doc) => match(doc, filter)) || null); },
      find(filter, options = {}) { let limit = Infinity; const cursor = { limit(n) { limit = n; return cursor; }, maxTimeMS() { return cursor; }, async toArray() { return clone([...rows(db, name, options.session).values()].filter((doc) => match(doc, filter)).slice(0, limit)); } }; return cursor; },
      async insertOne(doc, options = {}) {
        state.events.push({ action: "insert", db, name, session: options.session, id: doc._id });
        if (name === "__remote_debug_bulk_receipts" && options.session && state.rejectReceipt) throw new Error("receipt permission denied");
        const store = rows(db, name, options.session);
        if (store.has(doc._id)) throw Object.assign(new Error("duplicate"), { code: 11000 });
        store.set(doc._id, clone(doc)); return { insertedId: doc._id };
      },
      async deleteMany(filter) { state.events.push({ action: "deleteMany", db, name, filter: clone(filter) }); let count = 0; const store = rows(db, name); for (const [id, doc] of store) if (match(doc, filter)) { store.delete(id); count++; } return { deletedCount: count }; },
      listIndexes() { return { toArray: async () => clone(state.indexes.get(db + "/" + name) || []) }; },
      async createIndex(key, options) { const id = db + "/" + name; const indices = state.indexes.get(id) || []; indices.push({ key: clone(key), ...clone(options) }); state.indexes.set(id, indices); return options.name; },
      async bulkWrite(operations, options) {
        state.events.push({ action: "businessWrite", db, name, session: options.session });
        const store = rows(db, name, options.session); let insertedCount = 0, matchedCount = 0, modifiedCount = 0, deletedCount = 0;
        for (const op of operations) {
          if (op.insertOne) { store.set(op.insertOne.document._id, clone(op.insertOne.document)); insertedCount++; }
          if (op.updateOne) { const doc = [...store.values()].find((item) => match(item, op.updateOne.filter)); if (doc) { matchedCount++; modifiedCount++; for (const [key, value] of Object.entries(op.updateOne.update.$set || {})) doc[key] = value; for (const [key, value] of Object.entries(op.updateOne.update.$inc || {})) doc[key] += value; } }
          if (op.replaceOne) { const id = op.replaceOne.filter._id; if (store.has(id)) { store.set(id, clone(op.replaceOne.replacement)); matchedCount++; } }
          if (op.deleteOne) { if (store.delete(op.deleteOne.filter._id)) deletedCount++; }
        }
        return { insertedCount, matchedCount, modifiedCount, deletedCount };
      },
    };
  }
  class MongoClient {
    constructor(uri) { this.uri = uri; }
    async connect() {}
    async close() {}
    db(db) {
      return { collection: (name) => collection(db, name), listCollections: (filter) => ({ toArray: async () => [...state.collections.keys()].filter((key) => key.startsWith(db + "/")).map((key) => ({ name: key.slice(db.length + 1), type: "collection" })).filter((item) => match(item, filter)) }), command: async () => ({ authInfo: { authenticatedUserPrivileges: [{ resource: { db: state.unsafeManager ? "business" : "remote_debug_agent", collection: "__remote_debug_bulk_receipts" }, actions: ["find", "remove"] }] } }) };
    }
    startSession() {
      return { snapshot: null, startTransaction() { this.snapshot = clone(state.collections); }, async commitTransaction() { state.collections = this.snapshot; this.snapshot = null; if (state.loseReply) { state.loseReply = false; throw new Error("lost commit reply"); } }, async abortTransaction() { this.snapshot = null; }, async endSession() {} };
    }
  }
  const remoteRequire = (name) => {
    if (name === "fs") return remoteFs;
    if (name === "path") return path.posix;
    if (name === "crypto") return crypto;
    if (name === config.driverPath) return { MongoClient };
    throw new Error("unexpected dependency: " + name);
  };
  remoteRequire.resolve = () => { throw new Error("BSON unavailable"); };
  async function run(input, policy = config) {
    const request = input.action === "upload" ? { ...input, chunk: normalizeMongoBulkChunk(input.chunk, policy) } : input;
    const script = buildMongoBulkScript(request, policy).replace(/\n__bulkMain\(\);\s*$/, "\nglobalThis.done = __bulkMain();");
    let stdout = "";
    const context = { require: remoteRequire, process: { pid: process.pid, stdout: { write: (text) => { stdout += text; } } }, Buffer, setInterval, clearInterval, setTimeout };
    vm.runInNewContext(script, context); await context.done;
    const result = JSON.parse(stdout.split("__REMOTE_DEBUG_MONGODB_RESULT__BULK:")[1]);
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.data;
  }
  async function initialize() {
    // Exercise the exact initialization routine embedded in the helper.
    const script = buildMongoBulkScript({ action: "list" }, config);
    const definitions = script.slice(0, script.lastIndexOf("__bulkMain();"));
    await vm.runInNewContext(definitions + "__bulkPrepareStorage();", { require: remoteRequire, process: { pid: process.pid }, Buffer });
    rows("business", "orders").set("order-1", { _id: "order-1", count: 0 });
  }
  const read = (jobId, name) => JSON.parse(fs.readFileSync(translate(root + "/" + jobId + "/" + name), "utf8"));
  const write = (jobId, name, data) => fs.writeFileSync(translate(root + "/" + jobId + "/" + name), JSON.stringify(data), { mode: 0o600 });
  return { config, state, rows, run, initialize, read, write, nativeRoot, translate, collection, async definitions(code) { const script = buildMongoBulkScript({ action: "list" }, config); return vm.runInNewContext(script.slice(0, script.lastIndexOf("__bulkMain();")) + code, { require: remoteRequire, process: { pid: process.pid }, Buffer, setInterval, clearInterval, setTimeout }); } };
}
