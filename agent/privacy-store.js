import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadPrivacyKey, privacyError } from "./privacy-key.js";
import { isPrepareTicket } from "../plugins/remote-debug-agent/prepare-protocol.js";
import windowsPrivacy from "../plugins/remote-debug-agent/windows-privacy.cjs";

const REF = /^rda_ref_v1_[a-f0-9]{48}$/;
const DAY = 86400000;
export class PrivacyStore {
  constructor({ directory, key, now = Date.now, fault } = {}) {
    this.now = now; this.fault = fault;
    this.directory = path.resolve(directory);
    let windowsExisting;
    if (process.platform === "win32") {
      windowsExisting = windowsPrivacy.prepareStore(this.directory).existing;
    } else {
    if (/(?:\/|\\)(?:CloudStorage|Mobile Documents|Dropbox|OneDrive|plugins\/cache)(?:\/|\\|$)/i.test(this.directory)) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (let p = this.directory; p !== path.dirname(p); p = path.dirname(p)) if (fs.lstatSync(p).isSymbolicLink() && !(process.platform === "darwin" && ["/tmp", "/var"].includes(p))) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
    const stat = fs.statfsSync(this.directory);
    if (process.platform === "darwin" ? ![17, 26].includes(stat.type) : [0x6969, 0x517b, 0xff534d42, 0x65735546].includes(stat.type)) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
    fs.chmodSync(this.directory, 0o700);
    const filename = path.join(this.directory, "privacy.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(filename + suffix)) {
      const entry = fs.lstatSync(filename + suffix);
      if (!entry.isFile() || entry.isSymbolicLink() || process.getuid && entry.uid !== process.getuid()) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
    }
    }
    const filename = path.join(this.directory, "privacy.sqlite");
    const master = key ? Buffer.from(key) : loadPrivacyKey(this.directory, { existing: process.platform === "win32" ? windowsExisting : fs.existsSync(filename) });
    if (master.length !== 32) throw privacyError("BUSINESS_KEYSTORE_UNAVAILABLE");
    this.enc = Buffer.from(hkdfSync("sha256", master, "rda-privacy-v1", "encryption", 32));
    this.index = Buffer.from(hkdfSync("sha256", master, "rda-privacy-v1", "reverse-index", 32)); master.fill(0);
    try {
      this.db = new DatabaseSync(filename);
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
      if (process.platform === "win32") windowsPrivacy.protectStoreFiles(this.directory);
      else for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(filename + suffix)) fs.chmodSync(filename + suffix, 0o600);
      const sentinel = this.get("meta", "key-check", "", "");
      if (sentinel && sentinel.version !== 1) throw privacyError();
      if (!sentinel) {
        if (version !== 0) throw privacyError("BUSINESS_STORAGE_CORRUPT");
        this.put("meta", "key-check", "", "", { version: 1 }, Number.MAX_SAFE_INTEGER, true);
      }
    } catch (error) { this.close(); throw privacyError(error.code?.startsWith("BUSINESS_") ? error.code : "BUSINESS_STORAGE_CORRUPT"); }
  }
  hash(...items) { return createHmac("sha256", this.index).update(JSON.stringify(items)).digest("hex"); }
  aad(kind, id, ctx, scope) { return Buffer.from(JSON.stringify(["rda", 1, 1, kind, id, ctx, scope])); }
  seal(kind, id, ctx, scope, value) {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.enc, nonce);
    cipher.setAAD(this.aad(kind, id, ctx, scope));
    return JSON.stringify({ v: 1, k: 1, n: nonce.toString("base64"), c: Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]).toString("base64"), t: cipher.getAuthTag().toString("base64") });
  }
  open(row) {
    try {
      const e = JSON.parse(row.envelope); if (e.v !== 1 || e.k !== 1) throw privacyError();
      const cipher = createDecipheriv("aes-256-gcm", this.enc, Buffer.from(e.n, "base64"));
      cipher.setAAD(this.aad(row.kind, row.id, row.ctx, row.scope)); cipher.setAuthTag(Buffer.from(e.t, "base64"));
      const value = JSON.parse(Buffer.concat([cipher.update(Buffer.from(e.c, "base64")), cipher.final()]).toString("utf8"));
      if (row.kind === "mapping" && (row.scope !== this.hash("scope", value.scope) || row.lookup !== this.hash("value", row.ctx, value.scope, JSON.stringify(value.value)))) throw privacyError();
      return value;
    } catch { throw privacyError("BUSINESS_STORAGE_CORRUPT"); }
  }
  get(kind, id, ctx, scope) {
    const row = this.db.prepare("SELECT * FROM records WHERE kind=? AND id=? AND ctx=? AND scope=?").get(kind, id, ctx, scope);
    return row ? this.open(row) : undefined;
  }
  put(kind, id, ctx, scope, value, expires = this.now() + 30 * DAY, pinned = false, lookup = null) {
    const result = this.db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET envelope=excluded.envelope,expires=excluded.expires,pinned=excluded.pinned WHERE records.ctx=excluded.ctx AND records.scope=excluded.scope AND records.lookup IS excluded.lookup").run(kind, id, ctx, scope, lookup, expires, +pinned, this.seal(kind, id, ctx, scope, value));
    if (Number(result.changes) !== 1) throw privacyError("BUSINESS_REFERENCE_INVALID");
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.fault?.("beforeCommit"); this.db.exec("COMMIT"); this.fault?.("afterCommit"); return value; }
    catch (e) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw e; }
  }
  authenticate(auth) {
    if (!auth || typeof auth.contextId !== "string" || !/^[a-f0-9]{64}$/.test(auth.capability || "")) throw privacyError("BUSINESS_CONTEXT_DENIED");
    const context = this.get("context", auth.contextId, auth.contextId, "");
    const proof = this.hash("capability", auth.capability);
    if (!context || context.expires <= this.now() || !timingSafeEqual(Buffer.from(context.proof), Buffer.from(proof))) throw privacyError("BUSINESS_CONTEXT_DENIED");
    return auth.contextId;
  }
  execute(action, input = {}) {
    if (action === "create") return this.transaction(() => {
      const contextId = randomUUID(), capability = randomBytes(32).toString("hex"), expires = this.now() + 365 * DAY;
      this.put("context", contextId, contextId, "", { proof: this.hash("capability", capability), expires }, expires);
      return { contextId, capability };
    });
    const ctx = this.authenticate(input.auth);
    if (action === "attach") return { contextId: ctx };
    const scope = this.hash("scope", input.scope);
    if (action === "resolve") {
      if (!Array.isArray(input.refs) || input.refs.length > 10000) throw privacyError("BUSINESS_PRIVACY_LIMIT");
      return { records: input.refs.map((ref) => {
        if (!REF.test(ref)) throw privacyError("BUSINESS_REFERENCE_INVALID");
        const row = this.db.prepare("SELECT * FROM records WHERE kind='mapping' AND id=? AND ctx=? AND scope=?").get(ref, ctx, scope);
        if (!row || row.expires <= this.now() && !row.pinned) throw privacyError("BUSINESS_REFERENCE_INVALID");
        return { ref, ...this.open(row) };
      }) };
    }
    if (action === "commit") return this.transaction(() => {
      if (!Array.isArray(input.records) || input.records.length > 10000 || !Array.isArray(input.tasks || []) || (input.tasks || []).length > 1000) throw privacyError("BUSINESS_PRIVACY_LIMIT");
      const aliases = {}, refs = new Set();
      for (const record of input.records) {
        if (!REF.test(record.ref) || typeof record.scope !== "string") throw privacyError("BUSINESS_REFERENCE_INVALID");
        const scoped = this.hash("scope", record.scope), lookup = this.hash("value", ctx, record.scope, JSON.stringify(record.value));
        const existing = this.db.prepare("SELECT * FROM records WHERE kind='mapping' AND ctx=? AND scope=? AND lookup=?").get(ctx, scoped, lookup);
        const ref = existing?.id || record.ref;
        if (existing) this.open(existing); // Detect tampering even on a dedup hit.
        else this.put("mapping", ref, ctx, scoped, { value: record.value, scope: record.scope }, this.now() + 30 * DAY, false, lookup);
        if (existing) this.db.prepare("UPDATE records SET expires=MAX(expires,?) WHERE kind='mapping' AND id=?").run(this.now() + 30 * DAY, ref);
        aliases[record.ref] = ref; refs.add(ref);
      }
      for (const original of input.refs || []) {
        const ref = aliases[original] || original;
        const row = this.db.prepare("SELECT * FROM records WHERE kind='mapping' AND id=? AND ctx=?").get(ref, ctx);
        if (!row) throw privacyError("BUSINESS_REFERENCE_INVALID"); this.open(row); refs.add(ref);
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
      const deliveryId = input.deliveryId || randomUUID();
      // Only counts/opaque IDs enter event bodies; never upstream exception text.
      const canonicalize = (value) => typeof value === "string" ? aliases[value] || value : Array.isArray(value) ? value.map(canonicalize)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, canonicalize(child)])) : value;
      this.put("delivery", deliveryId, ctx, scope, { aliases, output: canonicalize(input.output), delivered: false }, this.now() + 30 * DAY);
      this.put("event", randomUUID(), ctx, scope, { type: "references_committed", count: refs.size, deliveryId }, this.now() + 30 * DAY);
      return { aliases, deliveryId };
    });
    if (action === "intent") return this.transaction(() => {
      const id = this.hash("operation", ctx, input.scope, input.route, input.request);
      const previous = this.get("operation", id, ctx, scope);
      const retryPrepare = previous?.state === "rejected_before_dispatch" && previous.prepare && input.dispatchDigest === previous.prepare.requestDigest;
      if (previous && !retryPrepare && !(previous.state === "complete" && input.renew === true && input.route === "/mongodb/bulk/control")) return { id, ...previous };
      const prepare = input.route === "/mongodb/mutations/prepare" && /^[a-f0-9]{64}$/.test(input.dispatchDigest || "")
        ? { mutationId: previous?.prepare?.mutationId || randomUUID(), binding: id, requestDigest: input.dispatchDigest, attempt: (previous?.prepare?.attempt || 0) + 1 } : undefined;
      const record = { state: "uncertain", route: input.route, identity: input.identity, started: this.now(),
        ...(prepare ? { prepare, previousRejection: previous?.rejection } : {}) };
      this.put("operation", id, ctx, scope, record, Number.MAX_SAFE_INTEGER, true);
      const task = this.hash("task", ctx, input.scope, "operation:" + id);
      const retention = this.now() + 90 * DAY;
      this.put("task", task, ctx, scope, { id: "operation:" + id, active: true, expires: retention }, retention, true);
      for (const ref of input.refs || []) {
        const row = this.db.prepare("SELECT * FROM records WHERE kind='mapping' AND id=? AND ctx=? AND scope=?").get(ref, ctx, scope);
        if (!row) throw privacyError("BUSINESS_REFERENCE_INVALID"); this.open(row);
        this.db.prepare("INSERT OR IGNORE INTO links VALUES(?,?,?,?)").run(ctx, scope, task, ref);
        this.db.prepare("UPDATE records SET pinned=1 WHERE kind='mapping' AND id=?").run(ref);
      }
      return { id, state: "new", ...(prepare ? { prepare } : {}) };
    });
    // Internal Manager actions. They are deliberately absent from privacyRequest's
    // public action allowlist: callers cannot submit their own recovery proof.
    if (action === "inspect_operation") {
      if (!/^[a-f0-9]{64}$/.test(input.id || "")) throw privacyError("BUSINESS_OPERATION_DENIED");
      const record = this.get("operation", input.id, ctx, scope);
      if (!record) throw privacyError("BUSINESS_OPERATION_DENIED");
      return { id: input.id, ...record };
    }
    if (action === "claim_prepare") return this.transaction(() => {
      const record = this.get("operation", input.id, ctx, scope);
      if (!record?.prepare || record.state !== "uncertain" || record.dispatched ||
          record.prepare.requestDigest !== input.dispatchDigest || record.prepare.attempt !== input.attempt) throw privacyError("BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
      this.put("operation", input.id, ctx, scope, { ...record, dispatched: true, operationId: input.operationId }, Number.MAX_SAFE_INTEGER, true);
      return { ...record, dispatched: true };
    });
    if (action === "claim_execution") return this.transaction(() => {
      const record = this.get("operation", input.id, ctx, scope);
      if (!record || record.state !== "uncertain" || record.execution ||
          !["/mongodb/mutations/execute", "/mongodb/mutations/rollback"].includes(record.route) ||
          typeof input.operationId !== "string") throw privacyError("BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
      const execution = { intentId: input.id, operationId: input.operationId };
      this.put("operation", input.id, ctx, scope, { ...record, execution }, Number.MAX_SAFE_INTEGER, true);
      return execution;
    });
    if (action === "prepare_result") return this.transaction(() => {
      const record = this.get("operation", input.id, ctx, scope);
      if (!record?.prepare || !isPrepareTicket(input.prepare) || JSON.stringify(record.prepare) !== JSON.stringify(input.prepare)) throw privacyError("BUSINESS_OPERATION_DENIED");
      if (record.state !== "uncertain") return { id: input.id, ...record }; // Stale reply after recovery.
      let value;
      if (input.result?.ok === true && input.result.mutationId === record.prepare.mutationId && /^[a-f0-9]{64}$/.test(input.result.planHash || "")) {
        value = { ...record, state: "prepared", result: input.result };
      } else if (input.notDispatched === true || input.fenced === true) {
        value = { ...record, state: "rejected_before_dispatch", rejection: {
          attempt: record.prepare.attempt, code: input.result?.error?.code || "MONGODB_PREPARE_FENCED", at: this.now(),
          evidence: input.fenced ? "remote_fence" : "worker_validation",
        } };
      } else value = { ...record, reconciliation: { state: "unavailable", code: input.result?.error?.code } };
      const resolved = value.state !== "uncertain";
      this.put("operation", input.id, ctx, scope, value, resolved ? this.now() + 90 * DAY : Number.MAX_SAFE_INTEGER, !resolved);
      this.put("event", randomUUID(), ctx, scope, { type: "prepare_state", operation: input.id, state: value.state, attempt: record.prepare.attempt,
        code: value.rejection?.code, evidence: value.rejection?.evidence, operationId: record.operationId }, this.now() + 90 * DAY);
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
      let proof;
      const identity = previous.identity || {};
      if (action === "reconcile" && input.result?.ok === true && /^[a-f0-9]{64}$/.test(identity.planHash || "")) {
        if (identity.jobId && input.result.jobId === identity.jobId && input.result.planHash === identity.planHash &&
          (previous.route === "/mongodb/bulk/execute" && input.result.status === "completed" || previous.route === "/mongodb/bulk/rollback" && input.result.status === "rolled_back")) proof = input.result;
        if (identity.mutationId) {
          const entry = input.result.entries?.find((item) => item.mutationId === identity.mutationId && item.planHash === identity.planHash);
          const bound = !previous.execution || JSON.stringify(entry?.execution) === JSON.stringify(previous.execution);
          if (entry && bound && !["legacy_execution_evidence_required", "execution_acknowledgement_required"].includes(entry.indexRecovery?.reason) &&
              (previous.route === "/mongodb/mutations/execute" && entry.status === "committed" || previous.route === "/mongodb/mutations/rollback" && entry.status === "rolled_back")) proof = { ok: true, ...entry };
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
      return { state: value.state, ...(complete ? { result: value.result } : {}) };
    });
    if (action === "delivered") return this.transaction(() => {
      const previous = this.get("delivery", input.id, ctx, scope);
      if (previous) this.put("delivery", input.id, ctx, scope, { ...previous, delivered: true });
      return { ok: true };
    });
    if (action === "cleanup") return this.cleanup(ctx, Math.min(1000, Math.max(1, Number(input.limit) || 100)));
    throw privacyError("BUSINESS_STORAGE_ACTION_DENIED");
  }
  cleanup(ctx, limit) {
    return this.transaction(() => {
      // Each call touches at most limit rows. Active tasks and unresolved intents
      // are pinned indefinitely until explicitly reconciled/observed terminal.
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
      // Recompute only candidates that have expired, bounded by the same budget.
      removed += tasks.length;
      const rows = this.db.prepare("SELECT * FROM records WHERE ctx=? AND kind='mapping' AND pinned=0 AND expires<=? LIMIT ?").all(ctx, this.now(), limit - removed);
      for (const row of rows) {
        if (this.db.prepare("SELECT 1 FROM links WHERE ctx=? AND ref=? LIMIT 1").get(ctx, row.id)) continue;
        this.open(row); this.db.prepare("DELETE FROM records WHERE kind='mapping' AND id=?").run(row.id); removed++;
      }
      const extra = this.db.prepare("DELETE FROM records WHERE rowid IN (SELECT rowid FROM records WHERE ctx=? AND kind IN ('event','delivery','operation') AND pinned=0 AND expires<=? LIMIT ?)").run(ctx, this.now(), limit - removed);
      return { removed: removed + Number(extra.changes), limit };
    });
  }
  close() { this.db?.close(); this.db = undefined; this.enc?.fill(0); this.index?.fill(0); }
}
