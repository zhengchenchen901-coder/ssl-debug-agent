var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../plugins/remote-debug-agent/windows-privacy.cjs
var require_windows_privacy = __commonJS({
  "../plugins/remote-debug-agent/windows-privacy.cjs"(exports2, module2) {
    "use strict";
    var fs2 = require("fs");
    var path2 = require("path");
    var { createHash: createHash2 } = require("crypto");
    var { execFileSync: execFileSync2 } = require("child_process");
    function fail(code = "BUSINESS_STORAGE_UNAVAILABLE") {
      return Object.assign(new Error("Windows protected local storage is unavailable; no business operation was replayed."), { code, statusCode: 409, retriable: false });
    }
    function native(action, input = {}, run = execFileSync2) {
      if (process.platform !== "win32") throw fail("BUSINESS_KEYSTORE_UNSUPPORTED");
      const systemRoot = process.env.SystemRoot || process.env.WINDIR;
      if (!systemRoot || !path2.isAbsolute(systemRoot)) throw fail("BUSINESS_KEYSTORE_UNAVAILABLE");
      try {
        const helper = path2.join(__dirname, "native/windows-privacy.ps1");
        const manifestPath = fs2.existsSync(path2.join(__dirname, "runtime-manifest.json")) ? path2.join(__dirname, "runtime-manifest.json") : path2.join(__dirname, "runtime/agent/runtime-manifest.json");
        const expected = JSON.parse(fs2.readFileSync(manifestPath, "utf8")).hashes?.["native/windows-privacy.ps1"];
        if (!/^[a-f0-9]{64}$/.test(expected || "") || createHash2("sha256").update(fs2.readFileSync(helper)).digest("hex") !== expected) throw fail("BUSINESS_STORAGE_INTEGRITY_INVALID");
        const raw = run(
          path2.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper],
          {
            input: JSON.stringify({ action, ...input }),
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 3e4,
            maxBuffer: 128 * 1024,
            windowsHide: true
          }
        );
        const result = JSON.parse(raw);
        if (result.ok !== true) throw fail(/^BUSINESS_[A-Z_]+$/.test(result.code || "") ? result.code : void 0);
        return result;
      } catch (error) {
        if (error.code?.startsWith("BUSINESS_")) throw fail(error.code);
        throw fail(action === "key" ? "BUSINESS_KEYSTORE_UNAVAILABLE" : action.includes("context") ? "BUSINESS_CONTEXT_DENIED" : "BUSINESS_STORAGE_PATH_INVALID");
      }
    }
    function targetFor(directory) {
      return "RemoteDebugAgent/business-privacy/v1/" + createHash2("sha256").update(fs2.realpathSync.native(directory)).digest("hex");
    }
    function prepareStore(directory) {
      return native("prepare-store", { directory });
    }
    function protectStoreFiles(directory) {
      native("protect-store", { directory });
    }
    function loadKey(directory, { existing = false, run } = {}) {
      const target = targetFor(directory);
      const result = native("key", { directory, target, existing }, run);
      if (!/^[a-f0-9]{64}$/.test(result.key || "")) throw fail("BUSINESS_KEYSTORE_UNAVAILABLE");
      return Buffer.from(result.key, "hex");
    }
    function prepareContext(directory) {
      native("prepare-context", { directory });
    }
    function readContext(filename) {
      return native("read-context", { filename }).content;
    }
    function createContext(filename, content) {
      return native("create-context", { filename, content }).created;
    }
    module2.exports = { prepareStore, protectStoreFiles, loadKey, prepareContext, readContext, createContext, targetFor };
  }
});

// privacy-worker.js
var import_node_worker_threads = require("node:worker_threads");

// privacy-store.js
var import_node_sqlite = require("node:sqlite");
var import_node_crypto2 = require("node:crypto");
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);

