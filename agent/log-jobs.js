import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { normalizeLogQuery } from "./log-query.js";
import { LOG_QUERY_RUNTIME_SOURCE, LOG_JOB_RUNTIME_SOURCE } from "./log-query-runtime-source.js";
import { createOperationController, operationError } from "./operation.js";
import { quotePosixArgument } from "./ssh.js";
import { logInputError, normalizeLogJobLimits } from "./log-policy.js";

export const LOG_JOB_DEFAULTS = Object.freeze({
  jobTimeoutMs: 30 * 60 * 1000, maxJobTimeoutMs: 120 * 60 * 1000,
  cpuPercent: 20, readBytesPerSecond: 2 * 1024 * 1024,
  processBytesPerSecond: 4 * 1024 * 1024, rssLimitBytes: 192 * 1024 * 1024,
  pauseTtlMs: 5 * 60 * 1000, batchScanBytes: 256 * 1024 * 1024,
});
const terminal = new Set(["completed", "partial", "failed", "cancelled", "interrupted", "expired"]);
const fault = (message, code, statusCode = 400) => operationError(message, { code, statusCode, layer: "logs", phase: "job" });
function bounded(value, fallback, min, max, field) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw logInputError(`invalid ${field}`, "INVALID_LOG_JOB");
  return value;
}
export function normalizeLogJob(input, config) {
  if (input.mode !== undefined && input.mode !== "search") throw logInputError("background queries support search only", "INVALID_LOG_JOB");
  if (input.fileOffset || input.memberOffset) throw logInputError("background queries start from the full selected scope", "INVALID_LOG_JOB");
  for (const key of ["maxScanBytes", "maxExpandedBytes", "maxFiles"]) {
    if (input[key] !== undefined) throw logInputError(`${key} is for synchronous queries; use task resource limits`, "INVALID_LOG_JOB");
  }
  const query = normalizeLogQuery({ ...input, mode: "search" }, config);
  const limits = normalizeLogJobLimits(config.logs?.jobLimits);
  const timeoutMax = Math.min(limits.maxJobTimeoutMs || LOG_JOB_DEFAULTS.maxJobTimeoutMs, LOG_JOB_DEFAULTS.maxJobTimeoutMs);
  return { ...query, background: true, fileOffset: 0, maxFiles: 5000,
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
  return "node --max-old-space-size=64 -e " + quotePosixArgument(`${LOG_QUERY_RUNTIME_SOURCE}\n${LOG_JOB_RUNTIME_SOURCE}\nrunRemoteLogJob();`);
}

export class LogJobRunner {
  constructor({ config, runSSH, now = Date.now }) {
    this.config = config; this.runSSH = runSSH; this.now = now;
    this.jobs = new Map(); this.active = null; this.closed = false;
    this.retentionMs = 30 * 60 * 1000;
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
  start(input) {
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
      progress: { matchedLines: 0, scannedBytes: 0, expandedBytes: 0, countsAreComplete: false } };
    this.jobs.set(job.jobId, job);
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
    return { jobId: job.jobId, status: job.status, createdAt: job.createdAt, startedAt: job.startedAt,
      finishedAt: job.finishedAt, expiresAt: job.finishedAt ? job.finishedAt + this.retentionMs : undefined,
      progress: job.progress, ...result, countsAreComplete: job.status === "completed" && result.countsAreComplete === true,
      records, hasMoreRecords: hasMore, nextOffset: hasMore ? offset + records.length : null,
      error: job.error, requestedAction: job.requestedAction,
      limits: { jobTimeoutMs: job.query.jobTimeoutMs, cpuPercent: job.query.cpuPercent,
        readBytesPerSecond: job.query.readBytesPerSecond, processBytesPerSecond: job.query.processBytesPerSecond,
        rssLimitBytes: job.query.rssLimitBytes, batchScanBytes: job.query.batchScanBytes } };
  }
  control(input) {
    const job = this.find(input.jobId);
    if (!["pause", "resume", "cancel"].includes(input.action)) throw fault("action must be pause, resume or cancel", "INVALID_LOG_JOB_ACTION");
    if (terminal.has(job.status)) return this.get(input);
    if (job.status === "queued") {
      if (input.action !== "cancel") throw fault("queued tasks can only be cancelled", "LOG_JOB_NOT_RUNNING", 409);
      job.status = "cancelled"; this.retain(job);
    } else {
      job.requestedAction = input.action;
      if (job.channel && !job.channel.destroyed) job.channel.write(JSON.stringify({ type: input.action }) + "\n");
      if (input.action === "cancel") job.controller.abort(fault("log query cancelled", "LOG_JOB_CANCELLED", 499));
    }
    return this.get({ jobId: job.jobId });
  }
  pump() {
    if (this.active || this.closed) return;
    const job = [...this.jobs.values()].find((item) => item.status === "queued");
    if (!job) return;
    this.active = job;
    job.promise = this.execute(job).finally(() => { this.active = null; this.pump(); });
  }
  async execute(job) {
    job.startedAt = this.now(); job.status = "running";
    const envelope = { operationId: job.jobId, deadlineAt: this.now() + job.query.jobTimeoutMs, timeoutMs: job.query.jobTimeoutMs };
    job.controller = new AbortController();
    const linked = createOperationController(envelope, job.controller.signal, { layer: "logs", deadlinePhase: "job" });
    const decoder = new StringDecoder("utf8");
    let pending = "", receivedFinal = false, heartbeat;
    const onFrame = (frame) => {
      if (receivedFinal) throw fault("duplicate terminal log frame", "LOG_JOB_PROTOCOL", 502);
      if (frame.type === "progress") {
        job.progress = frame;
        if (frame.status === "paused" || frame.status === "running") job.status = frame.status;
        if (job.requestedAction === "pause" && frame.status === "paused" || job.requestedAction === "resume" && frame.status === "running") job.requestedAction = undefined;
      } else if (frame.type === "evidence") {
        const bytes = Buffer.byteLength(JSON.stringify(frame.record));
        if (job.evidence.length >= job.query.limit || job.evidenceBytes + bytes > job.query.maxBytes) throw fault("log evidence budget exceeded", "LOG_JOB_PROTOCOL", 502);
        job.evidence.push(frame.record); job.evidenceBytes += bytes;
        job.progress = frame.progress;
      } else if (frame.type === "result") {
        receivedFinal = true; job.result = { ...frame.result, resources: frame.resources };
      } else if (frame.type === "error") {
        receivedFinal = true; job.progress = frame; job.error = frame.error;
      } else throw fault("unknown log job frame", "LOG_JOB_PROTOCOL", 502);
    };
    try {
      const result = await this.runSSH(logJobCommand(), {
        config: this.config, operation: { ...envelope, signal: linked.signal }, priority: "background",
        captureStdout: false, keepStdinOpen: true,
        stdin: JSON.stringify({ type: "start", input: { ...job.query, deadlineAt: envelope.deadlineAt } }) + "\n",
        onChannel: (channel) => {
          job.channel = channel;
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
      else { job.status = job.result.countsAreComplete ? "completed" : "partial"; job.progress = { ...job.result, records: undefined, groups: undefined, warnings: undefined }; job.evidence = []; }
    } catch (error) {
      // A terminal result is trusted only with a clean channel exit.
      job.result = undefined;
      job.error = { code: error.code || "LOG_JOB_FAILED", message: error.message };
      job.status = this.errorStatus(job.error.code);
    } finally {
      clearInterval(heartbeat); linked.cleanup(); job.channel = null;
      this.retain(job); job.requestedAction = undefined;
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
    await this.active?.promise;
    for (const job of this.jobs.values()) clearTimeout(job.expiryTimer);
    this.jobs.clear();
  }
}
