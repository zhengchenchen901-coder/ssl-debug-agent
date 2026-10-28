import { mutationDiagnostic } from "../plugins/remote-debug-agent/mutation-diagnostic.js";
import { normalizeMongoImport } from "./mongodb-mutations.js";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privacyError } from "./privacy-key.js";
import { businessTargetScope } from "../plugins/remote-debug-agent/business-privacy.js";
import { prepareRequestDigest, importBatchIdentity, IMPORT_PREPARE_ROUTE, isImportRequest, importPrepareResultMatches } from "../plugins/remote-debug-agent/prepare-protocol.js";
import { validateImportLookup } from "./mongodb-import-recovery.js";
import { createOutputGuard } from "../plugins/remote-debug-agent/output-guard.js";
import { normalizeMongoBulkChunk } from "./mongodb-bulk.js";
import { createBulkHistoryReader } from "./mongodb-bulk-history.js";
import { isMongoAdmissionRoute } from "./mongodb-disposition.js";
import { businessTargetScope as riskTargetScope } from "../plugins/remote-debug-agent/business-privacy.js";

async function historicalBulkRequest(service, input, record, target, { instance, dispatch, historicalEvidence }, view) {
  if (record.identity?.instanceId !== target.id) throw privacyError("BUSINESS_OPERATION_DENIED");
  const raw = input.originalRequest;
  if (raw !== undefined && (!raw || raw.instanceId !== target.id || raw.database !== target.database)) throw privacyError("BUSINESS_OPERATION_DENIED");
  const { operationId, deadlineAt, timeoutMs, ...request } = raw ? createOutputGuard().sanitize(raw).value : {};
  const binding = await service.call("historical_bulk_identity", { ...input, request: raw ? request : undefined });
  let diagnostics;
  try { diagnostics = historicalEvidence ? await historicalEvidence({ record, target }) : { trust: "diagnostic_only", scanStatus: "not_configured" }; }
  catch { diagnostics = { trust: "diagnostic_only", scanStatus: "unavailable" }; }
  const history = { ...binding, jobId: record.identity.jobId, chunkIndex: record.identity.chunkIndex, diagnostics };
  if (!raw) return { ...view(record, record.state === "uncertain" ? "historical_request_required" : undefined), history };
  if (!binding.requestMatched) {
    if (record.state !== "uncertain") throw privacyError("BUSINESS_OPERATION_DENIED");
    return { ...view(record, "historical_request_mismatch"), history };
  }
  // Legacy keyed intent identity covered credential-sanitized JSON, not a raw
  // digest. If redaction lost original bytes, an exact raw chunk cannot be
  // inferred even when its redacted request looks identical.
  if (JSON.stringify(raw).includes("[REDACTED]") || prepareRequestDigest(raw) !== prepareRequestDigest(request)) {
    return { ...view(record, "historical_original_bytes_unbound"), history };
  }
  if (record.state !== "uncertain") return { ...view(record), history: { ...history, evidence: record.historicalRecovery?.evidence } };
  try {
    const { instanceId, ...chunkInput } = raw;
    // Normalizing a read-only recovery identity must not require enabling new
    // bulk uploads. All database/collection/value bounds remain in force.
    const chunk = normalizeMongoBulkChunk(chunkInput, { ...instance(target.id).mongodb, bulkEnabled: true });
    const identity = { jobId: chunk.jobId, database: chunk.database, chunkIndex: chunk.chunkIndex, chunkHash: chunk.chunkHash, endOfUpload: chunk.endOfUpload };
    if (!dispatch) throw privacyError("BUSINESS_STORAGE_UNAVAILABLE");
    const result = createOutputGuard().sanitize(await dispatch(target.id, "/mongodb/bulk/recover-prepare", {
      ...identity, operationId: input.operationId, timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt,
    })).value;
    const saved = await service.call("historical_bulk_result", { ...input, request, requestDigest: prepareRequestDigest(raw), chunk: identity, result });
    return { ...view(saved), history: { ...history, evidence: "exact_remote_chunk" } };
  } catch (error) {
    // A missing job, plain-text audit, caller proof, validation code, or even a
    // not_dispatched flag cannot retrospectively bind an old dispatch to intent.
    return { ...view(record, "historical_dispatch_evidence_required"), history: { ...history,
      remoteEvidenceCode: /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code || "") ? error.code : "MONGODB_RECOVERY_UNAVAILABLE" } };
  }
}

