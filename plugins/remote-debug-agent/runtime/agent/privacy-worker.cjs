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
    for (let key3 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key3) && key3 !== except)
        __defProp(to, key3, { get: () => from[key3], enumerable: !(desc = __getOwnPropDesc(from, key3)) || desc.enumerable });
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
    var fs3 = require("fs");
    var path3 = require("path");
    var { createHash: createHash4 } = require("crypto");
    var { execFileSync: execFileSync2 } = require("child_process");
    function fail2(code = "BUSINESS_STORAGE_UNAVAILABLE") {
      return Object.assign(new Error("Windows protected local storage is unavailable; no business operation was replayed."), { code, statusCode: 409, retriable: false });
    }
    function native(action, input = {}, run = execFileSync2) {
      if (process.platform !== "win32") throw fail2("BUSINESS_KEYSTORE_UNSUPPORTED");
      const systemRoot = process.env.SystemRoot || process.env.WINDIR;
      if (!systemRoot || !path3.isAbsolute(systemRoot)) throw fail2("BUSINESS_KEYSTORE_UNAVAILABLE");
      try {
        const helper = path3.join(__dirname, "native/windows-privacy.ps1");
        const manifestPath = fs3.existsSync(path3.join(__dirname, "runtime-manifest.json")) ? path3.join(__dirname, "runtime-manifest.json") : path3.join(__dirname, "runtime/agent/runtime-manifest.json");
        const expected = JSON.parse(fs3.readFileSync(manifestPath, "utf8")).hashes?.["native/windows-privacy.ps1"];
        if (!/^[a-f0-9]{64}$/.test(expected || "") || createHash4("sha256").update(fs3.readFileSync(helper)).digest("hex") !== expected) throw fail2("BUSINESS_STORAGE_INTEGRITY_INVALID");
        const raw = run(
          path3.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
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
        if (result.ok !== true) throw fail2(/^BUSINESS_[A-Z_]+$/.test(result.code || "") ? result.code : void 0);
        return result;
      } catch (error2) {
        if (error2.code?.startsWith("BUSINESS_")) throw fail2(error2.code);
        throw fail2(action === "key" ? "BUSINESS_KEYSTORE_UNAVAILABLE" : action.includes("context") ? "BUSINESS_CONTEXT_DENIED" : "BUSINESS_STORAGE_PATH_INVALID");
      }
    }
    function targetFor(directory) {
      return "RemoteDebugAgent/business-privacy/v1/" + createHash4("sha256").update(fs3.realpathSync.native(directory)).digest("hex");
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
      if (!/^[a-f0-9]{64}$/.test(result.key || "")) throw fail2("BUSINESS_KEYSTORE_UNAVAILABLE");
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
  } catch (error2) {
    if (existing || error2.status !== 44) throw privacyError("BUSINESS_KEYSTORE_UNAVAILABLE");
  }
  const key3 = (0, import_node_crypto.randomBytes)(32);
  try {
    run("/usr/bin/security", ["-i"], { input: `add-generic-password -s ${service} -a ${account} -w ${key3.toString("hex")}
`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15e3 });
    return read();
  } catch {
    throw privacyError("BUSINESS_KEYSTORE_UNAVAILABLE");
  } finally {
    key3.fill(0);
  }
}

// ../plugins/remote-debug-agent/prepare-protocol.js
var import_node_crypto2 = require("node:crypto");
function bulkPreparePayload(args) {
  return {
    instanceId: args.instanceId,
    jobId: args.jobId,
    database: args.database,
    chunkIndex: args.chunkIndex,
    chunkHash: args.chunkHash,
    units: args.units,
    purpose: args.purpose,
    rollbackTtlMs: args.rollbackTtlMs,
    endOfUpload: args.endOfUpload,
    timeoutMs: args.timeoutMs
  };
}
function prepareRequestDigest(input) {
  const { operationId, deadlineAt, timeoutMs, _businessPrepare, _businessImport, ...request } = input;
  return (0, import_node_crypto2.createHash)("sha256").update(JSON.stringify(request)).digest("hex");
}
function isPrepareTicket(value) {
  return value && /^[a-f0-9-]{36}$/.test(value.mutationId || "") && /^[a-f0-9]{64}$/.test(value.binding || "") && /^[a-f0-9]{64}$/.test(value.requestDigest || "") && Number.isSafeInteger(value.attempt) && value.attempt > 0;
}
function importPreparePayload(args) {
  return {
    instanceId: args.instanceId,
    importId: args.importId,
    database: args.database,
    collection: args.collection,
    documents: args.documents,
    batchSize: args.batchSize,
    rollbackTtlMs: args.rollbackTtlMs,
    purpose: args.purpose,
    timeoutMs: args.timeoutMs
  };
}
var IMPORT_PREPARE_ROUTE = "/mongodb/imports/prepare";

// mongodb-import-risk.js
var MAX = Number.MAX_SAFE_INTEGER;
var POLICY = "human-risk-acceptance-v2";
var CONFIRM = "我接受历史结果未知的风险，并批准建立此替代任务";
var fail = (code = "BUSINESS_REPLACEMENT_DENIED") => {
  throw privacyError(code);
};
var key = (store2, kind, instanceId, database, id) => store2.hash("risk-import-" + kind, instanceId, database, id);
function load(store2, id) {
  const row = store2.db.prepare("SELECT * FROM records WHERE kind='risk_replacement' AND id=?").get(id);
  if (!row) fail();
  const plan = store2.open(row);
  if (plan.kind !== "import") fail();
  return { plan, ctx: row.ctx, scope: row.scope };
}
function current(store2, plan, ctx, scope) {
  const record = store2.get("operation", plan.binding.intentId, ctx, scope);
  if (record?.state !== "uncertain" || store2.hash("operation-record", ctx, plan.targetScope, plan.binding.intentId, record) !== plan.recordFingerprint) fail("BUSINESS_REPLACEMENT_STALE");
}
function event(store2, type, plan, ctx, scope, details = {}) {
  const id = store2.hash("risk-import-audit", type, plan.id, details);
  if (!store2.get("event", id, ctx, scope)) store2.put(
    "event",
    id,
    ctx,
    scope,
    {
      type,
      riskPlanId: plan.id,
      dispositionId: plan.dispositionId,
      binding: plan.binding,
      requestDigest: plan.requestDigest,
      historicalOutcome: "unknown",
      at: store2.now(),
      ...details
    },
    MAX,
    true
  );
  return id;
}
var candidateKey = (store2, plan) => key(store2, "candidate", plan.binding.instanceId, plan.binding.database, plan.replacementRequest.importId);
var retirementKey = (store2, plan) => key(store2, "retirement", plan.binding.instanceId, plan.binding.database, plan.binding.importId);
var gateKey = (store2, plan) => key(store2, "gate", plan.binding.instanceId, plan.binding.database, plan.replacementRequest.importId);
function reviewHash(store2, plan) {
  return store2.hash(
    "risk-import-human-review-v2",
    plan.id,
    plan.recordFingerprint,
    plan.expiresAt,
    plan.requestDigest,
    plan.effectDigest,
    plan.originalBatches,
    plan.replacementBatches,
    plan.observations,
    plan.reviewMemo,
    plan.approvalPolicy
  );
}
function importRiskView(store2, plan) {
  const { ctx, scope } = load(store2, plan.id);
  const parent = store2.get("disposition", plan.dispositionId, ctx, scope);
  let unchanged = true;
  try {
    current(store2, plan, ctx, scope);
  } catch {
    unchanged = false;
  }
  const candidate = store2.get("risk_import_candidate", candidateKey(store2, plan), "", "");
  const eligible = candidate?.riskPlanId === plan.id && unchanged && (parent?.state === "review_required" || parent?.state === "quarantined" || ["termination_requested", "retired_unknown"].includes(parent?.state) && parent.retirement?.riskPlanId === plan.id);
  return {
    ok: true,
    kind: "import",
    riskPlanId: plan.id,
    dispositionId: plan.dispositionId,
    binding: plan.binding,
    state: plan.state,
    replacementImportId: plan.replacementRequest.importId,
    replacementIntentId: plan.replacementIntentId,
    replacementRequestDigest: plan.requestDigest,
    effectDigest: plan.effectDigest,
    originalBatches: plan.originalBatches,
    replacementBatches: plan.replacementBatches,
    batchCount: plan.replacementBatches.length,
    documentCount: plan.replacementRequest.documents.length,
    collections: [plan.replacementRequest.collection],
    atomicity: "per_batch",
    reviewHash: reviewHash(store2, plan),
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    approvalPolicy: POLICY,
    approvalAuthority: "independent-human-administrator",
    confirmation: CONFIRM,
    historicalOutcome: "unknown",
    legacyInFlightOutcome: "unknown",
    humanApproved: !!plan.approval,
    humanConfirmationRequired: !plan.approval,
    canApprove: eligible && !plan.approval && store2.now() < plan.expiresAt,
    replacementAllowed: eligible && !!plan.approval && store2.now() < plan.approval.validUntil,
    remoteFenceConfirmed: false,
    remoteTermination: plan.remoteRetirement ? "recorded" : "pending",
    originalTaskState: parent?.retirement?.riskPlanId === plan.id ? "terminated_unknown" : "protected_unknown",
    acceptedResidualRisk: !!plan.approval,
    reviewMemo: plan.reviewMemo,
    memoSource: "caller_statement_not_verified_evidence",
    observations: plan.observations,
    historicalEvidenceGaps: parent?.missingRequirements || [],
    batches: plan.preparedBatches || [],
    warning: "历史导入及在途事务结果未知。人工接受迟到提交、重复导入和部分批次成功风险，不证明未执行。每批独立确认、事务及回滚；已有文档不证明本任务所有权。",
    auditId: plan.auditId,
    approvalAuditId: plan.approval?.auditId,
    creationAuditId: plan.creationAuditId
  };
}
function prepareImportRisk(store2, input, ctx, scope) {
  return store2.transaction(() => {
    const parent = store2.get("disposition", input.dispositionId, ctx, scope), a = input.originalRequest, b = input.replacementRequest;
    const { importId: _a, ...effectA } = a || {}, { importId: _b, ...effectB } = b || {};
    if (!parent || parent.binding.kind !== "import" || parent.binding.contextId !== ctx || input.reviewHash !== parent.reviewHash || !a || !b || a.instanceId !== parent.binding.instanceId || a.database !== parent.binding.database || prepareRequestDigest(a) !== parent.binding.requestDigest || store2.hash("operation", ctx, input.scope, IMPORT_PREPARE_ROUTE, a) !== parent.binding.intentId || a.importId !== parent.binding.importId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(b.importId || "") || a.importId === b.importId || prepareRequestDigest(effectA) !== prepareRequestDigest(effectB) || !input.originalBatches?.length || !input.replacementBatches?.length) fail();
    const id = store2.hash("risk-import-human-v2", ctx, input.scope, parent.id, prepareRequestDigest(b), parent.recordFingerprint, input.reviewMemo || "");
    const old = store2.get("risk_replacement", id, ctx, scope);
    if (old && (JSON.stringify(old.originalBatches) !== JSON.stringify(input.originalBatches) || JSON.stringify(old.replacementBatches) !== JSON.stringify(input.replacementBatches))) fail("BUSINESS_REPLACEMENT_STALE");
    if (old && store2.now() < (old.approval?.validUntil || old.expiresAt)) return importRiskView(store2, old);
    const plan = {
      ...old,
      id,
      kind: "import",
      approvalPolicy: POLICY,
      dispositionId: parent.id,
      binding: parent.binding,
      targetScope: input.scope,
      recordFingerprint: parent.recordFingerprint,
      originalRequest: a,
      replacementRequest: b,
      requestDigest: prepareRequestDigest(b),
      effectDigest: prepareRequestDigest(effectA),
      originalBatches: input.originalBatches,
      replacementBatches: input.replacementBatches,
      reviewMemo: input.reviewMemo || "",
      observations: input.observations,
      state: "awaiting_human",
      approval: void 0,
      createdAt: old?.createdAt || store2.now(),
      expiresAt: store2.now() + 36e5
    };
    current(store2, plan, ctx, scope);
    for (const [kind, k] of [["risk_import_candidate", candidateKey(store2, plan)], ["risk_import_gate", gateKey(store2, plan)]]) {
      const existing = store2.get(kind, k, "", "");
      if (existing && existing.riskPlanId !== id) fail("BUSINESS_REPLACEMENT_JOB_CONFLICT");
    }
    const retired = store2.get("risk_import_retirement", retirementKey(store2, plan), "", "");
    if (retired && retired.riskPlanId !== id) fail("BUSINESS_REPLACEMENT_JOB_CONFLICT");
    plan.auditId = event(store2, "risk_import_prepared", plan, ctx, scope, { revision: store2.now() });
    store2.put("risk_replacement", id, ctx, scope, plan, MAX, true);
    store2.put("risk_import_candidate", candidateKey(store2, plan), "", "", { riskPlanId: id, ctx, scope }, MAX, true);
    for (const batch2 of plan.replacementBatches) {
      const k = key(store2, "batch", b.instanceId, "", batch2.mutationId), existing = store2.get("risk_import_batch", k, "", "");
      if (existing && existing.riskPlanId !== id) fail("BUSINESS_REPLACEMENT_JOB_CONFLICT");
      store2.put("risk_import_batch", k, "", "", { riskPlanId: id, role: "replacement", ctx, scope }, MAX, true);
    }
    return importRiskView(store2, plan);
  });
}
function importHumanAction(store2, action, input, found) {
  const { plan, ctx, scope } = found;
  if (plan.binding.instanceId !== input.instanceId) fail();
  if (action === "human_risk_context") return { targetScope: plan.targetScope, database: plan.binding.database };
  if (input.targetScope !== plan.targetScope) fail();
  if (action === "human_risk_view") return importRiskView(store2, plan);
  return store2.transaction(() => {
    if (input.confirmation !== CONFIRM || input.reviewHash !== reviewHash(store2, plan) || typeof input.actor?.username !== "string" || !input.actor.username || typeof input.actor?.sessionId !== "string" || !input.actor.sessionId || !Number.isSafeInteger(input.actor.verifiedAt) || input.actor.verifiedAt > store2.now() || store2.now() - input.actor.verifiedAt > 6e4) fail();
    if (plan.approval) {
      requireApproval(store2, plan, input, ctx, scope);
      return importRiskView(store2, plan);
    }
    if (!importRiskView(store2, plan).canApprove) fail("BUSINESS_REPLACEMENT_STALE");
    const retired = store2.get("risk_import_retirement", retirementKey(store2, plan), "", "");
    if (retired && retired.riskPlanId !== plan.id) fail("BUSINESS_REPLACEMENT_JOB_CONFLICT");
    const approval = { ...input.actor, reviewHash: input.reviewHash, policy: POLICY, validUntil: Math.min(plan.expiresAt, store2.now() + 9e5) };
    approval.auditId = event(store2, "risk_import_human_approved", plan, ctx, scope, approval);
    const retirement = { riskPlanId: plan.id, replacementImportId: plan.replacementRequest.importId, approvalAuditId: approval.auditId, at: store2.now() };
    store2.put("risk_import_retirement", retirementKey(store2, plan), "", "", { ...retirement, database: plan.binding.database, importId: plan.binding.importId }, MAX, true);
    for (const batch2 of plan.originalBatches) store2.put(
      "risk_import_batch",
      key(store2, "batch", plan.binding.instanceId, "", batch2.mutationId),
      "",
      "",
      { riskPlanId: plan.id, role: "original", ctx, scope },
      MAX,
      true
    );
    const parent = store2.get("disposition", plan.dispositionId, ctx, scope);
    if (parent.state !== "retired_unknown") store2.put("disposition", parent.id, ctx, scope, { ...parent, state: "termination_requested", retirement }, MAX, true);
    const taskId = store2.hash("task", ctx, plan.targetScope, "operation:" + plan.binding.intentId), task = store2.get("task", taskId, ctx, scope);
    if (task) store2.put("task", taskId, ctx, scope, { ...task, active: false, status: "terminated_unknown" }, MAX, true);
    const saved = { ...plan, state: "human_approved", approval };
    store2.put("risk_replacement", plan.id, ctx, scope, saved, MAX, true);
    return importRiskView(store2, saved);
  });
}
function requireApproval(store2, plan, input, ctx, scope) {
  if (plan.approval?.policy !== POLICY || input.reviewHash !== plan.approval.reviewHash) fail("BUSINESS_REPLACEMENT_HUMAN_CONFIRMATION_REQUIRED");
  if (store2.now() >= plan.approval.validUntil) fail("BUSINESS_REPLACEMENT_APPROVAL_EXPIRED");
  current(store2, plan, ctx, scope);
  if (store2.get("risk_import_retirement", retirementKey(store2, plan), "", "")?.riskPlanId !== plan.id) fail("BUSINESS_REPLACEMENT_JOB_CONFLICT");
}
function importRiskAction(store2, action, input, found) {
  const { plan, ctx, scope } = found;
  if (plan.targetScope !== input.scope) fail();
  if (action === "inspect_risk_replacement") return importRiskView(store2, plan);
  requireApproval(store2, plan, input, ctx, scope);
  const request = {
    database: plan.binding.database,
    importId: plan.binding.importId,
    replacementImportId: plan.replacementRequest.importId,
    riskPlanId: plan.id,
    dispositionId: plan.dispositionId,
    originalRequestDigest: plan.binding.requestDigest,
    replacementRequestDigest: plan.requestDigest,
    approvalAuditId: plan.approval.auditId,
    originalBatches: plan.originalBatches,
    replacementBatches: plan.replacementBatches
  };
  if (action === "risk_handoff_context") return { required: true, route: "/mongodb/imports/retire", request };
  if (action === "record_risk_retirement") {
    const result = input.result;
    if (result?.ok !== true || result.status !== "terminated_unknown" || result.managedAdmissionClosed !== true || result.riskPlanId !== plan.id || result.originalRequestDigest !== plan.binding.requestDigest || result.replacementRequestDigest !== plan.requestDigest || result.importId !== plan.binding.importId || result.replacementImportId !== plan.replacementRequest.importId || result.database !== plan.binding.database || result.dispositionId !== plan.dispositionId || result.approvalAuditId !== plan.approval.auditId || JSON.stringify(result.originalBatches) !== JSON.stringify(plan.originalBatches) || JSON.stringify(result.replacementBatches) !== JSON.stringify(plan.replacementBatches) || !/^[a-f0-9]{64}$/.test(result.controlRecordDigest || "")) fail("BUSINESS_REPLACEMENT_TERMINATION_REQUIRED");
    const saved2 = { ...plan, remoteRetirement: { ...request, controlRecordDigest: result.controlRecordDigest, recordedAt: store2.now() } };
    store2.put("risk_replacement", plan.id, ctx, scope, saved2, MAX, true);
    event(store2, "risk_import_remote_retirement", saved2, ctx, scope, { controlRecordDigest: result.controlRecordDigest });
    return { ok: true };
  }
  if (!plan.remoteRetirement) fail("BUSINESS_REPLACEMENT_TERMINATION_REQUIRED");
  const id = store2.hash("operation", ctx, plan.targetScope, IMPORT_PREPARE_ROUTE, plan.replacementRequest);
  const previousRecord = store2.get("operation", id, ctx, scope);
  const previous = previousRecord && continuePartialImport(store2, id, previousRecord, ctx, scope), gate = store2.get("risk_import_gate", gateKey(store2, plan), "", "");
  if (previous && !gate || gate && gate.riskPlanId !== plan.id) fail("BUSINESS_REPLACEMENT_JOB_CONFLICT");
  if (previous?.state === "rejected_before_dispatch") {
    const evidenceId = store2.hash("import-attempt", ctx, plan.targetScope, id, previous.importPrepare.attempt);
    if (!store2.get("import_prepare_evidence", evidenceId, ctx, scope)) store2.put("import_prepare_evidence", evidenceId, ctx, scope, { intentId: id, ...previous }, MAX, true);
  }
  const record = previous && previous.state !== "rejected_before_dispatch" ? previous : {
    route: IMPORT_PREPARE_ROUTE,
    state: "uncertain",
    started: store2.now(),
    identity: {
      instanceId: plan.binding.instanceId,
      database: plan.binding.database,
      collection: plan.binding.collection,
      importId: plan.replacementRequest.importId
    },
    importPrepare: { binding: id, requestDigest: plan.requestDigest, attempt: (previous?.importPrepare?.attempt || 0) + 1 },
    importBatches: plan.replacementBatches,
    riskPlanId: plan.id
  };
  if (!previous || previous.state === "rejected_before_dispatch" || previous !== previousRecord) store2.put("operation", id, ctx, scope, record, MAX, true);
  const taskId = store2.hash("task", ctx, plan.targetScope, "operation:" + id), oldTask = store2.hash("task", ctx, plan.targetScope, "operation:" + plan.binding.intentId);
  store2.put("task", taskId, ctx, scope, { id: "operation:" + id, active: record.state === "uncertain", expires: MAX }, MAX, true);
  store2.db.prepare("INSERT OR IGNORE INTO links SELECT ctx,scope,?,ref FROM links WHERE ctx=? AND scope=? AND task=?").run(taskId, ctx, scope, oldTask);
  const creationAuditId = plan.creationAuditId || event(store2, "risk_import_creation_reserved", plan, ctx, scope, { replacementIntentId: id, approvalAuditId: plan.approval.auditId });
  const saved = { ...plan, state: record.state === "complete" ? "prepared" : "creating", creationAuditId, replacementIntentId: id };
  store2.put("risk_replacement", plan.id, ctx, scope, saved, MAX, true);
  store2.put("risk_import_gate", gateKey(store2, plan), "", "", { riskPlanId: plan.id, ctx, scope }, MAX, true);
  const parent = store2.get("disposition", plan.dispositionId, ctx, scope);
  store2.put("disposition", parent.id, ctx, scope, { ...parent, state: "retired_unknown", retirement: { ...parent.retirement, replacementIntentId: id } }, MAX, true);
  return { intent: { id, ...record }, request: plan.replacementRequest, risk: importRiskView(store2, saved) };
}
function importReplacementAdmission(store2, instanceId, admission) {
  const request = admission.request || admission.identity || {}, database = request.database || (() => {
    try {
      return JSON.parse(admission.scope).database;
    } catch {
      return void 0;
    }
  })();
  if (!database || typeof request.importId !== "string") return false;
  const gate = store2.get("risk_import_gate", key(store2, "gate", instanceId, database, request.importId), "", "");
  if (!gate) return false;
  const { plan } = load(store2, gate.riskPlanId);
  if (admission.ctx && admission.ctx !== gate.ctx) return false;
  return admission.route === IMPORT_PREPARE_ROUTE && !!plan.approval && store2.now() < plan.approval.validUntil && (admission.dispatchDigest || prepareRequestDigest(importPreparePayload({ ...request, instanceId, database }))) === plan.requestDigest;
}
function assertImportAdmission(store2, instanceId, admission) {
  const request = admission.request || admission.identity || {};
  let database = request.database;
  if (!database && admission.scope) {
    try {
      database = JSON.parse(admission.scope).database;
    } catch {
    }
  }
  const found = typeof request.mutationId === "string" && store2.get("risk_import_batch", key(store2, "batch", instanceId, "", request.mutationId), "", "");
  if (found) {
    const { plan } = load(store2, found.riskPlanId);
    if (database && plan.binding.database !== database) fail("BUSINESS_REPLACEMENT_NOT_ADMITTED");
    if (found.role === "original") fail("BUSINESS_ORIGINAL_JOB_TERMINATED");
    const batch2 = plan.preparedBatches?.find((b) => b.mutationId === request.mutationId);
    if (!batch2 || batch2.planHash !== request.planHash || !plan.approval || store2.now() >= plan.approval.validUntil || admission.ctx && admission.ctx !== found.ctx || !["/mongodb/mutations/execute", "/mongodb/mutations/rollback"].includes(admission.route)) fail("BUSINESS_REPLACEMENT_NOT_ADMITTED");
    return true;
  }
  if (!request.importId || !database) return false;
  if (store2.get("risk_import_retirement", key(store2, "retirement", instanceId, database, request.importId), "", "")) fail("BUSINESS_ORIGINAL_JOB_TERMINATED");
  const candidate = store2.get("risk_import_candidate", key(store2, "candidate", instanceId, database, request.importId), "", "");
  if (candidate && !importReplacementAdmission(store2, instanceId, admission)) fail("BUSINESS_REPLACEMENT_NOT_ADMITTED");
  return !!candidate;
}
function continuePartialImport(store2, id, record, ctx, scope) {
  if (record.state !== "complete" || !["prepare_partial", "prepare_rejected"].includes(record.result?.status)) return record;
  const attempt = record.importPrepare.attempt;
  const evidenceId = store2.hash("import-prepare-evidence", ctx, scope, id, attempt);
  store2.put("import_prepare_evidence", evidenceId, ctx, scope, { intentId: id, attempt, result: record.result, record, at: store2.now() }, MAX, true);
  return {
    ...record,
    state: "uncertain",
    importPrepare: { ...record.importPrepare, attempt: attempt + 1 },
    dispatched: void 0,
    operationId: void 0,
    result: void 0,
    reconciliation: void 0
  };
}
function recordImportPrepared(store2, record, result) {
  if (!record.riskPlanId) return;
  const { plan, ctx, scope } = load(store2, record.riskPlanId);
  const batches = result.batches.map(({ mutationId, planHash, batchIndex, status }) => ({ mutationId, planHash, batchIndex, status }));
  const saved = { ...plan, state: result.status === "prepared" ? "prepared" : "prepare_partial", preparedBatches: batches };
  saved.preparedAuditId = event(store2, "risk_import_prepared_remotely", plan, ctx, scope, { batches });
  store2.put("risk_replacement", plan.id, ctx, scope, saved, MAX, true);
}

