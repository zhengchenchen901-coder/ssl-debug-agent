import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { byteLength, createActivityLog, previewText } from "./activity.js";
import {
  assertApprovedCommandsEnabled,
  APPROVED_COMMAND_CONFIRMATION,
  createCommandDraftStore,
  redactCommand,
} from "./approved-commands.js";
import {
  inspectCommandDraft,
  isModelAutoApproval,
  manualReviewViolation,
  runCodexReview as defaultRunCodexReview,
} from "./command-review.js";
import {
  allowedPathsForSourceRoots,
  configFingerprint,
  loadConfig,
  publicSecurity,
  publicTarget,
} from "./config.js";
import { writeAuditLog } from "./audit.js";
import {
  assertPathAllowed,
  normalizeMaxBytes,
  securityCapabilities,
  validateCommand,
} from "./security.js";
import {
  normalizeMongoQuery,
  runMongoQuery as defaultRunMongoQuery,
  summarizeMongoQuery,
} from "./mongodb.js";
import {
  listLogArchiveMembers as defaultListLogArchiveMembers,
  listLogs as defaultListLogs,
  readLog as defaultReadLog,
} from "./logs.js";
import {
  normalizeArchiveMemberListOptions,
  normalizeLogListOptions,
  normalizeLogReadOptions,
} from "./log-policy.js";
import { InstanceRegistry } from "./instance-registry.js";
import { WorkerManager } from "./worker-manager.js";
import {
  API_VERSION,
  createOperationController,
  normalizeOperationEnvelope,
  operationError,
  operationErrorPayload,
  operationPolicy,
} from "./operation.js";
import {
  listRemoteDir as defaultListRemoteDir,
  readRemoteFile as defaultReadRemoteFile,
  resolveRemotePaths as defaultResolveRemotePaths,
  runSSH as defaultRunSSH,
} from "./ssh.js";

const moduleFilePath =
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
const moduleDirectory =
  typeof __dirname === "string" ? __dirname : path.dirname(moduleFilePath);
const DEFAULT_AGENT_LIFETIME = "manual";
const DESKTOP_AGENT_LIFETIME = "desktop";
const DEFAULT_MANAGER_LEASE_TTL_MS = 45_000;
const MIN_MANAGER_LEASE_TTL_MS = 10_000;
const MAX_MANAGER_LEASE_TTL_MS = 120_000;
const DEFAULT_MANAGER_LEASE_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_DESKTOP_STARTUP_GRACE_MS = 60_000;

function durationSince(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function errorStatus(error) {
  return Number.isInteger(error.statusCode) ? error.statusCode : 502;
}

function errorPayload(error) {
  return {
    ok: false,
    error: operationErrorPayload(error),
    details: error.details,
  };
}

function publicAgent(config) {
  return {
    host: config.agent.host,
    port: config.agent.port,
    pid: process.pid,
    configFingerprint: configFingerprint(config),
    runtimeId: config.runtime?.runtimeId || "development",
  };
}

async function writeRuntimeState(config, event) {
  const statePath = config.runtime?.statePath;
  if (!statePath) {
    return;
  }

  const state = {
    name: "remote-debug-agent",
    pid: process.pid,
    host: config.agent.host,
    port: config.agent.port,
    target: publicTarget(config),
    configFingerprint: configFingerprint(config),
    runtimeId: config.runtime?.runtimeId || "development",
    ...event,
    updatedAt: new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, statePath);
}

function requestText(value, maxChars = 256) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    return `[${typeof value}]`;
  }

  return previewText(value, maxChars);
}

function sourceFrom(request) {
  return requestText(request.get("x-remote-debug-source"), 80) || "http-api";
}

function createOperation(request, config, tool, requestPayload) {
  return {
    type: "interaction",
    operationId:
      requestPayload?.operationId || request.body?.operationId || randomUUID(),
    tool,
    source: sourceFrom(request),
    target: publicTarget(config),
    request: requestPayload,
  };
}

function createRequestOperation(request, response, pathName, config, layer = "worker") {
  const envelope = normalizeOperationEnvelope(
    request.body || {},
    operationPolicy(pathName, config),
  );
  const upstream = new AbortController();
  let cleaned = false;
  const abortUpstream = () => {
    if (!response.writableEnded && !upstream.signal.aborted) {
      upstream.abort(operationError("upstream request was cancelled", {
        code: "OPERATION_CANCELLED",
        statusCode: 499,
        operationId: envelope.operationId,
        layer,
        phase: "upstream-cancel",
      }));
    }
  };
  const controllerEnvelope = layer === "manager"
    ? { ...envelope, deadlineAt: envelope.deadlineAt + 2_000 }
    : envelope;
  const linked = createOperationController(controllerEnvelope, upstream.signal, {
    layer,
    deadlinePhase: "operation",
  });
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    request.off("aborted", abortUpstream);
    response.off("close", abortUpstream);
    linked.cleanup();
  };
  request.once("aborted", abortUpstream);
  response.once("close", abortUpstream);
  response.once("finish", cleanup);
  response.once("close", cleanup);
  return {
    ...envelope,
    signal: linked.signal,
    cleanup,
  };
}

function publishStage(activity, operation, stage, event = {}) {
  return activity.publish({
    ...operation,
    stage,
    ...event,
  });
}

function outputSummary(payload) {
  return {
    durationMs: payload.durationMs,
    exitCode: payload.exitCode,
    timedOut: payload.timedOut,
    stdoutLength: byteLength(payload.stdout),
    stderrLength: byteLength(payload.stderr),
    stdoutPreview: previewText(payload.stdout),
    stderrPreview: previewText(payload.stderr),
  };
}

function fileSummary(payload) {
  return {
    path: payload.path,
    durationMs: payload.durationMs,
    contentLength: byteLength(payload.content),
    contentPreview: previewText(payload.content),
    truncated: payload.truncated,
  };
}

function directorySummary(payload) {
  return {
    path: payload.path,
    durationMs: payload.durationMs,
    entryCount: payload.entries.length,
    entriesPreview: payload.entries.slice(0, 50),
  };
}

function logListSummary(payload) {
  return {
    category: payload.category,
    entryCount: payload.entries?.length || 0,
    hasMore: Boolean(payload.hasMore),
    truncated: Boolean(payload.truncated),
    scannedEntries: payload.scannedEntries,
    sourceCount: payload.sourceCount,
    warningCount: payload.warnings?.length || 0,
  };
}

function logArchiveSummary(payload) {
  return {
    path: payload.path,
    compression: payload.compression,
    memberCount: payload.members?.length || 0,
    hasMore: Boolean(payload.hasMore),
    truncated: Boolean(payload.truncated),
    scannedBytes: payload.scannedBytes,
  };
}

function logReadSummary(payload) {
  return {
    path: payload.path,
    memberPath: payload.memberPath,
    compression: payload.compression,
    contentLength: byteLength(payload.content),
    totalLines: payload.totalLines,
    matchedLines: payload.matchedLines,
    scannedBytes: payload.scannedBytes,
    archiveScannedBytes: payload.archiveScannedBytes,
    truncated: Boolean(payload.truncated),
  };
}

function mongoSummary(payload) {
  return {
    operation: payload.operation,
    database: payload.database,
    collection: payload.collection,
    resultCount: payload.resultCount,
    durationMs: payload.durationMs,
  };
}

function approvedDraftSummary(payload) {
  return {
    draftId: payload.draftId,
    purpose: payload.purpose,
    commandHash: payload.commandHash,
    commandCount: payload.commandCount,
    expiresAt: payload.expiresAt,
    status: payload.status,
  };
}

function approvedExecutionSummary(payload) {
  return {
    draftId: payload.draftId,
    commandHash: payload.commandHash,
    durationMs: payload.durationMs,
    commandCount: payload.results.length,
    stopped: payload.stopped,
    commandsOk: payload.commandsOk,
  };
}

function commandReviewViolationSummary(violations = []) {
  return violations.map((violation) => ({
    commandIndex: violation.commandIndex,
    code: violation.code,
    severity: violation.severity,
  }));
}

