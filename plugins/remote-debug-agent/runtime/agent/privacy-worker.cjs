var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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
function privacyError(code = "BUSINESS_STORAGE_UNAVAILABLE") {
  return Object.assign(new Error("Protected local storage is unavailable; no business operation was replayed."), { code, statusCode: 409, retriable: false });
}
function loadPrivacyKey(directory, { platform = process.platform, run = import_node_child_process.execFileSync, existing = false } = {}) {
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

// privacy-store.js
var REF = /^rda_ref_v1_[a-f0-9]{48}$/;
var DAY = 864e5;
var PrivacyStore = class {
  constructor({ directory, key, now = Date.now, fault } = {}) {
    this.now = now;
    this.fault = fault;
    this.directory = import_node_path.default.resolve(directory);
    if (/(?:\/|\\)(?:CloudStorage|Mobile Documents|Dropbox|OneDrive|plugins\/cache)(?:\/|\\|$)/i.test(this.directory)) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
    import_node_fs.default.mkdirSync(this.directory, { recursive: true, mode: 448 });
    for (let p = this.directory; p !== import_node_path.default.dirname(p); p = import_node_path.default.dirname(p)) if (import_node_fs.default.lstatSync(p).isSymbolicLink() && !(process.platform === "darwin" && ["/tmp", "/var"].includes(p))) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
    const stat = import_node_fs.default.statfsSync(this.directory);
    if (process.platform === "darwin" ? ![17, 26].includes(stat.type) : [26985, 20859, 4283649346, 1702057286].includes(stat.type)) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
    import_node_fs.default.chmodSync(this.directory, 448);
    const filename = import_node_path.default.join(this.directory, "privacy.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) if (import_node_fs.default.existsSync(filename + suffix)) {
      const entry = import_node_fs.default.lstatSync(filename + suffix);
      if (!entry.isFile() || entry.isSymbolicLink() || process.getuid && entry.uid !== process.getuid()) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
    }
    const master = key ? Buffer.from(key) : loadPrivacyKey(this.directory, { existing: import_node_fs.default.existsSync(filename) });
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
      for (const suffix of ["", "-wal", "-shm"]) if (import_node_fs.default.existsSync(filename + suffix)) import_node_fs.default.chmodSync(filename + suffix, 384);
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
      if (previous && !(previous.state === "complete" && input.renew === true && input.route === "/mongodb/bulk/control")) return { id, ...previous };
      const record = { state: "uncertain", route: input.route, identity: input.identity, started: this.now() };
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
      return { id, state: "new" };
    });
    if (action === "outcome" || action === "reconcile") return this.transaction(() => {
      const previous = this.get("operation", input.id, ctx, scope);
      if (!previous) throw privacyError("BUSINESS_OPERATION_DENIED");
      let proof;
      const identity = previous.identity || {};
      if (action === "reconcile" && input.result?.ok === true && /^[a-f0-9]{64}$/.test(identity.planHash || "")) {
        if (identity.jobId && input.result.jobId === identity.jobId && input.result.planHash === identity.planHash && (previous.route === "/mongodb/bulk/execute" && input.result.status === "completed" || previous.route === "/mongodb/bulk/rollback" && input.result.status === "rolled_back")) proof = input.result;
        if (identity.mutationId) {
          const entry = input.result.entries?.find((item) => item.mutationId === identity.mutationId && item.planHash === identity.planHash);
          if (entry && (previous.route === "/mongodb/mutations/execute" && entry.status === "committed" || previous.route === "/mongodb/mutations/rollback" && entry.status === "rolled_back")) proof = { ok: true, ...entry };
        }
      }
      const complete = action === "outcome" || Boolean(proof);
      const value = complete ? { ...previous, state: "complete", result: proof || input.result } : { ...previous, reconciliation: input.result };
      this.put("operation", input.id, ctx, scope, value, complete ? this.now() + 90 * DAY : Number.MAX_SAFE_INTEGER, !complete);
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