async function bulkPrepareRequest(service, input, record, target, { instance, dispatch }, view) {
  if (!dispatch || record.identity?.instanceId !== target.id) throw privacyError("BUSINESS_OPERATION_DENIED");
  const recovering = input.action === "recover_operation";
  let result, notDispatched = false, unclaimed = false;
  try {
    if (recovering) {
      if (!record.dispatched) {
        unclaimed = true;
        result = { ok: false, error: { code: "MONGODB_PREPARE_FENCED" } };
      } else if (!record.bulkChunk) return view(record, "bulk_prepare_evidence_required");
      else result = await dispatch(target.id, "/mongodb/bulk/recover-prepare", { ...record.bulkChunk,
        operationId: input.operationId, timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt });
    } else {
      const { instanceId, ...request } = input.request || {};
      if (instanceId !== target.id || request.database !== target.database) throw privacyError("BUSINESS_OPERATION_DENIED");
      let chunk, preflightError;
      try { chunk = normalizeMongoBulkChunk(request, instance(target.id).mongodb); } catch (error) { preflightError = error; }
      const bulkChunk = chunk && { jobId: chunk.jobId, database: chunk.database, chunkIndex: chunk.chunkIndex,
        chunkHash: chunk.chunkHash, endOfUpload: chunk.endOfUpload };
      await service.call("claim_bulk_prepare", { ...input, dispatchDigest: prepareRequestDigest(input.request), bulkChunk });
      if (preflightError) { notDispatched = true; throw preflightError; }
      result = await dispatch(target.id, record.route, { ...request,
        operationId: input.operationId, timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt });
    }
    result = createOutputGuard().sanitize(result).value;
  } catch (error) {
    // Only an explicit pre-SSH attestation proves rejection. phase=validation or
    // an absent job alone is never enough to discharge a dispatched operation.
    notDispatched ||= !recovering && error.dispatchState === "not_dispatched";
    result = { ok: false, error: { code: /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code || "") ? error.code : "MONGODB_BULK_FAILED",
      message: "Structured bulk preparation failed; inspect this exact protected intent.",
      operationId: input.operationId, layer: error.layer, phase: error.phase, retriable: error.retriable, ...(error.diagnostic ? { diagnostic: mutationDiagnostic(error.diagnostic) } : {}) } };
  }
  const saved = await service.call("bulk_prepare_result", { ...input, bulkPrepare: record.bulkPrepare, result, notDispatched, unclaimed });
  if (!recovering && result?.ok === true && saved.state !== "complete") {
    result = { ok: false, error: { code: "BUSINESS_OPERATION_RECONCILIATION_REQUIRED",
      message: "Bulk preparation acknowledgement did not prove the exact chunk identity.", operationId: input.operationId, retriable: false } };
  }
  return recovering ? view(saved, saved.state === "uncertain" ? "bulk_prepare_evidence_required" : unclaimed ? "old_attempt_fenced" : undefined)
    : { ...result, intentId: input.id, intentState: saved.state };
}