// privacy-store.js
var import_node_sqlite = require("node:sqlite");
var import_node_crypto4 = require("node:crypto");
var import_node_fs2 = __toESM(require("node:fs"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);
var import_windows_privacy2 = __toESM(require_windows_privacy(), 1);

// mongodb-fence-authority.js
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_node_crypto3 = require("node:crypto");
var FENCE_COVERAGE = Object.freeze(["dispatch", "upload", "execute", "resume", "replay", "old_processes", "queues", "leases", "restart", "authenticated_sessions", "inflight_transactions", "legacy_credentials"]);
var digest = (value) => (0, import_node_crypto3.createHash)("sha256").update(JSON.stringify(value)).digest("hex");
function fenceChallenge(plan) {
  return {
    version: 1,
    binding: plan.binding,
    targetScopeDigest: digest(plan.targetScope),
    replacementJobId: plan.replacementRequest.jobId,
    replacementRequestDigest: plan.requestDigest,
    sealRequestDigest: plan.sealDigest,
    effectDigest: plan.effectDigest
  };
}
function readOwnedFile(filename) {
  if (!import_node_path.default.isAbsolute(filename)) throw Error();
  for (let parent = import_node_path.default.dirname(filename); parent !== import_node_path.default.dirname(parent); parent = import_node_path.default.dirname(parent)) {
    const stat = import_node_fs.default.lstatSync(parent);
    if (stat.isSymbolicLink() && !(process.platform === "darwin" && ["/tmp", "/var"].includes(parent))) throw Error();
    if (process.platform !== "win32" && (stat.mode & 18 || ![0, process.getuid()].includes(stat.uid)) && !["/tmp", "/private/tmp"].includes(parent)) throw Error();
  }
  const fd = import_node_fs.default.openSync(filename, import_node_fs.default.constants.O_RDONLY | (import_node_fs.default.constants.O_NOFOLLOW || 0));
  try {
    const before = import_node_fs.default.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 65536 || process.platform !== "win32" && (before.mode & 63 || ![0, process.getuid()].includes(before.uid))) throw Error();
    const value = JSON.parse(import_node_fs.default.readFileSync(fd, "utf8")), after = import_node_fs.default.fstatSync(fd), current2 = import_node_fs.default.lstatSync(filename);
    if (before.ino !== current2.ino || before.dev !== current2.dev || current2.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error();
    return value;
  } finally {
    import_node_fs.default.closeSync(fd);
  }
}
function inspectFenceAuthority(plan, options = {}, now = Date.now()) {
  const configured = options.trustFile && options.receiptDirectory;
  if (!configured) return { confirmed: false, reason: "executor_fence_authority_not_configured" };
  if (process.platform === "win32") return { confirmed: false, reason: "executor_fence_native_acl_verifier_required" };
  try {
    const trust = readOwnedFile(options.trustFile);
    const receipt = readOwnedFile(import_node_path.default.join(options.receiptDirectory, plan.id + ".json"));
    if (trust.version !== 1 || trust.boundaryType !== "externally-enforced-legacy-retirement-v1" || typeof trust.issuer !== "string") throw Error();
    const key3 = (0, import_node_crypto3.createPublicKey)(trust.publicKey);
    if (key3.asymmetricKeyType !== "ed25519" || receipt.version !== 1 || typeof receipt.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(receipt.signature)) throw Error();
    const p = receipt.payload;
    if (!p || !(0, import_node_crypto3.verify)(null, Buffer.from(JSON.stringify(p)), key3, Buffer.from(receipt.signature, "base64"))) throw Error();
    if (p.issuer !== trust.issuer || p.challengeDigest !== digest(fenceChallenge(plan)) || p.riskPlanId !== plan.id || typeof p.receiptId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(p.receiptId) || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.validUntil) || p.issuedAt > now || p.validUntil <= now || p.validUntil - p.issuedAt > 36e5 || p.issuedAt < plan.createdAt || p.protection !== "permanent" || p.historicalOutcome !== "unknown" || p.inFlightTransactions !== "terminal" || p.restartSafe !== true || p.legacyCredentialsRevoked !== true || p.oldSessionsDrained !== true || p.oldQueuesDrained !== true || !Array.isArray(p.coverage) || p.coverage.length !== FENCE_COVERAGE.length || FENCE_COVERAGE.some((x) => !p.coverage.includes(x))) throw Error();
    return { confirmed: true, issuer: trust.issuer, receiptId: p.receiptId, fingerprint: digest(receipt), validUntil: p.validUntil };
  } catch {
    return { confirmed: false, reason: "executor_fence_receipt_missing_invalid_or_expired" };
  }
}
function requireFenceAuthority(plan, store2) {
  const proof = inspectFenceAuthority(plan, store2.fenceAuthority, store2.now());
  if (!proof.confirmed) throw privacyError("BUSINESS_REPLACEMENT_FENCE_REQUIRED");
  return proof;
}