// privacy-key.js
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_windows_privacy = __toESM(require_windows_privacy(), 1);
function privacyError(code = "BUSINESS_STORAGE_UNAVAILABLE") {
  return Object.assign(new Error("Protected local storage is unavailable; no business operation was replayed."), { code, statusCode: 409, retriable: false });
}
function loadPrivacyKey(directory, { platform = process.platform, run = import_node_child_process.execFileSync, existing = false } = {}) {
  if (platform === "win32") return import_windows_privacy.default.loadKey(directory, { existing, run });
  if (platform !== "darwin") throw privacyError("BUSINESS_KEYSTORE_UNSUPPORTED");
  const service = "com.remote-debug-agent.business-privacy.v1";
  const account = (0, import_node_crypto.createHash)("sha256").update(directory).digest("hex");
  const read = () => {
    const value = run("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15e3 }).trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw privacyError("BUSINESS_KEYSTORE_UNAVAILABLE");
    return Buffer.from(value, "hex");
  };
  try {
    return read();
  } catch (error) {
    if (existing || error.status !== 44) throw privacyError("BUSINESS_KEYSTORE_UNAVAILABLE");
  }
  const key = (0, import_node_crypto.randomBytes)(32);
  try {
    run("/usr/bin/security", ["-i"], { input: `add-generic-password -s ${service} -a ${account} -w ${key.toString("hex")}
`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15e3 });
    return read();
  } catch {
    throw privacyError("BUSINESS_KEYSTORE_UNAVAILABLE");
  } finally {
    key.fill(0);
  }
}

// ../plugins/remote-debug-agent/prepare-protocol.js
function isPrepareTicket(value) {
  return value && /^[a-f0-9-]{36}$/.test(value.mutationId || "") && /^[a-f0-9]{64}$/.test(value.binding || "") && /^[a-f0-9]{64}$/.test(value.requestDigest || "") && Number.isSafeInteger(value.attempt) && value.attempt > 0;
}

// privacy-store.js
var import_windows_privacy2 = __toESM(require_windows_privacy(), 1);
var REF = /^rda_ref_v1_[a-f0-9]{48}$/;
var DAY = 864e5;
var PrivacyStore = class {
  constructor({ directory, key, now = Date.now, fault } = {}) {
    this.now = now;
    this.fault = fault;
    this.directory = import_node_path.default.resolve(directory);
    let windowsExisting;
    if (process.platform === "win32") {
      windowsExisting = import_windows_privacy2.default.prepareStore(this.directory).existing;
    } else {
      if (/(?:\/|\\)(?:CloudStorage|Mobile Documents|Dropbox|OneDrive|plugins\/cache)(?:\/|\\|$)/i.test(this.directory)) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
      import_node_fs.default.mkdirSync(this.directory, { recursive: true, mode: 448 });
      for (let p = this.directory; p !== import_node_path.default.dirname(p); p = import_node_path.default.dirname(p)) if (import_node_fs.default.lstatSync(p).isSymbolicLink() && !(process.platform === "darwin" && ["/tmp", "/var"].includes(p))) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
      const stat = import_node_fs.default.statfsSync(this.directory);
      if (process.platform === "darwin" ? ![17, 26].includes(stat.type) : [26985, 20859, 4283649346, 1702057286].includes(stat.type)) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
      import_node_fs.default.chmodSync(this.directory, 448);
      const filename2 = import_node_path.default.join(this.directory, "privacy.sqlite");
      for (const suffix of ["", "-wal", "-shm"]) if (import_node_fs.default.existsSync(filename2 + suffix)) {
        const entry = import_node_fs.default.lstatSync(filename2 + suffix);
        if (!entry.isFile() || entry.isSymbolicLink() || process.getuid && entry.uid !== process.getuid()) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
      }
    }
    const filename = import_node_path.default.join(this.directory, "privacy.sqlite");
    const master = key ? Buffer.from(key) : loadPrivacyKey(this.directory, { existing: process.platform === "win32" ? windowsExisting : import_node_fs.default.existsSync(filename) });
    if (master.length !== 32) throw privacyError("BUSINESS_KEYSTORE_UNAVAILABLE");
    this.enc = Buffer.from((0, import_node_crypto2.hkdfSync)("sha256", master, "rda-privacy-v1", "encryption", 32));
    this.index = Buffer.from((0, import_node_crypto2.hkdfSync)("sha256", master, "rda-privacy-v1", "reverse-index", 32));
    master.fill(0);
    try {
      this.db = new import_node_sqlite.DatabaseSync(filename);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;");
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (version > 1) throw privacyError("BUSINESS_STORAGE_VERSION_UNSUPPORTED");
      if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE records(kind TEXT NOT NULL, id TEXT NOT NULL, ctx TEXT NOT NULL, scope TEXT NOT NULL, lookup TEXT, expires INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, envelope TEXT NOT NULL, PRIMARY KEY(kind,id));
        CREATE UNIQUE INDEX reverse_mapping ON records(ctx,scope,lookup) WHERE kind='mapping';
        CREATE INDEX expiry ON records(pinned,expires);
        CREATE INDEX retention_scan ON records(ctx,kind,pinned,expires);
        CREATE TABLE links(ctx TEXT NOT NULL,scope TEXT NOT NULL,task TEXT NOT NULL,ref TEXT NOT NULL,PRIMARY KEY(ctx,scope,task,ref));
        CREATE INDEX link_ref ON links(ctx,ref);
        CREATE INDEX link_task ON links(ctx,task);
        PRAGMA user_version=1; COMMIT;`);
      if (process.platform === "win32") import_windows_privacy2.default.protectStoreFiles(this.directory);
      else for (const suffix of ["", "-wal", "-shm"]) if (import_node_fs.default.existsSync(filename + suffix)) import_node_fs.default.chmodSync(filename + suffix, 384);
      const sentinel = this.get("meta", "key-check", "", "");
      if (sentinel && sentinel.version !== 1) throw privacyError();
      if (!sentinel) {
        if (version !== 0) throw privacyError("BUSINESS_STORAGE_CORRUPT");
        this.put("meta", "key-check", "", "", { version: 1 }, Number.MAX_SAFE_INTEGER, true);
      }
    } catch (error) {
      this.close();
      throw privacyError(error.code?.startsWith("BUSINESS_") ? error.code : "BUSINESS_STORAGE_CORRUPT");
    }
  }
  hash(...items) {
    return (0, import_node_crypto2.createHmac)("sha256", this.index).update(JSON.stringify(items)).digest("hex");
  }
  aad(kind, id, ctx, scope) {
    return Buffer.from(JSON.stringify(["rda", 1, 1, kind, id, ctx, scope]));
  }
  seal(kind, id, ctx, scope, value) {
    const nonce = (0, import_node_crypto2.randomBytes)(12), cipher = (0, import_node_crypto2.createCipheriv)("aes-256-gcm", this.enc, nonce);
    cipher.setAAD(this.aad(kind, id, ctx, scope));
    return JSON.stringify({ v: 1, k: 1, n: nonce.toString("base64"), c: Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]).toString("base64"), t: cipher.getAuthTag().toString("base64") });
  }
  open(row) {
    try {
      const e = JSON.parse(row.envelope);
      if (e.v !== 1 || e.k !== 1) throw privacyError();
      const cipher = (0, import_node_crypto2.createDecipheriv)("aes-256-gcm", this.enc, Buffer.from(e.n, "base64"));
      cipher.setAAD(this.aad(row.kind, row.id, row.ctx, row.scope));
      cipher.setAuthTag(Buffer.from(e.t, "base64"));
      const value = JSON.parse(Buffer.concat([cipher.update(Buffer.from(e.c, "base64")), cipher.final()]).toString("utf8"));
      if (row.kind === "mapping" && (row.scope !== this.hash("scope", value.scope) || row.lookup !== this.hash("value", row.ctx, value.scope, JSON.stringify(value.value)))) throw privacyError();
      return value;
    } catch {
      throw privacyError("BUSINESS_STORAGE_CORRUPT");
    }
  }
  get(kind, id, ctx, scope) {
    const row = this.db.prepare("SELECT * FROM records WHERE kind=? AND id=? AND ctx=? AND scope=?").get(kind, id, ctx, scope);
    return row ? this.open(row) : void 0;
  }
  put(kind, id, ctx, scope, value, expires = this.now() + 30 * DAY, pinned = false, lookup = null) {
    const result = this.db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET envelope=excluded.envelope,expires=excluded.expires,pinned=excluded.pinned WHERE records.ctx=excluded.ctx AND records.scope=excluded.scope AND records.lookup IS excluded.lookup").run(kind, id, ctx, scope, lookup, expires, +pinned, this.seal(kind, id, ctx, scope, value));
    if (Number(result.changes) !== 1) throw privacyError("BUSINESS_REFERENCE_INVALID");
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.fault?.("beforeCommit");
      this.db.exec("COMMIT");
      this.fault?.("afterCommit");
      return value;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }
  authenticate(auth) {
    if (!auth || typeof auth.contextId !== "string" || !/^[a-f0-9]{64}$/.test(auth.capability || "")) throw privacyError("BUSINESS_CONTEXT_DENIED");
    const context = this.get("context", auth.contextId, auth.contextId, "");
    const proof = this.hash("capability", auth.capability);
    if (!context || context.expires <= this.now() || !(0, import_node_crypto2.timingSafeEqual)(Buffer.from(context.proof), Buffer.from(proof))) throw privacyError("BUSINESS_CONTEXT_DENIED");
    return auth.contextId;
  }
  execute(action, input = {}) {
    if (action === "create") return this.transaction(() => {
      const contextId = (0, import_node_crypto2.randomUUID)(), capability = (0, import_node_crypto2.randomBytes)(32).toString("hex"), expires = this.now() + 365 * DAY;
      this.put("context", contextId, contextId, "", { proof: this.hash("capability", capability), expires }, expires);
      return { contextId, capability };
    });
    const ctx = this.authenticate(input.auth);
    if (action === "attach") return { contextId: ctx };
    const scope = this.hash("scope", input.scope);
    if (action === "resolve") {
      if (!Array.isArray(input.refs) || input.refs.length > 1e4) throw privacyError("BUSINESS_PRIVACY_LIMIT");
      return { records: input.refs.map((ref) => {
        if (!REF.test(ref)) throw privacyError("BUSINESS_REFERENCE_INVALID");
        const row = this.db.prepare("SELECT * FROM records WHERE kind='mapping' AND id=? AND ctx=? AND scope=?").get(ref, ctx, scope);
        if (!row || row.expires <= this.now() && !row.pinned) throw privacyError("BUSINESS_REFERENCE_INVALID");
        return { ref, ...this.open(row) };
      }) };
    }
    if (action === "commit") return this.transaction(() => {
      if (!Array.isArray(input.records) || input.records.length > 1e4 || !Array.isArray(input.tasks || []) || (input.tasks || []).length > 1e3) throw privacyError("BUSINESS_PRIVACY_LIMIT");
      const aliases = {}, refs = /* @__PURE__ */ new Set();
      for (const record of input.records) {
        if (!REF.test(record.ref) || typeof record.scope !== "string") throw privacyError("BUSINESS_REFERENCE_INVALID");
        const scoped = this.hash("scope", record.scope), lookup = this.hash("value", ctx, record.scope, JSON.stringify(record.value));
        const existing = this.db.prepare("SELECT * FROM records WHERE kind='mapping' AND ctx=? AND scope=? AND lookup=?").get(ctx, scoped, lookup);
        const ref = existing?.id || record.ref;
        if (existing) this.open(existing);
        else this.put("mapping", ref, ctx, scoped, { value: record.value, scope: record.scope }, this.now() + 30 * DAY, false, lookup);
        if (existing) this.db.prepare("UPDATE records SET expires=MAX(expires,?) WHERE kind='mapping' AND id=?").run(this.now() + 30 * DAY, ref);
        aliases[record.ref] = ref;
        refs.add(ref);
      }
      for (const original of input.refs || []) {
        const ref = aliases[original] || original;
        const row = this.db.prepare("SELECT * FROM records WHERE kind='mapping' AND id=? AND ctx=?").get(ref, ctx);
        if (!row) throw privacyError("BUSINESS_REFERENCE_INVALID");
        this.open(row);
        refs.add(ref);
        this.db.prepare("UPDATE records SET expires=MAX(expires,?) WHERE kind='mapping' AND id=?").run(this.now() + 30 * DAY, ref);
      }
      for (const task of input.tasks || []) {
        if (typeof task.id !== "string" || task.id.length > 256) throw privacyError("BUSINESS_STORAGE_INVALID");
        const taskId = this.hash("task", ctx, input.scope, task.id);
        const previous = this.get("task", taskId, ctx, scope);
        const active = !["completed", "committed", "rolled_back", "failed", "cancelled", "expired", "prepared", "ready"].includes(task.status);
        const expires = Math.max(previous?.expires || 0, this.now() + (input.retentionMs || 30 * DAY), Number(task.expires) || 0);
        this.put("task", taskId, ctx, scope, { ...previous, ...task, active, expires }, expires, active);
        for (const ref of refs) this.db.prepare("INSERT OR IGNORE INTO links VALUES(?,?,?,?)").run(ctx, scope, taskId, ref);
        this.db.prepare("UPDATE records SET pinned=1 WHERE kind='mapping' AND ctx=? AND id IN (SELECT ref FROM links WHERE ctx=? AND task=?)").run(ctx, ctx, taskId);
      }
      const deliveryId = input.deliveryId || (0, import_node_crypto2.randomUUID)();
      const canonicalize = (value) => typeof value === "string" ? aliases[value] || value : Array.isArray(value) ? value.map(canonicalize) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, canonicalize(child)])) : value;
      this.put("delivery", deliveryId, ctx, scope, { aliases, output: canonicalize(input.output), delivered: false }, this.now() + 30 * DAY);
      this.put("event", (0, import_node_crypto2.randomUUID)(), ctx, scope, { type: "references_committed", count: refs.size, deliveryId }, this.now() + 30 * DAY);
      return { aliases, deliveryId };
    });
    if (action === "intent") return this.transaction(() => {
      const id = this.hash("operation", ctx, input.scope, input.route, input.request);
      const previous = this.get("operation", id, ctx, scope);
      if (previous?.bulkPrepare && previous.bulkPrepare.requestDigest !== input.dispatchDigest) throw privacyError("BUSINESS_OPERATION_CONTENT_CONFLICT");
      const retryPrepare = previous?.state === "rejected_before_dispatch" && (previous.prepare || previous.bulkPrepare) && input.dispatchDigest === (previous.prepare || previous.bulkPrepare).requestDigest;
      if (previous && !retryPrepare && !(previous.state === "complete" && input.renew === true && input.route === "/mongodb/bulk/control")) return { id, ...previous };
      const prepare = input.route === "/mongodb/mutations/prepare" && /^[a-f0-9]{64}$/.test(input.dispatchDigest || "") ? { mutationId: previous?.prepare?.mutationId || (0, import_node_crypto2.randomUUID)(), binding: id, requestDigest: input.dispatchDigest, attempt: (previous?.prepare?.attempt || 0) + 1 } : void 0;
      const record = {
        state: "uncertain",
        route: input.route,
        identity: input.identity,
        started: this.now(),
        ...prepare ? { prepare, previousRejection: previous?.rejection } : {},
        ...input.route === "/mongodb/bulk/prepare" && /^[a-f0-9]{64}$/.test(input.dispatchDigest || "") ? { bulkPrepare: { binding: id, requestDigest: input.dispatchDigest, attempt: (previous?.bulkPrepare?.attempt || 0) + 1 }, previousRejection: previous?.rejection } : {}
      };
      this.put("operation", id, ctx, scope, record, Number.MAX_SAFE_INTEGER, true);
      const task = this.hash("task", ctx, input.scope, "operation:" + id);
      const retention = this.now() + 90 * DAY;
      this.put("task", task, ctx, scope, { id: "operation:" + id, active: true, expires: retention }, retention, true);
      for (const ref of input.refs || []) {
        const row = this.db.prepare("SELECT * FROM records WHERE kind='mapping' AND id=? AND ctx=? AND scope=?").get(ref, ctx, scope);
        if (!row) throw privacyError("BUSINESS_REFERENCE_INVALID");
        this.open(row);
        this.db.prepare("INSERT OR IGNORE INTO links VALUES(?,?,?,?)").run(ctx, scope, task, ref);
        this.db.prepare("UPDATE records SET pinned=1 WHERE kind='mapping' AND id=?").run(ref);
      }
      return { id, state: "new", ...prepare ? { prepare } : {}, ...record.bulkPrepare ? { bulkPrepare: record.bulkPrepare } : {} };
    });
    if (action === "inspect_operation") {
      if (!/^[a-f0-9]{64}$/.test(input.id || "")) throw privacyError("BUSINESS_OPERATION_DENIED");
      const record = this.get("operation", input.id, ctx, scope);
      if (!record) throw privacyError("BUSINESS_OPERATION_DENIED");
      return { id: input.id, ...record };
    }
    if (action === "claim_prepare") return this.transaction(() => {
      const record = this.get("operation", input.id, ctx, scope);
      if (!record?.prepare || record.state !== "uncertain" || record.dispatched || record.prepare.requestDigest !== input.dispatchDigest || record.prepare.attempt !== input.attempt) throw privacyError("BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
      this.put("operation", input.id, ctx, scope, { ...record, dispatched: true, operationId: input.operationId }, Number.MAX_SAFE_INTEGER, true);
      return { ...record, dispatched: true };
    });
    if (action === "claim_bulk_prepare") return this.transaction(() => {
      const record = this.get("operation", input.id, ctx, scope);
      if (!record?.bulkPrepare || record.state !== "uncertain" || record.dispatched || record.bulkPrepare.requestDigest !== input.dispatchDigest || record.bulkPrepare.attempt !== input.attempt) throw privacyError("BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
      this.put("operation", input.id, ctx, scope, { ...record, dispatched: true, operationId: input.operationId, bulkChunk: input.bulkChunk }, Number.MAX_SAFE_INTEGER, true);
      return { ...record, dispatched: true, bulkChunk: input.bulkChunk };
    });
    if (action === "bulk_prepare_result") return this.transaction(() => {
      const record = this.get("operation", input.id, ctx, scope);
      if (!record?.bulkPrepare || JSON.stringify(record.bulkPrepare) !== JSON.stringify(input.bulkPrepare)) throw privacyError("BUSINESS_OPERATION_DENIED");
      if (record.state !== "uncertain") return { id: input.id, ...record };
      const result = input.result, chunk = record.bulkChunk;
      const proven = result?.ok === true && chunk && result.jobId === chunk.jobId && result.chunkIndex === chunk.chunkIndex && result.chunkHash === chunk.chunkHash && (!chunk.endOfUpload || result.status === "prepared" && /^[a-f0-9]{64}$/.test(result.planHash || ""));
      const value = proven ? { ...record, state: "complete", result, reconciliation: void 0 } : input.notDispatched === true || input.unclaimed === true && !record.dispatched ? { ...record, state: "rejected_before_dispatch", rejection: {
        attempt: record.bulkPrepare.attempt,
        code: result?.error?.code,
        at: this.now(),
        evidence: input.unclaimed ? "unclaimed_attempt_fence" : "preflight_before_ssh"
      }, result, reconciliation: void 0 } : { ...record, reconciliation: { code: result?.ok === true ? "MONGODB_BULK_RECEIPT_CONFLICT" : result?.error?.code } };
      const resolved = value.state !== "uncertain";
      this.put("operation", input.id, ctx, scope, value, resolved ? this.now() + 90 * DAY : Number.MAX_SAFE_INTEGER, !resolved);
      this.put("event", (0, import_node_crypto2.randomUUID)(), ctx, scope, {
        type: "bulk_prepare_state",
        operation: input.id,
        state: value.state,
        attempt: record.bulkPrepare.attempt,
        operationId: record.operationId || input.operationId,
        code: value.rejection?.code || value.reconciliation?.code,
        evidence: value.rejection?.evidence
      }, this.now() + 90 * DAY);
      if (resolved) {
        const taskId = this.hash("task", ctx, input.scope, "operation:" + input.id), task = this.get("task", taskId, ctx, scope);
        if (task) this.put("task", taskId, ctx, scope, { ...task, active: false }, task.expires, false);
      }
      return { id: input.id, ...value };
    });
    if (action === "claim_execution") return this.transaction(() => {
      const record = this.get("operation", input.id, ctx, scope);
      if (!record || record.state !== "uncertain" || record.execution || !["/mongodb/mutations/execute", "/mongodb/mutations/rollback"].includes(record.route) || typeof input.operationId !== "string") throw privacyError("BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
      const execution = { intentId: input.id, operationId: input.operationId };
      this.put("operation", input.id, ctx, scope, { ...record, execution }, Number.MAX_SAFE_INTEGER, true);
      return execution;
    });
    if (action === "prepare_result") return this.transaction(() => {
      const record = this.get("operation", input.id, ctx, scope);
      if (!record?.prepare || !isPrepareTicket(input.prepare) || JSON.stringify(record.prepare) !== JSON.stringify(input.prepare)) throw privacyError("BUSINESS_OPERATION_DENIED");
      if (record.state !== "uncertain") return { id: input.id, ...record };
      let value;
      if (input.result?.ok === true && input.result.mutationId === record.prepare.mutationId && /^[a-f0-9]{64}$/.test(input.result.planHash || "")) {
        value = { ...record, state: "prepared", result: input.result };
      } else if (input.notDispatched === true || input.fenced === true) {
        value = { ...record, state: "rejected_before_dispatch", rejection: {
          attempt: record.prepare.attempt,
          code: input.result?.error?.code || "MONGODB_PREPARE_FENCED",
          at: this.now(),
          evidence: input.fenced ? "remote_fence" : "worker_validation"
        } };
      } else value = { ...record, reconciliation: { state: "unavailable", code: input.result?.error?.code } };
      const resolved = value.state !== "uncertain";
      this.put("operation", input.id, ctx, scope, value, resolved ? this.now() + 90 * DAY : Number.MAX_SAFE_INTEGER, !resolved);
      this.put("event", (0, import_node_crypto2.randomUUID)(), ctx, scope, {
        type: "prepare_state",
        operation: input.id,
        state: value.state,
        attempt: record.prepare.attempt,
        code: value.rejection?.code,
        evidence: value.rejection?.evidence,
        operationId: record.operationId
      }, this.now() + 90 * DAY);
      if (resolved) {
        const taskId = this.hash("task", ctx, input.scope, "operation:" + input.id);
        const task = this.get("task", taskId, ctx, scope);
        if (task) this.put("task", taskId, ctx, scope, { ...task, active: false }, task.expires, false);
      }
      return { id: input.id, ...value };
    });
    if (action === "outcome" || action === "reconcile") return this.transaction(() => {
      const previous = this.get("operation", input.id, ctx, scope);
      if (!previous) throw privacyError("BUSINESS_OPERATION_DENIED");
      if (previous.route === "/mongodb/bulk/prepare") throw privacyError("BUSINESS_OPERATION_DENIED");
      let proof;
      const identity = previous.identity || {};
      if (action === "reconcile" && input.result?.ok === true && /^[a-f0-9]{64}$/.test(identity.planHash || "")) {
        if (identity.jobId && input.result.jobId === identity.jobId && input.result.planHash === identity.planHash && (previous.route === "/mongodb/bulk/execute" && input.result.status === "completed" || previous.route === "/mongodb/bulk/rollback" && input.result.status === "rolled_back")) proof = input.result;
        if (identity.mutationId) {
          const entry = input.result.entries?.find((item) => item.mutationId === identity.mutationId && item.planHash === identity.planHash);
          const bound = !previous.execution || JSON.stringify(entry?.execution) === JSON.stringify(previous.execution);
          if (entry && bound && !["legacy_execution_evidence_required", "execution_acknowledgement_required"].includes(entry.indexRecovery?.reason) && (previous.route === "/mongodb/mutations/execute" && entry.status === "committed" || previous.route === "/mongodb/mutations/rollback" && entry.status === "rolled_back")) proof = { ok: true, ...entry };
        }
      }
      const complete = action === "outcome" || Boolean(proof);
      const value = complete ? { ...previous, state: "complete", result: proof || input.result } : { ...previous, reconciliation: input.result };
      this.put("operation", input.id, ctx, scope, value, complete ? this.now() + 90 * DAY : Number.MAX_SAFE_INTEGER, !complete);
      if (complete) {
        const taskId = this.hash("task", ctx, input.scope, "operation:" + input.id);
        const task = this.get("task", taskId, ctx, scope);
        if (task) this.put("task", taskId, ctx, scope, { ...task, active: false }, task.expires, false);
      }
      return { state: value.state, ...complete ? { result: value.result } : {} };
    });
    if (action === "delivered") return this.transaction(() => {
      const previous = this.get("delivery", input.id, ctx, scope);
      if (previous) this.put("delivery", input.id, ctx, scope, { ...previous, delivered: true });
      return { ok: true };
    });
    if (action === "cleanup") return this.cleanup(ctx, Math.min(1e3, Math.max(1, Number(input.limit) || 100)));
    throw privacyError("BUSINESS_STORAGE_ACTION_DENIED");
  }
  cleanup(ctx, limit) {
    return this.transaction(() => {
      const expiredLinks = this.db.prepare("SELECT l.rowid,l.ref FROM records r JOIN links l ON r.id=l.task AND r.ctx=l.ctx WHERE r.kind='task' AND r.ctx=? AND r.pinned=0 AND r.expires<=? LIMIT ?").all(ctx, this.now(), limit);
      for (const link of expiredLinks) {
        this.db.prepare("DELETE FROM links WHERE rowid=?").run(link.rowid);
        if (!this.db.prepare("SELECT 1 FROM links WHERE ctx=? AND ref=? LIMIT 1").get(ctx, link.ref)) this.db.prepare("UPDATE records SET pinned=0 WHERE kind='mapping' AND ctx=? AND id=?").run(ctx, link.ref);
      }
      let removed = expiredLinks.length;
      const tasks = this.db.prepare("SELECT * FROM records WHERE kind='task' AND ctx=? AND pinned=0 AND expires<=? AND NOT EXISTS(SELECT 1 FROM links WHERE links.ctx=records.ctx AND links.task=records.id) LIMIT ?").all(ctx, this.now(), limit - removed);
      for (const row of tasks) {
        this.open(row);
        this.db.prepare("DELETE FROM records WHERE kind='task' AND id=?").run(row.id);
      }
      removed += tasks.length;
      const rows = this.db.prepare("SELECT * FROM records WHERE ctx=? AND kind='mapping' AND pinned=0 AND expires<=? LIMIT ?").all(ctx, this.now(), limit - removed);
      for (const row of rows) {
        if (this.db.prepare("SELECT 1 FROM links WHERE ctx=? AND ref=? LIMIT 1").get(ctx, row.id)) continue;
        this.open(row);
        this.db.prepare("DELETE FROM records WHERE kind='mapping' AND id=?").run(row.id);
        removed++;
      }
      const extra = this.db.prepare("DELETE FROM records WHERE rowid IN (SELECT rowid FROM records WHERE ctx=? AND kind IN ('event','delivery','operation') AND pinned=0 AND expires<=? LIMIT ?)").run(ctx, this.now(), limit - removed);
      return { removed: removed + Number(extra.changes), limit };
    });
  }
  close() {
    this.db?.close();
    this.db = void 0;
    this.enc?.fill(0);
    this.index?.fill(0);
  }
};

// privacy-worker.js
var store;
try {
  store = new PrivacyStore(import_node_worker_threads.workerData);
  import_node_worker_threads.parentPort.postMessage({ ready: true });
} catch (error) {
  import_node_worker_threads.parentPort.postMessage({ failed: error.code || "BUSINESS_STORAGE_UNAVAILABLE" });
}
import_node_worker_threads.parentPort.on("message", ({ id, action, input }) => {
  try {
    if (!store) throw new Error();
    const result = action === "close" ? store.close() : store.execute(action, input);
    import_node_worker_threads.parentPort.postMessage({ id, result });
  } catch (error) {
    import_node_worker_threads.parentPort.postMessage({ id, error: error.code?.startsWith("BUSINESS_") ? error.code : "BUSINESS_STORAGE_UNAVAILABLE" });
  }
});