function commandReviewSummary(payload) {
  return {
    instanceId: payload.instanceId,
    draftId: payload.draftId,
    decision: payload.decision,
    staticViolationCount: payload.review?.staticViolations?.length || 0,
    violationCount: payload.review?.violations?.length || 0,
    violationCodes: commandReviewViolationSummary(payload.review?.violations),
    modelAttempts: payload.review?.model?.attempts,
    modelDurationMs: payload.review?.model?.durationMs,
    execution: payload.execution ? approvedExecutionSummary(payload.execution) : undefined,
  };
}

function commandAuditPreview(commands) {
  return commands.map((command, index) => `${index + 1}. ${redactCommand(command)}`).join("\n");
}

async function audit(config, event) {
  try {
    await writeAuditLog(config.audit.logPath, event);
  } catch (error) {
    console.error("failed to write audit log", error);
  }
}

export function createApp(options = {}) {
  const config = options.config || loadConfig();
  const sshSupervisor = options.sshSupervisor;
  const runSSHImpl = options.runSSH || defaultRunSSH;
  const readRemoteFileImpl = options.readRemoteFile || defaultReadRemoteFile;
  const listRemoteDirImpl = options.listRemoteDir || defaultListRemoteDir;
  const resolveRemotePathsImpl = options.resolveRemotePaths || defaultResolveRemotePaths;
  const runMongoQueryImpl = options.runMongoQuery || defaultRunMongoQuery;
  const listLogsImpl = options.listLogs || defaultListLogs;
  const listLogArchiveMembersImpl =
    options.listLogArchiveMembers || defaultListLogArchiveMembers;
  const readLogImpl = options.readLog || defaultReadLog;
  const runSSH = (command, operationOptions) =>
    runSSHImpl(command, { ...operationOptions, supervisor: sshSupervisor });
  const readRemoteFile = (remotePath, operationOptions) =>
    readRemoteFileImpl(remotePath, { ...operationOptions, supervisor: sshSupervisor });
  const listRemoteDir = (remotePath, operationOptions) =>
    listRemoteDirImpl(remotePath, { ...operationOptions, supervisor: sshSupervisor });
  const resolveRemotePaths = (remotePaths, operationOptions) =>
    resolveRemotePathsImpl(remotePaths, { ...operationOptions, supervisor: sshSupervisor });
  const runMongoQuery = (query, operationOptions) =>
    runMongoQueryImpl(query, {
      ...operationOptions,
      config,
      runSSH,
    });
  const listLogs = (logOptions) => listLogsImpl({
    ...logOptions,
    config,
    supervisor: sshSupervisor,
  });
  const listLogArchiveMembers = (logOptions) => listLogArchiveMembersImpl({
    ...logOptions,
    config,
    supervisor: sshSupervisor,
  });
  const readLog = (logOptions) => readLogImpl({
    ...logOptions,
    config,
    supervisor: sshSupervisor,
  });
  const customPathResolver = Boolean(options.resolveRemotePaths);
  const activity = options.activity || createActivityLog();
  const commandDraftStore = options.commandDraftStore || createCommandDraftStore();
  const app = express();
  const publicDir = path.join(moduleDirectory, "public");

  app.use(express.json({ limit: "512kb" }));

  app.get("/", (_request, response) => {
    response.sendFile(path.join(publicDir, "dashboard.html"));
  });

  app.get("/favicon.ico", (_request, response) => {
    response.status(204).end();
  });

  app.use(express.static(publicDir, { index: false, maxAge: 0 }));

  app.get("/health", (_request, response) => {
    response.json({ ok: true, name: "remote-debug-agent", apiVersion: API_VERSION });
  });

  app.get("/api/capabilities", (_request, response) => {
    response.json({ ok: true, capabilities: securityCapabilities(config) });
  });

  app.get("/status", (_request, response) => {
    response.json({
      ok: true,
      name: "remote-debug-agent",
      apiVersion: API_VERSION,
      agent: publicAgent(config),
      target: publicTarget(config),
      security: publicSecurity(config),
      recentEvents: activity.list().slice(-20),
    });
  });

  app.get("/events", (request, response) => {
    activity.stream(request, response);
  });

  app.post("/run", async (request, response) => {
    const startedAt = performance.now();
    const rawCmd = request.body?.cmd;
    const requestOperation = createRequestOperation(request, response, "/run", config);
    const operation = createOperation(request, config, "run", {
      operationId: requestOperation.operationId,
      cmd: requestText(rawCmd),
      timeoutMs: requestOperation.timeoutMs,
    });
    publishStage(activity, operation, "started");

    try {
      const validation = validateCommand(rawCmd, config.security);
      operation.request = {
        cmd: validation.normalizedCommand,
        timeoutMs: requestOperation.timeoutMs,
        deadlineAt: requestOperation.deadlineAt,
      };
      publishStage(activity, operation, "validated");

      if (customPathResolver && validation.absolutePaths.length > 0) {
        await resolveRemotePaths(validation.absolutePaths, {
          config,
          operation: requestOperation,
        });
      }
      const result = await runSSH(validation.normalizedCommand, {
        config,
        operation: requestOperation,
        remotePaths: customPathResolver ? [] : validation.absolutePaths,
        onStdout: (chunk) => {
          publishStage(activity, operation, "stdout", {
            chunk: previewText(String(chunk)),
          });
        },
        onStderr: (chunk) => {
          publishStage(activity, operation, "stderr", {
            chunk: previewText(String(chunk)),
          });
        },
      });
      const payload = {
        ok: true,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: durationSince(startedAt),
        timedOut: result.timedOut,
        operationId: requestOperation.operationId,
        timing: result.timing,
      };

      await audit(config, {
        tool: "run",
        cmd: validation.normalizedCommand,
        ok: true,
        durationMs: payload.durationMs,
        stdout: payload.stdout,
        stderr: payload.stderr,
        operationId: requestOperation.operationId,
        ...result.timing,
      });

      publishStage(activity, operation, "completed", {
        ok: true,
        ...result.timing,
        result: outputSummary(payload),
      });

      response.json(payload);
    } catch (error) {
      error.operationId ||= requestOperation.operationId;
      const payload = errorPayload(error);
      const durationMs = durationSince(startedAt);
      await audit(config, {
        tool: "run",
        cmd: typeof rawCmd === "string" ? rawCmd.slice(0, 256) : undefined,
        ok: false,
        durationMs,
        errorCode: payload.error.code,
        operationId: requestOperation.operationId,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
      });
      publishStage(activity, operation, "failed", {
        ok: false,
        durationMs,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
        error: payload.error,
      });
      response.status(errorStatus(error)).json({ ...payload, durationMs });
    }
  });

  app.post("/approved-command-drafts", async (request, response) => {
    const startedAt = performance.now();
    const rawPurpose = request.body?.purpose;
    const rawCommands = request.body?.commands;
    const operation = createOperation(request, config, "approved-command-draft", {
      purpose: requestText(rawPurpose),
      commandCount: Array.isArray(rawCommands) ? rawCommands.length : undefined,
    });
    publishStage(activity, operation, "started");

    try {
      assertApprovedCommandsEnabled(config);
      const draft = commandDraftStore.createDraft({
        purpose: rawPurpose,
        commands: rawCommands,
        settings: config.approvedCommands,
      });
      const payload = {
        ok: true,
        ...draft,
        durationMs: durationSince(startedAt),
      };

      await audit(config, {
        tool: "approved-command-draft",
        draftId: draft.draftId,
        commandHash: draft.commandHash,
        commandCount: draft.commandCount,
        commandPreview: commandAuditPreview(draft.commands),
        ok: true,
        durationMs: payload.durationMs,
      });

      publishStage(activity, operation, "completed", {
        ok: true,
        result: approvedDraftSummary(payload),
      });

      response.json(payload);
    } catch (error) {
      const payload = errorPayload(error);
      const durationMs = durationSince(startedAt);
      await audit(config, {
        tool: "approved-command-draft",
        ok: false,
        durationMs,
        errorCode: payload.error.code,
      });
      publishStage(activity, operation, "failed", {
        ok: false,
        durationMs,
        error: payload.error,
      });
      response.status(errorStatus(error)).json({ ...payload, durationMs });
    }
  });

  app.post("/approved-command-drafts/get", async (request, response) => {
    const startedAt = performance.now();
    const rawDraftId = request.body?.draftId;
    const operation = createOperation(request, config, "approved-command-draft", {
      draftId: requestText(rawDraftId),
    });
    publishStage(activity, operation, "started");

    try {
      assertApprovedCommandsEnabled(config);
      const draft = commandDraftStore.getDraft(rawDraftId);
      const payload = {
        ok: true,
        ...draft,
        durationMs: durationSince(startedAt),
      };

      publishStage(activity, operation, "completed", {
        ok: true,
        result: approvedDraftSummary(payload),
      });

      response.json(payload);
    } catch (error) {
      const payload = errorPayload(error);
      const durationMs = durationSince(startedAt);
      publishStage(activity, operation, "failed", {
        ok: false,
        durationMs,
        error: payload.error,
      });
      response.status(errorStatus(error)).json({ ...payload, durationMs });
    }
  });

  app.post("/approved-command-drafts/execute", async (request, response) => {
    const startedAt = performance.now();
    const rawDraftId = request.body?.draftId;
    const rawCommandHash = request.body?.commandHash;
    const requestOperation = createRequestOperation(
      request,
      response,
      "/approved-command-drafts/execute",
      config,
    );
    const operation = createOperation(request, config, "approved-command-execute", {
      operationId: requestOperation.operationId,
      draftId: requestText(rawDraftId),
      commandHash: requestText(rawCommandHash),
      timeoutMs: requestOperation.timeoutMs,
    });
    publishStage(activity, operation, "started");

    let claimedDraft;
    const results = [];
    try {
      assertApprovedCommandsEnabled(config);
      claimedDraft = commandDraftStore.claimDraft({
        draftId: rawDraftId,
        commandHash: rawCommandHash,
        confirmation: request.body?.confirmation,
      });
      operation.request = {
        draftId: claimedDraft.draftId,
        commandHash: claimedDraft.commandHash,
        commandCount: claimedDraft.commandCount,
        timeoutMs: requestOperation.timeoutMs,
        deadlineAt: requestOperation.deadlineAt,
      };
      publishStage(activity, operation, "validated");

      await audit(config, {
        tool: "approved-command-execute-start",
        draftId: claimedDraft.draftId,
        commandHash: claimedDraft.commandHash,
        commandCount: claimedDraft.commandCount,
        ok: true,
        durationMs: 0,
        operationId: requestOperation.operationId,
      });

      let stopped;
      for (const [index, command] of claimedDraft.commands.entries()) {
        publishStage(activity, operation, "command-started", {
          commandIndex: index,
          commandPreview: redactCommand(command),
        });
        const commandStartedAt = performance.now();
        const result = await runSSH(command, {
          config,
          operation: requestOperation,
          onStdout: (chunk) => {
            publishStage(activity, operation, "stdout", {
              commandIndex: index,
              chunk: previewText(String(chunk)),
            });
          },
          onStderr: (chunk) => {
            publishStage(activity, operation, "stderr", {
              commandIndex: index,
              chunk: previewText(String(chunk)),
            });
          },
        });
        const durationMs = durationSince(commandStartedAt);
        const commandOk = result.exitCode === 0 && !result.timedOut;
        const commandPayload = {
          command,
          commandIndex: index,
          commandPreview: redactCommand(command),
          durationMs,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          timing: result.timing,
        };
        results.push(commandPayload);
        publishStage(activity, operation, "command-completed", {
          ok: commandOk,
          commandIndex: index,
          ...result.timing,
        });

        await audit(config, {
          tool: "approved-command-execute",
          draftId: claimedDraft.draftId,
          commandHash: claimedDraft.commandHash,
          commandIndex: index,
          commandPreview: commandPayload.commandPreview,
          ok: commandOk,
          durationMs,
          stdout: commandPayload.stdout,
          stderr: commandPayload.stderr,
          errorCode: commandOk
            ? undefined
            : result.timedOut
              ? "APPROVED_COMMAND_TIMED_OUT"
              : "APPROVED_COMMAND_NON_ZERO_EXIT",
          operationId: requestOperation.operationId,
          ...result.timing,
        });

        if (!commandOk) {
          stopped = {
            commandIndex: index,
            reason: result.timedOut ? "timed_out" : "non_zero_exit",
            exitCode: result.exitCode,
          };
          break;
        }
      }

      const finalDraft = commandDraftStore.finishDraft(claimedDraft.draftId, "executed");
      const payload = {
        ok: true,
        commandsOk: !stopped,
        draftId: claimedDraft.draftId,
        commandHash: claimedDraft.commandHash,
        status: finalDraft?.status || "executed",
        executedAt: finalDraft?.executedAt,
        results,
        stopped,
        durationMs: durationSince(startedAt),
        operationId: requestOperation.operationId,
      };

      await audit(config, {
        tool: "approved-command-execute-complete",
        draftId: claimedDraft.draftId,
        commandHash: claimedDraft.commandHash,
        commandCount: results.length,
        ok: payload.commandsOk,
        durationMs: payload.durationMs,
        errorCode: stopped ? `STOPPED_${stopped.reason.toUpperCase()}` : undefined,
        operationId: requestOperation.operationId,
      });

      publishStage(activity, operation, "completed", {
        ok: payload.commandsOk,
        result: approvedExecutionSummary(payload),
      });

      response.json(payload);
    } catch (error) {
      error.operationId ||= requestOperation.operationId;
      error.details = {
        ...(error.details || {}),
        partialResults: results,
      };
      if (claimedDraft) {
        commandDraftStore.finishDraft(claimedDraft.draftId, "failed");
      }
      const payload = errorPayload(error);
      const durationMs = durationSince(startedAt);
      await audit(config, {
        tool: "approved-command-execute",
        draftId: claimedDraft?.draftId || (typeof rawDraftId === "string" ? rawDraftId : undefined),
        commandHash: claimedDraft?.commandHash || (typeof rawCommandHash === "string" ? rawCommandHash : undefined),
        ok: false,
        durationMs,
        errorCode: payload.error.code,
        operationId: requestOperation.operationId,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
      });
      publishStage(activity, operation, "failed", {
        ok: false,
        durationMs,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
        error: payload.error,
      });
      response.status(errorStatus(error)).json({ ...payload, durationMs });
    }
  });

  app.post("/read-file", async (request, response) => {
    const startedAt = performance.now();
    const rawPath = request.body?.path;
    const requestOperation = createRequestOperation(request, response, "/read-file", config);
    const operation = createOperation(request, config, "read-file", {
      operationId: requestOperation.operationId,
      path: requestText(rawPath),
      maxBytes: request.body?.maxBytes,
      timeoutMs: requestOperation.timeoutMs,
    });
    publishStage(activity, operation, "started");

    try {
      const requestedPath = assertPathAllowed(rawPath, config.security.allowedPaths);
      const maxBytes = normalizeMaxBytes(request.body?.maxBytes, config.security);
      operation.request = {
        path: requestedPath,
        maxBytes,
        timeoutMs: requestOperation.timeoutMs,
        deadlineAt: requestOperation.deadlineAt,
      };
      publishStage(activity, operation, "validated");

      const result = await readRemoteFile(requestedPath, {
        config,
        maxBytes,
        operation: requestOperation,
      });
      const payload = {
        ok: true,
        path: result.path,
        content: result.content,
        truncated: result.truncated,
        durationMs: durationSince(startedAt),
        operationId: requestOperation.operationId,
        timing: result.timing,
      };

      await audit(config, {
        tool: "read-file",
        path: result.path,
        ok: true,
        durationMs: payload.durationMs,
        content: payload.content,
        operationId: requestOperation.operationId,
        ...result.timing,
      });

      publishStage(activity, operation, "completed", {
        ok: true,
        ...result.timing,
        result: fileSummary(payload),
      });

      response.json(payload);
    } catch (error) {
      error.operationId ||= requestOperation.operationId;
      const payload = errorPayload(error);
      const durationMs = durationSince(startedAt);
      await audit(config, {
        tool: "read-file",
        path: typeof rawPath === "string" ? rawPath.slice(0, 256) : undefined,
        ok: false,
        durationMs,
        errorCode: payload.error.code,
        operationId: requestOperation.operationId,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
      });
      publishStage(activity, operation, "failed", {
        ok: false,
        durationMs,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
        error: payload.error,
      });
      response.status(errorStatus(error)).json({ ...payload, durationMs });
    }
  });

  app.post("/list-dir", async (request, response) => {
    const startedAt = performance.now();
    const rawPath = request.body?.path;
    const requestOperation = createRequestOperation(request, response, "/list-dir", config);
    const operation = createOperation(request, config, "list-dir", {
      operationId: requestOperation.operationId,
      path: requestText(rawPath),
      timeoutMs: requestOperation.timeoutMs,
    });
    publishStage(activity, operation, "started");

    try {
      const requestedPath = assertPathAllowed(rawPath, config.security.allowedPaths);
      operation.request = {
        path: requestedPath,
        timeoutMs: requestOperation.timeoutMs,
        deadlineAt: requestOperation.deadlineAt,
      };
      publishStage(activity, operation, "validated");

      const result = await listRemoteDir(requestedPath, {
        config,
        operation: requestOperation,
      });
      const payload = {
        ok: true,
        path: result.path,
        entries: result.entries,
        durationMs: durationSince(startedAt),
        operationId: requestOperation.operationId,
        timing: result.timing,
      };

      await audit(config, {
        tool: "list-dir",
        path: result.path,
        ok: true,
        durationMs: payload.durationMs,
        contentLength: JSON.stringify(payload.entries).length,
        operationId: requestOperation.operationId,
        ...result.timing,
      });

      publishStage(activity, operation, "completed", {
        ok: true,
        ...result.timing,
        result: directorySummary(payload),
      });

      response.json(payload);
    } catch (error) {
      error.operationId ||= requestOperation.operationId;
      const payload = errorPayload(error);
      const durationMs = durationSince(startedAt);
      await audit(config, {
        tool: "list-dir",
        path: typeof rawPath === "string" ? rawPath.slice(0, 256) : undefined,
        ok: false,
        durationMs,
        errorCode: payload.error.code,
        operationId: requestOperation.operationId,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
      });
      publishStage(activity, operation, "failed", {
        ok: false,
        durationMs,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
        error: payload.error,
      });
      response.status(errorStatus(error)).json({ ...payload, durationMs });
    }
  });

  app.post("/logs/list", async (request, response) => {
    const startedAt = performance.now();
    const requestOperation = createRequestOperation(request, response, "/logs/list", config);
    const operation = createOperation(request, config, "logs-list", {
      operationId: requestOperation.operationId,
      category: requestText(request.body?.category),
      limit: request.body?.limit,
      cursor: requestText(request.body?.cursor, 128),
      timeoutMs: requestOperation.timeoutMs,
    });
    publishStage(activity, operation, "started");

    try {
      const normalized = normalizeLogListOptions(request.body || {});
      operation.request = {
        ...normalized,
        timeoutMs: requestOperation.timeoutMs,
        deadlineAt: requestOperation.deadlineAt,
      };
      publishStage(activity, operation, "validated");
      const result = await listLogs({
        ...normalized,
        operation: requestOperation,
      });
      const payload = {
        ok: true,
        category: normalized.category,
        ...result,
        durationMs: durationSince(startedAt),
        operationId: requestOperation.operationId,
        timing: result.timing,
      };

      await audit(config, {
        tool: "logs-list",
        category: normalized.category,
        entryCount: payload.entries.length,
        hasMore: payload.hasMore,
        truncated: payload.truncated,
        scannedEntries: payload.scannedEntries,
        sourceCount: payload.sourceCount,
        warningCount: payload.warnings?.length || 0,
        ok: true,
        durationMs: payload.durationMs,
        operationId: requestOperation.operationId,
        ...result.timing,
      });

      publishStage(activity, operation, "completed", {
        ok: true,
        ...result.timing,
        result: logListSummary(payload),
      });
      response.json(payload);
    } catch (error) {
      error.operationId ||= requestOperation.operationId;
      const payload = errorPayload(error);
      const durationMs = durationSince(startedAt);
      await audit(config, {
        tool: "logs-list",
        category: requestText(request.body?.category),
        ok: false,
        durationMs,
        errorCode: payload.error.code,
        operationId: requestOperation.operationId,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
      });
      publishStage(activity, operation, "failed", {
        ok: false,
        durationMs,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
        error: payload.error,
      });
      response.status(errorStatus(error)).json({ ...payload, durationMs });
    }
  });

  app.post("/logs/archive-members", async (request, response) => {
    const startedAt = performance.now();
    const requestOperation = createRequestOperation(
      request,
      response,
      "/logs/archive-members",
      config,
    );
    const operation = createOperation(request, config, "logs-archive-members", {
      operationId: requestOperation.operationId,
      path: requestText(request.body?.path),
      prefix: requestText(request.body?.prefix, 128),
      limit: request.body?.limit,
      cursor: requestText(request.body?.cursor, 128),
      timeoutMs: requestOperation.timeoutMs,
    });
    publishStage(activity, operation, "started");

    try {
      const normalized = normalizeArchiveMemberListOptions(request.body || {});
      operation.request = {
        ...normalized,
        timeoutMs: requestOperation.timeoutMs,
        deadlineAt: requestOperation.deadlineAt,
      };
      publishStage(activity, operation, "validated");
      const result = await listLogArchiveMembers({
        ...normalized,
        operation: requestOperation,
      });
      const payload = {
        ok: true,
        ...result,
        durationMs: durationSince(startedAt),
        operationId: requestOperation.operationId,
        timing: result.timing,
      };

      await audit(config, {
        tool: "logs-archive-members",
        path: result.path,
        compression: result.compression,
        memberCount: payload.members.length,
        hasMore: payload.hasMore,
        truncated: payload.truncated,
        scannedBytes: payload.scannedBytes,
        ok: true,
        durationMs: payload.durationMs,
        operationId: requestOperation.operationId,
        ...result.timing,
      });

      publishStage(activity, operation, "completed", {
        ok: true,
        ...result.timing,
        result: logArchiveSummary(payload),
      });
      response.json(payload);
    } catch (error) {
      error.operationId ||= requestOperation.operationId;
      const payload = errorPayload(error);
      const durationMs = durationSince(startedAt);
      await audit(config, {
        tool: "logs-archive-members",
        path: requestText(request.body?.path),
        ok: false,
        durationMs,
        errorCode: payload.error.code,
        operationId: requestOperation.operationId,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
      });
      publishStage(activity, operation, "failed", {
        ok: false,
        durationMs,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
        error: payload.error,
      });
      response.status(errorStatus(error)).json({ ...payload, durationMs });
    }
  });

  app.post("/logs/read", async (request, response) => {
    const startedAt = performance.now();
    const requestOperation = createRequestOperation(request, response, "/logs/read", config);
    const operation = createOperation(request, config, "logs-read", {
      operationId: requestOperation.operationId,
      path: requestText(request.body?.path),
      memberPath: requestText(request.body?.memberPath, 128),
      tailLines: request.body?.tailLines,
      maxBytes: request.body?.maxBytes,
      contains: requestText(request.body?.contains, 128),
      caseSensitive: request.body?.caseSensitive === true,
      timeoutMs: requestOperation.timeoutMs,
    });
    publishStage(activity, operation, "started");

    try {
      const normalized = normalizeLogReadOptions(request.body || {});
      operation.request = {
        ...normalized,
        timeoutMs: requestOperation.timeoutMs,
        deadlineAt: requestOperation.deadlineAt,
      };
      publishStage(activity, operation, "validated");
      const result = await readLog({
        ...normalized,
        operation: requestOperation,
      });
      const payload = {
        ok: true,
        ...result,
        durationMs: durationSince(startedAt),
        operationId: requestOperation.operationId,
        timing: result.timing,
      };

      await audit(config, {
        tool: "logs-read",
        path: result.path,
        memberPath: result.memberPath,
        compression: result.compression,
        contentLength: byteLength(result.content),
        totalLines: result.totalLines,
        matchedLines: result.matchedLines,
        scannedBytes: result.scannedBytes,
        archiveScannedBytes: result.archiveScannedBytes,
        truncated: result.truncated,
        scannedTruncated: result.scannedTruncated,
        ok: true,
        durationMs: payload.durationMs,
        operationId: requestOperation.operationId,
        ...result.timing,
      });

      publishStage(activity, operation, "completed", {
        ok: true,
        ...result.timing,
        result: logReadSummary(payload),
      });
      response.json(payload);
    } catch (error) {
      error.operationId ||= requestOperation.operationId;
      const payload = errorPayload(error);
      const durationMs = durationSince(startedAt);
      await audit(config, {
        tool: "logs-read",
        path: requestText(request.body?.path),
        memberPath: requestText(request.body?.memberPath, 128),
        ok: false,
        durationMs,
        errorCode: payload.error.code,
        operationId: requestOperation.operationId,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
      });
      publishStage(activity, operation, "failed", {
        ok: false,
        durationMs,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
        error: payload.error,
      });
      response.status(errorStatus(error)).json({ ...payload, durationMs });
    }
  });

  app.post("/mongodb/query", async (request, response) => {
    const startedAt = performance.now();
    const rawQuery = request.body || {};
    const requestOperation = createRequestOperation(request, response, "/mongodb/query", config);
    const operation = createOperation(request, config, "mongodb-query", {
      operationId: requestOperation.operationId,
      ...summarizeMongoQuery(rawQuery),
      timeoutMs: requestOperation.timeoutMs,
    });
    publishStage(activity, operation, "started");

    try {
      const query = normalizeMongoQuery(rawQuery, config.mongodb);
      operation.request = {
        ...summarizeMongoQuery(query),
        timeoutMs: requestOperation.timeoutMs,
        deadlineAt: requestOperation.deadlineAt,
      };
      publishStage(activity, operation, "validated");

      const result = await runMongoQuery(query, {
        operation: requestOperation,
      });
      const payload = {
        ok: true,
        operation: result.operation,
        database: result.database,
        collection: result.collection,
        data: result.data,
        resultCount: result.resultCount,
        durationMs: durationSince(startedAt),
        operationId: requestOperation.operationId,
        timing: result.timing,
      };

      await audit(config, {
        tool: "mongodb-query",
        operation: payload.operation,
        database: payload.database,
        collection: payload.collection,
        resultCount: payload.resultCount,
        ok: true,
        durationMs: payload.durationMs,
        operationId: requestOperation.operationId,
        ...result.timing,
      });

      publishStage(activity, operation, "completed", {
        ok: true,
        ...result.timing,
        result: mongoSummary(payload),
      });

      response.json(payload);
    } catch (error) {
      error.operationId ||= requestOperation.operationId;
      const payload = errorPayload(error);
      const durationMs = durationSince(startedAt);
      const summary = summarizeMongoQuery(rawQuery);
      await audit(config, {
        tool: "mongodb-query",
        operation: summary.operation,
        database: summary.database,
        collection: summary.collection,
        ok: false,
        durationMs,
        errorCode: payload.error.code,
        operationId: requestOperation.operationId,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
      });
      publishStage(activity, operation, "failed", {
        ok: false,
        durationMs,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
        error: payload.error,
      });
      response.status(errorStatus(error)).json({ ...payload, durationMs });
    }
  });

  return app;
}