// mongodb-risk-replacement.js
var RISK_CONFIRMATION = "我接受历史结果未知的风险，并批准建立此替代任务";
var HUMAN_RISK_POLICY = "human-risk-acceptance-v2";
var humanPolicy = (plan) => plan.approvalPolicy === HUMAN_RISK_POLICY;
var retirementKey2 = (store2, plan) => store2.hash("risk-job-retirement", plan.binding.instanceId, plan.binding.jobId);
var HASH = /^[a-f0-9]{64}$/;
var MAX2 = Number.MAX_SAFE_INTEGER;
var denied = (code = "BUSINESS_REPLACEMENT_DENIED") => {
  throw privacyError(code);
};
var wire = (value) => JSON.parse(JSON.stringify(bulkPreparePayload(value)));
function effects(request, originalJobId) {
  function walk(value, key3 = "", insideIdentity = false) {
    insideIdentity ||= ["id", "_id"].includes(key3.split(".").at(-1));
    if (!insideIdentity && typeof value === "string" && ["remediation_job_id", "job_id"].includes(key3.split(".").at(-1)) && value === request.jobId) return originalJobId;
    if (Array.isArray(value)) return value.map((x) => walk(x, "", insideIdentity));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k, insideIdentity)]));
    return value;
  }
  return { database: request.database, units: request.units.map((unit) => ({ unitId: unit.unitId, operations: unit.operations.map(({ expected, ...operation }) => {
    const updated = new Set(Object.values(operation.update || {}).flatMap((value) => Object.keys(value)));
    const guards = expected && Object.fromEntries(Object.entries(expected).map(([field, guard]) => [
      field,
      updated.has(field) && guard.exists === true && (guard.value === null || ["string", "number", "boolean"].includes(typeof guard.value)) ? { exists: true, refreshableScalarPreimage: true } : guard
    ]));
    return { ...walk(operation), ...guards ? { guards } : {} };
  }) })) };
}
function originalCurrent(store2, plan, ctx, scope) {
  const original = store2.get("operation", plan.binding.intentId, ctx, scope);
  if (!original || original.state !== "uncertain" || store2.hash("operation-record", ctx, plan.targetScope, plan.binding.intentId, original) !== plan.recordFingerprint) denied("BUSINESS_REPLACEMENT_STALE");
}
function humanHash(store2, plan, proof) {
  if (humanPolicy(plan)) return store2.hash("risk-human-review-v2", plan.id, plan.requestDigest, plan.sealDigest, plan.recordFingerprint, plan.expiresAt, plan.reviewMemo, plan.observations, plan.approvalPolicy);
  return store2.hash("risk-human-review", plan.id, plan.requestDigest, plan.sealDigest, plan.recordFingerprint, plan.expiresAt, proof.fingerprint || null);
}
function riskView(store2, plan) {
  if (plan.kind === "import") return importRiskView(store2, plan);
  const proof = humanPolicy(plan) ? { confirmed: false, reason: "human_risk_acceptance_no_external_attestation" } : inspectFenceAuthority(plan, store2.fenceAuthority, store2.now());
  const approved = !!plan.approval;
  const human = humanPolicy(plan);
  const scope = store2.hash("scope", plan.targetScope), parent = store2.get("disposition", plan.dispositionId, plan.binding.contextId, scope);
  const original = store2.get("operation", plan.binding.intentId, plan.binding.contextId, scope);
  const originalUnchanged = original?.state === "uncertain" && store2.hash("operation-record", plan.binding.contextId, plan.targetScope, plan.binding.intentId, original) === plan.recordFingerprint;
  const candidateEligible = !human || store2.get("risk_candidate", store2.hash("risk-candidate", plan.binding.instanceId, plan.replacementRequest.jobId), "", "")?.riskPlanId === plan.id;
  const parentEligible = human && parent?.state === "review_required" || human && parent?.state === "termination_requested" && parent.retirement?.riskPlanId === plan.id || parent?.state === "quarantined" || parent?.state === "retired_unknown" && parent.retirement?.riskPlanId === plan.id;
  return {
    ok: true,
    riskPlanId: plan.id,
    dispositionId: plan.dispositionId,
    state: plan.state,
    binding: plan.binding,
    replacementJobId: plan.replacementRequest.jobId,
    replacementRequestDigest: plan.requestDigest,
    sealRequestDigest: plan.sealDigest,
    effectDigest: plan.effectDigest,
    reviewHash: humanHash(store2, plan, proof),
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    historicalOutcome: "unknown",
    risk: "possible_prior_commit_or_unobserved_rollback_duplicate_compensation_risk",
    confirmation: RISK_CONFIRMATION,
    humanConfirmationRequired: !approved,
    humanApproved: approved,
    canApprove: (human || proof.confirmed) && parentEligible && candidateEligible && originalUnchanged && plan.state === "awaiting_human" && store2.now() < plan.expiresAt,
    remoteFenceConfirmed: proof.confirmed,
    fenceReason: proof.reason,
    fenceReceiptId: proof.receiptId,
    fenceFingerprint: proof.fingerprint,
    fenceValidUntil: proof.validUntil,
    approvalPolicy: plan.approvalPolicy || "external-fence-v1",
    approvalAuthority: human ? "independent-human-administrator" : "external-fence-and-human",
    reviewMemo: plan.reviewMemo || "",
    memoSource: "caller_statement_not_verified_evidence",
    observations: plan.observations,
    acceptedResidualRisk: human && approved,
    legacyInFlightOutcome: "unknown",
    originalTaskState: parent?.retirement?.riskPlanId === plan.id ? "terminated_unknown" : "protected_unknown",
    terminationScope: "managed_job_admissions_and_cooperative_workers",
    remoteTermination: plan.remoteRetirement ? "recorded" : "pending",
    warning: "历史结果未知；当前数据不变不能证明从未执行。人工批准接受旧进程迟到、事务结果未知及重复补偿风险；不代表全局撤权或证明未执行。",
    replacementAllowed: approved && parentEligible && originalUnchanged && (human || proof.confirmed && plan.approval.fenceFingerprint === proof.fingerprint) && store2.now() < plan.approval.validUntil,
    unitCount: plan.replacementRequest.units.length,
    operationCount: plan.replacementRequest.units.reduce((n, u) => n + u.operations.length, 0),
    collections: [...new Set(plan.replacementRequest.units.flatMap((u) => u.operations.map((o) => o.collection)))],
    auditId: plan.auditId,
    approvalAuditId: plan.approval?.auditId,
    creationAuditId: plan.creationAuditId,
    replacementIntentId: plan.replacementIntentId,
    planHash: plan.planHash,
    fenceChallenge: fenceChallenge(plan)
  };
}
function load2(store2, id, ctx, scope) {
  if (!HASH.test(id || "")) denied();
  const row = store2.db.prepare("SELECT * FROM records WHERE kind='risk_replacement' AND id=?").get(id);
  if (!row || ctx !== void 0 && (row.ctx !== ctx || row.scope !== scope)) denied();
  return { plan: store2.open(row), ctx: row.ctx, scope: row.scope };
}
function audit(store2, type, plan, ctx, scope, extra = {}) {
  const id = store2.hash("risk-audit", type, plan.id, extra);
  if (!store2.get("event", id, ctx, scope)) store2.put(
    "event",
    id,
    ctx,
    scope,
    {
      type,
      riskPlanId: plan.id,
      dispositionId: plan.dispositionId,
      binding: plan.binding,
      requestDigest: plan.requestDigest,
      historicalOutcome: "unknown",
      at: store2.now(),
      ...extra
    },
    MAX2,
    true
  );
  return id;
}
function riskStoreAction(store2, action, input, ctx, scope) {
  if (action === "prepare_risk_replacement" && input.originalRequest?.importId !== void 0) return prepareImportRisk(store2, input, ctx, scope);
  if (action === "prepare_risk_replacement") return store2.transaction(() => {
    const parent = store2.get("disposition", input.dispositionId, ctx, scope), original = input.originalRequest, replacement = input.replacementRequest;
    if (!parent || input.reviewHash !== parent.reviewHash || !original || !replacement || parent.binding.contextId !== ctx || original.instanceId !== parent.binding.instanceId || original.database !== parent.binding.database || replacement.instanceId !== original.instanceId || replacement.database !== original.database || prepareRequestDigest(original) !== parent.binding.requestDigest || store2.hash("operation", ctx, input.scope, "/mongodb/bulk/prepare", original) !== parent.binding.intentId || original.chunkIndex !== 0 || original.endOfUpload === true || replacement.chunkIndex !== 0 || replacement.endOfUpload === true || !Array.isArray(original.units) || !original.units.length || !Array.isArray(replacement.units) || typeof replacement.jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(replacement.jobId) || replacement.jobId === original.jobId || digest(effects(original, original.jobId)) !== digest(effects(replacement, original.jobId))) denied();
    const gateId = store2.hash("replacement-gate", replacement.instanceId, replacement.jobId);
    const existingGate = store2.get("replacement_gate", gateId, "", "");
    const request = wire(replacement), seal = wire({ ...replacement, chunkIndex: 1, chunkHash: void 0, units: [], endOfUpload: true });
    const approvalPolicy = store2.riskPolicy === "external-fence-v1" ? "external-fence-v1" : HUMAN_RISK_POLICY;
    const reviewMemo = input.reviewMemo || "";
    if (typeof reviewMemo !== "string" || reviewMemo.length > 4e3) denied();
    const id = store2.hash(approvalPolicy === HUMAN_RISK_POLICY ? "human-risk-replacement-v2" : "risk-replacement", ctx, input.scope, parent.id, prepareRequestDigest(request), parent.recordFingerprint, ...approvalPolicy === HUMAN_RISK_POLICY ? [reviewMemo] : []);
    if (existingGate && existingGate.riskPlanId !== id) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
    const old = store2.get("risk_replacement", id, ctx, scope);
    if (old && (old.approval ? store2.now() < old.approval.validUntil : store2.now() < old.expiresAt)) return riskView(store2, old);
    const plan = {
      id,
      approvalPolicy,
      reviewMemo,
      observations: input.observations,
      dispositionId: parent.id,
      state: "awaiting_human",
      binding: parent.binding,
      targetScope: input.scope,
      recordFingerprint: parent.recordFingerprint,
      replacementRequest: request,
      requestDigest: prepareRequestDigest(request),
      sealRequest: seal,
      sealDigest: prepareRequestDigest(seal),
      effectDigest: digest(effects(original, original.jobId)),
      createdAt: old?.createdAt || store2.now(),
      expiresAt: store2.now() + 36e5,
      ...old?.creationAuditId ? { creationAuditId: old.creationAuditId, replacementIntentId: old.replacementIntentId, planHash: old.planHash, remoteRetirement: old.remoteRetirement } : {}
    };
    originalCurrent(store2, plan, ctx, scope);
    plan.auditId = audit(store2, "risk_replacement_prepared", plan, ctx, scope, { revision: store2.now() });
    store2.put("risk_replacement", id, ctx, scope, plan, MAX2, true);
    if (humanPolicy(plan)) {
      const candidateKey2 = store2.hash("risk-candidate", plan.binding.instanceId, request.jobId);
      const prior = store2.get("risk_candidate", candidateKey2, "", "");
      if (prior && prior.riskPlanId !== id) {
        const other = load2(store2, prior.riskPlanId).plan;
        if (other.approval || other.creationAuditId) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
      }
      store2.put("risk_candidate", candidateKey2, "", "", { riskPlanId: id, ctx, scope }, MAX2, true);
    }
    return riskView(store2, plan);
  });
  if (["inspect_risk_replacement", "create_risk_replacement", "risk_handoff_context", "record_risk_retirement"].includes(action)) return store2.transaction(() => {
    const found = load2(store2, input.riskPlanId, ctx, scope), { plan } = found;
    if (plan.kind === "import") return importRiskAction(store2, action, input, found);
    if (plan.targetScope !== input.scope) denied();
    if (action === "inspect_risk_replacement") return riskView(store2, plan);
    if (action === "risk_handoff_context" || action === "record_risk_retirement") {
      if (!humanPolicy(plan)) return { required: false };
      requireHumanApproval(store2, plan, input, ctx, scope);
      const request = {
        jobId: plan.binding.jobId,
        replacementJobId: plan.replacementRequest.jobId,
        riskPlanId: plan.id,
        dispositionId: plan.dispositionId,
        originalRequestDigest: plan.binding.requestDigest,
        replacementRequestDigest: plan.requestDigest,
        approvalAuditId: plan.approval.auditId
      };
      if (action === "risk_handoff_context") return { required: true, request };
      const result = input.result;
      if (!result || result.status !== "terminated_unknown" || result.managedAdmissionClosed !== true || !HASH.test(result.controlRecordDigest || "") || Object.entries(request).some(([key3, value]) => key3 !== "approvalAuditId" && result[key3] !== value)) denied("BUSINESS_REPLACEMENT_TERMINATION_REQUIRED");
      const saved = { ...plan, remoteRetirement: {
        ...request,
        recordedAt: store2.now(),
        originalJobFound: result.originalJobFound === true,
        legacyInFlightOutcome: "unknown",
        controlRecordDigest: result.controlRecordDigest
      } };
      store2.put("risk_replacement", plan.id, ctx, scope, saved, MAX2, true);
      audit(store2, "risk_original_remote_termination_recorded", saved, ctx, scope, saved.remoteRetirement);
      return { ok: true };
    }
    return createReplacementIntent(store2, plan, input, ctx, scope);
  });
  return void 0;
}
function humanRiskStoreAction(store2, action, input) {
  if (!["human_risk_context", "human_risk_view", "human_risk_approve"].includes(action)) return void 0;
  const found = load2(store2, input.riskPlanId);
  if (found.plan.kind === "import") return importHumanAction(store2, action, input, found);
  if (found.plan.binding.instanceId !== input.instanceId) denied();
  if (action === "human_risk_context") return { targetScope: found.plan.targetScope, database: found.plan.binding.database };
  return store2.transaction(() => {
    const { plan, ctx, scope } = load2(store2, input.riskPlanId);
    if (plan.targetScope !== input.targetScope || plan.binding.instanceId !== input.instanceId) denied();
    if (action === "human_risk_view") return riskView(store2, plan);
    if (input.confirmation !== RISK_CONFIRMATION || typeof input.actor?.username !== "string" || !input.actor.username || typeof input.actor.sessionId !== "string" || !input.actor.sessionId || !Number.isSafeInteger(input.actor.verifiedAt) || input.actor.verifiedAt > store2.now() || store2.now() - input.actor.verifiedAt > 6e4) denied();
    const proof = humanPolicy(plan) ? {} : requireFenceAuthority(plan, store2);
    if (input.reviewHash !== humanHash(store2, plan, proof)) denied("BUSINESS_REPLACEMENT_STALE");
    if (plan.approval) {
      if (plan.approval.reviewHash !== input.reviewHash || store2.now() >= plan.approval.validUntil) denied("BUSINESS_REPLACEMENT_APPROVAL_EXPIRED");
      return riskView(store2, plan);
    }
    if (store2.now() >= plan.expiresAt) denied("BUSINESS_REPLACEMENT_REVIEW_EXPIRED");
    originalCurrent(store2, plan, ctx, scope);
    if (humanPolicy(plan) && store2.get("risk_candidate", store2.hash("risk-candidate", plan.binding.instanceId, plan.replacementRequest.jobId), "", "")?.riskPlanId !== plan.id) denied("BUSINESS_REPLACEMENT_STALE");
    const parent = store2.get("disposition", plan.dispositionId, ctx, scope);
    if (!(humanPolicy(plan) && ["review_required", "termination_requested"].includes(parent?.state) || parent?.state === "quarantined" || parent?.state === "retired_unknown" && parent.retirement?.riskPlanId === plan.id)) denied("BUSINESS_REPLACEMENT_QUARANTINE_REQUIRED");
    const gateId = store2.hash("replacement-gate", plan.binding.instanceId, plan.replacementRequest.jobId);
    const gate = store2.get("replacement_gate", gateId, "", "");
    if (gate && gate.riskPlanId !== plan.id) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
    const approval = {
      ...input.actor,
      reviewHash: input.reviewHash,
      fenceFingerprint: proof.fingerprint,
      validUntil: Math.min(plan.expiresAt, proof.validUntil || MAX2, store2.now() + 9e5),
      policy: plan.approvalPolicy,
      residualRiskAccepted: humanPolicy(plan)
    };
    approval.auditId = audit(store2, "risk_replacement_human_approved", plan, ctx, scope, approval);
    const saved = { ...plan, state: "human_approved", approval };
    if (humanPolicy(plan)) {
      const key3 = retirementKey2(store2, plan), retired = store2.get("risk_job_retirement", key3, "", "");
      if (retired && retired.riskPlanId !== plan.id) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
      store2.put("risk_job_retirement", key3, "", "", {
        instanceId: plan.binding.instanceId,
        jobId: plan.binding.jobId,
        database: plan.binding.database,
        riskPlanId: plan.id,
        replacementJobId: plan.replacementRequest.jobId,
        dispositionId: parent.id,
        approvalAuditId: approval.auditId,
        historicalOutcome: "unknown",
        at: store2.now()
      }, MAX2, true);
      const taskId = store2.hash("task", ctx, plan.targetScope, "operation:" + plan.binding.intentId);
      const task = store2.get("task", taskId, ctx, scope);
      if (task) store2.put("task", taskId, ctx, scope, { ...task, active: false, status: "terminated_unknown", replacementJobId: plan.replacementRequest.jobId }, MAX2, true);
      if (parent.state !== "retired_unknown") store2.put("disposition", parent.id, ctx, scope, {
        ...parent,
        state: "termination_requested",
        retirement: { riskPlanId: plan.id, replacementJobId: plan.replacementRequest.jobId, approvalAuditId: approval.auditId, at: store2.now() }
      }, MAX2, true);
    }
    store2.put("risk_replacement", plan.id, ctx, scope, saved, MAX2, true);
    if (gate) store2.put("replacement_gate", gateId, "", "", { ...gate, approvalAuditId: approval.auditId, fenceFingerprint: proof.fingerprint }, MAX2, true);
    return riskView(store2, saved);
  });
}
function requireHumanApproval(store2, plan, input, ctx, scope) {
  if (!plan.approval || plan.approval.policy !== HUMAN_RISK_POLICY || input.reviewHash !== plan.approval.reviewHash) denied("BUSINESS_REPLACEMENT_HUMAN_CONFIRMATION_REQUIRED");
  if (store2.now() >= plan.approval.validUntil) denied("BUSINESS_REPLACEMENT_APPROVAL_EXPIRED");
  originalCurrent(store2, plan, ctx, scope);
  const retirement = store2.get("risk_job_retirement", retirementKey2(store2, plan), "", "");
  if (retirement?.riskPlanId !== plan.id) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
}
function createReplacementIntent(store2, plan, input, ctx, scope) {
  if (!plan.approval || input.reviewHash !== plan.approval.reviewHash) denied("BUSINESS_REPLACEMENT_HUMAN_CONFIRMATION_REQUIRED");
  if (humanPolicy(plan)) {
    requireHumanApproval(store2, plan, input, ctx, scope);
    if (!plan.remoteRetirement) denied("BUSINESS_REPLACEMENT_TERMINATION_REQUIRED");
  }
  const proof = humanPolicy(plan) ? {} : requireFenceAuthority(plan, store2);
  if (!humanPolicy(plan) && proof.fingerprint !== plan.approval.fenceFingerprint || store2.now() >= plan.approval.validUntil) denied("BUSINESS_REPLACEMENT_APPROVAL_EXPIRED");
  originalCurrent(store2, plan, ctx, scope);
  const parent = store2.get("disposition", plan.dispositionId, ctx, scope);
  if (!(humanPolicy(plan) && parent?.state === "termination_requested" && parent.retirement?.riskPlanId === plan.id || parent?.state === "quarantined" || parent?.state === "retired_unknown" && parent.retirement?.riskPlanId === plan.id)) denied("BUSINESS_REPLACEMENT_QUARANTINE_REQUIRED");
  const id = store2.hash("operation", ctx, plan.targetScope, "/mongodb/bulk/prepare", plan.replacementRequest);
  const previous = store2.get("operation", id, ctx, scope);
  const gateId = store2.hash("replacement-gate", plan.binding.instanceId, plan.replacementRequest.jobId);
  const existingGate = store2.get("replacement_gate", gateId, "", "");
  if (existingGate && existingGate.riskPlanId !== plan.id || previous && !existingGate) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
  const record = previous && previous.state !== "rejected_before_dispatch" ? previous : {
    state: "uncertain",
    route: "/mongodb/bulk/prepare",
    identity: { instanceId: plan.binding.instanceId, jobId: plan.replacementRequest.jobId, chunkIndex: 0 },
    started: store2.now(),
    bulkPrepare: { binding: id, requestDigest: plan.requestDigest, attempt: (previous?.bulkPrepare?.attempt || 0) + 1 }
  };
  if (!previous || previous.state === "rejected_before_dispatch") store2.put("operation", id, ctx, scope, record, MAX2, true);
  const taskId = store2.hash("task", ctx, plan.targetScope, "operation:" + id);
  store2.put("task", taskId, ctx, scope, { id: "operation:" + id, active: true, expires: MAX2 }, MAX2, true);
  const oldTask = store2.hash("task", ctx, plan.targetScope, "operation:" + plan.binding.intentId);
  store2.db.prepare("INSERT OR IGNORE INTO links SELECT ctx,scope,?,ref FROM links WHERE ctx=? AND scope=? AND task=?").run(taskId, ctx, scope, oldTask);
  const creationAuditId = plan.creationAuditId || audit(
    store2,
    "risk_replacement_creation_reserved",
    plan,
    ctx,
    scope,
    { replacementIntentId: id, fenceFingerprint: proof.fingerprint, approvalAuditId: plan.approval.auditId }
  );
  const saved = { ...plan, state: plan.planHash ? "prepared" : plan.state === "uploaded" ? "uploaded" : "creating", replacementIntentId: id, creationAuditId };
  store2.put("risk_replacement", plan.id, ctx, scope, saved, MAX2, true);
  if (parent.state !== "retired_unknown") store2.put("disposition", parent.id, ctx, scope, {
    ...parent,
    state: "retired_unknown",
    retirement: {
      riskPlanId: plan.id,
      replacementJobId: plan.replacementRequest.jobId,
      replacementIntentId: id,
      approvalAuditId: plan.approval.auditId,
      creationAuditId,
      fenceFingerprint: proof.fingerprint,
      at: store2.now()
    }
  }, MAX2, true);
  store2.put("replacement_gate", gateId, "", "", { ...existingGate || {
    riskPlanId: plan.id,
    ctx,
    scope,
    instanceId: plan.binding.instanceId,
    jobId: plan.replacementRequest.jobId
  }, approvalAuditId: plan.approval.auditId, fenceFingerprint: proof.fingerprint }, MAX2, true);
  return { intent: { id, ...record }, request: plan.replacementRequest, risk: riskView(store2, saved) };
}
function riskRetirementStatus(store2, parent) {
  if (!parent.retirement) return {};
  const { plan, ctx } = load2(store2, parent.retirement.riskPlanId);
  if (ctx !== parent.binding.contextId || plan.dispositionId !== parent.id || plan.binding.intentId !== parent.binding.intentId) denied();
  if (plan.kind === "import") return { riskPlanId: plan.id, replacementImportId: plan.replacementRequest.importId, historicalOutcome: "unknown", approvalPolicy: plan.approvalPolicy, acceptedResidualRisk: !!plan.approval, replacementAllowed: false, missingRequirements: plan.remoteRetirement ? [] : ["remote_managed_import_termination_pending"] };
  const proof = humanPolicy(plan) ? { confirmed: false, reason: "human_risk_acceptance_no_external_attestation" } : inspectFenceAuthority(plan, store2.fenceAuthority, store2.now());
  return {
    riskPlanId: plan.id,
    replacementJobId: parent.retirement.replacementJobId,
    replacementIntentId: parent.retirement.replacementIntentId,
    remoteFenceConfirmed: proof.confirmed,
    historicalOutcome: "unknown",
    replacementAllowed: false,
    ...humanPolicy(plan) ? {
      approvalPolicy: plan.approvalPolicy,
      acceptedResidualRisk: true,
      missingRequirements: plan.remoteRetirement ? [] : ["remote_managed_job_termination_pending"],
      historicalEvidenceGaps: parent.missingRequirements.filter((x) => /^(original_|historical_)/.test(x))
    } : {}
  };
}
function replacementAdmission(store2, instanceId, admission = {}) {
  if (importReplacementAdmission(store2, instanceId, admission) || assertImportAdmission(store2, instanceId, admission)) return true;
  const request = admission.request || {}, identity = admission.identity || request;
  if (!identity.jobId || typeof identity.jobId !== "string") return false;
  const gate = store2.get("replacement_gate", store2.hash("replacement-gate", instanceId, identity.jobId), "", "");
  if (!gate) return false;
  const { plan } = load2(store2, gate.riskPlanId, gate.ctx, gate.scope);
  const proof = humanPolicy(plan) ? {} : requireFenceAuthority(plan, store2);
  if (!plan.approval || !humanPolicy(plan) && proof.fingerprint !== plan.approval.fenceFingerprint || store2.now() >= plan.approval.validUntil || plan.binding.instanceId !== instanceId || admission.ctx && admission.ctx !== gate.ctx) denied("BUSINESS_REPLACEMENT_APPROVAL_EXPIRED");
  if (admission.route === "/mongodb/bulk/prepare") {
    const candidate = admission.dispatchDigest || prepareRequestDigest(wire({ ...request, instanceId }));
    return [plan.requestDigest, plan.sealDigest].includes(candidate);
  }
  return ["/mongodb/bulk/execute", "/mongodb/bulk/rollback", "/mongodb/bulk/control"].includes(admission.route) && /^[a-f0-9]{64}$/.test(gate.planHash || "") && identity.planHash === gate.planHash;
}
function recordReplacementPrepared(store2, record, result) {
  const instanceId = record.identity?.instanceId, jobId = record.identity?.jobId;
  if (!instanceId || !jobId || !record.bulkChunk) return;
  const gateId = store2.hash("replacement-gate", instanceId, jobId), gate = store2.get("replacement_gate", gateId, "", "");
  if (!gate) return;
  const { plan, ctx, scope } = load2(store2, gate.riskPlanId, gate.ctx, gate.scope);
  if (!record.bulkChunk.endOfUpload) {
    if (record.bulkPrepare.requestDigest !== plan.requestDigest) denied();
    const firstUploadAuditId = audit(store2, "risk_replacement_uploaded", plan, ctx, scope, { chunkHash: result.chunkHash });
    store2.put("risk_replacement", plan.id, ctx, scope, { ...plan, state: plan.planHash ? "prepared" : "uploaded", firstUploadAuditId }, MAX2, true);
    return;
  }
  if (record.bulkPrepare.requestDigest !== plan.sealDigest || !HASH.test(result.planHash || "") || gate.planHash && gate.planHash !== result.planHash) denied();
  store2.put("replacement_gate", gateId, "", "", { ...gate, planHash: result.planHash }, MAX2, true);
  const auditId = audit(store2, "risk_replacement_prepared_remotely", plan, ctx, scope, { planHash: result.planHash });
  store2.put("risk_replacement", plan.id, ctx, scope, { ...plan, state: "prepared", planHash: result.planHash, preparedAuditId: auditId }, MAX2, true);
}
function assertRiskJobAdmission(store2, instanceId, admission = {}) {
  assertImportAdmission(store2, instanceId, admission);
  const identity = admission.identity || admission.request || {};
  if (typeof identity.jobId !== "string") return;
  const retired = store2.get("risk_job_retirement", store2.hash("risk-job-retirement", instanceId, identity.jobId), "", "");
  if (retired) denied("BUSINESS_ORIGINAL_JOB_TERMINATED");
  const candidate = store2.get("risk_candidate", store2.hash("risk-candidate", instanceId, identity.jobId), "", "");
  if (candidate && !replacementAdmission(store2, instanceId, admission)) denied("BUSINESS_REPLACEMENT_NOT_ADMITTED");
}

