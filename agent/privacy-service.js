import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privacyError } from "./privacy-key.js";
import { businessTargetScope } from "../plugins/remote-debug-agent/business-privacy.js";

const here = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
export class PrivacyService {
  constructor({ directory, key, maxQueue = 32, workerPath } = {}) {
    this.options = { directory, key }; this.maxQueue = maxQueue; this.pending = new Map(); this.sequence = 0;
    this.workerPath = workerPath || path.join(here, typeof __filename === "string" ? "privacy-worker.cjs" : "privacy-worker.js");
  }
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      this.worker = new Worker(this.workerPath, { workerData: this.options, execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")) });
      const fail = () => {
        this.failed = true; reject(privacyError());
        for (const item of this.pending.values()) item.reject(privacyError());
        this.pending.clear(); this.worker?.unref();
      };
      this.worker.on("error", fail); this.worker.on("exit", fail);
      this.worker.on("message", (message) => {
        if (message.ready) { if (!this.pending.size) this.worker.unref(); resolve(); return; }
        if (message.failed) { this.failed = true; reject(privacyError(message.failed)); this.worker.terminate(); return; }
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id);
        if (!this.pending.size) this.worker.unref();
        if (message.error) item.reject(privacyError(message.error)); else item.resolve(message.result);
      });
    });
    return this.ready;
  }
  async call(action, input) {
    if (this.failed) throw privacyError();
    if ((this.waiting || 0) + this.pending.size >= this.maxQueue) throw privacyError("BUSINESS_STORAGE_BUSY");
    this.waiting = (this.waiting || 0) + 1;
    try { await this.start(); } finally { this.waiting--; }
    if (this.failed) throw privacyError();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence; this.pending.set(id, { resolve, reject }); this.worker.ref();
      this.worker.postMessage({ id, action, input });
    });
  }
  async close() { this.failed = true; await this.worker?.terminate(); }
}

// This authenticated private protocol has no MCP tool or dashboard route. It
// accepts exact aliases only, never SQL, scans, key export, or a value-search API.
export async function privacyRequest(service, input, { instance, origin } = {}) {
  const actions = ["create", "attach", "resolve", "commit", "intent", "outcome", "reconcile", "delivered", "cleanup"];
  if (!actions.includes(input?.action)) throw privacyError("BUSINESS_STORAGE_ACTION_DENIED");
  const validate = (scope) => {
    if (typeof scope !== "string" || scope.length > 8192) throw privacyError("BUSINESS_PRIVACY_SCOPE_REQUIRED");
    let target; try { target = JSON.parse(scope); } catch { throw privacyError("BUSINESS_PRIVACY_SCOPE_REQUIRED"); }
    const current = instance(target.id);
    if (!current || current.enabled === false || target.endpoint !== origin || scope !== businessTargetScope(origin, current, target.database)) throw privacyError("BUSINESS_REFERENCE_INVALID");
  };
  if (!["create", "attach", "cleanup"].includes(input.action)) validate(input.scope);
  if (input.action === "commit") {
    for (const record of input.records || []) validate(record.scope);
    // Retention cannot be shortened by the client. Use the configured windows.
    const current = instance(JSON.parse(input.scope).id);
    input.retentionMs = Math.max(30 * 86400000, current.mongodb?.rollbackTtlMs || 0, current.mongodb?.bulkRollbackTtlMs || 0);
  }
  return service.call(input.action, input);
}

export function installPrivacyRoutes(app, { directory, registry, service } = {}) {
  const storage = service || new PrivacyService({ directory });
  app.locals.privacyService = storage;
  app.post("/api/private/business-storage", async (request, response) => {
    try {
      const result = await privacyRequest(storage, request.body, { instance: (id) => registry.getInternal(id), origin: new URL(`http://${request.headers.host}`).origin });
      response.json({ ok: true, result });
    } catch (error) {
      response.status(409).json({ ok: false, error: { code: error.code?.startsWith("BUSINESS_") ? error.code : "BUSINESS_STORAGE_UNAVAILABLE", message: privacyError().message, retriable: false } });
    }
  });
}
