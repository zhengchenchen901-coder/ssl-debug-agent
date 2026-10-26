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
    var fs3 = require("fs");
    var path3 = require("path");
    var { createHash: createHash4 } = require("crypto");
    var { execFileSync: execFileSync2 } = require("child_process");
    function fail(code = "BUSINESS_STORAGE_UNAVAILABLE") {
      return Object.assign(new Error("Windows protected local storage is unavailable; no business operation was replayed."), { code, statusCode: 409, retriable: false });
    }
    function native(action, input = {}, run = execFileSync2) {
      if (process.platform !== "win32") throw fail("BUSINESS_KEYSTORE_UNSUPPORTED");
      const systemRoot = process.env.SystemRoot || process.env.WINDIR;
      if (!systemRoot || !path3.isAbsolute(systemRoot)) throw fail("BUSINESS_KEYSTORE_UNAVAILABLE");
      try {
        const helper = path3.join(__dirname, "native/windows-privacy.ps1");
        const manifestPath = fs3.existsSync(path3.join(__dirname, "runtime-manifest.json")) ? path3.join(__dirname, "runtime-manifest.json") : path3.join(__dirname, "runtime/agent/runtime-manifest.json");
        const expected = JSON.parse(fs3.readFileSync(manifestPath, "utf8")).hashes?.["native/windows-privacy.ps1"];
        if (!/^[a-f0-9]{64}$/.test(expected || "") || createHash4("sha256").update(fs3.readFileSync(helper)).digest("hex") !== expected) throw fail("BUSINESS_STORAGE_INTEGRITY_INVALID");
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
        if (result.ok !== true) throw fail(/^BUSINESS_[A-Z_]+$/.test(result.code || "") ? result.code : void 0);
        return result;
      } catch (error) {
        if (error.code?.startsWith("BUSINESS_")) throw fail(error.code);
        throw fail(action === "key" ? "BUSINESS_KEYSTORE_UNAVAILABLE" : action.includes("context") ? "BUSINESS_CONTEXT_DENIED" : "BUSINESS_STORAGE_PATH_INVALID");
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
var import_node_crypto4 = require("node:crypto");
var import_node_fs2 = __toESM(require("node:fs"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);

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
  const { operationId, deadlineAt, timeoutMs, _businessPrepare, ...request } = input;
  return (0, import_node_crypto2.createHash)("sha256").update(JSON.stringify(request)).digest("hex");
}
function isPrepareTicket(value) {
  return value && /^[a-f0-9-]{36}$/.test(value.mutationId || "") && /^[a-f0-9]{64}$/.test(value.binding || "") && /^[a-f0-9]{64}$/.test(value.requestDigest || "") && Number.isSafeInteger(value.attempt) && value.attempt > 0;
}

// privacy-store.js
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
    const value = JSON.parse(import_node_fs.default.readFileSync(fd, "utf8")), after = import_node_fs.default.fstatSync(fd), current = import_node_fs.default.lstatSync(filename);
    if (before.ino !== current.ino || before.dev !== current.dev || current.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error();
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
    const key = (0, import_node_crypto3.createPublicKey)(trust.publicKey);
    if (key.asymmetricKeyType !== "ed25519" || receipt.version !== 1 || typeof receipt.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(receipt.signature)) throw Error();
    const p = receipt.payload;
    if (!p || !(0, import_node_crypto3.verify)(null, Buffer.from(JSON.stringify(p)), key, Buffer.from(receipt.signature, "base64"))) throw Error();
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
var retirementKey = (store2, plan) => store2.hash("risk-job-retirement", plan.binding.instanceId, plan.binding.jobId);
var HASH = /^[a-f0-9]{64}$/;
var MAX = Number.MAX_SAFE_INTEGER;
var denied = (code = "BUSINESS_REPLACEMENT_DENIED") => {
  throw privacyError(code);
};
var wire = (value) => JSON.parse(JSON.stringify(bulkPreparePayload(value)));
function effects(request, originalJobId) {
  function walk(value, key = "", insideIdentity = false) {
    insideIdentity ||= ["id", "_id"].includes(key.split(".").at(-1));
    if (!insideIdentity && typeof value === "string" && ["remediation_job_id", "job_id"].includes(key.split(".").at(-1)) && value === request.jobId) return originalJobId;
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
function load(store2, id, ctx, scope) {
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
    MAX,
    true
  );
  return id;
}
function riskStoreAction(store2, action, input, ctx, scope) {
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
    store2.put("risk_replacement", id, ctx, scope, plan, MAX, true);
    if (humanPolicy(plan)) {
      const candidateKey = store2.hash("risk-candidate", plan.binding.instanceId, request.jobId);
      const prior = store2.get("risk_candidate", candidateKey, "", "");
      if (prior && prior.riskPlanId !== id) {
        const other = load(store2, prior.riskPlanId).plan;
        if (other.approval || other.creationAuditId) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
      }
      store2.put("risk_candidate", candidateKey, "", "", { riskPlanId: id, ctx, scope }, MAX, true);
    }
    return riskView(store2, plan);
  });
  if (["inspect_risk_replacement", "create_risk_replacement", "risk_handoff_context", "record_risk_retirement"].includes(action)) return store2.transaction(() => {
    const { plan } = load(store2, input.riskPlanId, ctx, scope);
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
      if (!result || result.status !== "terminated_unknown" || result.managedAdmissionClosed !== true || !HASH.test(result.controlRecordDigest || "") || Object.entries(request).some(([key, value]) => key !== "approvalAuditId" && result[key] !== value)) denied("BUSINESS_REPLACEMENT_TERMINATION_REQUIRED");
      const saved = { ...plan, remoteRetirement: {
        ...request,
        recordedAt: store2.now(),
        originalJobFound: result.originalJobFound === true,
        legacyInFlightOutcome: "unknown",
        controlRecordDigest: result.controlRecordDigest
      } };
      store2.put("risk_replacement", plan.id, ctx, scope, saved, MAX, true);
      audit(store2, "risk_original_remote_termination_recorded", saved, ctx, scope, saved.remoteRetirement);
      return { ok: true };
    }
    return createReplacementIntent(store2, plan, input, ctx, scope);
  });
  return void 0;
}
function humanRiskStoreAction(store2, action, input) {
  if (!["human_risk_context", "human_risk_view", "human_risk_approve"].includes(action)) return void 0;
  const found = load(store2, input.riskPlanId);
  if (found.plan.binding.instanceId !== input.instanceId) denied();
  if (action === "human_risk_context") return { targetScope: found.plan.targetScope, database: found.plan.binding.database };
  return store2.transaction(() => {
    const { plan, ctx, scope } = load(store2, input.riskPlanId);
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
      validUntil: Math.min(plan.expiresAt, proof.validUntil || MAX, store2.now() + 9e5),
      policy: plan.approvalPolicy,
      residualRiskAccepted: humanPolicy(plan)
    };
    approval.auditId = audit(store2, "risk_replacement_human_approved", plan, ctx, scope, approval);
    const saved = { ...plan, state: "human_approved", approval };
    if (humanPolicy(plan)) {
      const key = retirementKey(store2, plan), retired = store2.get("risk_job_retirement", key, "", "");
      if (retired && retired.riskPlanId !== plan.id) denied("BUSINESS_REPLACEMENT_JOB_CONFLICT");
      store2.put("risk_job_retirement", key, "", "", {
        instanceId: plan.binding.instanceId,
        jobId: plan.binding.jobId,
        database: plan.binding.database,
        riskPlanId: plan.id,
        replacementJobId: plan.replacementRequest.jobId,
        dispositionId: parent.id,
        approvalAuditId: approval.auditId,
        historicalOutcome: "unknown",
        at: store2.now()
      }, MAX, true);
      const taskId = store2.hash("task", ctx, plan.targetScope, "operation:" + plan.binding.intentId);
      const task = store2.get("task", taskId, ctx, scope);
      if (task) store2.put("task", taskId, ctx, scope, { ...task, active: false, status: "terminated_unknown", replacementJobId: plan.replacementRequest.jobId }, MAX, true);
      if (parent.state !== "retired_unknown") store2.put("disposition", parent.id, ctx, scope, {
        ...parent,
        state: "termination_requested",
        retirement: { riskPlanId: plan.id, replacementJobId: plan.replacementRequest.jobId, approvalAuditId: approval.auditId, at: store2.now() }
      }, MAX, true);
    }
    store2.put("risk_replacement", plan.id, ctx, scope, saved, MAX, true);
    if (gate) store2.put("replacement_gate", gateId, "", "", { ...gate, approvalAuditId: approval.auditId, fenceFingerprint: proof.fingerprint }, MAX, true);
    return riskView(store2, saved);
  });
}
function requireHumanApproval(store2, plan, input, ctx, scope) {
  if (!plan.approval || plan.approval.policy !== HUMAN_RISK_POLICY || input.reviewHash !== plan.approval.reviewHash) denied("BUSINESS_REPLACEMENT_HUMAN_CONFIRMATION_REQUIRED");
  if (store2.now() >= plan.approval.validUntil) denied("BUSINESS_REPLACEMENT_APPROVAL_EXPIRED");
  originalCurrent(store2, plan, ctx, scope);
  const retirement = store2.get("risk_job_retirement", retirementKey(store2, plan), "", "");
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
  if (!previous || previous.state === "rejected_before_dispatch") store2.put("operation", id, ctx, scope, record, MAX, true);
  const taskId = store2.hash("task", ctx, plan.targetScope, "operation:" + id);
  store2.put("task", taskId, ctx, scope, { id: "operation:" + id, active: true, expires: MAX }, MAX, true);
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
  store2.put("risk_replacement", plan.id, ctx, scope, saved, MAX, true);
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
  }, MAX, true);
  store2.put("replacement_gate", gateId, "", "", { ...existingGate || {
    riskPlanId: plan.id,
    ctx,
    scope,
    instanceId: plan.binding.instanceId,
    jobId: plan.replacementRequest.jobId
  }, approvalAuditId: plan.approval.auditId, fenceFingerprint: proof.fingerprint }, MAX, true);
  return { intent: { id, ...record }, request: plan.replacementRequest, risk: riskView(store2, saved) };
}
function riskRetirementStatus(store2, parent) {
  if (!parent.retirement) return {};
  const { plan, ctx } = load(store2, parent.retirement.riskPlanId);
  if (ctx !== parent.binding.contextId || plan.dispositionId !== parent.id || plan.binding.intentId !== parent.binding.intentId) denied();
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
  const request = admission.request || {}, identity = admission.identity || request;
  if (!identity.jobId || typeof identity.jobId !== "string") return false;
  const gate = store2.get("replacement_gate", store2.hash("replacement-gate", instanceId, identity.jobId), "", "");
  if (!gate) return false;
  const { plan } = load(store2, gate.riskPlanId, gate.ctx, gate.scope);
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
  const { plan, ctx, scope } = load(store2, gate.riskPlanId, gate.ctx, gate.scope);
  if (!record.bulkChunk.endOfUpload) {
    if (record.bulkPrepare.requestDigest !== plan.requestDigest) denied();
    const firstUploadAuditId = audit(store2, "risk_replacement_uploaded", plan, ctx, scope, { chunkHash: result.chunkHash });
    store2.put("risk_replacement", plan.id, ctx, scope, { ...plan, state: plan.planHash ? "prepared" : "uploaded", firstUploadAuditId }, MAX, true);
    return;
  }
  if (record.bulkPrepare.requestDigest !== plan.sealDigest || !HASH.test(result.planHash || "") || gate.planHash && gate.planHash !== result.planHash) denied();
  store2.put("replacement_gate", gateId, "", "", { ...gate, planHash: result.planHash }, MAX, true);
  const auditId = audit(store2, "risk_replacement_prepared_remotely", plan, ctx, scope, { planHash: result.planHash });
  store2.put("risk_replacement", plan.id, ctx, scope, { ...plan, state: "prepared", planHash: result.planHash, preparedAuditId: auditId }, MAX, true);
}
function assertRiskJobAdmission(store2, instanceId, admission = {}) {
  const identity = admission.identity || admission.request || {};
  if (typeof identity.jobId !== "string") return;
  const retired = store2.get("risk_job_retirement", store2.hash("risk-job-retirement", instanceId, identity.jobId), "", "");
  if (retired) denied("BUSINESS_ORIGINAL_JOB_TERMINATED");
  const candidate = store2.get("risk_candidate", store2.hash("risk-candidate", instanceId, identity.jobId), "", "");
  if (candidate && !replacementAdmission(store2, instanceId, admission)) denied("BUSINESS_REPLACEMENT_NOT_ADMITTED");
}