// ../plugins/remote-debug-agent/output-contracts.js
var scalar = "scalar";
var json = "json";
var fields = (names) => Object.fromEntries(names.split(/\s+/).filter(Boolean).map((key3) => [key3, scalar]));
var timing = fields("connectionGeneration queueMs connectMs validationMs executionMs errorLayer errorPhase");
var warning = fields("code message path source phase");
var error = { ...fields("operationId code message layer phase retriable cause causeCode intentId"), diagnostic: fields("phase category databaseCode filesystemCode serverMaxWireVersion driverVersion") };
var memory = { ...fields("status updatedAt initializedAt lastCheckedAt"), summary: json, changedSections: [scalar] };
var runtime = { ...fields("status workerPort pid startedAt stoppedAt lastHeartbeatAt lastUsedAt exitCode signal"), lastError: error, health: json, connection: json, memory, events: json };
var instance = {
  ...fields("id name enabled host port username privateKeyPath hasPassphrase connectOnStart createdAt updatedAt"),
  sourceRoots: json,
  logProjects: json,
  serviceProfiles: json,
  approvedCommands: json,
  commandReview: json,
  mongodb: { ...fields("enabled configPath driverPath configProfile uriKey database hasSandboxManagementPassword writeEnabled mutationsEnabled rollbackRoot rollbackTtlMs maxAffectedDocuments maxImportBatchDocuments bulkEnabled bulkRoot sandboxDatabase sandboxManagementProfile sandboxManagementUriKey bulkReceiptsCollection bulkBatchDocuments bulkBatchBytes bulkMaxDocuments bulkMaxBytes bulkMaxJobs bulkMaxFiles bulkConcurrency"), allowedDatabases: [scalar], allowedCollections: [scalar] },
  runtime,
  memory,
  hasPassphrase: "boolean"
};
instance.mongodb.hasSandboxManagementPassword = "boolean";
var common = { ...fields("ok instanceId operationId durationMs"), timing, memory };
var entry = fields("name path size modifyTime modified mtime permissions type isDirectory compression category source readable readReason linkName");
var mutation = {
  ...fields("mutationId operationId kind operation database collection name status rollbackMode riskLevel requiresConfirmation purpose createdAt committedAt rolledBackAt rollbackExpiresAt planHash affectedCount storageRoot receiptsDatabase importId batchCount batchIndex retryable journalPath intentId intentState"),
  collections: [scalar],
  changedFields: [scalar],
  affectedIds: json,
  storageStatus: json,
  rollbackRestoresDocuments: scalar,
  atomicity: scalar,
  execution: fields("intentId operationId version attempt mutationId planHash"),
  indexRecovery: fields("reason"),
  diagnostic: error.diagnostic,
  importExecution: { ...fields("version mutationId planHash database collection mode confirmation stage at"), outcomeEvidence: fields("kind sessionDigest transactionDigest requestId"), execution: fields("intentId operationId version attempt mutationId planHash") },
  collectionReceipt: fields("version mutationId planHash database collection stage rollbackMode acknowledgedAt"),
  failedBatch: { ...fields("batchIndex mutationId code"), diagnostic: error.diagnostic },
  prepareRejection: { ...fields("version stage code"), diagnostic: error.diagnostic },
  preview: { ...fields("affectedCount rollbackMode"), affectedIds: json, changedFields: [scalar] }
};
var batch = { ...mutation, ...fields("batchIndex operationCount unitCount rollbackBytes"), changedFields: [scalar], sampleIds: json };
mutation.batches = [batch];
var receiptStorage = fields("database collection legacy scope schemaVersion");
function bulkFailure(depth = 2) {
  const shape = {
    ...fields("version at code name message messageRedacted messageFingerprint layer phase batchIndex operationId parentOperationId outcome recovery retriable driverVersion nodeVersion collectionIndex collectionOperationCount"),
    ...fields("category driverCode writeErrorCount writeErrorsTruncated"),
    errorLabels: [scalar],
    writeErrors: [fields("code index category")],
    writeConcernErrors: [fields("code index category")],
    driverFrames: [fields("module line column")],
    frames: [fields("function line column")]
  };
  if (depth > 0) for (const key3 of ["cause", "receiptCheckFailure", "persistenceFailure"]) shape[key3] = bulkFailure(depth - 1);
  return shape;
}
var bulk = {
  ...fields("terminationId reviewHash previousStatus"),
  lastFailure: bulkFailure(),
  ...fields("jobId database status mode desiredState createdAt updatedAt planHash rollbackExpiresAt operationCount unitCount batchCount nextBatch nextVerifyBatch nextRollbackBatch committedBatchCount rolledBackBatchCount activePhase queuedBatchCount verifiedBatchCount differenceOffset differenceLimit differenceCount hasMoreDifferences pauseReason effectiveConcurrency requiresConfirmation atomicity chunkIndex chunkHash nextChunkIndex duplicate inputBytes leaseId accepted background command"),
  riskLineage: fields("originalJobId riskPlanId dispositionId replacementRequestDigest historicalOutcome"),
  ...fields("replacementJobId riskPlanId dispositionId originalRequestDigest replacementRequestDigest approvalAuditId recordedAt controlRecordDigest historicalOutcome legacyInFlightOutcome"),
  managedAdmissionClosed: "boolean",
  originalJobFound: "boolean",
  receiptStorage,
  activeBatchIndexes: [scalar],
  committed: fields("matched modified inserted unchanged"),
  differences: json,
  changedFields: [scalar],
  planPreview: [batch],
  batches: [batch]
};
var historyScan = { ...fields("status complete snapshotBytes"), matches: [fields("operationId kind code validationRejected line sha256")] };
var bulkHistory = {
  ...fields("requestMatched recordFingerprint jobId chunkIndex evidence remoteEvidenceCode"),
  diagnostics: { ...fields("trust scanStatus intentBound requestDigestBound candidateCount"), mcp: historyScan, worker: historyScan }
};
var draft = { ...fields("draftId purpose commandHash commandCount commandBlock status createdAt expiresAt executedAt"), commands: [scalar], instructions: [scalar] };
var execution = {
  ...fields("ok commandsOk draftId commandHash status executedAt durationMs operationId"),
  results: [{ ...fields("commandIndex command commandPreview cmd ok stdout stderr exitCode durationMs timedOut"), timing }],
  stopped: fields("commandIndex reason exitCode")
};
var violation = fields("commandIndex code severity rule reason message");
var model = { ...fields("status errorCode attempts durationMs decision isReadOnly riskLevel summary"), violations: [violation] };
var review = { ...fields("reason reviewedAt"), staticViolations: [violation], violations: [violation], model };
var sandbox = {
  ...fields("sandboxDatabase storageRoot jobCount bytes initialized activeFilesRetained jobId scannedBytes truncated cleanupHash fileCount retainedUntil removedFiles removedBytes removedReceipts"),
  receiptStorage,
  files: [fields("name bytes modified")],
  records: json,
  jobs: [{ ...fields("jobId status rollbackExpiresAt"), receiptStorage }],
  hasMore: scalar
};
var access = {
  ...fields("setupId planHash status expiresAt instanceId sandboxDatabase collection managerUser managerRole executorRole managementProfile configPath configModeAfter backupMode collectionsInitialized passwordReset requiresConfirmation confirmation rollbackMode"),
  executionUser: fields("user db"),
  environment: json,
  managerPrivileges: json,
  executorPrivileges: json,
  existing: { ...fields("manager profile executorGranted"), roles: json }
};
var logResources = {
  ...fields("rssBytes peakRssBytes cpuMs readBytes processedBytes elapsedMs resourceState budgetRevision"),
  budget: fields("cpuMilliCores readBytesPerSecond processBytesPerSecond transferBytesPerSecond rssLimitBytes parallelism dispatchDelayMs mode reason")
};
var fileReceipt = {
  ...fields("queryId fileIndex path compression status startedAt finishedAt scannedBytes expandedBytes scannedLines matchedLines selectedMembers completedMembers retainedEvidenceCount evidenceBytes evidenceTruncated scanComplete countsAreComplete evidenceComplete warningsTruncated reason"),
  source: fields("size modifyTime changeTime inode device"),
  error,
  warnings: [fields("code message memberPath lineNumber")]
};
var logProgress = { ...fields("status scannedBytes expandedBytes matchedLines scannedLines totalFiles completedFiles failedFiles selectedMembers completedMembers currentFile currentMember batchesCompleted outputTruncated scanTruncated directoryListingTruncated countsAreComplete skippedFiles stoppedAtBoundary remainingDateFrom remainingDateTo stopAfterFile scanComplete"), resources: logResources, currentFileProgress: fileReceipt };
var logJob = {
  ...logProgress,
  ...fields("jobId createdAt startedAt finishedAt expiresAt returnedLines outputBytes complete coverage warningsTruncated groupsTruncated hasMoreRecords nextOffset requestedAction stopReason evidenceComplete evidenceTruncated retainedEvidenceCount paginationScope observedMatchedLines fileResultCount hasMoreFileResults nextFileOffset"),
  resourceTaskId: scalar,
  evidenceLimits: fields("count bytes"),
  fileResults: [fileReceipt],
  scopeControls: fields("dateFrom dateTo stopAfterFile"),
  progress: logProgress,
  resources: logResources,
  error,
  limits: fields("jobTimeoutMs cpuPercent readBytesPerSecond processBytesPerSecond rssLimitBytes batchScanBytes"),
  records: [fields("text file memberPath lineNumber timestamp level route method truncated")],
  groups: [fields("level route method code message count")],
  warnings: [{ ...warning, ...fields("file memberPath lineNumber") }]
};
var finalFile = fields("artifactId category format encoding name relativePath bytes sha256");
var finalResult = {
  ...fields("version taskId instanceId title type status publishedAt fingerprint totalBytes"),
  final: "boolean",
  privacy: fields("credentials binary policyVersion"),
  references: { operationIds: [scalar], ...fields("jobId mutationId resourceTaskId") },
  files: [finalFile]
};
var contracts = {
  remote_debug_publish_final_result: { result: finalResult, duplicate: "boolean" },
  remote_debug_list_final_results: { results: [finalResult], ...fields("total totalBytes unavailable nextOffset outputDirectory") },
  remote_debug_get_final_result: { result: finalResult },
  remote_debug_read_final_artifact: { file: finalFile, content: scalar, truncated: "boolean", previewAvailable: "boolean" },
  remote_debug_list_service_profiles: { instances: [{ instanceId: scalar, profiles: [{ ...fields("serviceId profileHash"), profile: {
    ...fields("instanceId enabled cwd releaseRoot entry mode interpreter nodeVersion pm2Path pm2Home maxMemoryRestart restartDelayMs stableMs startupTimeoutMs startupMarker persist"),
    target: fields("host port username"),
    envFiles: [scalar],
    processes: [{ name: scalar, ports: [scalar], env: fields("NODE_ENV PORT WS_PORT CRON_PRIMARY TRANSLATION_ENABLED ORDER_AI_ENABLED ORDER_AI_ALLOWED_RESTAURANTS") }]
  } }] }] },
  remote_debug_set_service_profile: fields("serviceId profileHash workerRefreshRequired"),
  ...Object.fromEntries(["remote_debug_inspect_service", "remote_debug_start_service"].map((name) => [name, {
    ...fields("serviceId profileHash status phase resolvedCwd nodeVersion mode persisted unchanged persistenceWarning recovery"),
    started: [scalar],
    attempted: [scalar],
    missing: [scalar],
    verified: [{ ...fields("name pid status restarts startupMarkerSeen interpreterVerified environmentVerified"), ports: [scalar] }],
    error
  }])),
  remote_debug_list_instances: { ...fields("defaultInstanceId"), manager: json, lifecycle: json, instances: [instance] },
  remote_debug_get_capabilities: { capabilities: json },
  remote_debug_mongodb_query: { ...fields("operation database collection resultCount"), data: json },
  remote_debug_mongodb_recover_operation: { ...fields("intentId state route attempt mutationId legacy reason recoveryCode"), result: { ...common, ...mutation, ...bulk }, history: bulkHistory },
  remote_debug_mongodb_disposition: {
    ...fields("dispositionId reviewHash state recordFingerprint createdAt expiresAt quarantinedAt auditId admission admissionAuditId containmentScope historicalOutcome confirmation"),
    requiresConfirmation: "boolean",
    localContainment: "boolean",
    remoteFenceConfirmed: "boolean",
    replacementAllowed: "boolean",
    missingRequirements: [scalar],
    historicalEvidenceGaps: [scalar],
    ...fields("kind replacementImportId batchCount documentCount atomicity riskPlanId replacementJobId replacementRequestDigest sealRequestDigest effectDigest risk fenceReason fenceReceiptId fenceFingerprint fenceValidUntil unitCount operationCount approvalAuditId creationAuditId replacementIntentId planHash"),
    humanConfirmationRequired: "boolean",
    humanApproved: "boolean",
    canApprove: "boolean",
    collections: [scalar],
    ...fields("approvalPolicy approvalAuthority reviewMemo memoSource originalTaskState terminationScope remoteTermination legacyInFlightOutcome warning"),
    acceptedResidualRisk: "boolean",
    originalBatches: [fields("mutationId batchIndex documentCount requestDigest")],
    replacementBatches: [fields("mutationId batchIndex documentCount requestDigest")],
    batches: [fields("mutationId planHash batchIndex status")],
    observations: { ...fields("source observedAt status code historicalOutcome"), batches: [fields("mutationId batchIndex status code planHash rollbackExpiresAt historicalOutcome")] },
    binding: fields("kind route importId collection contextId instanceId database intentId requestDigest originalOperationId jobId chunkIndex chunkHash planHash"),
    fenceChallenge: {
      ...fields("version targetScopeDigest replacementJobId replacementRequestDigest sealRequestDigest effectDigest"),
      binding: fields("kind route importId collection contextId instanceId database intentId requestDigest originalOperationId jobId chunkIndex chunkHash planHash")
    },
    result: { ...common, ...bulk, ...mutation, error, ...fields("intentId intentState state"), result: { ...common, ...bulk, ...mutation } }
  },
  remote_debug_mongodb_prepare_write: mutation,
  remote_debug_mongodb_prepare_collection: mutation,
  remote_debug_mongodb_prepare_index: mutation,
  remote_debug_mongodb_prepare_transaction: mutation,
  remote_debug_mongodb_prepare_import: mutation,
  remote_debug_mongodb_prepare_bulk_storage: mutation,
  remote_debug_mongodb_execute_mutation: mutation,
  remote_debug_mongodb_rollback_mutation: mutation,
  remote_debug_mongodb_list_mutations: { entries: [mutation] },
  remote_debug_mongodb_prepare_bulk: bulk,
  remote_debug_mongodb_execute_bulk: bulk,
  remote_debug_mongodb_get_bulk_job: bulk,
  remote_debug_mongodb_control_bulk_job: bulk,
  remote_debug_mongodb_rollback_bulk_job: bulk,
  remote_debug_mongodb_list_bulk_jobs: { ...fields("offset limit total hasMore"), jobs: [bulk] },
  remote_debug_prepare_sandbox_access: access,
  remote_debug_configure_sandbox_access: access,
  remote_debug_get_sandbox: sandbox,
  remote_debug_export_sandbox_log: sandbox,
  remote_debug_prepare_sandbox_cleanup: sandbox,
  remote_debug_cleanup_sandbox: sandbox,
  remote_debug_restart_instance: { ...fields("restarted action previousStatus"), instance, runtime },
  remote_debug_update_memory: { note: { ...fields("topic summary updatedAt"), facts: [scalar] } },
  remote_debug_run_command: fields("stdout stderr exitCode timedOut"),
  remote_debug_read_file: fields("path content truncated"),
  remote_debug_list_dir: { path: scalar, entries: [entry] },
  remote_debug_list_logs: { ...fields("category nextCursor hasMore truncated scannedEntries sourceCount"), entries: [entry], warnings: [warning] },
  remote_debug_list_log_archive_members: { ...fields("path compression nextCursor hasMore truncated scannedBytes"), members: [entry] },
  remote_debug_read_log: fields("path memberPath compression content truncated scannedTruncated scannedBytes archiveScannedBytes totalLines matchedLines"),
  remote_debug_query_logs: {
    ...fields("mode projectId content returnedLines matchedLines scannedLines scannedBytes expandedBytes outputBytes outputTruncated scanTruncated complete coverage countsAreComplete hasMoreFiles nextFileOffset hasMoreMembers nextMemberOffset memberBytes directoryListingTruncated warningsTruncated"),
    files: [entry],
    scannedFiles: [fields("path scannedBytes startByte endByte")],
    records: [{ ...fields("text file path memberPath lineNumber lineFromEnd timestamp level route method truncated"), source: json }],
    members: [entry],
    warnings: [warning]
  },
  remote_debug_start_log_query: logJob,
  remote_debug_get_log_query: logJob,
  remote_debug_control_log_query: logJob,
  remote_debug_list_log_projects: { instances: [{ instanceId: scalar, projects: json }] },
  remote_debug_set_log_project: { projects: json },
  remote_debug_prepare_command_draft: draft,
  remote_debug_get_command_draft: draft,
  remote_debug_execute_command_draft: execution,
  remote_debug_review_command_draft: { ...draft, draft, decision: scalar, review, execution }
};
var OUTPUT_CONTRACTS = Object.freeze(Object.fromEntries(
  Object.entries(contracts).map(([name, shape]) => [name, { ...common, ...shape }])
));
var ERROR_CONTRACT = {
  ...common,
  error,
  details: { ...fields("ok operationId code layer phase retriable cause agentUrl port manifestPath"), error }
};