function managerErrorPayload(error) {
  return {
    ok: false,
    error: operationErrorPayload(error, {
      code: "REMOTE_DEBUG_MANAGER_ERROR",
      message: "remote debug manager operation failed",
      layer: "manager",
    }),
    instances: error.instances,
    details: error.payload || error.details,
  };
}

function respondManagerError(response, error) {
  response.status(error.statusCode || error.status || 500).json(managerErrorPayload(error));
}

function managerRouteError(message, code, statusCode = 500, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function normalizeAgentLifetime(value) {
  return value === DESKTOP_AGENT_LIFETIME ? DESKTOP_AGENT_LIFETIME : DEFAULT_AGENT_LIFETIME;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  const normalized = Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(max, Math.max(min, normalized));
}

function publicLease(lease) {
  return {
    clientId: lease.clientId,
    ttlMs: lease.ttlMs,
    source: lease.source,
    pid: lease.pid,
    expiresAt: new Date(lease.expiresAt).toISOString(),
  };
}

export function createManagerLifecycle(options = {}) {
  const lifetime = normalizeAgentLifetime(options.lifetime);
  const leases = new Map();
  const now = options.now || (() => Date.now());
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const requestShutdown = options.requestShutdown || (() => Promise.resolve());
  const startupGraceMs = clampNumber(
    options.startupGraceMs,
    DEFAULT_DESKTOP_STARTUP_GRACE_MS,
    0,
    MAX_MANAGER_LEASE_TTL_MS,
  );
  const checkIntervalMs = clampNumber(
    options.checkIntervalMs,
    DEFAULT_MANAGER_LEASE_CHECK_INTERVAL_MS,
    1,
    MAX_MANAGER_LEASE_TTL_MS,
  );
  const minLeaseTtlMs = clampNumber(
    options.minLeaseTtlMs,
    MIN_MANAGER_LEASE_TTL_MS,
    1,
    MAX_MANAGER_LEASE_TTL_MS,
  );
  const maxLeaseTtlMs = clampNumber(
    options.maxLeaseTtlMs,
    MAX_MANAGER_LEASE_TTL_MS,
    minLeaseTtlMs,
    MAX_MANAGER_LEASE_TTL_MS,
  );
  const startupDeadline = now() + startupGraceMs;
  let timer = null;
  let hadLease = false;
  let shuttingDown = false;

  function pruneExpiredLeases() {
    const current = now();
    for (const [clientId, lease] of leases.entries()) {
      if (lease.expiresAt <= current) {
        leases.delete(clientId);
      }
    }
  }

  function activeLeaseCount() {
    pruneExpiredLeases();
    return leases.size;
  }

  function publicStatus() {
    return {
      lifetime,
      activeLeaseCount: activeLeaseCount(),
    };
  }

  async function checkLeases() {
    if (lifetime !== DESKTOP_AGENT_LIFETIME || shuttingDown) {
      return;
    }

    const activeCount = activeLeaseCount();
    if (activeCount > 0) {
      return;
    }

    if (!hadLease && now() < startupDeadline) {
      return;
    }

    shuttingDown = true;
    stop();
    await requestShutdown(hadLease ? "lease-expired" : "lease-missing");
  }

  function start() {
    if (lifetime !== DESKTOP_AGENT_LIFETIME || timer) {
      return;
    }

    timer = setIntervalFn(() => {
      checkLeases().catch((error) => {
        console.error("failed to check manager leases", error);
      });
    }, checkIntervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  function registerLease(payload = {}) {
    const clientId = typeof payload.clientId === "string" ? payload.clientId.trim() : "";
    if (!clientId) {
      throw managerRouteError("lease clientId is required", "LEASE_CLIENT_ID_REQUIRED", 400);
    }

    const ttlMs = clampNumber(
      payload.ttlMs,
      DEFAULT_MANAGER_LEASE_TTL_MS,
      minLeaseTtlMs,
      maxLeaseTtlMs,
    );
    const lease = {
      clientId,
      ttlMs,
      source: requestText(payload.source, 80) || "unknown",
      pid: Number.isInteger(payload.pid) ? payload.pid : null,
      expiresAt: now() + ttlMs,
    };

    leases.set(clientId, lease);
    hadLease = true;
    return publicLease(lease);
  }

  function releaseLease(clientId) {
    return leases.delete(clientId);
  }

  start();

  return {
    checkLeases,
    publicStatus,
    registerLease,
    releaseLease,
    stop,
  };
}

function managerPublicStatus(config, workerManager, registry, lifecycle) {
  return {
    ok: true,
    name: "remote-debug-agent",
    apiVersion: API_VERSION,
    mode: "manager",
    capabilities: {
      persistentSsh: true,
      operationDeadlines: true,
      cancellation: true,
      structuredHealth: true,
      logs: true,
    },
    agent: {
      ...publicAgent(config),
      role: "manager",
    },
    manager: {
      defaultInstanceId: registry.registry.defaultInstanceId,
      registryPath: registry.registryPath,
      worker: registry.managerConfig(),
    },
    target: publicTarget(config),
    security: publicSecurity(config),
    lifecycle: lifecycle.publicStatus(),
    instances: workerManager.publicInstances(),
  };
}

function managerPathCapabilities(config, registry) {
  const capabilities = securityCapabilities(config);
  capabilities.paths.byInstance = Object.fromEntries(
    registry.listInternal().map((instance) => {
      const sourceRoots = { ...(instance.sourceRoots || {}) };
      return [instance.id, {
        sourceRoots,
        allowedRoots: allowedPathsForSourceRoots(sourceRoots),
      }];
    }),
  );
  return capabilities;
}

function managerAsync(handler) {
  return (request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      respondManagerError(response, error);
    });
  };
}

function bodyWithoutInstanceId(body = {}) {
  const { instanceId, ...payload } = body || {};
  return payload;
}

export function createManagerApp(options = {}) {
  const config = options.config || loadConfig();
  const registry =
    options.registry ||
    new InstanceRegistry({
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      managerPort: config.agent.port,
      registryPath: options.registryPath,
    });
  const workerManager =
    options.workerManager ||
    new WorkerManager({
      registry,
      managerPort: config.agent.port,
      cwd: options.cwd || process.cwd(),
      workerEntryPath: options.workerEntryPath,
      forkWorker: options.forkWorker,
      fetchImpl: options.fetchImpl,
    });
  const commandReviewConfig =
    options.commandReviewConfig || config.commandReview || { status: "unavailable" };
  const runCodexReview = options.runCodexReview || defaultRunCodexReview;
  const activity = options.activity || createActivityLog();
  const shutdownController = options.shutdownController || {};
  const lifecycle =
    options.lifecycle ||
    createManagerLifecycle({
      lifetime: config.lifecycle?.lifetime,
      requestShutdown: (reason) => shutdownController.request?.(reason),
      ...options.lifecycleOptions,
    });
  const app = express();
  const publicDir = path.join(moduleDirectory, "public");
  let commandReviewInFlight = false;

  app.locals.registry = registry;
  app.locals.workerManager = workerManager;
  app.locals.lifecycle = lifecycle;
  app.use(express.json({ limit: "512kb" }));
  let restoreCheckScheduled = false;

  app.get("/", (_request, response) => {
    response.sendFile(path.join(publicDir, "dashboard.html"));
  });

  app.get("/favicon.ico", (_request, response) => {
    response.status(204).end();
  });

  app.use(express.static(publicDir, { index: false, maxAge: 0 }));

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      name: "remote-debug-agent",
      apiVersion: API_VERSION,
      mode: "manager",
    });
  });

  app.get("/status", (_request, response) => {
    response.json({
      ...managerPublicStatus(config, workerManager, registry, lifecycle),
      recentEvents: activity.list().slice(-20),
    });
  });

  app.get("/events", (request, response) => {
    activity.stream(request, response);
  });

  app.get("/api/instances", (_request, response) => {
    response.json({
      ok: true,
      defaultInstanceId: registry.registry.defaultInstanceId,
      manager: registry.managerConfig(),
      lifecycle: lifecycle.publicStatus(),
      instances: workerManager.publicInstances(),
    });
  });

  function scheduleRestoreInstancesAfterLease(lease) {
    if (typeof workerManager.restoreInstancesFromSnapshot !== "function") {
      return;
    }
    if (restoreCheckScheduled) {
      return;
    }
    restoreCheckScheduled = true;

    setImmediate(() => {
      workerManager.restoreInstancesFromSnapshot().then((result) => {
        const restored = result.restored || [];
        const skipped = result.skipped || [];
        const failed = result.failed || [];
        const diagnostic = result.diagnostic || { status: "unknown" };

        activity.publish({
          type: "lifecycle",
          stage: restored.length > 0 || skipped.length > 0 || failed.length > 0
            ? "instances-restored"
            : "instances-restore-checked",
          clientId: lease.clientId,
          restored,
          skipped,
          failed,
          diagnostic,
        });
      }).catch((error) => {
        console.error("failed to restore manager instances", error);
        activity.publish({
          type: "lifecycle",
          stage: "restore-failed",
          clientId: lease.clientId,
          error: {
            code: error.code || "INSTANCE_RESTORE_FAILED",
            message: error.message || "failed to restore manager instances",
          },
        });
      });
    });
  }

  app.post("/api/leases", managerAsync(async (request, response) => {
    const lease = lifecycle.registerLease(request.body || {});
    activity.publish({ type: "lifecycle", stage: "lease-renewed", clientId: lease.clientId });
    scheduleRestoreInstancesAfterLease(lease);
    response.json({
      ok: true,
      lease,
      lifecycle: lifecycle.publicStatus(),
    });
  }));

  app.delete("/api/leases/:clientId", managerAsync(async (request, response) => {
    const released = lifecycle.releaseLease(request.params.clientId);
    activity.publish({
      type: "lifecycle",
      stage: released ? "lease-released" : "lease-missing",
      clientId: request.params.clientId,
    });
    response.json({
      ok: true,
      released,
      lifecycle: lifecycle.publicStatus(),
    });
  }));

  app.post("/api/shutdown", managerAsync(async (_request, response) => {
    if (lifecycle.publicStatus().lifetime !== DEFAULT_AGENT_LIFETIME) {
      throw managerRouteError(
        "manager lifecycle is controlled by Codex Desktop",
        "LIFECYCLE_MANAGED_BY_CODEX",
        409,
      );
    }

    response.status(202).json({ ok: true, status: "shutting-down" });
    setImmediate(() => {
      shutdownController.request?.("manual-api")?.catch((error) => {
        console.error("failed to shut down manager", error);
      });
    });
  }));

  app.post("/api/instances", managerAsync(async (request, response) => {
    const instance = registry.create(request.body || {});
    activity.publish({ type: "instance", stage: "created", instanceId: instance.id });
    response.status(201).json({
      ok: true,
      instance,
      runtime: workerManager.runtimeFor(instance.id),
    });
  }));

  app.put("/api/instances/:id", managerAsync(async (request, response) => {
    const instance = registry.update(request.params.id, request.body || {});
    activity.publish({ type: "instance", stage: "updated", instanceId: instance.id });
    response.json({
      ok: true,
      instance,
      runtime: workerManager.runtimeFor(instance.id),
    });
  }));

  app.delete("/api/instances/:id", managerAsync(async (request, response) => {
    const instance = await workerManager.deleteInstance(request.params.id);
    activity.publish({ type: "instance", stage: "deleted", instanceId: instance.id });
    response.json({ ok: true, instance });
  }));

  app.post("/api/instances/:id/start", managerAsync(async (request, response) => {
    const result = await workerManager.startInstance(request.params.id);
    activity.publish({ type: "instance", stage: "started", instanceId: request.params.id });
    response.json({ ok: true, ...result });
  }));

  app.post("/api/instances/:id/refresh", managerAsync(async (request, response) => {
    const result = await workerManager.refreshInstance(request.params.id);
    activity.publish({ type: "instance", stage: "refreshed", instanceId: request.params.id });
    response.json({ ok: true, ...result });
  }));

  app.post("/api/instances/:id/restart", managerAsync(async (request, response) => {
    const result = await workerManager.restartInstance(request.params.id);
    activity.publish({
      type: "instance",
      stage: result.restarted ? "restarted" : "restart-not-needed",
      instanceId: request.params.id,
      previousStatus: result.previousStatus,
    });
    response.json({ ok: true, ...result });
  }));

  app.post("/api/instances/:id/stop", managerAsync(async (request, response) => {
    const result = await workerManager.stopInstance(request.params.id, "stopped");
    activity.publish({ type: "instance", stage: "stopped", instanceId: request.params.id });
    response.json({ ok: true, ...result });
  }));

  app.post("/api/instances/:id/pause", (_request, response) => {
    response.status(501).json({
      ok: false,
      error: {
        code: "NOT_IMPLEMENTED",
        message: "pause is reserved for a later release",
      },
    });
  });

  app.get("/api/capabilities", (_request, response) => {
    response.json({ ok: true, capabilities: managerPathCapabilities(config, registry) });
  });

  app.post("/approved-command-drafts/review", async (request, response) => {
    const startedAt = performance.now();
    const rawDraftId = request.body?.draftId;
    const rawInstanceId = request.body?.instanceId;
    const requestOperation = createRequestOperation(
      request,
      response,
      "/approved-command-drafts/review",
      config,
      "manager",
    );
    const operation = createOperation(request, config, "approved-command-review", {
      operationId: requestOperation.operationId,
      instanceId: requestText(rawInstanceId),
      draftId: requestText(rawDraftId),
      timeoutMs: requestOperation.timeoutMs,
    });
    publishStage(activity, operation, "started");

    let instanceId;
    let draft;
    let staticReview;
    let modelResult;
    let reviewClaimed = false;

    const responseForReview = ({
      decision,
      reason,
      violations = [],
      model,
      execution,
    }) => ({
      ok: true,
      instanceId,
      decision,
      draftId: draft?.draftId,
      purpose: draft?.purpose,
      commands: draft?.commands,
      commandBlock: draft?.commandBlock,
      commandHash: draft?.commandHash,
      expiresAt: draft?.expiresAt,
      draft,
      review: {
        reason,
        staticViolations: staticReview?.violations || [],
        violations,
        model,
      },
      execution,
      durationMs: durationSince(startedAt),
      operationId: requestOperation.operationId,
    });

    const completeReview = async (payload) => {
      await audit(config, {
        tool: "approved-command-review",
        instanceId,
        draftId: payload.draftId,
        commandHash: payload.commandHash,
        commandCount: payload.commands?.length,
        decision: payload.decision,
        reviewReason: payload.review?.reason,
        staticViolationCodes: commandReviewViolationSummary(payload.review?.staticViolations),
        violationCodes: commandReviewViolationSummary(payload.review?.violations),
        modelDecision: payload.review?.model?.decision,
        modelAttempts: payload.review?.model?.attempts,
        modelDurationMs: payload.review?.model?.durationMs,
        execution: payload.execution ? approvedExecutionSummary(payload.execution) : undefined,
        ok: true,
        durationMs: payload.durationMs,
        operationId: requestOperation.operationId,
      });
      publishStage(activity, operation, "completed", {
        ...commandReviewSummary(payload),
        durationMs: payload.durationMs,
      });
      response.json(payload);
    };

    try {
      instanceId = registry.resolveId(rawInstanceId);
      const instance = registry.getInternal(instanceId);
      assertApprovedCommandsEnabled({ approvedCommands: instance?.approvedCommands });
      if (commandReviewInFlight) {
        throw managerRouteError(
          "another command draft review is already in progress",
          "COMMAND_REVIEW_BUSY",
          429,
        );
      }
      commandReviewInFlight = true;
      reviewClaimed = true;

      draft = await workerManager.callInstance(
        instanceId,
        "/approved-command-drafts/get",
        {
          draftId: rawDraftId,
          operationId: requestOperation.operationId,
          timeoutMs: requestOperation.timeoutMs,
          deadlineAt: requestOperation.deadlineAt,
        },
        request.headers,
        { signal: requestOperation.signal },
      );
      staticReview = inspectCommandDraft(draft.commands, config.security);
      operation.request = {
        operationId: requestOperation.operationId,
        instanceId,
        draftId: draft.draftId,
        commandHash: draft.commandHash,
        commandCount: draft.commandCount,
        timeoutMs: requestOperation.timeoutMs,
        deadlineAt: requestOperation.deadlineAt,
      };
      publishStage(activity, operation, "static-reviewed", {
        eligible: staticReview.eligible,
        violations: commandReviewViolationSummary(staticReview.violations),
      });

      if (!staticReview.eligible) {
        await completeReview(responseForReview({
          decision: "manual_review",
          reason: "static_policy_rejected",
          violations: staticReview.violations,
        }));
        return;
      }

      if (!commandReviewConfig.autoExecuteEnabled) {
        const violation = manualReviewViolation(
          "COMMAND_REVIEW_AUTO_EXECUTION_DISABLED",
          "自动审核开关未启用，必须由人工确认后执行。",
          {
            severity: "medium",
            rule: "自动执行必须同时启用现有 approved command 开关和草稿审核开关",
          },
        );
        await completeReview(responseForReview({
          decision: "manual_review",
          reason: "auto_execution_disabled",
          violations: [violation],
        }));
        return;
      }

      if (commandReviewConfig.status !== "ready") {
        const violation = manualReviewViolation(
          commandReviewConfig.error?.code || "COMMAND_REVIEW_CONFIG_UNAVAILABLE",
          commandReviewConfig.error?.message || "Codex 审核配置不可用。",
          {
            severity: "high",
            rule: "自动执行必须使用有效的 Codex 审核配置",
          },
        );
        await completeReview(responseForReview({
          decision: "manual_review",
          reason: "review_config_unavailable",
          violations: [violation],
          model: {
            status: "unavailable",
            errorCode: commandReviewConfig.error?.code || "COMMAND_REVIEW_CONFIG_UNAVAILABLE",
          },
        }));
        return;
      }

      try {
        modelResult = await runCodexReview({
          draft,
          config: commandReviewConfig,
          staticReview,
          signal: requestOperation.signal,
          options: options.commandReviewOptions,
        });
      } catch (error) {
        if (["OPERATION_CANCELLED", "OPERATION_DEADLINE_EXCEEDED", "COMMAND_REVIEW_CANCELLED"].includes(error.code)) {
          throw error;
        }
        const violation = manualReviewViolation(
          error.code || "COMMAND_REVIEW_MODEL_UNAVAILABLE",
          error.message || "Codex 审核没有返回可用结果。",
          {
            severity: "high",
            rule: "模型审核失败或结果不可用时必须转人工",
          },
        );
        await completeReview(responseForReview({
          decision: "manual_review",
          reason: "model_review_unavailable",
          violations: [violation],
          model: {
            status: "error",
            errorCode: error.code || "COMMAND_REVIEW_MODEL_UNAVAILABLE",
            attempts: error.details?.attempts,
            durationMs: error.details?.durationMs,
          },
        }));
        return;
      }

      const modelReview = {
        ...modelResult.review,
        status: "completed",
        attempts: modelResult.attempts,
        durationMs: modelResult.durationMs,
      };
      if (!isModelAutoApproval(modelResult.review)) {
        const violations = [
          ...staticReview.violations,
          ...modelResult.review.violations,
        ];
        if (violations.length === 0) {
          violations.push(
            manualReviewViolation(
              "COMMAND_REVIEW_MODEL_DID_NOT_APPROVE",
              modelResult.review.summary,
              {
                severity: modelResult.review.riskLevel === "high" ? "high" : "medium",
                rule: "模型必须明确确认命令为低风险只读操作",
              },
            ),
          );
        }
        await completeReview(responseForReview({
          decision: "manual_review",
          reason: "model_review_rejected",
          violations,
          model: modelReview,
        }));
        return;
      }

      publishStage(activity, operation, "model-approved", {
        attempts: modelResult.attempts,
        durationMs: modelResult.durationMs,
      });
      let execution;
      try {
        execution = await workerManager.callInstance(
          instanceId,
          "/approved-command-drafts/execute",
          {
            draftId: draft.draftId,
            commandHash: draft.commandHash,
            confirmation: APPROVED_COMMAND_CONFIRMATION,
            operationId: requestOperation.operationId,
            timeoutMs: requestOperation.timeoutMs,
            deadlineAt: requestOperation.deadlineAt,
          },
          request.headers,
          { signal: requestOperation.signal },
        );
      } catch (error) {
        error.operationId ||= requestOperation.operationId;
        error.details = {
          ...(error.details || {}),
          instanceId,
          draft,
          review: modelReview,
          autoExecutionStarted: true,
        };
        throw error;
      }

      await completeReview(responseForReview({
        decision: "auto_executed",
        reason: "static_and_model_approved",
        violations: [],
        model: modelReview,
        execution,
      }));
    } catch (error) {
      error.operationId ||= requestOperation.operationId;
      const payload = errorPayload(error);
      const durationMs = durationSince(startedAt);
      await audit(config, {
        tool: "approved-command-review",
        instanceId,
        draftId: draft?.draftId || (typeof rawDraftId === "string" ? rawDraftId : undefined),
        commandHash: draft?.commandHash,
        ok: false,
        durationMs,
        errorCode: payload.error.code,
        operationId: requestOperation.operationId,
        errorLayer: payload.error.layer,
        errorPhase: payload.error.phase,
      });
      publishStage(activity, operation, "failed", {
        ok: false,
        durationMs,
        error: payload.error,
      });
      response.status(errorStatus(error)).json({ ...payload, durationMs });
    } finally {
      if (reviewClaimed) {
        commandReviewInFlight = false;
      }
    }
  });

  app.post("/api/memory", managerAsync(async (request, response) => {
    const instanceId = registry.resolveId(request.body?.instanceId);
    const instance = registry.getInternal(instanceId);
    if (!workerManager.memoryStore?.upsertNote) {
      throw managerRouteError(
        "instance memory updates are unavailable",
        "MEMORY_UPDATE_UNAVAILABLE",
        501,
      );
    }

    const result = await workerManager.memoryStore.upsertNote(
      instance,
      request.body || {},
      `mcp:${sourceFrom(request)}`,
    );
    activity.publish({
      type: "memory",
      stage: "note-updated",
      instanceId,
      topic: result.note.topic,
    });
    response.json({
      ok: true,
      instanceId,
      ...result,
    });
  }));

  async function proxyToInstance(pathName, request, response) {
    const startedAt = performance.now();
    const instanceId = request.body?.instanceId;
    const requestOperation = createRequestOperation(
      request,
      response,
      pathName,
      config,
      "manager",
    );
    const payload = {
      ...bodyWithoutInstanceId(request.body),
      operationId: requestOperation.operationId,
      timeoutMs: requestOperation.timeoutMs,
      deadlineAt: requestOperation.deadlineAt,
    };
    const operation = {
      type: "proxy",
      operationId: requestOperation.operationId,
      tool: pathName.replace(/^\//, ""),
      source: sourceFrom(request),
      request: {
        instanceId,
        timeoutMs: requestOperation.timeoutMs,
        deadlineAt: requestOperation.deadlineAt,
      },
    };
    publishStage(activity, operation, "started");

    try {
      const result = await workerManager.callInstance(
        instanceId,
        pathName,
        payload,
        request.headers,
        { signal: requestOperation.signal },
      );
      let memory = null;
      const instance = registry.getInternal(result.instanceId);
      if (instance && workerManager.memoryStore) {
        try {
          memory = await workerManager.memoryStore.recordToolObservation(instance, pathName, payload, result);
        } catch (error) {
          console.error("failed to update instance memory", error);
          memory = workerManager.memoryStore.summary(instance);
        }
      }
      publishStage(activity, operation, "completed", {
        ok: true,
        instanceId: result.instanceId,
        durationMs: durationSince(startedAt),
        ...result.timing,
      });
      response.json(memory ? { ...result, memory } : result);
    } catch (error) {
      error.operationId ||= requestOperation.operationId;
      publishStage(activity, operation, "failed", {
        ok: false,
        durationMs: durationSince(startedAt),
        errorLayer: error.layer,
        errorPhase: error.phase,
        error: operationErrorPayload(error, {
          code: "INSTANCE_PROXY_FAILED",
          layer: "manager",
        }),
      });
      respondManagerError(response, error);
    }
  }

  app.post("/run", (request, response) => proxyToInstance("/run", request, response));
  app.post("/read-file", (request, response) => proxyToInstance("/read-file", request, response));
  app.post("/list-dir", (request, response) => proxyToInstance("/list-dir", request, response));
  app.post("/logs/list", (request, response) => proxyToInstance("/logs/list", request, response));
  app.post("/logs/archive-members", (request, response) =>
    proxyToInstance("/logs/archive-members", request, response));
  app.post("/logs/read", (request, response) => proxyToInstance("/logs/read", request, response));
  app.post("/mongodb/query", (request, response) => proxyToInstance("/mongodb/query", request, response));
  app.post("/approved-command-drafts", (request, response) =>
    proxyToInstance("/approved-command-drafts", request, response));
  app.post("/approved-command-drafts/get", (request, response) =>
    proxyToInstance("/approved-command-drafts/get", request, response));
  app.post("/approved-command-drafts/execute", (request, response) =>
    proxyToInstance("/approved-command-drafts/execute", request, response));

  return app;
}

function isEnabledFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function isServerEntrypointProcess(options = {}) {
  const argv = options.argv || process.argv;
  const env = options.env || process.env;
  const filePath = options.filePath || moduleFilePath;
  return Boolean(
    !isEnabledFlag(env.REMOTE_DEBUG_WORKER) &&
      argv[1] &&
      path.resolve(filePath) === path.resolve(argv[1]),
  );
}

export function startWorkerServer(config = loadConfig()) {
  const app = createApp({ config });
  return listenHttpServer(app, config, (port, startedAt) => ({
    status: "listening",
    role: "worker",
    startedAt,
    port,
    hasTargetHost: Boolean(config.ssh.host),
    hasTargetUser: Boolean(config.ssh.username),
    hasPrivateKeyPath: Boolean(config.ssh.privateKeyPath),
  }));
}

function listenHttpServer(app, config, eventFactory) {
  const startedAt = new Date().toISOString();
  let failedToListen = false;
  let listeningStateTimer;
  const server = app.listen(config.agent.port, config.agent.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.agent.port;
    const event = eventFactory(port, startedAt);

    listeningStateTimer = setTimeout(() => {
      if (failedToListen) {
        return;
      }

      writeRuntimeState(config, event).catch((error) => {
        console.error("failed to write runtime state", error);
      });
      console.log(JSON.stringify({
        name: "remote-debug-agent",
        role: event.role || "agent",
        pid: process.pid,
        host: config.agent.host,
        port,
        target: publicTarget(config),
        startedAt,
      }));
    }, 25);
    listeningStateTimer.unref?.();
  });

  server.on("error", (error) => {
    failedToListen = true;
    if (listeningStateTimer) {
      clearTimeout(listeningStateTimer);
    }
    const payload = {
      status: "error",
      role: "manager",
      startedAt,
      lastError: {
        code: error.code || "AGENT_LISTEN_ERROR",
        message: error.message,
      },
    };

    writeRuntimeState(config, payload).catch((stateError) => {
      console.error("failed to write runtime state", stateError);
    });
    console.error(error);
    if (isServerEntrypointProcess()) {
      process.exitCode = 1;
    }
  });

  return server;
}