// mongodb-disposition.js
var DISPOSITION_CONFIRMATION = "确认隔离原意图";
var HASH2 = /^[a-f0-9]{64}$/;
var DAY = 864e5;
var READ_ROUTES = /* @__PURE__ */ new Set([
  "/mongodb/query",
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
function view(store2, record) {
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
    if (!HASH2.test(input.id || "") || !original || original.state !== "uncertain" || original.route !== "/mongodb/bulk/prepare" || original.identity?.instanceId !== target.id || !request || request.instanceId !== target.id || request.database !== target.database || store2.hash("operation", ctx, input.scope, original.route, request) !== input.id || typeof original.identity.jobId !== "string" || original.identity.jobId !== request.jobId || !Number.isSafeInteger(original.identity.chunkIndex) || original.identity.chunkIndex !== request.chunkIndex || input.requestDigest !== prepareRequestDigest(request)) denied2();
    if (original.bulkPrepare && original.bulkPrepare.requestDigest !== input.requestDigest) denied2();
    const fingerprint = store2.hash("operation-record", ctx, input.scope, input.id, original);
    const binding = {
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
    const missingRequirements = [...requirements];
    for (const [field, reason] of [["originalOperationId", "original_operation_identity_unbound"], ["chunkHash", "original_chunk_hash_unbound"], ["planHash", "original_plan_hash_unbound"]]) {
      if (!binding[field]) missingRequirements.push(reason);
    }
    const id = store2.hash("disposition", ctx, input.scope, binding, fingerprint);
    const previous = store2.get("disposition", id, ctx, scope);
    if (previous && (["quarantined", "retired_unknown"].includes(previous.state) || store2.now() < previous.expiresAt)) return view(store2, previous);
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
    return view(store2, record);
  });
  if (["inspect_disposition", "quarantine_disposition", "admit_disposition"].includes(action)) return store2.transaction(() => {
    if (!HASH2.test(input.dispositionId || "")) denied2();
    const record = store2.get("disposition", input.dispositionId, ctx, scope);
    if (!record || record.binding.contextId !== ctx || record.binding.instanceId !== targetOf(input).id || record.binding.database !== targetOf(input).database) denied2();
    if (action === "inspect_disposition") return view(store2, record);
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
      return { ...view(store2, record), admission: "blocked", admissionAuditId: auditId2 };
    }
    if (input.confirmation !== DISPOSITION_CONFIRMATION) denied2();
    if (["quarantined", "retired_unknown"].includes(record.state)) return view(store2, record);
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
    return view(store2, saved);
  });
  return void 0;
}
function assertInstanceAdmission(store2, instanceId, admission = {}) {
  if (typeof instanceId !== "string" || !instanceId) denied2();
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
  constructor({ directory, key, now = Date.now, fault, fenceAuthority, riskPolicy } = {}) {
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
        const entry = import_node_fs2.default.lstatSync(filename2 + suffix);
        if (!entry.isFile() || entry.isSymbolicLink() || process.getuid && entry.uid !== process.getuid()) throw privacyError("BUSINESS_STORAGE_PATH_INVALID");
      }
    }
    const filename = import_node_path2.default.join(this.directory, "privacy.sqlite");
    const master = key ? Buffer.from(key) : loadPrivacyKey(this.directory, { existing: process.platform === "win32" ? windowsExisting : import_node_fs2.default.existsSync(filename) });
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
    } catch (error) {
      this.close();
      throw privacyError(error.code?.startsWith("BUSINESS_") ? error.code : "BUSINESS_STORAGE_CORRUPT");
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
      for (const task of input.tasks || []) {
        if (typeof task.id !== "string" || task.id.length > 256) throw privacyError("BUSINESS_STORAGE_INVALID");
        const taskId = this.hash("task", ctx, input.scope, task.id);
        const previous = this.get("task", taskId, ctx, scope);
        const active = !["completed", "committed", "rolled_back", "failed", "cancelled", "expired", "prepared", "ready"].includes(task.status);
        const expires = Math.max(previous?.expires || 0, this.now() + (input.retentionMs || 30 * DAY2), Number(task.expires) || 0);
        this.put("task", taskId, ctx, scope, { ...previous, ...task, active, expires }, expires, active);
        for (const ref of refs) this.db.prepare("INSERT OR IGNORE INTO links VALUES(?,?,?,?)").run(ctx, scope, taskId, ref);
        this.db.prepare("UPDATE records SET pinned=1 WHERE kind='mapping' AND ctx=? AND id IN (SELECT ref FROM links WHERE ctx=? AND task=?)").run(ctx, ctx, taskId);
      }
      const deliveryId = input.deliveryId || (0, import_node_crypto4.randomUUID)();
      const canonicalize = (value) => typeof value === "string" ? aliases[value] || value : Array.isArray(value) ? value.map(canonicalize) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, canonicalize(child)])) : value;
      this.put("delivery", deliveryId, ctx, scope, { aliases, output: canonicalize(input.output), delivered: false }, this.now() + 30 * DAY2);
      this.put("event", (0, import_node_crypto4.randomUUID)(), ctx, scope, { type: "references_committed", count: refs.size, deliveryId }, this.now() + 30 * DAY2);
      return { aliases, deliveryId };
    });
    if (action === "intent") return this.transaction(() => {
      if (isMongoAdmissionRoute(input.route) && input.identity?.instanceId) assertInstanceAdmission(this, input.identity.instanceId, { ...input, ctx });
      const id = this.hash("operation", ctx, input.scope, input.route, input.request);
      const previous = this.get("operation", id, ctx, scope);
      const boundDigest = previous?.bulkPrepare?.requestDigest || previous?.historicalRecovery?.requestDigest;
      if (boundDigest && boundDigest !== input.dispatchDigest) throw privacyError("BUSINESS_OPERATION_CONTENT_CONFLICT");
      const retryPrepare = previous?.state === "rejected_before_dispatch" && (previous.prepare || previous.bulkPrepare) && input.dispatchDigest === (previous.prepare || previous.bulkPrepare).requestDigest;
      if (previous && !retryPrepare && !(previous.state === "complete" && input.renew === true && input.route === "/mongodb/bulk/control")) return { id, ...previous };
      const prepare = input.route === "/mongodb/mutations/prepare" && /^[a-f0-9]{64}$/.test(input.dispatchDigest || "") ? { mutationId: previous?.prepare?.mutationId || (0, import_node_crypto4.randomUUID)(), binding: id, requestDigest: input.dispatchDigest, attempt: (previous?.prepare?.attempt || 0) + 1 } : void 0;
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
      const retention = this.now() + 90 * DAY2;
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
      const execution = { intentId: input.id, operationId: input.operationId };
      this.put("operation", input.id, ctx, scope, { ...record, execution }, Number.MAX_SAFE_INTEGER, true);
      return execution;
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
    if (original?.identity?.instanceId) assertInstanceAdmission(this, original.identity.instanceId, { route: original.route, identity: original.identity, dispatchDigest: original.bulkPrepare?.requestDigest, ctx });
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