// ../plugins/remote-debug-agent/output-guard.js
var GUARD_BLOCKED = Object.freeze({
  ok: false,
  error: Object.freeze({ code: "OUTPUT_GUARD_BLOCKED", message: "Output was blocked by the sensitive information guard.", retriable: false })
});
var MAX_BYTES = 8 * 1024 * 1024;
var ASSIGNMENT_NAME = String.raw`[\w.-]*(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?key(?:[_-]?id)?|connection[_-]?string|dsn)`;
var ASSIGNMENT = new RegExp(String.raw`(\b${ASSIGNMENT_NAME}["']?\s*[=:]\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;}&]+)`, "gi");
var CLI_SECRET = new RegExp(String.raw`(--?(?:password|passwd|passphrase|pwd|pass|token|secret|api[-_]?key|client[-_]?secret)(?:=|\s+))("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s;]+)`, "gi");

// mongodb-job-termination.js
var TERMINATION_CONFIRMATION = "我确认永久终止此任务，不再恢复或重试";
var MAX3 = Number.MAX_SAFE_INTEGER;
var HASH2 = /^[a-f0-9]{64}$/;
var JOB = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var deny = (code = "BUSINESS_TERMINATION_REVIEW_REQUIRED") => {
  throw privacyError(code);
};
var key2 = (store2, instanceId, jobId) => store2.hash("job-termination", instanceId, jobId);
var load3 = (store2, id) => store2.get("job_termination", id, "", "") || deny();
var view = (store2, p) => ({
  ok: true,
  terminationId: p.id,
  instanceId: p.instanceId,
  database: p.database,
  jobId: p.jobId,
  planHash: p.planHash,
  reason: p.reason,
  state: p.state,
  reviewHash: p.reviewHash,
  observations: p.observations,
  expiresAt: p.expiresAt,
  confirmation: TERMINATION_CONFIRMATION,
  canApprove: p.state !== "terminated_unknown" && (!!p.approval || store2.now() < p.expiresAt),
  managedAdmissionClosed: !!p.approval,
  remoteTermination: p.receipt ? "recorded" : "pending",
  historicalOutcome: "unknown",
  legacyInFlightOutcome: "unknown",
  approvalAuditId: p.approval?.auditId,
  controlRecordDigest: p.receipt?.controlRecordDigest,
  warning: "永久关闭此任务的后续执行、恢复及回滚准入；不回滚业务数据，不创建新任务，不证明历史或旧在途事务从未提交。"
});
function jobTerminationStoreAction(store2, action, input) {
  if (!action.startsWith("human_job_termination_")) return void 0;
  if (action === "human_job_termination_prepare") return store2.transaction(() => {
    if (!JOB.test(input.jobId || "") || !HASH2.test(input.planHash || "") || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1e3 || input.observations?.jobId !== input.jobId || input.observations.planHash !== input.planHash || input.observations.database !== input.database) deny();
    const id = key2(store2, input.instanceId, input.jobId), old = store2.get("job_termination", id, "", "");
    if (old && (old.planHash !== input.planHash || old.targetScope !== input.targetScope)) deny("BUSINESS_TERMINATION_TARGET_CHANGED");
    if (old?.approval) return view(store2, old);
    const p2 = {
      id,
      instanceId: input.instanceId,
      database: input.database,
      targetScope: input.targetScope,
      jobId: input.jobId,
      planHash: input.planHash,
      reason: input.reason.trim(),
      observations: input.observations,
      state: "awaiting_human",
      expiresAt: store2.now() + 3e5
    };
    p2.reviewHash = store2.hash("termination-review-v1", p2);
    store2.put("job_termination", id, "", "", p2, MAX3, true);
    return view(store2, p2);
  });
  const p = load3(store2, input.terminationId);
  if (p.instanceId !== input.instanceId || input.targetScope !== void 0 && p.targetScope !== input.targetScope) deny("BUSINESS_TERMINATION_TARGET_CHANGED");
  if (action === "human_job_termination_context") return { targetScope: p.targetScope, database: p.database, jobId: p.jobId, planHash: p.planHash, state: p.state };
  if (action === "human_job_termination_view") return view(store2, p);
  if (action === "human_job_termination_approve") return store2.transaction(() => {
    const current2 = load3(store2, p.id);
    if (current2.reviewHash !== input.reviewHash || input.confirmation !== TERMINATION_CONFIRMATION || typeof input.actor?.username !== "string" || !input.actor.username || typeof input.actor.sessionId !== "string" || !input.actor.sessionId || !Number.isSafeInteger(input.actor.verifiedAt) || input.actor.verifiedAt > store2.now() || store2.now() - input.actor.verifiedAt > 6e4) deny();
    if (current2.approval) return view(store2, current2);
    if (store2.now() >= current2.expiresAt || store2.hash("termination-observations", input.observations) !== store2.hash("termination-observations", current2.observations)) deny("BUSINESS_TERMINATION_REVIEW_STALE");
    const auditId = store2.hash("job-termination-approved", current2.id, current2.reviewHash, input.actor);
    const saved = { ...current2, state: "termination_pending", approval: { ...input.actor, auditId, at: store2.now() } };
    store2.put("job_termination", p.id, "", "", saved, MAX3, true);
    store2.put("event", auditId, "", "", {
      type: "bulk_job_termination_approved",
      terminationId: p.id,
      instanceId: p.instanceId,
      jobId: p.jobId,
      planHash: p.planHash,
      reviewHash: p.reviewHash,
      actor: input.actor,
      historicalOutcome: "unknown",
      at: store2.now()
    }, MAX3, true);
    for (const row of store2.db.prepare("SELECT * FROM records WHERE kind='task'").all()) {
      const task = store2.open(row);
      if (task.id !== p.jobId) continue;
      const target = store2.get("context", row.ctx, row.ctx, "");
      if (!target) continue;
      const mappings = store2.db.prepare("SELECT * FROM records WHERE kind='mapping' AND ctx=? AND scope=? LIMIT 1").all(row.ctx, row.scope);
      if (!mappings.length) continue;
      let scope;
      try {
        scope = JSON.parse(store2.open(mappings[0]).scope);
      } catch {
        continue;
      }
      if (scope.id === p.instanceId && scope.database === p.database) store2.put(
        "task",
        row.id,
        row.ctx,
        row.scope,
        { ...task, active: false, status: "termination_pending", terminationId: p.id },
        MAX3,
        true
      );
    }
    return view(store2, saved);
  });
  if (action === "human_job_termination_dispatch") {
    if (!p.approval) deny();
    return { jobId: p.jobId, planHash: p.planHash, terminationId: p.id, reviewHash: p.reviewHash, approvalAuditId: p.approval.auditId };
  }
  if (action === "human_job_termination_record") return store2.transaction(() => {
    const current2 = load3(store2, p.id), r = input.result;
    if (!current2.approval || r?.ok !== true || r.jobId !== p.jobId || r.database !== p.database || r.planHash !== p.planHash || r.terminationId !== p.id || r.reviewHash !== p.reviewHash || r.approvalAuditId !== current2.approval.auditId || r.status !== "terminated_unknown" || r.managedAdmissionClosed !== true || !HASH2.test(r.controlRecordDigest || "")) deny("BUSINESS_TERMINATION_ACK_REQUIRED");
    const saved = { ...current2, state: "terminated_unknown", receipt: r };
    store2.put("job_termination", p.id, "", "", saved, MAX3, true);
    const auditId = store2.hash("job-termination-recorded", p.id, r.controlRecordDigest);
    store2.put("event", auditId, "", "", {
      type: "bulk_job_termination_recorded",
      terminationId: p.id,
      instanceId: p.instanceId,
      jobId: p.jobId,
      planHash: p.planHash,
      controlRecordDigest: r.controlRecordDigest,
      historicalOutcome: "unknown",
      at: store2.now()
    }, MAX3, true);
    return view(store2, saved);
  });
  deny();
}
function assertJobNotTerminated(store2, instanceId, admission) {
  const jobId = (admission.identity || admission.request || {}).jobId;
  if (typeof jobId !== "string") return;
  const p = store2.get("job_termination", key2(store2, instanceId, jobId), "", "");
  if (p?.approval) deny("BUSINESS_JOB_PERMANENTLY_TERMINATED");
}
function jobTerminationFor(store2, instanceId, jobId) {
  const p = store2.get("job_termination", key2(store2, instanceId, jobId), "", "");
  return p?.approval ? { terminationId: p.id, state: p.state } : void 0;
}