async function importPrepareRequest(service, input, record, target, { instance, dispatch, preflight }, view) {
  if (!dispatch || record.identity.instanceId !== target.id) throw privacyError("BUSINESS_OPERATION_DENIED");
  const recovering = input.action === "recover_operation";
  if (!recovering && input.attempt !== record.importPrepare.attempt) throw privacyError("BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
  let result, notDispatched = false, unclaimed = false, claimed = false;
  try {
    if (recovering) {
      if (!record.dispatched) {
        // The store rechecks this in the same transaction that closes the
        // attempt. A delayed claim either wins first or can never run later.
        unclaimed = true;
        result = { ok: false, error: { code: "MONGODB_PREPARE_FENCED" } };
      } else if (!record.importBatches?.length) return view(record, "import_prepare_evidence_required");
      else result = await dispatch(target.id, "/mongodb/imports/recover-prepare", { database: target.database,
        importId: record.identity.importId, importReceipt: { ...record.importPrepare, ...(record.riskPlanId ? { riskPlanId: record.riskPlanId } : {}), batchesDigest: prepareRequestDigest({ batches: record.importBatches }) },
        operationId: input.operationId, timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt });
    } else {
      const request = input.request;
      if (request?.instanceId !== target.id || request.database !== target.database) throw privacyError("BUSINESS_OPERATION_DENIED");
      let plan;
      try {
        plan = normalizeMongoImport(request, instance(target.id).mongodb);
        // Reject known stale policy before acquiring a dispatch claim. The
        // transport checks again after the asynchronous claim to cover changes
        // that race with this check or queued SQLite work.
        await preflight?.(target.id);
      } catch (error) { unclaimed = true; throw error; }
      const batches = importBatchIdentity(plan);
      await service.call("claim_import_prepare", { ...input, dispatchDigest: prepareRequestDigest(request), importBatches: batches });
      claimed = true;
      result = await dispatch(target.id, IMPORT_PREPARE_ROUTE, { ...request,
        _businessImport: { ...record.importPrepare, batchesDigest: prepareRequestDigest({ batches }), ...(record.riskPlanId ? { riskPlanId: record.riskPlanId } : {}) },
        operationId: input.operationId, timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt });
    }
    result = createOutputGuard().sanitize(result).value;
  } catch (error) { notDispatched = claimed && error.dispatchState === "not_dispatched"; result = { ok: false, error: { code: /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code || "") ? error.code : "MONGODB_IMPORT_PREPARE_FAILED", ...(error.diagnostic ? { diagnostic: mutationDiagnostic(error.diagnostic) } : {}) } }; }
  const saved = await service.call("import_prepare_result", { ...input, importPrepare: record.importPrepare, result, notDispatched, unclaimed });
  if (recovering) return view(saved, saved.state === "uncertain" ? "import_prepare_evidence_required" : undefined);
  return ["complete", "rejected_before_dispatch"].includes(saved.state) ? { ...result, intentId: input.id, intentState: saved.state } : {
    ok: false, intentId: input.id, intentState: saved.state, error: { code: "BUSINESS_OPERATION_RECONCILIATION_REQUIRED", causeCode: result.error?.code, diagnostic: result.error?.diagnostic } };
}

// Observation shares exact receipt validation with normal recovery, but never
// fences an unclaimed attempt or persists a result. It grants no retry admission.
async function observeImportPreparation(input, record, target, { dispatch }) {
  const base = { ok: true, readOnly: true, intentId: input.id, route: record.route,
    attempt: record.importPrepare?.attempt, protectedState: record.state };
  const unresolved = reason => ({ ...base, state: "unresolved", reason });
  if (record.route !== IMPORT_PREPARE_ROUTE || record.identity?.instanceId !== target.id || !record.importPrepare) {
    return unresolved("import_prepare_identity_required");
  }
  if (record.state === "rejected_before_dispatch") {
    return record.rejection?.attempt === record.importPrepare.attempt &&
      ["unclaimed_attempt_fence", "preflight_before_ssh"].includes(record.rejection.evidence)
      ? { ...base, state: "rejected_before_dispatch", evidenceSource: "protected_rejection", result: record.result }
      : unresolved("pre_dispatch_evidence_required");
  }
  if (record.state === "complete") {
    return importPrepareResultMatches(record, input.id, target.database, record.result)
      ? { ...base, state: "complete", evidenceSource: "protected_receipt", result: record.result }
      : unresolved("import_prepare_evidence_required");
  }
  if (record.state !== "uncertain" || !record.dispatched || !record.importBatches?.length || !dispatch) {
    return unresolved("import_prepare_evidence_required");
  }
  try {
    const result = createOutputGuard().sanitize(await dispatch(target.id, "/mongodb/imports/recover-prepare", {
      database: target.database, importId: record.identity.importId,
      importReceipt: { ...record.importPrepare, ...(record.riskPlanId ? { riskPlanId: record.riskPlanId } : {}), batchesDigest: prepareRequestDigest({ batches: record.importBatches }) },
      operationId: input.operationId, timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt,
    })).value;
    return importPrepareResultMatches(record, input.id, target.database, result)
      ? { ...base, state: "complete", evidenceSource: "exact_remote_receipt", result }
      : unresolved("import_prepare_evidence_required");
  } catch { return unresolved("remote_evidence_unavailable"); }
}