export function startServer(config = loadConfig(), options = {}) {
  const shutdownController = options.shutdownController || {};
  const app = createManagerApp({ config, ...options, shutdownController });
  const workerManager = app.locals.workerManager;
  const lifecycle = app.locals.lifecycle;
  const server = listenHttpServer(app, config, (port, startedAt) => ({
    status: "listening",
    role: "manager",
    startedAt,
    port,
    instanceCount: workerManager.publicInstances().length,
  }));

  const closeServer = () =>
    new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }

      server.close((error) => {
        if (error) {
          console.error("failed to close manager server", error);
        }
        resolve();
      });
    });

  const exit = options.exit || ((code) => process.exit(code));
  let shutdownPromise = null;
  const gracefulShutdown = (reason = "shutdown", shutdownOptions = {}) => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        lifecycle.stop();
        await workerManager.shutdownAll(reason).catch((error) => {
          console.error("failed to stop worker processes", error);
        });
        if (shutdownOptions.closeServer !== false) {
          await closeServer();
        }
        if (Number.isInteger(shutdownOptions.exitCode)) {
          exit(shutdownOptions.exitCode);
        }
      })();
      server.shutdownPromise = shutdownPromise;
    }

    return shutdownPromise;
  };

  shutdownController.request = (reason) => gracefulShutdown(reason);
  server.gracefulShutdown = gracefulShutdown;
  server.managerLifecycle = lifecycle;

  server.once("close", () => {
    gracefulShutdown("server-close", { closeServer: false }).catch((error) => {
      console.error("failed to stop worker processes", error);
    });
  });

  const signalProcess = options.signalProcess || process;
  const installSignalHandlers = options.installSignalHandlers ?? isServerEntrypointProcess();
  if (installSignalHandlers) {
    const handleSignal = (signal) => {
      gracefulShutdown(signal, { exitCode: 0 }).catch((error) => {
        console.error("failed to gracefully shut down manager", error);
        exit(1);
      });
    };
    signalProcess.once("SIGINT", handleSignal);
    signalProcess.once("SIGTERM", handleSignal);
  }

  return server;
}

if (isServerEntrypointProcess()) {
  try {
    startServer();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