// mongodb-disposition.js
var DISPOSITION_CONFIRMATION = "确认隔离原意图";
var HASH3 = /^[a-f0-9]{64}$/;
var DAY = 864e5;
var READ_ROUTES = /* @__PURE__ */ new Set([
  "/mongodb/query",
  "/mongodb/imports/review",
  "/mongodb/imports/recover-prepare",
  "/mongodb/bulk/job",
  "/mongodb/bulk/jobs",
  "/mongodb/mutations/list",
  "/mongodb/mutations/get",
  "/mongodb/bulk/recover-prepare",
  "/mongodb/mutations/recover-prepare",
  "/mongodb/mutations/recover-execution"
]);
function isMongoAdmissionRoute(route) {
  return typeof route === "string" && (route === "/sandbox/cleanup" || route.startsWith("/mongodb/") && !READ_ROUTES.has(route));
}
var requirements = Object.freeze([
  "mandatory_executor_boundary_migration_required",
  "legacy_process_queue_and_lease_drain_attestation_required",
  "durable_remote_fence_receipt_required",
  "historical_transaction_receipts_required"
]);
function denied2() {
  throw privacyError("BUSINESS_DISPOSITION_DENIED");
}
function targetOf(input) {
  let target;
  try {
    target = JSON.parse(input.scope);
  } catch {
    denied2();
  }
  if (!target?.id || !target.database) denied2();
  return target;
}
function view2(store2, record) {
  const instanceHold = !!store2.get("disposition_hold", store2.hash("disposition-instance-hold", record.binding.instanceId), "", "");
  return {
    ok: true,
    dispositionId: record.id,
    reviewHash: record.reviewHash,
    state: record.state,
    binding: record.binding,
    recordFingerprint: record.recordFingerprint,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    quarantinedAt: record.quarantinedAt,
    auditId: record.auditId,
    localContainment: instanceHold || ["termination_requested", "retired_unknown"].includes(record.state),
    requiresConfirmation: record.state === "review_required",
    confirmation: DISPOSITION_CONFIRMATION,
    containmentScope: record.retirement && !instanceHold ? "original_job_managed_admissions" : "instance_all_mongodb_write_admissions",
    remoteFenceConfirmed: false,
    historicalOutcome: "unknown",
    replacementAllowed: false,
    missingRequirements: record.missingRequirements,
    ...riskRetirementStatus(store2, record)
  };
}
function dispositionStoreAction(store2, action, input, ctx, scope) {
  if (action === "prepare_disposition") return store2.transaction(() => {
    const target = targetOf(input), original = store2.get("operation", input.id, ctx, scope), request = input.request;
    if (!HASH3.test(input.id || "") || !original || original.state !== "uncertain" || !["/mongodb/bulk/prepare", "/mongodb/imports/prepare"].includes(original.route) || original.identity?.instanceId !== target.id || !request || request.instanceId !== target.id || request.database !== target.database || store2.hash("operation", ctx, input.scope, original.route, request) !== input.id || (original.route === "/mongodb/bulk/prepare" ? typeof original.identity.jobId !== "string" || original.identity.jobId !== request.jobId || !Number.isSafeInteger(original.identity.chunkIndex) || original.identity.chunkIndex !== request.chunkIndex : typeof request.importId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(request.importId) || request.jobId !== void 0 || original.identity.importId !== void 0 && original.identity.importId !== request.importId) || input.requestDigest !== prepareRequestDigest(request)) denied2();
    if (original.importPrepare && original.importPrepare.requestDigest !== input.requestDigest) denied2();
    if (original.bulkPrepare && original.bulkPrepare.requestDigest !== input.requestDigest) denied2();
    const fingerprint = store2.hash("operation-record", ctx, input.scope, input.id, original);
    const binding = {
      ...original.route === "/mongodb/imports/prepare" ? { kind: "import", route: original.route, importId: request.importId, collection: request.collection } : {},
      contextId: ctx,
      instanceId: target.id,
      database: target.database,
      intentId: input.id,
      requestDigest: input.requestDigest,
      originalOperationId: original.operationId || null,
      jobId: original.identity.jobId,
      chunkIndex: original.identity.chunkIndex,
      chunkHash: original.bulkChunk?.chunkHash || null,
      planHash: original.identity.planHash || null
    };
    const missingRequirements = binding.kind === "import" ? ["historical_import_batch_receipts_required", "historical_in_flight_outcomes_unknown"] : [...requirements];
    const identityGaps = binding.kind === "import" ? [["originalOperationId", "original_operation_identity_unbound"]] : [["originalOperationId", "original_operation_identity_unbound"], ["chunkHash", "original_chunk_hash_unbound"], ["planHash", "original_plan_hash_unbound"]];
    for (const [field, reason] of identityGaps) {
      if (!binding[field]) missingRequirements.push(reason);
    }
    const id = store2.hash("disposition", ctx, input.scope, binding, fingerprint);
    const previous = store2.get("disposition", id, ctx, scope);
    if (previous && (["quarantined", "retired_unknown"].includes(previous.state) || store2.now() < previous.expiresAt)) return view2(store2, previous);
    const createdAt = store2.now(), expiresAt = createdAt + DAY;
    const record = {
      id,
      state: "review_required",
      binding,
      recordFingerprint: fingerprint,
      createdAt,
      expiresAt,
      missingRequirements,
      auditId: store2.hash("disposition-audit", id, "review", createdAt)
    };
    record.reviewHash = store2.hash("disposition-review", record);
    store2.put("disposition", id, ctx, scope, record, Number.MAX_SAFE_INTEGER, true);
    store2.put("event", record.auditId, ctx, scope, {
      type: "disposition_review_prepared",
      dispositionId: id,
      binding,
      recordFingerprint: fingerprint,
      reviewHash: record.reviewHash,
      at: createdAt
    }, Number.MAX_SAFE_INTEGER, true);
    return view2(store2, record);
  });
  if (["inspect_disposition", "quarantine_disposition", "admit_disposition"].includes(action)) return store2.transaction(() => {
    if (!HASH3.test(input.dispositionId || "")) denied2();
    const record = store2.get("disposition", input.dispositionId, ctx, scope);
    if (!record || record.binding.contextId !== ctx || record.binding.instanceId !== targetOf(input).id || record.binding.database !== targetOf(input).database) denied2();
    if (action === "inspect_disposition") return view2(store2, record);
    if (input.reviewHash !== record.reviewHash) denied2();
    if (action === "admit_disposition") {
      const auditId2 = store2.hash("disposition-audit", record.id, "replacement_denied");
      if (!store2.get("event", auditId2, ctx, scope)) store2.put(
        "event",
        auditId2,
        ctx,
        scope,
        { type: "disposition_replacement_denied", dispositionId: record.id, at: store2.now(), reasons: record.missingRequirements },
        Number.MAX_SAFE_INTEGER,
        true
      );
      return { ...view2(store2, record), admission: "blocked", admissionAuditId: auditId2 };
    }
    if (input.confirmation !== DISPOSITION_CONFIRMATION) denied2();
    if (["quarantined", "retired_unknown"].includes(record.state)) return view2(store2, record);
    if (store2.now() >= record.expiresAt) throw privacyError("BUSINESS_DISPOSITION_REVIEW_EXPIRED");
    const original = store2.get("operation", record.binding.intentId, ctx, scope);
    if (!original || original.state !== "uncertain" || record.recordFingerprint !== store2.hash("operation-record", ctx, input.scope, record.binding.intentId, original)) throw privacyError("BUSINESS_DISPOSITION_STALE");
    const holdId = store2.hash("disposition-instance-hold", record.binding.instanceId);
    const hold = store2.get("disposition_hold", holdId, "", "");
    if (hold && hold.instanceId !== record.binding.instanceId) denied2();
    const at = store2.now(), auditId = store2.hash("disposition-audit", record.id, "quarantine");
    store2.put("disposition_hold", holdId, "", "", hold || { instanceId: record.binding.instanceId, firstDispositionId: record.id, at }, Number.MAX_SAFE_INTEGER, true);
    const saved = { ...record, state: "quarantined", quarantinedAt: at, auditId };
    store2.put("disposition", record.id, ctx, scope, saved, Number.MAX_SAFE_INTEGER, true);
    store2.put("event", auditId, ctx, scope, {
      type: "disposition_locally_quarantined",
      dispositionId: record.id,
      binding: record.binding,
      reviewHash: record.reviewHash,
      recordFingerprint: record.recordFingerprint,
      remoteFenceConfirmed: false,
      historicalOutcome: "unknown",
      replacementAllowed: false,
      at
    }, Number.MAX_SAFE_INTEGER, true);
    return view2(store2, saved);
  });
  return void 0;
}
function assertInstanceAdmission(store2, instanceId, admission = {}) {
  if (typeof instanceId !== "string" || !instanceId) denied2();
  assertJobNotTerminated(store2, instanceId, admission);
  assertRiskJobAdmission(store2, instanceId, admission);
  if (store2.get("disposition_hold", store2.hash("disposition-instance-hold", instanceId), "", "")) {
    if (replacementAdmission(store2, instanceId, admission)) return { ok: true };
    throw privacyError("BUSINESS_DISPOSITION_QUARANTINED");
  }
  return { ok: true };
}