const here = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
export class PrivacyService {
  constructor({ directory, key, maxQueue = 32, workerPath, fenceAuthority } = {}) {
    this.options = { directory, key, fenceAuthority }; this.maxQueue = maxQueue; this.pending = new Map(); this.sequence = 0;
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
export async function privacyRequest(service, input, { instance, origin, dispatch, preflight, historicalEvidence } = {}) {
  // Reconciliation proof is fetched below by the Manager, never accepted from
  // an MCP caller's result object. The store action remains internal.
  const actions = ["create", "attach", "resolve", "commit", "intent", "outcome", "delivered", "cleanup", "dispatch_prepare", "claim_execution", "recover_operation", "resolve_import", "disposition"];
  if (!actions.includes(input?.action)) throw privacyError("BUSINESS_STORAGE_ACTION_DENIED");
  const validate = (scope) => {
    if (typeof scope !== "string" || scope.length > 8192) throw privacyError("BUSINESS_PRIVACY_SCOPE_REQUIRED");
    let target; try { target = JSON.parse(scope); } catch { throw privacyError("BUSINESS_PRIVACY_SCOPE_REQUIRED"); }
    const current = instance(target.id);
    if (!current || current.enabled === false || target.endpoint !== origin || scope !== businessTargetScope(origin, current, target.database)) throw privacyError("BUSINESS_REFERENCE_INVALID");
  };
  if (!["create", "attach", "cleanup"].includes(input.action)) validate(input.scope);
  if (input.action === "resolve_import") {
    const allowed = ["action", "auth", "scope", "originalOperationId", "importId", "requestDigest", "operationId", "timeoutMs", "deadlineAt"];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw privacyError("BUSINESS_OPERATION_LOOKUP_INVALID");
    validateImportLookup(input);
    const found = await service.call("resolve_import_operation", input);
    if (found.state !== "resolved") return { ok: true, readOnly: true, ...found };
    // The resolved record came from authenticated storage, never from callers,
    // logs, a reconstructed identity or a second prepare call.
    return { ...await observeImportPreparation({ ...input, id: found.id }, found.record, JSON.parse(input.scope), { dispatch }), archived: found.archived };
  }
  if (input.action === "outcome") {
    const record = await service.call("inspect_operation", input);
    if (record.executionProtocol === 2) {
      // Never trust an MCP caller's successful result as execution proof. Fetch
      // the exact worker receipt through the same reconciliation protocol.
      return privacyRequest(service, { ...input, action: "recover_operation", mode: "reconcile", result: undefined },
        { instance, origin, dispatch, preflight, historicalEvidence });
    }
  }
  if (input.action === "disposition") {
    const common = ["action", "auth", "scope", "mode", "operationId", "timeoutMs", "deadlineAt"];
    const fields = input.mode === "prepare_orphan_risk" ? ["originalOperationId", "importId", "requestDigest", "originalRequest", "replacementRequest", "reviewMemo"]
      : ["inspect_orphan_risk", "consume_orphan_risk"].includes(input.mode) ? ["riskPlanId", ...(input.mode === "consume_orphan_risk" ? ["reviewHash"] : [])]
      : input.mode === "prepare" ? ["id", "originalRequest"] : input.mode === "quarantine"
      ? ["dispositionId", "reviewHash", "confirmation"] : input.mode === "admit_replacement" ? ["dispositionId", "reviewHash"] : input.mode === "inspect" ? ["dispositionId"]
        : input.mode === "prepare_execution_risk" ? ["id", "riskPlanId"]
          : ["inspect_execution_risk", "continue_execution"].includes(input.mode) ? ["riskPlanId", ...(input.mode === "continue_execution" ? ["reviewHash"] : [])]
        : input.mode === "prepare_risk" ? ["dispositionId", "reviewHash", "originalRequest", "replacementRequest", "reviewMemo"]
          : ["inspect_risk", "create_replacement"].includes(input.mode) ? ["riskPlanId", ...(input.mode === "create_replacement" ? ["reviewHash"] : [])] : [];
    if (!fields.length || Object.keys(input).some(key => ![...common, ...fields].includes(key))) throw privacyError("BUSINESS_DISPOSITION_DENIED");
    if (input.mode === "prepare_orphan_risk") {
      validateImportLookup(input);
      const target = JSON.parse(input.scope), requests = {};
      for (const name of ["originalRequest", "replacementRequest"]) {
        const raw = input[name];
        if (!isImportRequest(raw) || Object.keys(raw).some(key => !["instanceId", "importId", "database", "collection", "documents", "batchSize", "rollbackTtlMs", "purpose", "operationId", "timeoutMs", "deadlineAt"].includes(key)) || raw.instanceId !== target.id || raw.database !== target.database || JSON.stringify(raw).includes("[REDACTED]")) throw privacyError("BUSINESS_DISPOSITION_ORIGINAL_BYTES_REQUIRED");
        const { operationId, deadlineAt, timeoutMs, ...request } = createOutputGuard().sanitize(raw).value;
        if (prepareRequestDigest(raw) !== prepareRequestDigest(request)) throw privacyError("BUSINESS_DISPOSITION_ORIGINAL_BYTES_REQUIRED");
        try { normalizeMongoImport(request, instance(target.id).mongodb); }
        catch { throw privacyError("BUSINESS_DISPOSITION_INPUT_INVALID"); }
        requests[name] = request;
      }
      if (input.reviewMemo !== undefined && (typeof input.reviewMemo !== "string" || input.reviewMemo.length > 4000)) throw privacyError("BUSINESS_ORPHAN_RISK_DENIED");
      const reviewMemo = createOutputGuard().sanitize({ reviewMemo: input.reviewMemo || "" }).value.reviewMemo;
      const batches = importBatchIdentity(normalizeMongoImport(requests.replacementRequest, instance(target.id).mongodb));
      return service.call("orphan_risk_prepare", { ...input, ...requests, reviewMemo, batches });
    }
    if (input.mode === "inspect_orphan_risk") return service.call("orphan_risk_inspect", input);
    if (input.mode === "consume_orphan_risk") {
      const reserved = await service.call("orphan_risk_consume", input);
      if (reserved.done) { const { done, ...result } = reserved; return result; }
      const record = reserved.intent, target = JSON.parse(input.scope);
      const result = await importPrepareRequest(service, { ...input, id: record.id, attempt: 1,
        action: "dispatch_prepare", request: reserved.request }, record, target, { instance, dispatch, preflight }, saved => saved);
      return service.call("orphan_risk_result", { ...input, result });
    }
    if (input.mode === "prepare_execution_risk") {
      const context = await service.call("execution_risk_context", input);
      if (context.existing) return context.existing;
      const b = context.binding;
      // Only Manager-fetched fixed-helper observations enter the protected store.
      const observed = await dispatch(b.instanceId, "/mongodb/imports/execution-review", {
        binding: b, _businessExecution: b.execution, operationId: input.operationId, timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt });
      if (observed?.ok !== true) throw privacyError("BUSINESS_EXECUTION_RISK_OBSERVATION_REQUIRED");
      return service.call("execution_risk_prepare", { ...input, context, proposal: observed.proposal, proposalDigest: observed.proposalDigest });
    }
    if (input.mode === "inspect_execution_risk") return service.call("execution_risk_inspect", input);
    if (input.mode === "continue_execution") {
      const reserved = await service.call("execution_risk_reserve", input);
      if (reserved.done) { const { done, ...result } = reserved; return result; }
      const b = reserved.binding;
      const result = await dispatch(b.instanceId, "/mongodb/imports/execution-continue", { ...reserved,
        _businessExecution: b.execution, operationId: input.operationId, timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt });
      return service.call("execution_risk_result", { ...input, result });
    }
    if (input.mode === "prepare_risk") {
      const target = JSON.parse(input.scope), requests = {};
      for (const name of ["originalRequest", "replacementRequest"]) {
        const raw = input[name];
        if (!raw || raw.instanceId !== target.id || raw.database !== target.database || JSON.stringify(raw).includes("[REDACTED]")) throw privacyError("BUSINESS_DISPOSITION_ORIGINAL_BYTES_REQUIRED");
        const { operationId, deadlineAt, timeoutMs, ...request } = createOutputGuard().sanitize(raw).value;
        if (prepareRequestDigest(raw) !== prepareRequestDigest(request)) throw privacyError("BUSINESS_DISPOSITION_ORIGINAL_BYTES_REQUIRED");
        const { instanceId, ...chunk } = request;
        try {
          if (isImportRequest(request)) normalizeMongoImport(chunk, instance(target.id).mongodb);
          else normalizeMongoBulkChunk(chunk, { ...instance(target.id).mongodb, bulkEnabled: true });
        } catch (error) {
          // Public callers need to distinguish invalid proposals from storage
          // failures. Never forward validator messages containing business data.
          if (["mongodb-bulk", "mongodb-mutation"].includes(error.layer) && error.phase === "validation") throw privacyError("BUSINESS_DISPOSITION_INPUT_INVALID");
          throw error;
        }
        requests[name] = request;
      }
      if (input.reviewMemo !== undefined && (typeof input.reviewMemo !== "string" || input.reviewMemo.length > 4000)) throw privacyError("BUSINESS_DISPOSITION_DENIED");
      const reviewMemo = input.reviewMemo === undefined ? "" : createOutputGuard().sanitize({ reviewMemo: input.reviewMemo }).value.reviewMemo;
      let observations;
      if (isImportRequest(requests.originalRequest)) {
        if (!isImportRequest(requests.replacementRequest)) throw privacyError("BUSINESS_DISPOSITION_INPUT_INVALID");
        const originalBatches = importBatchIdentity(normalizeMongoImport(requests.originalRequest, instance(target.id).mongodb));
        const replacementBatches = importBatchIdentity(normalizeMongoImport(requests.replacementRequest, instance(target.id).mongodb));
        try {
          const observed = await dispatch(target.id, "/mongodb/imports/review", { database: target.database,
            importId: requests.originalRequest.importId, batches: originalBatches, operationId: input.operationId,
            timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt });
          observations = { source: "manager_remote_import_batch_read", observedAt: Date.now(),
            status: observed.ok === true ? "observed" : "unavailable", batches: observed.ok === true ? observed.batches : undefined,
            code: observed.error?.code, historicalOutcome: "unknown" };
        } catch { observations = { source: "manager_remote_import_batch_read", observedAt: Date.now(), status: "unavailable", historicalOutcome: "unknown" }; }
        return service.call("prepare_risk_replacement", { ...input, ...requests, reviewMemo, observations, originalBatches, replacementBatches });
      }
      if (isImportRequest(requests.replacementRequest)) throw privacyError("BUSINESS_DISPOSITION_INPUT_INVALID");
      try {
        const observed = await dispatch(target.id, "/mongodb/bulk/job", { jobId: requests.originalRequest.jobId, includeDifferences: false, timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt, operationId: input.operationId });
        observations = { source: "manager_remote_job_read", observedAt: Date.now(), status: observed.ok === false ? "unavailable" : observed.status || "unknown", code: observed.error?.code, historicalOutcome: "unknown" };
      } catch (error) { observations = { source: "manager_remote_job_read", observedAt: Date.now(), status: "unavailable", code: /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code || "") ? error.code : "UNKNOWN", historicalOutcome: "unknown" }; }
      return service.call("prepare_risk_replacement", { ...input, ...requests, reviewMemo, observations });
    }
    if (input.mode === "inspect_risk") return service.call("inspect_risk_replacement", input);
    if (input.mode === "create_replacement") {
      const target = JSON.parse(input.scope);
      const handoff = await service.call("risk_handoff_context", input);
      if (handoff.required) {
        const result = createOutputGuard().sanitize(await dispatch(target.id, handoff.route || "/mongodb/bulk/retire", {
          ...handoff.request, operationId: input.operationId, timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt })).value;
        await service.call("record_risk_retirement", { ...input, result });
      }
      const reserved = await service.call("create_risk_replacement", input);
      if (reserved.intent.state === "complete") return { ...reserved.risk, result: reserved.intent.result };
      const record = reserved.intent;
      const result = await (record.importPrepare ? importPrepareRequest : bulkPrepareRequest)(service, { ...input, id: record.id, attempt: (record.importPrepare || record.bulkPrepare).attempt,
        action: record.dispatched ? "recover_operation" : "dispatch_prepare", request: reserved.request }, record, target, { instance, dispatch, preflight },
        saved => ({ ok: true, intentId: record.id, state: saved.state, ...(saved.result ? { result: saved.result } : {}) }));
      return { ...reserved.risk, result };
    }
    if (input.mode === "prepare") {
      const raw = input.originalRequest;
      if (!raw || JSON.stringify(raw).includes("[REDACTED]")) throw privacyError("BUSINESS_DISPOSITION_ORIGINAL_BYTES_REQUIRED");
      const { operationId, deadlineAt, timeoutMs, ...request } = createOutputGuard().sanitize(raw).value;
      if (prepareRequestDigest(raw) !== prepareRequestDigest(request)) throw privacyError("BUSINESS_DISPOSITION_ORIGINAL_BYTES_REQUIRED");
      return service.call("prepare_disposition", { ...input, request, requestDigest: prepareRequestDigest(raw) });
    }
    return service.call(({ inspect: "inspect_disposition", quarantine: "quarantine_disposition", admit_replacement: "admit_disposition" })[input.mode], input);
  }
  if (input.action === "intent" && isMongoAdmissionRoute(input.route)) {
    const target = JSON.parse(input.scope);
    if (input.identity?.instanceId !== target.id) throw privacyError("BUSINESS_OPERATION_DENIED");
  }
  if (input.action === "dispatch_prepare" || input.action === "recover_operation") {
    const record = await service.call("inspect_operation", input);
    const target = JSON.parse(input.scope);
    const view = (value, reason) => ({ ok: true, intentId: input.id, state: value.state, route: value.route,
      attempt: (value.prepare || value.bulkPrepare || value.importPrepare)?.attempt || value.executionAttempt, mutationId: value.prepare?.mutationId,
      legacy: value.route === "/mongodb/mutations/prepare" && !value.prepare || value.route === "/mongodb/bulk/prepare" && !value.bulkPrepare,
      reason, recoveryCode: value.reconciliation?.code, ...(value.result ? { result: value.result } : {}) });
    if (input.action === "recover_operation") {
      if (!["inspect", "reconcile", "historical", "observe"].includes(input.mode)) throw privacyError("BUSINESS_STORAGE_INVALID");
      if (input.mode === "observe") return observeImportPreparation(input, record, target, { dispatch });
      if (input.mode === "historical") {
        if (record.route !== "/mongodb/bulk/prepare" || record.bulkPrepare) throw privacyError("BUSINESS_OPERATION_DENIED");
        return historicalBulkRequest(service, input, record, target, { instance, dispatch, historicalEvidence }, view);
      }
      if (input.mode === "inspect" || record.state !== "uncertain") return view(record);
      if (record.route === IMPORT_PREPARE_ROUTE) {
        if (!record.importPrepare) return view(record, "legacy_evidence_required");
        return importPrepareRequest(service, input, record, target, { instance, dispatch, preflight }, view);
      }
      if (record.route === "/mongodb/bulk/prepare") {
        if (!record.bulkPrepare) return view(record, "bulk_prepare_identity_required");
        return bulkPrepareRequest(service, input, record, target, { instance, dispatch }, view);
      }
      // Old envelopes have no prepare identity. No absence query or caller-supplied
      // error text can turn those records into permission to dispatch again.
      if (!record.prepare) {
        const identity = record.identity || {};
        if (dispatch && /^[a-f0-9]{64}$/.test(identity.planHash || "") && (identity.mutationId || identity.jobId)) {
          try {
            const receipt = await dispatch(target.id, identity.mutationId && record.execution ? "/mongodb/mutations/recover-execution" : identity.mutationId ? "/mongodb/mutations/get" : "/mongodb/bulk/job",
              { ...(identity.mutationId ? { mutationId: identity.mutationId } : { jobId: identity.jobId }), planHash: identity.planHash,
                database: target.database, ...(record.execution ? { _businessExecution: record.execution } : {}),
                operationId: input.operationId, timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt });
            const evidence = identity.mutationId ? { ok: receipt.ok === true, entries: [receipt] } : receipt;
            const saved = await service.call("reconcile", { ...input, result: createOutputGuard().sanitize(evidence).value });
            return view({ ...record, ...saved }, saved.state === "uncertain"
              ? receipt.indexRecovery?.reason || (receipt.status === "commit_failed" && !record.execution ? "legacy_execution_evidence_required" : "remote_outcome_unproven") : undefined);
          } catch (error) { return { ...view(record, "remote_evidence_unavailable"), recoveryCode: /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code || "") ? error.code : "MONGODB_RECOVERY_UNAVAILABLE" }; }
        }
        return view(record, "legacy_evidence_required");
      }
    }
    if (input.action === "dispatch_prepare" && record.route === IMPORT_PREPARE_ROUTE && record.importPrepare) return importPrepareRequest(service, input, record, target, { instance, dispatch, preflight }, view);
    if (input.action === "dispatch_prepare" && record.route === "/mongodb/bulk/prepare" && record.bulkPrepare) {
      return bulkPrepareRequest(service, input, record, target, { instance, dispatch }, view);
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
        operationId: input.operationId, layer: error.layer, phase: error.phase, retriable: error.retriable, ...(error.diagnostic ? { diagnostic: mutationDiagnostic(error.diagnostic) } : {}) } };
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

export function installPrivacyRoutes(app, { directory, registry, service, dispatch, preflight, dataDirectory, historicalEvidence } = {}) {
  const storage = service || new PrivacyService({ directory });
  app.locals.privacyService = storage;
  app.post("/api/private/business-storage", async (request, response) => {
    try {
      const result = await privacyRequest(storage, request.body, { instance: (id) => registry.getInternal(id), origin: new URL(`http://${request.headers.host}`).origin, dispatch, preflight,
        historicalEvidence: historicalEvidence || (dataDirectory ? createBulkHistoryReader({ dataDirectory, instance: (id) => registry.getInternal(id) }) : undefined) });
      response.json({ ok: true, result });
    } catch (error) {
      response.status(409).json({ ok: false, error: { code: error.code?.startsWith("BUSINESS_") ? error.code : "BUSINESS_STORAGE_UNAVAILABLE",
        message: error.code === "BUSINESS_DISPOSITION_INPUT_INVALID" ? "Risk replacement input failed bulk validation; inspect the exact original and proposed first chunks. No request was dispatched." : privacyError().message,
        retriable: false } });
    }
  });
}

// Apply to Manager proxy calls as well as protected dispatch. This gate makes
// new local admissions fail closed; it cannot recall a request already handed
// to an old worker, SSH queue, helper or MongoDB transaction.
export async function assertMongoDispatchAdmission(service, instanceId, route, request, defaultDatabase, trustedPrivacyDispatch = false) {
  if (isMongoAdmissionRoute(route)) await service.call("assert_instance_admission", { instanceId, route, ...(trustedPrivacyDispatch ? { orphanIntentId: request._businessImport?.binding } : {}), request: route.startsWith("/mongodb/imports/") ? { ...request, database: request.database || defaultDatabase } : request });
}

export async function humanRiskRequest(service, action, input, instance) {
  const context = await service.call(action.startsWith("human_orphan_risk_") ? "human_orphan_risk_context" : action.startsWith("human_execution_risk_") ? "human_execution_risk_context" : "human_risk_context", input);
  const target = JSON.parse(context.targetScope), current = instance(input.instanceId);
  if (!current || current.enabled === false || context.targetScope !== riskTargetScope(target.endpoint, current, target.database)) throw privacyError("BUSINESS_REPLACEMENT_STALE");
  return service.call(action, { ...input, targetScope: context.targetScope });
}
