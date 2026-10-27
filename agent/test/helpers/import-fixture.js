import realFs from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import crypto from "node:crypto";
import path from "node:path/posix";
import { runMongoMutation } from "../../mongodb-mutations.js";
export const importConfig = {
  enabled: true, writeEnabled: true, configPath: "/home/app/config.json", driverPath: "/home/app/node_modules/mongodb",
  configProfile: "test", uriKey: "url", database: "test", allowedDatabases: ["test"],
  allowedCollections: ["members"], maxAffectedDocuments: 20,
};

export function importHarness({ cryptoModule = crypto, readPreference = "primary", legacyBson = false, cleanup = () => Promise.resolve(), realFiles, fault, beforeRename } = {}) {
  const files = new Map([[importConfig.configPath, JSON.stringify({ test: { url: "test-uri" } })]]);
  const directories = new Set();
  const fds = new Map();
  let fd = 0;
  const state = { rows: new Map(), find: 0, insert: 0, remove: 0, failInsert: false, loseCommitReply: false, failConnect: false, collectionExists: true, collectionType: "collection", wireVersion: 9, replicaSet: true, sessions: 30, privileges: true, failAbort: false, swallowedAbort: false, preflightError: null, created: 0 };
  let fs = {
    constants: { O_CREAT: 1, O_APPEND: 2, O_WRONLY: 4 },
    existsSync: (p) => files.has(p) || directories.has(p),
    lstatSync: () => ({ isSymbolicLink: () => false, mtimeMs: Date.now() }),
    statSync: () => ({ mtimeMs: Date.now() }),
    mkdirSync: (p) => { directories.add(p); directories.add(path.dirname(p)); },
    chmodSync() {}, fsyncSync() {},
    openSync(p, flags) {
      if (flags === "wx" && files.has(p)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      if (flags === "w" || flags === "wx") files.set(p, "");
      fds.set(++fd, { p, append: typeof flags === "number" });
      return fd;
    },
    closeSync: (n) => fds.delete(n),
    writeFileSync(n, value) { const { p, append } = fds.get(n); files.set(p, (append ? files.get(p) || "" : "") + value); },
    readFileSync(p) { if (!files.has(p)) throw new Error(`missing ${p}`); return files.get(p); },
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
    unlinkSync: (p) => files.delete(p),
    readdirSync: (p) => [...directories].filter((d) => path.dirname(d) === p).map((d) => path.basename(d)),
  };
  if (realFiles) {
    const translate = p => {
      if (typeof p === "number") return p;
      const root = "/tmp/remote-debug-agent/mutations";
      if (p !== root && !p.startsWith(root + "/")) throw Error("Unexpected fixture filesystem path");
      return realFiles + p.slice(root.length);
    };
    fs = { constants: realFs.constants, closeSync: realFs.closeSync, fsyncSync: realFs.fsyncSync };
    for (const method of ["existsSync", "lstatSync", "statSync", "mkdirSync", "chmodSync", "openSync", "unlinkSync", "readdirSync", "writeFileSync"])
      fs[method] = (p, ...args) => realFs[method](translate(p), ...args);
    fs.readFileSync = (p, ...args) => p === importConfig.configPath ? JSON.stringify({ test: { url: "fixture-only" } }) : realFs.readFileSync(translate(p), ...args);
    fs.renameSync = (a, b) => { beforeRename?.(translate(a), translate(b)); realFs.renameSync(translate(a), translate(b)); fault?.(translate(b)); };
  }
  class Oid {
    constructor(hex) { this.hex = hex; this._bsontype = "ObjectID"; }
    toJSON() { return this.hex; }
    toHexString() { return this.hex; }
  }
  const encode = (v) => v instanceof Oid ? { $oid: v.hex } : Array.isArray(v) ? v.map(encode) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, encode(value)])) : v;
  const bson = { EJSON: { stringify: (v) => JSON.stringify(encode(v)), parse: (s) => JSON.parse(s, (_k, v) => v?.$oid ? new Oid(v.$oid) : v) } };
  const key = (id) => JSON.stringify(encode(id));
  const clone = (value) => bson.EJSON.parse(bson.EJSON.stringify(value));
  const cloneRows = () => new Map([...state.rows].map(([k, v]) => [k, clone(v)]));
  const collection = {
    async findOne(filter, options) {
      if (legacyBson && typeof filter._id === "object") assert.ok(filter._id instanceof Oid);
      return clone((options?.session?.rows || state.rows).get(key(filter._id)) || null);
    },
    async insertOne(document, options) { return this.insertMany([document], options); },
    async deleteOne(filter, options) { return this.deleteMany({ _id: { $in: [filter._id] } }, options); },
    async updateOne(filter, update, { session }) {
      if (legacyBson && typeof filter._id === "object") assert.ok(filter._id instanceof Oid);
      const row = session.rows.get(key(filter._id));
      if (!row) return { n: 0 };
      Object.assign(row, clone(update.$set));
      return { n: 1 };
    },
    async replaceOne(filter, document, { session }) {
      if (legacyBson && typeof filter._id === "object") assert.ok(filter._id instanceof Oid);
      if (!session.rows.has(key(filter._id))) return { n: 0 };
      session.rows.set(key(filter._id), clone(document));
      return { n: 1 };
    },
    find(filter, options) {
      state.find++;
      const requestedIds = filter._id.$in || [filter._id];
      if (legacyBson) for (const id of requestedIds) if (typeof id === "object") assert.ok(id instanceof Oid);
      const ids = new Set(requestedIds.map(key));
      let limit = Infinity;
      const cursor = { limit(n) { limit = n; return cursor; }, maxTimeMS() { return cursor; },
        async toArray() { return [...(options?.session?.rows || state.rows)].filter(([k]) => ids.has(k)).slice(0, limit).map(([, v]) => clone(v)); } };
      return cursor;
    },
    async insertMany(documents, { session }) {
      state.insert++;
      for (const document of documents) {
        if (legacyBson && typeof document._id === "object") assert.ok(document._id instanceof Oid);
        if (session.rows.has(key(document._id))) throw new Error("duplicate");
        session.rows.set(key(document._id), clone(document));
        if (state.failInsert) { state.failInsert = false; throw state.insertError || new Error("injected partial insert failure"); }
      }
    },
    async deleteMany(filter, { session }) {
      state.remove++;
      let deletedCount = 0;
      for (const id of filter._id.$in) if (session.rows.delete(key(id))) deletedCount++;
      return { deletedCount };
    },
  };
  class MongoClient {
    listeners = new Map();
    on(name, callback) { const set = this.listeners.get(name) || new Set(); set.add(callback); this.listeners.set(name, set); }
    removeListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    emit(name, event) { for (const callback of this.listeners.get(name) || []) callback(event); }
    async connect() { if (state.failConnect) throw new Error("connect failed"); }
    close() { return cleanup(); }
    db() { return {
      command: async command => {
        if (state.preflightError) throw state.preflightError;
        if (command.isMaster) return { maxWireVersion: state.wireVersion, setName: state.replicaSet ? "fixture" : undefined, logicalSessionTimeoutMinutes: state.sessions, ...(state.sharded ? { msg: "isdbgrid" } : {}) };
        if (command.connectionStatus) return { authInfo: { authenticatedUserPrivileges: state.privileges ? [{ resource: { db: "test", collection: "members" }, actions: ["createCollection"] }] : [] } };
        if (command.create) { if (state.collectionExists || state.concurrentCollection) throw Object.assign(Error("private namespace"), { code: 48 }); state.created++; state.collectionExists = true; return { ok: 1 }; }
        throw Error("Unexpected fixture command");
      },
      listCollections: () => ({ toArray: async () => state.collectionExists ? [{ name: "members", type: state.collectionType, info: { uuid: state.collectionUuid || "synthetic-uuid-1" }, options: state.collectionOptions || {} }] : [] }),
      collection: () => collection,
    }; }
    startSession() {
      const client = this;
      let requestId = 0;
      const observe = (session, commandName, failure) => {
        const id = ++requestId;
        client.emit('commandStarted', { requestId: id, commandName, command: { lsid: state.mismatchedAck && commandName === "abortTransaction" ? { id: "another-session" } : session.id, txnNumber: 1 } });
        if (failure) client.emit('commandFailed', { requestId: id, commandName, failure });
        else client.emit('commandSucceeded', { requestId: id, commandName, reply: { ok: 1 } });
      };
      return {
        id: { id: 'synthetic-session' },
        rows: null,
        startTransaction(options = {}) {
          const effectiveReadPreference = options.readPreference || readPreference;
          if (effectiveReadPreference !== "primary") {
            throw new Error(`Read preference in a transaction must be primary, not: ${effectiveReadPreference}`);
          }
          this.rows = cloneRows();
        },
        async commitTransaction() {
          state.rows = this.rows;
          if (state.loseCommitReply) { state.loseCommitReply = false; observe(this, 'commitTransaction', Object.assign(Error('reply lost'), { name: 'MongoNetworkError' })); throw new Error("reply lost"); }
          if (!state.suppressCommitAck) observe(this, 'commitTransaction');
        },
        async abortTransaction() {
          if (state.failAbort || state.swallowedAbort) {
            observe(this, 'abortTransaction', Object.assign(Error('synthetic abort uncertainty'), { name: 'MongoNetworkError' }));
            if (state.swallowedAbort) return;
            throw Error('synthetic abort uncertainty');
          }
          this.rows = null; observe(this, 'abortTransaction');
        },
        async withTransaction(callback, options) {
          this.startTransaction(options);
          try { await callback(); await this.commitTransaction(); }
          catch (error) { await this.abortTransaction(); throw error; }
        },
        endSession() { return cleanup(); },
      };
    }
  }
  const require = (name) => ({ fs, path, crypto: cryptoModule, bson: legacyBson ? {} : bson, [importConfig.driverPath]: { MongoClient, ObjectID: Oid } })[name];
  require.resolve = () => "bson";
  async function execute(script) {
    let stdout = "";
    const process = { pid: 42, exitCode: 0, stdout: { write: (s) => { stdout += s; } } };
    await new vm.Script(script).runInNewContext({ require, process, Buffer });
    return { stdout, stderr: "", exitCode: process.exitCode, timedOut: false };
  }
  return { state, files, key, run: (request, policy = importConfig) => runMongoMutation(request, { config: policy, runSSH: async (_command, { stdin }) => execute(stdin) }) };
}