// privacy-store.js
var REF = /^rda_ref_v1_[a-f0-9]{48}$/;
var DAY2 = 864e5;
var PrivacyStore = class {
  constructor({ directory, key: key3, now = Date.now, fault, fenceAuthority, riskPolicy } = {}) {
    this.now = now;
    this.fault = fault;
    this.riskPolicy = riskPolicy;
    this.fenceAuthority = fenceAuthority || { trustFile: process.env.REMOTE_DEBUG_EXECUTOR_TRUST_FILE, receiptDirectory: process.env.REMOTE_DEBUG_EXECUTOR_RECEIPT_DIRECTORY };
    this.directory = import_node_path2.default.resolve(directory);
    let windowsExisting;
    if (process.platform === "win32") {
      windowsExisting = import_windows_privacy2.default.prepareStore(this.directory).existing;
    } else {
      if (/(?:\/|\\)(?:CloudStorage|Mobile Documents|Dropbox|OneDrive|plugins\/cache)(?:\/|\\|$)/i.test(this.directory)) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
      import_node_fs2.default.mkdirSync(this.directory, { recursive: true, mode: 448 });
      for (let p = this.directory; p !== import_node_path2.default.dirname(p); p = import_node_path2.default.dirname(p)) if (import_node_fs2.default.lstatSync(p).isSymbolicLink() && !(process.platform === "darwin" && ["/tmp", "/var"].includes(p))) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
      const stat = import_node_fs2.default.statfsSync(this.directory);
      if (process.platform === "darwin" ? ![17, 26].includes(stat.type) : [26985, 20859, 4283649346, 1702057286].includes(stat.type)) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
      import_node_fs2.default.chmodSync(this.directory, 448);
      const filename2 = import_node_path2.default.join(this.directory, "privacy.sqlite");
      for (const suffix of ["", "-wal", "-shm"]) if (import_node_fs2.default.existsSync(filename2 + suffix)) {
        const entry2 = import_node_fs2.default.lstatSync(filename2 + suffix);
        if (!entry2.isFile() || entry2.isSymbolicLink() || process.getuid && entry2.uid !== process.getuid()) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
      }
    }
    const filename = import_node_path2.default.join(this.directory, "privacy.sqlite");
    const master = key3 ? Buffer.from(key3) : loadPrivacyKey(this.directory, { existing: process.platform === "win32" ? windowsExisting : import_node_fs2.default.existsSync(filename) });
    if (master.length !== 32) throw privacyError("BUSINESS_KEYSTORE_UNAVAILABLE");
    this.enc = Buffer.from((0, import_node_crypto4.hkdfSync)("sha256", master, "rda-privacy-v1", "encryption", 32));
    this.index = Buffer.from((0, import_node_crypto4.hkdfSync)("sha256", master, "rda-privacy-v1", "reverse-index", 32));
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
      else for (const suffix of ["", "-wal", "-shm"]) if (import_node_fs2.default.existsSync(filename + suffix)) import_node_fs2.default.chmodSync(filename + suffix, 384);
      const sentinel = this.get("meta", "key-check", "", "");
      if (sentinel && sentinel.version !== 1) throw privacyError();
      if (!sentinel) {
        if (version !== 0) throw privacyError("BUSINESS_STORAGE_CORRUPT");
        this.put("meta", "key-check", "", "", { version: 1 }, Number.MAX_SAFE_INTEGER, true);
      }
    } catch (error2) {
      this.close();
      throw privacyError(error2.code?.startsWith("BUSINESS_") ? error2.code : "BUSINESS_STORAGE_CORRUPT");
    }
  }
  hash(...items) {
    return (0, import_node_crypto4.createHmac)("sha256", this.index).update(JSON.stringify(items)).digest("hex");
  }
  aad(kind, id, ctx, scope) {
    return Buffer.from(JSON.stringify(["rda", 1, 1, kind, id, ctx, scope]));
  }
  seal(kind, id, ctx, scope, value) {
    const nonce = (0, import_node_crypto4.randomBytes)(12), cipher = (0, import_node_crypto4.createCipheriv)("aes-256-gcm", this.enc, nonce);
    cipher.setAAD(this.aad(kind, id, ctx, scope));
    return JSON.stringify({ v: 1, k: 1, n: nonce.toString("base64"), c: Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]).toString("base64"), t: cipher.getAuthTag().toString("base64") });
  }
  open(row) {
    try {
      const e = JSON.parse(row.envelope);
      if (e.v !== 1 || e.k !== 1) throw privacyError();
      const cipher = (0, import_node_crypto4.createDecipheriv)("aes-256-gcm", this.enc, Buffer.from(e.n, "base64"));
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
  put(kind, id, ctx, scope, value, expires = this.now() + 30 * DAY2, pinned = false, lookup = null) {
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
    if (!context || context.expires <= this.now() || !(0, import_node_crypto4.timingSafeEqual)(Buffer.from(context.proof), Buffer.from(proof))) throw privacyError("BUSINESS_CONTEXT_DENIED");
    return auth.contextId;
  }
  execute(action, input = {}) {
    if (action === "assert_instance_admission") return assertInstanceAdmission(this, input.instanceId, input);
    const termination = jobTerminationStoreAction(this, action, input);
    if (termination !== void 0) return termination;
    const humanRisk = humanRiskStoreAction(this, action, input);
    if (humanRisk !== void 0) return humanRisk;
    if (action === "create") return this.transaction(() => {
      const contextId = (0, import_node_crypto4.randomUUID)(), capability = (0, import_node_crypto4.randomBytes)(32).toString("hex"), expires = this.now() + 365 * DAY2;
      this.put("context", contextId, contextId, "", { proof: this.hash("capability", capability), expires }, expires);
      return { contextId, capability };
    });
    const ctx = this.authenticate(input.auth);
    if (action === "attach") return { contextId: ctx };
    const scope = this.hash("scope", input.scope);
    const disposition = dispositionStoreAction(this, action, input, ctx, scope);
    if (disposition !== void 0) return disposition;
    const risk = riskStoreAction(this, action, input, ctx, scope);
    if (risk !== void 0) return risk;
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
        else this.put("mapping", ref, ctx, scoped, { value: record.value, scope: record.scope }, this.now() + 30 * DAY2, false, lookup);
        if (existing) this.db.prepare("UPDATE records SET expires=MAX(expires,?) WHERE kind='mapping' AND id=?").run(this.now() + 30 * DAY2, ref);
        aliases[record.ref] = ref;
        refs.add(ref);
      }
      for (const original of input.refs || []) {
        const ref = aliases[original] || original;
        const row = this.db.prepare("SELECT * FROM records WHERE kind='mapping' AND id=? AND ctx=?").get(ref, ctx);
        if (!row) throw privacyError("BUSINESS_REFERENCE_INVALID");
        this.open(row);
        refs.add(ref);
        this.db.prepare("UPDATE records SET expires=MAX(expires,?) WHERE kind='mapping' AND id=?").run(this.now() + 30 * DAY2, ref);
      }
      for (const incoming of input.tasks || []) {
        const task = { ...incoming };
        if (typeof task.id !== "string" || task.id.length > 256) throw privacyError("BUSINESS_STORAGE_INVALID");
        let target;
        try {
          target = JSON.parse(input.scope);
        } catch {
        }
        const termination2 = target?.id ? jobTerminationFor(this, target.id, task.id) : void 0;
        if (termination2) {
          task.status = termination2.state;
          task.terminationId = termination2.terminationId;
        }
        const taskId = this.hash("task", ctx, input.scope, task.id);
        const previous = this.get("task", taskId, ctx, scope);
        const active = !["completed", "committed", "rolled_back", "failed", "cancelled", "expired", "prepared", "ready", "terminated_unknown", "termination_pending"].includes(task.status);
        const expires = Math.max(previous?.expires || 0, this.now() + (input.retentionMs || 30 * DAY2), Number(task.expires) || 0);
        this.put("task", taskId, ctx, scope, { ...previous, ...task, active, expires }, expires, active || !!termination2);
        for (const ref of refs) this.db.prepare("INSERT OR IGNORE INTO links VALUES(?,?,?,?)").run(ctx, scope, taskId, ref);
        this.db.prepare("UPDATE records SET pinned=1 WHERE kind='mapping' AND ctx=? AND id IN (SELECT ref FROM links WHERE ctx=? AND task=?)").run(ctx, ctx, taskId);
      }
      const deliveryId = input.deliveryId || (0, import_node_crypto4.randomUUID)();
      const canonicalize = (value) => typeof value === "string" ? aliases[value] || value : Array.isArray(value) ? value.map(canonicalize) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key3, child]) => [key3, canonicalize(child)])) : value;
      this.put("delivery", deliveryId, ctx, scope, { aliases, output: canonicalize(input.output), delivered: false }, this.now() + 30 * DAY2);
      this.put("event", (0, import_node_crypto4.randomUUID)(), ctx, scope, { type: "references_committed", count: refs.size, deliveryId }, this.now() + 30 * DAY2);
      return { aliases, deliveryId };
    });
    if (action === "intent") return this.transaction(() => {
      if (isMongoAdmissionRoute(input.route) && input.identity?.instanceId) assertInstanceAdmission(this, input.identity.instanceId, { ...input, ctx });
      const id = this.hash("operation", ctx, input.scope, input.route, input.request);
      const previous = this.get("operation", id, ctx, scope);
      const boundDigest = previous?.importPrepare?.requestDigest || previous?.bulkPrepare?.requestDigest || previous?.historicalRecovery?.requestDigest;
      if (boundDigest && boundDigest !== input.dispatchDigest) throw privacyError("BUSINESS_OPERATION_CONTENT_CONFLICT");
      if (input.route === "/mongodb/imports/prepare" && previous?.importPrepare && previous.state === "complete" && ["prepare_partial", "prepare_rejected"].includes(previous.result?.status)) {
        const record2 = continuePartialImport(this, id, previous, ctx, scope);
        this.put("operation", id, ctx, scope, record2, Number.MAX_SAFE_INTEGER, true);
        const taskId = this.hash("task", ctx, input.scope, "operation:" + id), task2 = this.get("task", taskId, ctx, scope);
        if (task2) this.put("task", taskId, ctx, scope, { ...task2, active: true }, Number.MAX_SAFE_INTEGER, true);
        return { id, state: "new", importPrepare: record2.importPrepare };
      }
      const retryPrepare = previous?.state === "rejected_before_dispatch" && (previous.prepare || previous.bulkPrepare || previous.importPrepare) && input.dispatchDigest === (previous.prepare || previous.bulkPrepare || previous.importPrepare).requestDigest;
      const retryExecution = previous?.state === "retryable" && previous.executionProtocol === 2 && previous.execution;
      if (retryExecution) this.put(
        "execution_evidence",
        this.hash("execution-attempt", ctx, input.scope, id, previous.executionAttempt),
        ctx,
        scope,
        { intentId: id, ...previous },
        Number.MAX_SAFE_INTEGER,
        true
      );
      if (previous && !retryPrepare && !retryExecution && !(previous.state === "complete" && input.renew === true && input.route === "/mongodb/bulk/control")) return { id, ...previous };
      if (retryPrepare && previous.importPrepare) {
        const evidenceId = this.hash("import-attempt", ctx, input.scope, id, previous.importPrepare.attempt);
        if (!this.get("import_prepare_evidence", evidenceId, ctx, scope)) this.put(
          "import_prepare_evidence",
          evidenceId,
          ctx,
          scope,
          { intentId: id, ...previous },
          Number.MAX_SAFE_INTEGER,
          true
        );
      }
      const prepare = input.route === "/mongodb/mutations/prepare" && /^[a-f0-9]{64}$/.test(input.dispatchDigest || "") ? { mutationId: previous?.prepare?.mutationId || (0, import_node_crypto4.randomUUID)(), binding: id, requestDigest: input.dispatchDigest, attempt: (previous?.prepare?.attempt || 0) + 1 } : void 0;
      const record = {
        state: "uncertain",
        route: input.route,
        identity: input.identity,
        started: this.now(),
        ...["/mongodb/mutations/execute", "/mongodb/mutations/rollback"].includes(input.route) && /^import-[a-f0-9]{64}$/.test(input.identity?.mutationId || "") ? { executionProtocol: 2, executionAttempt: (previous?.executionAttempt || 0) + 1 } : {},
        ...input.route === "/mongodb/imports/prepare" && /^[a-f0-9]{64}$/.test(input.dispatchDigest || "") ? { importPrepare: { binding: id, requestDigest: input.dispatchDigest, attempt: (previous?.importPrepare?.attempt || 0) + 1 }, previousRejection: previous?.rejection } : {},
        ...prepare ? { prepare, previousRejection: previous?.rejection } : {},
        ...input.route === "/mongodb/bulk/prepare" && /^[a-f0-9]{64}$/.test(input.dispatchDigest || "") ? { bulkPrepare: { binding: id, requestDigest: input.dispatchDigest, attempt: (previous?.bulkPrepare?.attempt || 0) + 1 }, previousRejection: previous?.rejection } : {}
      };
      this.put("operation", id, ctx, scope, record, Number.MAX_SAFE_INTEGER, true);
      const task = this.hash("task", ctx, input.scope, "operation:" + id);
      const retention = this.now() + 90 * DAY2;
      this.put("task", task, ctx, scope, { id: "operation:" + id, active: true, expires: retention }, retention, true);
      for (const ref of input.refs || []) {
        const row = this.db.prepare("SELECT * FROM records WHERE kind='mapping' AND id=? AND ctx=? AND scope=?").get(ref, ctx, scope);
        if (!row) throw privacyError("BUSINESS_REFERENCE_INVALID");
        this.open(row);
        this.db.prepare("INSERT OR IGNORE INTO links VALUES(?,?,?,?)").run(ctx, scope, task, ref);
        this.db.prepare("UPDATE records SET pinned=1 WHERE kind='mapping' AND id=?").run(ref);
      }
      return { id, state: "new", ...record.executionProtocol ? { executionProtocol: 2, executionAttempt: record.executionAttempt } : {}, ...prepare ? { prepare } : {}, ...record.bulkPrepare ? { bulkPrepare: record.bulkPrepare } : {}, ...record.importPrepare ? { importPrepare: record.importPrepare } : {} };
    });
    if (action === "inspect_operation") {
      if (!/^[a-f0-9]{64}$/.test(input.id || "")) throw privacyError("BUSINESS_OPERATION_DENIED");
      const record = this.get("operation", input.id, ctx, scope);
      if (!record) throw privacyError("BUSINESS_OPERATION_DENIED");
      return { id: input.id, ...record };
    }
    if (action === "historical_bulk_identity") {
      const record = this.get("operation", input.id, ctx, scope);
      if (!record || record.route !== "/mongodb/bulk/prepare" || record.bulkPrepare) throw privacyError("BUSINESS_OPERATION_DENIED");
      const requestMatched = input.request !== void 0 && this.hash("operation", ctx, input.scope, record.route, input.request) === input.id;
      return { requestMatched, recordFingerprint: this.hash("operation-record", ctx, input.scope, input.id, record) };
    }
    if (action === "historical_bulk_result") return this.transaction(() => {
      this.assertOperationAdmission(input.id, ctx, scope);
      const record = this.get("operation", input.id, ctx, scope), chunk = input.chunk, result = input.result;
      if (!record || record.route !== "/mongodb/bulk/prepare" || record.bulkPrepare || this.hash("operation", ctx, input.scope, record.route, input.request) !== input.id || input.requestDigest !== prepareRequestDigest(input.request) || record.identity?.jobId !== chunk?.jobId || record.identity?.chunkIndex !== chunk?.chunkIndex || result?.ok !== true || result.jobId !== chunk.jobId || result.chunkIndex !== chunk.chunkIndex || result.chunkHash !== chunk.chunkHash || chunk.endOfUpload && (result.status !== "prepared" || !/^[a-f0-9]{64}$/.test(result.planHash || ""))) throw privacyError("BUSINESS_OPERATION_DENIED");
      if (record.state !== "uncertain") return { id: input.id, ...record };
      const value = { ...record, state: "complete", result, historicalRecovery: {
        version: 1,
        evidence: "exact_remote_chunk",
        requestDigest: input.requestDigest,
        chunk,
        at: this.now(),
        operationId: input.operationId
      } };
      this.put("operation", input.id, ctx, scope, value, this.now() + 90 * DAY2, false);
      this.put("event", (0, import_node_crypto4.randomUUID)(), ctx, scope, {
        type: "historical_bulk_recovered",
        operation: input.id,
        evidence: "exact_remote_chunk",
        operationId: input.operationId,
        chunkHash: chunk.chunkHash
      }, this.now() + 90 * DAY2);
      const taskId = this.hash("task", ctx, input.scope, "operation:" + input.id), task = this.get("task", taskId, ctx, scope);
      if (task) this.put("task", taskId, ctx, scope, { ...task, active: false }, task.expires, false);
      return { id: input.id, ...value };
    });
    if (action === "claim_import_prepare") return this.transaction(() => {
      this.assertOperationAdmission(input.id, ctx, scope);
      const record = this.get("operation", input.id, ctx, scope);
      if (!record?.importPrepare || record.state !== "uncertain" || record.dispatched || record.importPrepare.requestDigest !== input.dispatchDigest || record.importPrepare.attempt !== input.attempt || !input.importBatches?.length || record.importBatches && JSON.stringify(record.importBatches) !== JSON.stringify(input.importBatches)) throw privacyError("BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
      const saved = { ...record, dispatched: true, operationId: input.operationId, importBatches: input.importBatches };
      this.put("operation", input.id, ctx, scope, saved, Number.MAX_SAFE_INTEGER, true);
      return saved;
    });
    if (action === "import_prepare_result") return this.transaction(() => {
      this.assertOperationAdmission(input.id, ctx, scope);
      const record = this.get("operation", input.id, ctx, scope), result = input.result;
      if (!record?.importPrepare || JSON.stringify(record.importPrepare) !== JSON.stringify(input.importPrepare)) throw privacyError("BUSINESS_OPERATION_DENIED");
      if (record.state !== "uncertain") return { id: input.id, ...record };
      const batches = record.importBatches || [];
      const proven = result?.ok === true && result.importReceipt?.binding === input.id && result.importReceipt.requestDigest === record.importPrepare.requestDigest && result.importReceipt.attempt === record.importPrepare.attempt && result.importId === record.identity.importId && result.kind === "import_plan" && result.importReceipt.riskPlanId === record.riskPlanId && result.collection === record.identity.collection && result.affectedCount === batches.reduce((n, b) => n + b.documentCount, 0) && result.batchCount === batches.length && result.importReceipt.batchesDigest === prepareRequestDigest({ batches }) && result.database === JSON.parse(input.scope).database && ["prepared", "prepare_partial", "prepare_rejected"].includes(result.status) && Array.isArray(result.batches) && (result.status === "prepare_rejected" ? result.batches.length === 0 && result.prepareRejection?.version === 1 && result.prepareRejection.stage === "preflight_rejected" && /^MONGODB_[A-Z0-9_]{1,70}$/.test(result.prepareRejection.code || "") : result.batches.length > 0) && result.batches.every((batch2, index) => batch2.mutationId === batches[index]?.mutationId && batch2.batchIndex === index && /^[a-f0-9]{64}$/.test(batch2.planHash || "")) && (result.status !== "prepared" || result.batches.length === batches.length);
      const saved = proven ? { ...record, state: "complete", result, reconciliation: void 0 } : input.notDispatched === true || input.unclaimed === true && !record.dispatched ? { ...record, state: "rejected_before_dispatch", result, reconciliation: void 0, rejection: {
        attempt: record.importPrepare.attempt,
        code: result.error?.code,
        at: this.now(),
        evidence: input.unclaimed ? "unclaimed_attempt_fence" : "preflight_before_ssh"
      } } : { ...record, reconciliation: { code: result?.error?.code || "MONGODB_IMPORT_EVIDENCE_REQUIRED" } };
      if (proven && result.status !== "prepare_rejected") recordImportPrepared(this, record, result);
      this.put("operation", input.id, ctx, scope, saved, Number.MAX_SAFE_INTEGER, true);
      this.put("event", (0, import_node_crypto4.randomUUID)(), ctx, scope, { type: "import_prepare_state", operation: input.id, state: saved.state, code: saved.rejection?.code || saved.reconciliation?.code, evidence: saved.rejection?.evidence, at: this.now() }, Number.MAX_SAFE_INTEGER, true);
      return { id: input.id, ...saved };
    });
    if (action === "claim_prepare") return this.transaction(() => {
      this.assertOperationAdmission(input.id, ctx, scope);
      const record = this.get("operation", input.id, ctx, scope);
      if (!record?.prepare || record.state !== "uncertain" || record.dispatched || record.prepare.requestDigest !== input.dispatchDigest || record.prepare.attempt !== input.attempt) throw privacyError("BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
      this.put("operation", input.id, ctx, scope, { ...record, dispatched: true, operationId: input.operationId }, Number.MAX_SAFE_INTEGER, true);
      return { ...record, dispatched: true };
    });
    if (action === "claim_bulk_prepare") return this.transaction(() => {
      this.assertOperationAdmission(input.id, ctx, scope);
      const record = this.get("operation", input.id, ctx, scope);
      if (!record?.bulkPrepare || record.state !== "uncertain" || record.dispatched || record.bulkPrepare.requestDigest !== input.dispatchDigest || record.bulkPrepare.attempt !== input.attempt) throw privacyError("BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
      this.put("operation", input.id, ctx, scope, { ...record, dispatched: true, operationId: input.operationId, bulkChunk: input.bulkChunk }, Number.MAX_SAFE_INTEGER, true);
      return { ...record, dispatched: true, bulkChunk: input.bulkChunk };
    });
    if (action === "bulk_prepare_result") return this.transaction(() => {
      this.assertOperationAdmission(input.id, ctx, scope);
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
      if (proven) recordReplacementPrepared(this, record, result);
      this.put("operation", input.id, ctx, scope, value, resolved ? this.now() + 90 * DAY2 : Number.MAX_SAFE_INTEGER, !resolved);
      this.put("event", (0, import_node_crypto4.randomUUID)(), ctx, scope, {
        type: "bulk_prepare_state",
        operation: input.id,
        state: value.state,
        attempt: record.bulkPrepare.attempt,
        operationId: record.operationId || input.operationId,
        code: value.rejection?.code || value.reconciliation?.code,
        evidence: value.rejection?.evidence
      }, this.now() + 90 * DAY2);
      if (resolved) {
        const taskId = this.hash("task", ctx, input.scope, "operation:" + input.id), task = this.get("task", taskId, ctx, scope);
        if (task) this.put("task", taskId, ctx, scope, { ...task, active: false }, task.expires, false);
      }
      return { id: input.id, ...value };
    });
    if (action === "claim_execution") return this.transaction(() => {
      this.assertOperationAdmission(input.id, ctx, scope);
      const record = this.get("operation", input.id, ctx, scope);
      if (!record || record.state !== "uncertain" || record.execution || !["/mongodb/mutations/execute", "/mongodb/mutations/rollback"].includes(record.route) || typeof input.operationId !== "string") throw privacyError("BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
      if (record.executionProtocol === 2 && input.attempt !== record.executionAttempt) throw privacyError("BUSINESS_OPERATION_RECONCILIATION_REQUIRED");
      const execution2 = {
        intentId: input.id,
        operationId: input.operationId,
        ...record.executionProtocol === 2 ? {
          version: 2,
          attempt: record.executionAttempt,
          mutationId: record.identity.mutationId,
          planHash: record.identity.planHash
        } : {}
      };
      this.put("operation", input.id, ctx, scope, { ...record, execution: execution2 }, Number.MAX_SAFE_INTEGER, true);
      return execution2;
    });
    if (action === "prepare_result") return this.transaction(() => {
      this.assertOperationAdmission(input.id, ctx, scope);
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
      this.put("operation", input.id, ctx, scope, value, resolved ? this.now() + 90 * DAY2 : Number.MAX_SAFE_INTEGER, !resolved);
      this.put("event", (0, import_node_crypto4.randomUUID)(), ctx, scope, {
        type: "prepare_state",
        operation: input.id,
        state: value.state,
        attempt: record.prepare.attempt,
        code: value.rejection?.code,
        evidence: value.rejection?.evidence,
        operationId: record.operationId
      }, this.now() + 90 * DAY2);
      if (resolved) {
        const taskId = this.hash("task", ctx, input.scope, "operation:" + input.id);
        const task = this.get("task", taskId, ctx, scope);
        if (task) this.put("task", taskId, ctx, scope, { ...task, active: false }, task.expires, false);
      }
      return { id: input.id, ...value };
    });
    if (action === "outcome" || action === "reconcile") return this.transaction(() => {
      this.assertOperationAdmission(input.id, ctx, scope);
      const previous = this.get("operation", input.id, ctx, scope);
      if (!previous) throw privacyError("BUSINESS_OPERATION_DENIED");
      if (previous.route === "/mongodb/bulk/prepare") throw privacyError("BUSINESS_OPERATION_DENIED");
      let proof;
      const identity = previous.identity || {};
      if (action === "outcome" && previous.executionProtocol === 2 && (previous.state !== "uncertain" || JSON.stringify(input.result?.execution) !== JSON.stringify(previous.execution) || input.result?.importExecution?.stage !== "acknowledged")) return { state: previous.state };
      if (action === "reconcile" && previous.executionProtocol === 2) {
        const entry2 = input.result?.ok === true && input.result.entries?.find((e) => e.mutationId === identity.mutationId && e.planHash === identity.planHash);
        const receipt = entry2?.importExecution;
        const exact = previous.state === "uncertain" && previous.execution && receipt?.version === 2 && JSON.stringify(entry2.execution) === JSON.stringify(previous.execution) && JSON.stringify(receipt.execution) === JSON.stringify(previous.execution) && receipt.mutationId === identity.mutationId && receipt.planHash === identity.planHash && receipt.database === JSON.parse(input.scope).database && entry2.database === receipt.database && entry2.collection === receipt.collection && receipt.mode === (previous.route.endsWith("rollback") ? "rollback" : "commit") && receipt.confirmation === (previous.route.endsWith("rollback") ? "确认回滚" : "确认执行");
        if (exact && receipt.stage === "safe_terminal" && ["before_transaction", "abort_acknowledged", "server_no_such_transaction"].includes(receipt.outcomeEvidence?.kind) && entry2.status === (receipt.mode === "commit" ? "commit_retryable" : "rollback_retryable") && entry2.indexRecovery?.reason === "exact_safe_terminal_receipt") {
          const value2 = { ...previous, state: "retryable", reconciliation: input.result, recovery: { evidence: "exact_safe_terminal_receipt", at: this.now() } };
          this.put("operation", input.id, ctx, scope, value2, Number.MAX_SAFE_INTEGER, true);
          this.put("event", (0, import_node_crypto4.randomUUID)(), ctx, scope, {
            type: "execution_safe_terminal",
            operation: input.id,
            attempt: previous.executionAttempt,
            operationId: previous.execution.operationId
          }, Number.MAX_SAFE_INTEGER, true);
          return { state: value2.state };
        }
        if (!exact) return { state: previous.state, ...previous.result ? { result: previous.result } : {} };
      }
      if (action === "reconcile" && input.result?.ok === true && /^[a-f0-9]{64}$/.test(identity.planHash || "")) {
        if (identity.jobId && input.result.jobId === identity.jobId && input.result.planHash === identity.planHash && (previous.route === "/mongodb/bulk/execute" && input.result.status === "completed" || previous.route === "/mongodb/bulk/rollback" && input.result.status === "rolled_back")) proof = input.result;
        if (identity.mutationId) {
          const entry2 = input.result.entries?.find((item) => item.mutationId === identity.mutationId && item.planHash === identity.planHash);
          const bound = !previous.execution || JSON.stringify(entry2?.execution) === JSON.stringify(previous.execution);
          if (entry2 && bound && !["legacy_execution_evidence_required", "execution_acknowledgement_required"].includes(entry2.indexRecovery?.reason) && (previous.route === "/mongodb/mutations/execute" && entry2.status === "committed" || previous.route === "/mongodb/mutations/rollback" && entry2.status === "rolled_back")) proof = { ok: true, ...entry2 };
        }
      }
      const complete = action === "outcome" || Boolean(proof);
      const value = complete ? { ...previous, state: "complete", result: proof || input.result } : { ...previous, reconciliation: input.result };
      this.put("operation", input.id, ctx, scope, value, complete ? this.now() + 90 * DAY2 : Number.MAX_SAFE_INTEGER, !complete);
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
  assertOperationAdmission(id, ctx, scope) {
    const original = this.get("operation", id, ctx, scope);
    if (original?.identity?.instanceId) assertInstanceAdmission(this, original.identity.instanceId, { route: original.route, identity: original.identity, dispatchDigest: original.importPrepare?.requestDigest || original.bulkPrepare?.requestDigest, ctx });
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
} catch (error2) {
  import_node_worker_threads.parentPort.postMessage({ failed: error2.code || "BUSINESS_STORAGE_UNAVAILABLE" });
}
import_node_worker_threads.parentPort.on("message", ({ id, action, input }) => {
  try {
    if (!store) throw new Error();
    const result = action === "close" ? store.close() : store.execute(action, input);
    import_node_worker_threads.parentPort.postMessage({ id, result });
  } catch (error2) {
    import_node_worker_threads.parentPort.postMessage({ id, error: error2.code?.startsWith("BUSINESS_") ? error2.code : "BUSINESS_STORAGE_UNAVAILABLE" });
  }
});
