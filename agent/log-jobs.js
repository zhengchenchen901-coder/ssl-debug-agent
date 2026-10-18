import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { normalizeLogQuery } from "./log-query.js";
import { LOG_QUERY_RUNTIME_SOURCE, LOG_JOB_RUNTIME_SOURCE } from "./log-query-runtime-source.js";
import { createOperationController, operationError } from "./operation.js";
import { quotePosixArgument } from "./ssh.js";
import { logInputError, normalizeLogJobLimits } from "./log-policy.js";
import { assertPathAllowed } from "./security.js";
import posixPath from "node:path/posix";
import { REMOTE_RESOURCE_RUNTIME_SOURCE } from "./remote-resource-runtime-source.js";

export const LOG_JOB_DEFAULTS = Object.freeze({
  jobTimeoutMs: 30 * 60 * 1000, maxJobTimeoutMs: 120 * 60 * 1000,
  cpuPercent: 20, readBytesPerSecond: 2 * 1024 * 1024,
  processBytesPerSecond: 4 * 1024 * 1024, rssLimitBytes: 192 * 1024 * 1024,
  pauseTtlMs: 5 * 60 * 1000, batchScanBytes: 256 * 1024 * 1024,
});
const terminal = new Set(["completed", "partial", "stopped", "failed", "cancelled", "interrupted", "expired"]);
const fault = (message, code, statusCode = 400) => operationError(message, { code, statusCode, layer: "logs", phase: "job" });
const contextFields = ["instanceId", "operationId", "timeoutMs", "deadlineAt"];
const startFields = ["projectId", "path", "mode", "date", "dateFrom", "dateTo", "fileContains", "memberPath", "memberContains", "contains", "caseSensitive", "route", "method", "level", "fromTime", "toTime", "limit", "maxBytes", "jobTimeoutMs", "cpuPercent", "readBytesPerSecond", "processBytesPerSecond", "batchScanBytes", "stopAfterFile", "_logProjects"];
function validateFields(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw logInputError("log task arguments must be an object", "INVALID_LOG_JOB");
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.includes(key) && !contextFields.includes(key)) throw logInputError(`unknown log task parameter: ${key}`, "INVALID_LOG_JOB");
    if (value === null || value === undefined) throw logInputError(`invalid ${key}`, "INVALID_LOG_JOB");
    if (key === "caseSensitive" && typeof value !== "boolean") throw logInputError("caseSensitive must be boolean", "INVALID_LOG_JOB");
    if (["projectId", "path", "mode", "date", "dateFrom", "dateTo", "fileContains", "memberPath", "memberContains", "contains", "route", "method", "level", "fromTime", "toTime", "stopAfterFile", "jobId", "action"].includes(key)
      && (typeof value !== "string" || !value.trim() || value.includes("\0"))) throw logInputError(`invalid ${key}`, "INVALID_LOG_JOB");
    const maxLength = { path: 4096, stopAfterFile: 4096, jobId: 64, action: 32, dateFrom: 10, dateTo: 10 }[key];
    if (maxLength && value.length > maxLength) throw logInputError(`${key} is too long`, "INVALID_LOG_JOB");
  }
}
function checkDate(value) {
  if (value === undefined) return;
  const time = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(time.getTime()) || time.toISOString().slice(0, 10) !== value) throw logInputError("invalid date bound", "INVALID_LOG_JOB_SCOPE");
}
function bounded(value, fallback, min, max, field) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw logInputError(`invalid ${field}`, "INVALID_LOG_JOB");
  return value;
}
export function normalizeLogJob(input, config) {
  validateFields(input, startFields);
  if (input.date && (input.dateFrom || input.dateTo)) throw logInputError("date cannot be combined with dateFrom/dateTo", "INVALID_LOG_JOB_SCOPE");
  if (input.mode !== undefined && input.mode !== "search") throw logInputError("background queries support search only", "INVALID_LOG_JOB");
  if (input.fileOffset || input.memberOffset) throw logInputError("background queries start from the full selected scope", "INVALID_LOG_JOB");
  for (const key of ["maxScanBytes", "maxExpandedBytes", "maxFiles"]) {
    if (input[key] !== undefined) throw logInputError(`${key} is for synchronous queries; use task resource limits`, "INVALID_LOG_JOB");
  }
  const query = normalizeLogQuery({ ...input, mode: "search" }, config);
  bounded(input.limit, 50, 1, 2000, "limit"); bounded(input.maxBytes, 262144, 1, 262144, "maxBytes");
  if (input.path && (input.memberPath || input.memberContains) && !/\.(?:tar\.gz|tgz)$/i.test(input.path)) throw logInputError("member filters require a tar.gz/tgz archive", "INVALID_LOG_JOB");
  if (input.stopAfterFile) { assertPathAllowed(input.stopAfterFile, config.security.allowedPaths); if (input.stopAfterFile.length > 4096) throw logInputError("stopAfterFile is too long", "INVALID_LOG_JOB_BOUNDARY"); }
  const limits = normalizeLogJobLimits(config.logs?.jobLimits);
  const timeoutMax = Math.min(limits.maxJobTimeoutMs || LOG_JOB_DEFAULTS.maxJobTimeoutMs, LOG_JOB_DEFAULTS.maxJobTimeoutMs);
  return { ...query, background: true, fileOffset: 0, maxFiles: 5000,
    stopAfterFile: input.stopAfterFile ? posixPath.normalize(input.stopAfterFile) : undefined,
    maxScanBytes: Number.MAX_SAFE_INTEGER, maxExpandedBytes: Number.MAX_SAFE_INTEGER,
    jobTimeoutMs: bounded(input.jobTimeoutMs, Math.min(LOG_JOB_DEFAULTS.jobTimeoutMs, timeoutMax), 1000, timeoutMax, "jobTimeoutMs"),
    cpuPercent: bounded(input.cpuPercent, Math.min(limits.cpuPercent || 20, 20), 1, Math.min(limits.cpuPercent || 50, 50), "cpuPercent"),
    readBytesPerSecond: bounded(input.readBytesPerSecond, Math.min(limits.readBytesPerSecond || LOG_JOB_DEFAULTS.readBytesPerSecond, LOG_JOB_DEFAULTS.readBytesPerSecond), 65536, Math.min(limits.readBytesPerSecond || 16 * 1024 * 1024, 16 * 1024 * 1024), "readBytesPerSecond"),
    processBytesPerSecond: bounded(input.processBytesPerSecond, Math.min(limits.processBytesPerSecond || LOG_JOB_DEFAULTS.processBytesPerSecond, LOG_JOB_DEFAULTS.processBytesPerSecond), 65536, Math.min(limits.processBytesPerSecond || 32 * 1024 * 1024, 32 * 1024 * 1024), "processBytesPerSecond"),
    rssLimitBytes: Math.min(limits.rssLimitBytes || LOG_JOB_DEFAULTS.rssLimitBytes, LOG_JOB_DEFAULTS.rssLimitBytes),
    pauseTtlMs: LOG_JOB_DEFAULTS.pauseTtlMs,
    batchScanBytes: bounded(input.batchScanBytes, LOG_JOB_DEFAULTS.batchScanBytes, 65536, LOG_JOB_DEFAULTS.batchScanBytes, "batchScanBytes"),
  };
}

