import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privacyError } from "./privacy-key.js";
import { businessTargetScope } from "../plugins/remote-debug-agent/business-privacy.js";
import { prepareRequestDigest } from "../plugins/remote-debug-agent/prepare-protocol.js";
import { createOutputGuard } from "../plugins/remote-debug-agent/output-guard.js";

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

// This authenticated protocol exposes only bounded operations. The recovery MCP
// tool delegates here; it never receives capabilities or supplies remote proof.
export async function privacyRequest(service, input, { instance, origin, dispatch } = {}) {
  const actions = ["create", "attach", "resolve", "commit", "intent", "outcome", "reconcile", "delivered", "cleanup", "dispatch_prepare", "recover_operation"];
  if (!actions.includes(input?.action)) throw privacyError("BUSINESS_STORAGE_ACTION_DENIED");
  const validate = (scope) => {
    if (typeof scope !== "string" || scope.length > 8192) throw privacyError("BUSINESS_PRIVACY_SCOPE_REQUIRED");
    let target; try { target = JSON.parse(scope); } catch { throw privacyError("BUSINESS_PRIVACY_SCOPE_REQUIRED"); }
    const current = instance(target.id);
    if (!current || current.enabled === false || target.endpoint !== origin || scope !== businessTargetScope(origin, current, target.database)) throw privacyError("BUSINESS_REFERENCE_INVALID");
  };
  if (!["create", "attach", "cleanup"].includes(input.action)) validate(input.scope);
  if (input.action === "dispatch_prepare" || input.action === "recover_operation") {
    const record = await service.call("inspect_operation", input);
    const target = JSON.parse(input.scope);
    const view = (value, reason) => ({ ok: true, intentId: input.id, state: value.state, route: value.route,
      attempt: value.prepare?.attempt, mutationId: value.prepare?.mutationId, legacy: !value.prepare && value.route === "/mongodb/mutations/prepare",
      reason, recoveryCode: value.reconciliation?.code, ...(value.result ? { result: value.result } : {}) });
    if (input.action === "recover_operation") {
      if (!["inspect", "reconcile"].includes(input.mode)) throw privacyError("BUSINESS_STORAGE_INVALID");
      if (input.mode === "inspect" || record.state !== "uncertain") return view(record);
      // Old envelopes have no prepare identity. No absence query or caller-supplied
      // error text can turn those records into permission to dispatch again.
      if (!record.prepare) {
        const identity = record.identity || {};
        if (dispatch && /^[a-f0-9]{64}$/.test(identity.planHash || "") && (identity.mutationId || identity.jobId)) {
          try {
            const receipt = await dispatch(target.id, identity.mutationId ? "/mongodb/mutations/get" : "/mongodb/bulk/job",
              { ...(identity.mutationId ? { mutationId: identity.mutationId } : { jobId: identity.jobId }), planHash: identity.planHash,
                operationId: input.operationId, timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt });
            const evidence = identity.mutationId ? { ok: receipt.ok === true, entries: [receipt] } : receipt;
            const saved = await service.call("reconcile", { ...input, result: createOutputGuard().sanitize(evidence).value });
            return view({ ...record, ...saved }, saved.state === "uncertain" ? "remote_evidence_unavailable" : undefined);
          } catch { return view(record, "remote_evidence_unavailable"); }
        }
        return view(record, "legacy_evidence_required");
      }
    }
    if (!dispatch || record.route !== "/mongodb/mutations/prepare" || record.identity?.instanceId !== target.id) throw privacyError("BUSINESS_OPERATION_DENIED");
    if (input.action === "dispatch_prepare") {
      const digest = prepareRequestDigest(input.request || {});
      if (input.request?.instanceId !== target.id || input.request?.database !== target.database) throw privacyError("BUSINESS_OPERATION_DENIED");
      await service.call("claim_prepare", { ...input, dispatchDigest: digest });
    }
    const recovering = input.action === "recover_operation";
    let result, notDispatched = false, fenced = false;
    try {
      const { instanceId, ...request } = input.request || {};
      result = await dispatch(target.id, recovering ? "/mongodb/mutations/recover-prepare" : record.route,
        { ...(recovering ? { database: target.database } : request), _businessPrepare: record.prepare,
          operationId: input.operationId, timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt });
      if (result?.ok !== true) throw privacyError("BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
      if (recovering) {
        if (JSON.stringify(result.prepare) !== JSON.stringify(record.prepare)) throw privacyError("BUSINESS_OPERATION_DENIED");
        fenced = result.recovery === "fenced";
        if (fenced) result = { ok: false, error: { code: "MONGODB_PREPARE_FENCED" } };
        else { const { prepare, recovery, ...receipt } = result; result = receipt; }
      }
      if (!fenced && (result.mutationId !== record.prepare.mutationId || !/^[a-f0-9]{64}$/.test(result.planHash || ""))) throw privacyError("BUSINESS_OPERATION_DENIED");
      result = createOutputGuard().sanitize(result).value;
    } catch (error) {
      notDispatched = !recovering && error.dispatchState === "not_dispatched";
      result = { ok: false, error: { code: /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code || "") ? error.code : "MONGODB_OPERATION_FAILED",
        message: "Structured MongoDB operation failed; inspect the error code and existing plan or job state.",
        operationId: input.operationId, layer: error.layer, phase: error.phase, retriable: error.retriable } };
    }
    const saved = await service.call("prepare_result", { ...input, prepare: record.prepare, result, notDispatched, fenced });
    return recovering ? view(saved, saved.state === "uncertain" ? "remote_evidence_unavailable" : fenced ? "old_attempt_fenced" : undefined)
      : { ...result, intentId: input.id, intentState: saved.state };
  }
  if (input.action === "commit") {
    for (const record of input.records || []) validate(record.scope);
    // Retention cannot be shortened by the client. Use the configured windows.
    const current = instance(JSON.parse(input.scope).id);
    input.retentionMs = Math.max(30 * 86400000, current.mongodb?.rollbackTtlMs || 0, current.mongodb?.bulkRollbackTtlMs || 0);
  }
  return service.call(input.action, input);
}

export function installPrivacyRoutes(app, { directory, registry, service, dispatch } = {}) {
  const storage = service || new PrivacyService({ directory });
  app.locals.privacyService = storage;
  app.post("/api/private/business-storage", async (request, response) => {
    try {
      const result = await privacyRequest(storage, request.body, { instance: (id) => registry.getInternal(id), origin: new URL(`http://${request.headers.host}`).origin, dispatch });
      response.json({ ok: true, result });
    } catch (error) {
      response.status(409).json({ ok: false, error: { code: error.code?.startsWith("BUSINESS_") ? error.code : "BUSINESS_STORAGE_UNAVAILABLE", message: privacyError().message, retriable: false } });
    }
  });
}