export function logJobCommand() {
  return "node --max-old-space-size=64 -e " + quotePosixArgument(`${REMOTE_RESOURCE_RUNTIME_SOURCE}\n${LOG_QUERY_RUNTIME_SOURCE}\n${LOG_JOB_RUNTIME_SOURCE}\nrunRemoteLogJob();`);
}

export class LogJobRunner {
  constructor({ config, runSSH, now = Date.now, resourceClient }) {
    this.config = config; this.runSSH = runSSH; this.now = now;
    this.jobs = new Map(); this.active = null; this.closed = false;
    this.retentionMs = 30 * 60 * 1000;
    this.resourceClient = resourceClient;
    this.activeJobs = new Set();
  }
  prune() {
    for (const [id, job] of this.jobs) {
      if (terminal.has(job.status) && this.now() - job.finishedAt >= this.retentionMs) {
        clearTimeout(job.expiryTimer); this.jobs.delete(id);
      }
    }
  }
  retain(job) {
    job.finishedAt = this.now();
    job.expiryTimer = setTimeout(() => this.prune(), this.retentionMs + 1);
    job.expiryTimer.unref?.();
    // The scope and filter are not needed after execution; keep only limits.
    job.query = Object.fromEntries(Object.entries(job.query).filter(([key]) =>
      ["jobTimeoutMs", "cpuPercent", "readBytesPerSecond", "processBytesPerSecond", "rssLimitBytes", "batchScanBytes"].includes(key)));
  }
  start(input, metadata = {}) {
    this.prune();
    if (this.closed) throw fault("log query runner is stopping", "LOG_JOB_RUNNER_CLOSED", 503);
    const config = { ...this.config, logs: { ...this.config.logs, projects: input._logProjects || this.config.logs?.projects || {} } };
    const query = normalizeLogJob(input, config);
    if ([...this.jobs.values()].filter((job) => !terminal.has(job.status)).length >= 4) throw fault("log query queue is full", "LOG_JOB_QUEUE_FULL", 429);
    // Bound local retention even when callers create many short tasks.
    if (this.jobs.size >= 16) {
      const oldest = [...this.jobs.values()].find((job) => terminal.has(job.status));
      if (oldest) { clearTimeout(oldest.expiryTimer); this.jobs.delete(oldest.jobId); }
    }
    const job = { jobId: randomUUID(), status: "queued", createdAt: this.now(), query,
      evidence: [], evidenceBytes: 0,
      fileResults: new Map(), receiptBytes: 0, controls: new Map(),
      evidenceLimits: { count: query.limit, bytes: query.maxBytes },
      scopeControls: { dateFrom: query.dateFrom, dateTo: query.dateTo, stopAfterFile: query.stopAfterFile },
      progress: { matchedLines: 0, scannedBytes: 0, expandedBytes: 0, countsAreComplete: false } };
    this.jobs.set(job.jobId, job);
    if (this.resourceClient) job.resourceTaskId = this.resourceClient.register({ type: "log_search", referenceId: job.jobId,
      label: `日志批量查询${query.dateFrom || query.dateTo ? ` · ${query.dateFrom || "起始"}—${query.dateTo || "至今"}` : ""}`, source: metadata.source, capabilities: ["pause", "resume", "cancel", "stop_after_file", "detail"],
      requested: { cpuMilliCores: query.cpuPercent * 10, readBytesPerSecond: query.readBytesPerSecond,
        processBytesPerSecond: query.processBytesPerSecond, rssLimitBytes: query.rssLimitBytes,
        ...(config.logs?.jobLimits?.cpuPercent ? { maxCpuMilliCores: config.logs.jobLimits.cpuPercent * 10 } : {}),
        ...(config.logs?.jobLimits?.readBytesPerSecond ? { maxReadBytesPerSecond: config.logs.jobLimits.readBytesPerSecond } : {}),
        ...(config.logs?.jobLimits?.processBytesPerSecond ? { maxProcessBytesPerSecond: config.logs.jobLimits.processBytesPerSecond } : {}) } },
      { control: (action) => this.control({ jobId: job.jobId, action }) });
    setImmediate(() => this.pump());
    return this.get({ jobId: job.jobId });
  }
  find(jobId) {
    this.prune();
    const job = this.jobs.get(jobId);
    if (!job) throw fault("log query task not found or expired", "LOG_JOB_NOT_FOUND", 404);
    return job;
  }
  get(input) {
    validateFields(input, ["jobId", "offset", "limit", "fileOffset", "fileLimit"]);
    if (!input.jobId) throw fault("jobId is required", "INVALID_LOG_JOB");
    const job = this.find(input.jobId);
    const offset = bounded(input.offset, 0, 0, 2000, "offset");
    const limit = bounded(input.limit, 50, 1, 2000, "limit");
    const all = job.result?.records || job.evidence;
    const records = [];
    let bytes = 0;
    for (const record of all.slice(offset, offset + limit)) {
      const size = Buffer.byteLength(JSON.stringify(record));
      if (records.length && bytes + size > 256 * 1024) break;
      records.push(record); bytes += size;
    }
    const { records: ignored, ...result } = job.result || {};
    const hasMore = offset + records.length < all.length;
    const fileOffset = bounded(input.fileOffset, 0, 0, 5000, "fileOffset"), fileLimit = bounded(input.fileLimit, 50, 1, 500, "fileLimit");
    const receipts = [...job.fileResults.values()].sort((a, b) => a.fileIndex - b.fileIndex);
    const fileResults = []; let fileBytes = 0;
    for (const receipt of receipts.slice(fileOffset, fileOffset + fileLimit)) {
      const size = Buffer.byteLength(JSON.stringify(receipt));
      if (fileResults.length && fileBytes + size > 128 * 1024) break;
      fileResults.push(receipt); fileBytes += size;
    }
    const countsAreComplete = job.status === "completed" && result.countsAreComplete === true;
    const observed = result.matchedLines ?? job.progress.matchedLines ?? 0;
    const evidenceTruncated = Boolean(result.outputTruncated || job.progress.outputTruncated || observed > all.length || all.some((r) => r.truncated));
    const hasMoreFiles = fileOffset + fileResults.length < receipts.length;
    return { jobId: job.jobId, status: job.status, createdAt: job.createdAt, startedAt: job.startedAt,
      finishedAt: job.finishedAt, expiresAt: job.finishedAt ? job.finishedAt + this.retentionMs : undefined,
      progress: { ...job.progress, status: job.status, countsAreComplete,
        currentFileProgress: job.progress.currentFileProgress
          ? job.fileResults.get(job.progress.currentFileProgress.fileIndex) || job.progress.currentFileProgress : null }, ...result, countsAreComplete,
      scanComplete: result.scanComplete === true,
      evidenceComplete: countsAreComplete && !evidenceTruncated,
      evidenceTruncated, retainedEvidenceCount: all.length, evidenceLimits: job.evidenceLimits,
      paginationScope: "retained_evidence", observedMatchedLines: observed,
      fileResults, fileResultCount: receipts.length, hasMoreFileResults: hasMoreFiles,
      nextFileOffset: hasMoreFiles ? fileOffset + fileResults.length : null,
      scopeControls: job.scopeControls,
      resourceTaskId: job.resourceTaskId,
      records, hasMoreRecords: hasMore, nextOffset: hasMore ? offset + records.length : null,
      error: job.error, requestedAction: job.requestedAction,
      limits: { jobTimeoutMs: job.query.jobTimeoutMs, cpuPercent: job.query.cpuPercent,
        readBytesPerSecond: job.query.readBytesPerSecond, processBytesPerSecond: job.query.processBytesPerSecond,
        rssLimitBytes: job.query.rssLimitBytes, batchScanBytes: job.query.batchScanBytes } };
  }
  control(input) {
    validateFields(input, ["jobId", "action", "stopAfterFile", "dateFrom", "dateTo"]);
    if (!input.jobId) throw fault("jobId is required", "INVALID_LOG_JOB");
    const job = this.find(input.jobId);
    if (!["pause", "resume", "cancel", "stop_after_file", "narrow"].includes(input.action)) throw fault("invalid log task action", "INVALID_LOG_JOB_ACTION");
    if (input.stopAfterFile !== undefined && input.action !== "stop_after_file" || (input.dateFrom !== undefined || input.dateTo !== undefined) && input.action !== "narrow") throw fault("parameters do not apply to this action", "INVALID_LOG_JOB_ACTION");
    if (input.action === "narrow") {
      if (!input.dateFrom && !input.dateTo) throw fault("narrow requires dateFrom or dateTo", "INVALID_LOG_JOB_SCOPE");
      checkDate(input.dateFrom); checkDate(input.dateTo);
      if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) throw fault("invalid date range", "INVALID_LOG_JOB_SCOPE");
    }
    if (input.stopAfterFile) { assertPathAllowed(input.stopAfterFile, this.config.security.allowedPaths); input = { ...input, stopAfterFile: posixPath.normalize(input.stopAfterFile) }; }
    if (terminal.has(job.status)) return this.get({ jobId: job.jobId });
    if (["stop_after_file", "narrow"].includes(input.action)) return this.sendControl(job, input);
    if (job.status === "queued") {
      if (input.action !== "cancel") throw fault("queued tasks can only be cancelled", "LOG_JOB_NOT_RUNNING", 409);
      job.status = "cancelled"; this.retain(job);
      this.resourceClient?.update(job.resourceTaskId, { status: "cancelled", phase: "finished" });
    } else {
      job.requestedAction = input.action;
      if (input.action === "cancel") job.status = "cancelling";
      if (job.channel && !job.channel.destroyed) job.channel.write(JSON.stringify({ type: input.action }) + "\n");
      if (input.action === "cancel") job.controller.abort(fault("log query cancelled", "LOG_JOB_CANCELLED", 499));
    }
    return this.get({ jobId: job.jobId });
  }
  async sendControl(job, input) {
    if (!job.channel || job.status === "cancelling") throw fault("log task control channel is not ready", "LOG_JOB_NOT_READY", 409);
    const requestId = randomUUID();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { job.controls.delete(requestId); reject(fault("log task control acknowledgement timed out", "LOG_JOB_CONTROL_TIMEOUT", 504)); }, 5000);
      job.controls.set(requestId, { resolve: () => { clearTimeout(timer); resolve(); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      job.channel.write(JSON.stringify({ type: input.action, requestId, stopAfterFile: input.stopAfterFile, dateFrom: input.dateFrom, dateTo: input.dateTo }) + "\n");
    });
    return this.get({ jobId: job.jobId });
  }
  pump() {
    if (this.activeJobs.size >= (this.resourceClient ? 2 : 1) || this.closed) return;
    const job = [...this.jobs.values()].filter((item) => item.status === "queued").sort((a, b) =>
      Number(this.resourceClient?.registry.tasks.get(b.resourceTaskId)?.resourceMode === "manual_max") - Number(this.resourceClient?.registry.tasks.get(a.resourceTaskId)?.resourceMode === "manual_max"))[0];
    if (!job) return;
    this.active = job;
    this.activeJobs.add(job);
    job.promise = this.execute(job).finally(() => { this.activeJobs.delete(job); this.active = [...this.activeJobs][0] || null; this.pump(); });
    this.pump();
  }
  storeReceipt(job, receipt) {
    if (!Number.isInteger(receipt.fileIndex) || receipt.fileIndex < 0 || receipt.fileIndex >= 5000 || typeof receipt.path !== "string") throw fault("invalid file receipt", "LOG_JOB_PROTOCOL", 502);
    const previous = job.fileResults.get(receipt.fileIndex);
    if (previous && previous.path !== receipt.path) throw fault("file receipt identity changed", "LOG_JOB_PROTOCOL", 502);
    if (previous?.finishedAt !== undefined) return;
    if (previous && previous.status !== "running" && receipt.status === "running") return;
    const value = { ...receipt, queryId: job.jobId,
      ...(receipt.finishedAt === undefined ? { status: "running", scanComplete: false, countsAreComplete: false, evidenceComplete: false } : {}) };
    const bytes = job.receiptBytes - (previous ? Buffer.byteLength(JSON.stringify(previous)) : 0) + Buffer.byteLength(JSON.stringify(value));
    if (bytes > 8 * 1024 * 1024) throw fault("file receipt storage budget exceeded", "LOG_JOB_RECEIPT_LIMIT", 502);
    job.receiptBytes = bytes; job.fileResults.set(receipt.fileIndex, value);
  }
  async execute(job) {
    job.startedAt = this.now(); job.status = "running";
    const envelope = { operationId: job.jobId, deadlineAt: this.now() + job.query.jobTimeoutMs, timeoutMs: job.query.jobTimeoutMs };
    job.controller = new AbortController();
    const linked = createOperationController(envelope, job.controller.signal, { layer: "logs", deadlinePhase: "job" });
    const decoder = new StringDecoder("utf8");
    const resourcePending = new Map();
    if (job.resourceTaskId) {
      this.resourceClient.update(job.resourceTaskId, { status: "starting", phase: "waiting_resources" });
      this.resourceClient.bind(job.resourceTaskId, {
        onBudget: (budget, revision) => {
          job.resourceBudget = budget;
          if (!job.channel) return;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { resourcePending.delete(revision); reject(new Error("resource update not acknowledged")); }, 5000);
            resourcePending.set(revision, { resolve: () => { clearTimeout(timer); resolve(); }, reject: () => { clearTimeout(timer); reject(new Error("task terminated")); } });
            job.channel.write(JSON.stringify({ type: "resource_update", budget, revision }) + "\n");
          });
        },
        renew: (valid) => { if (valid && job.channel && !job.channel.destroyed) job.channel.write('{"type":"resource_renew"}\n'); },
      });
    }
    let pending = "", receivedFinal = false, heartbeat;
    const onFrame = (frame) => {
      if (receivedFinal) throw fault("duplicate terminal log frame", "LOG_JOB_PROTOCOL", 502);
      if (frame.type === "progress") {
        job.progress = frame;
        if (job.status !== "cancelling" && ["paused", "running", "stopping"].includes(frame.status)) job.status = frame.status;
        if (job.requestedAction === "pause" && frame.status === "paused" || job.requestedAction === "resume" && ["running", "stopping"].includes(frame.status)) job.requestedAction = undefined;
        if (frame.currentFileProgress) this.storeReceipt(job, frame.currentFileProgress);
      } else if (frame.type === "resource_ack") {
        resourcePending.get(frame.revision)?.resolve(); resourcePending.delete(frame.revision);
      } else if (frame.type === "file_started") {
        this.storeReceipt(job, frame.receipt);
      } else if (frame.type === "file_result") {
        this.storeReceipt(job, frame.receipt);
        job.progress = frame.progress;
        job.channel?.write(JSON.stringify({ type: "receipt_ack", receiptId: frame.receiptId }) + "\n");
      } else if (frame.type === "control_ack") {
        const pending = job.controls.get(frame.requestId);
        if (pending) {
          job.controls.delete(frame.requestId);
          if (frame.ok) {
            job.progress = frame.progress;
            job.scopeControls = { dateFrom: frame.progress.remainingDateFrom, dateTo: frame.progress.remainingDateTo, stopAfterFile: frame.progress.stopAfterFile };
            if (job.status !== "cancelling") job.status = frame.progress.status;
            pending.resolve();
          } else pending.reject(fault(frame.error.message, frame.error.code, 409));
        }
      } else if (frame.type === "evidence") {
        const bytes = Buffer.byteLength(JSON.stringify(frame.record));
        if (job.evidence.length >= job.query.limit || job.evidenceBytes + bytes > job.query.maxBytes) throw fault("log evidence budget exceeded", "LOG_JOB_PROTOCOL", 502);
        job.evidence.push(frame.record); job.evidenceBytes += bytes;
        job.progress = frame.progress;
        if (frame.progress.currentFileProgress) this.storeReceipt(job, frame.progress.currentFileProgress);
      } else if (frame.type === "result") {
        receivedFinal = true; job.result = { ...frame.result, resources: frame.resources };
      } else if (frame.type === "error") {
        receivedFinal = true; job.progress = frame; job.error = frame.error;
      } else throw fault("unknown log job frame", "LOG_JOB_PROTOCOL", 502);
      if (job.resourceTaskId) this.resourceClient.update(job.resourceTaskId, {
        status: job.status, phase: "scanning", usage: frame.resources || frame.progress?.resources || job.progress.resources || {},
        progress: { scannedBytes: job.progress.scannedBytes || 0, expandedBytes: job.progress.expandedBytes || 0,
          matchedLines: job.progress.matchedLines || 0, completedFiles: job.progress.completedFiles || 0, totalFiles: job.progress.totalFiles || 0 } });
    };
    try {
      if (job.resourceTaskId) await this.resourceClient.wait(job.resourceTaskId, linked.signal);
      const result = await this.runSSH(logJobCommand(), {
        config: this.config, operation: { ...envelope, signal: linked.signal }, priority: "background",
        captureStdout: false, keepStdinOpen: true,
        resourceTaskId: job.resourceTaskId, taskType: "log_search",
        stdin: JSON.stringify({ type: "start", input: { ...job.query, deadlineAt: envelope.deadlineAt,
          resourceBudget: job.resourceBudget, resourceLeaseRequired: Boolean(job.resourceTaskId) } }) + "\n",
        onChannel: (channel) => {
          job.channel = channel;
          if (job.resourceTaskId) this.resourceClient.update(job.resourceTaskId, { status: "running", phase: "scanning" });
          if (job.requestedAction) channel.write(JSON.stringify({ type: job.requestedAction }) + "\n");
          heartbeat = setInterval(() => {
            if (!channel.destroyed && channel.writableLength < 4096) channel.write('{"type":"heartbeat"}\n');
          }, 10000);
          heartbeat.unref?.();
        },
        onStdoutChunk: (chunk) => {
          pending += decoder.write(chunk);
          let index;
          while ((index = pending.indexOf("\n")) >= 0) {
            if (Buffer.byteLength(pending.slice(0, index)) > 1024 * 1024) throw fault("oversized log job frame", "LOG_JOB_PROTOCOL", 502);
            const line = pending.slice(0, index); pending = pending.slice(index + 1);
            onFrame(JSON.parse(line));
          }
          if (Buffer.byteLength(pending) > 1024 * 1024) throw fault("oversized log job frame", "LOG_JOB_PROTOCOL", 502);
        },
      });
      if (!receivedFinal || pending || result.exitCode !== 0 && !job.error) throw fault("SSH log task ended without a complete result", "LOG_JOB_INTERRUPTED", 502);
      if (job.error) job.status = this.errorStatus(job.error.code);
      else { job.status = job.result.stopReason ? "stopped" : job.result.countsAreComplete ? "completed" : "partial"; job.progress = { ...job.result, records: undefined, groups: undefined, warnings: undefined }; job.evidence = []; }
    } catch (error) {
      // A terminal result is trusted only with a clean channel exit.
      job.result = undefined;
      job.error = { code: error.code || "LOG_JOB_FAILED", message: error.message };
      job.status = this.errorStatus(job.error.code);
    } finally {
      clearInterval(heartbeat); linked.cleanup(); job.channel = null;
      for (const pending of resourcePending.values()) pending.reject(); resourcePending.clear();
      for (const pending of job.controls.values()) pending.reject(fault("log task terminated before control acknowledgement", "LOG_JOB_NOT_RUNNING", 409));
      job.controls.clear();
      try {
        if (job.progress.currentFileProgress) this.storeReceipt(job, job.progress.currentFileProgress);
        for (const receipt of job.fileResults.values()) {
          if (receipt.status === "running") this.storeReceipt(job, { ...receipt, status: job.status, scanComplete: false, countsAreComplete: false, evidenceComplete: false, finishedAt: this.now(), error: job.error });
        }
      } catch (error) {
        job.status = "failed"; job.result = undefined;
        job.error = { code: error.code || "LOG_JOB_PROTOCOL", message: error.message };
      }
      job.progress = { ...job.progress, status: job.status, countsAreComplete: job.status === "completed" && job.result?.countsAreComplete === true };
      this.retain(job); job.requestedAction = undefined;
      if (job.resourceTaskId) this.resourceClient.update(job.resourceTaskId, { status: job.status, phase: "finished", usage: job.result?.resources || job.progress.resources || {} });
    }
  }
  errorStatus(code) {
    if (code === "LOG_JOB_CANCELLED" || code === "OPERATION_CANCELLED") return "cancelled";
    if (["LOG_JOB_PAUSE_EXPIRED", "LOG_JOB_TIMEOUT", "OPERATION_DEADLINE_EXCEEDED"].includes(code)) return "expired";
    if (["SSH_TRANSPORT_LOST", "LOG_JOB_INTERRUPTED", "LOG_JOB_CONTROLLER_LOST"].includes(code)) return "interrupted";
    return "failed";
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) if (!terminal.has(job.status)) this.control({ jobId: job.jobId, action: "cancel" });
    await Promise.allSettled([...this.activeJobs].map((job) => job.promise));
    for (const job of this.jobs.values()) clearTimeout(job.expiryTimer);
    this.jobs.clear();
  }
}
