import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { byteLength, createActivityLog, previewText } from "./activity.js";
import {
  assertApprovedCommandsEnabled,
  createCommandDraftStore,
  normalizeApprovedCommandTimeoutMs,
  redactCommand,
} from "./approved-commands.js";
import { configFingerprint, loadConfig, publicSecurity, publicTarget } from "./config.js";
import { writeAuditLog } from "./audit.js";
import {
  assertPathAllowed,
  normalizeMaxBytes,
  normalizeTimeoutMs,
  validateCommand,
} from "./security.js";
import {
  listRemoteDir as defaultListRemoteDir,
  readRemoteFile as defaultReadRemoteFile,
  resolveRemotePaths as defaultResolveRemotePaths,
  runSSH as defaultRunSSH,
} from "./ssh.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function durationSince(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function errorStatus(error) {
  return Number.isInteger(error.statusCode) ? error.statusCode : 502;
}

function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: error.code || "REMOTE_DEBUG_ERROR",
      message: error.message || "remote debug operation failed",
    },
  };
}

function publicAgent(config) {
  return {
    host: config.agent.host,
    port: config.agent.port,
    pid: process.pid,
    configFingerprint: configFingerprint(config),
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
    operationId: randomUUID(),
    tool,
    source: sourceFrom(request),
    target: publicTarget(config),
    request: requestPayload,
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
  const runSSH = options.runSSH || defaultRunSSH;
  const readRemoteFile = options.readRemoteFile || defaultReadRemoteFile;
  const listRemoteDir = options.listRemoteDir || defaultListRemoteDir;
  const resolveRemotePaths = options.resolveRemotePaths || defaultResolveRemotePaths;
  const activity = options.activity || createActivityLog();
  const commandDraftStore = options.commandDraftStore || createCommandDraftStore();
  const app = express();
  const publicDir = path.join(__dirname, "public");

  app.use(express.json({ limit: "512kb" }));

  app.get("/", (_request, response) => {
    response.sendFile(path.join(publicDir, "dashboard.html"));
  });

  app.use(express.static(publicDir, { index: false, maxAge: 0 }));

  app.get("/health", (_request, response) => {
    response.json({ ok: true, name: "remote-debug-agent" });
  });

  app.get("/status", (_request, response) => {
    response.json({
      ok: true,
      name: "remote-debug-agent",
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
    const operation = createOperation(request, config, "run", {
      cmd: requestText(rawCmd),
      timeoutMs: request.body?.timeoutMs,
    });
    publishStage(activity, operation, "started");

    try {
      const validation = validateCommand(rawCmd, config.security);
      const timeoutMs = normalizeTimeoutMs(request.body?.timeoutMs, config.security);
      operation.request = {
        cmd: validation.normalizedCommand,
        timeoutMs,
      };
      publishStage(activity, operation, "validated");

      if (validation.absolutePaths.length > 0) {
        await resolveRemotePaths(validation.absolutePaths, { config });
      }
      const result = await runSSH(validation.normalizedCommand, {
        config,
        timeoutMs,
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
      };

      await audit(config, {
        tool: "run",
        cmd: validation.normalizedCommand,
        ok: true,
        durationMs: payload.durationMs,
        stdout: payload.stdout,
        stderr: payload.stderr,
      });

      publishStage(activity, operation, "completed", {
        ok: true,
        result: outputSummary(payload),
      });

      response.json(payload);
    } catch (error) {
      const payload = errorPayload(error);
      const durationMs = durationSince(startedAt);
      await audit(config, {
        tool: "run",
        cmd: typeof rawCmd === "string" ? rawCmd.slice(0, 256) : undefined,
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
    const operation = createOperation(request, config, "approved-command-execute", {
      draftId: requestText(rawDraftId),
      commandHash: requestText(rawCommandHash),
      timeoutMs: request.body?.timeoutMs,
    });
    publishStage(activity, operation, "started");

    let claimedDraft;
    try {
      assertApprovedCommandsEnabled(config);
      const timeoutMs = normalizeApprovedCommandTimeoutMs(
        request.body?.timeoutMs,
        config.approvedCommands,
      );
      claimedDraft = commandDraftStore.claimDraft({
        draftId: rawDraftId,
        commandHash: rawCommandHash,
        confirmation: request.body?.confirmation,
      });
      operation.request = {
        draftId: claimedDraft.draftId,
        commandHash: claimedDraft.commandHash,
        commandCount: claimedDraft.commandCount,
        timeoutMs,
      };
      publishStage(activity, operation, "validated");

      await audit(config, {
        tool: "approved-command-execute-start",
        draftId: claimedDraft.draftId,
        commandHash: claimedDraft.commandHash,
        commandCount: claimedDraft.commandCount,
        ok: true,
        durationMs: 0,
      });

      const results = [];
      let stopped;
      for (const [index, command] of claimedDraft.commands.entries()) {
        publishStage(activity, operation, "command-started", {
          commandIndex: index,
          commandPreview: redactCommand(command),
        });
        const commandStartedAt = performance.now();
        const result = await runSSH(command, {
          config,
          timeoutMs,
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
        };
        results.push(commandPayload);

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
      };

      await audit(config, {
        tool: "approved-command-execute-complete",
        draftId: claimedDraft.draftId,
        commandHash: claimedDraft.commandHash,
        commandCount: results.length,
        ok: payload.commandsOk,
        durationMs: payload.durationMs,
        errorCode: stopped ? `STOPPED_${stopped.reason.toUpperCase()}` : undefined,
      });

      publishStage(activity, operation, "completed", {
        ok: payload.commandsOk,
        result: approvedExecutionSummary(payload),
      });

      response.json(payload);
    } catch (error) {
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
      });
      publishStage(activity, operation, "failed", {
        ok: false,
        durationMs,
        error: payload.error,
      });
      response.status(errorStatus(error)).json({ ...payload, durationMs });
    }
  });

  app.post("/read-file", async (request, response) => {
    const startedAt = performance.now();
    const rawPath = request.body?.path;
    const operation = createOperation(request, config, "read-file", {
      path: requestText(rawPath),
      maxBytes: request.body?.maxBytes,
    });
    publishStage(activity, operation, "started");

    try {
      const requestedPath = assertPathAllowed(rawPath, config.security.allowedPaths);
      const maxBytes = normalizeMaxBytes(request.body?.maxBytes, config.security);
      operation.request = {
        path: requestedPath,
        maxBytes,
      };
      publishStage(activity, operation, "validated");

      const result = await readRemoteFile(requestedPath, { config, maxBytes });
      const payload = {
        ok: true,
        path: result.path,
        content: result.content,
        truncated: result.truncated,
        durationMs: durationSince(startedAt),
      };

      await audit(config, {
        tool: "read-file",
        path: result.path,
        ok: true,
        durationMs: payload.durationMs,
        content: payload.content,
      });

      publishStage(activity, operation, "completed", {
        ok: true,
        result: fileSummary(payload),
      });

      response.json(payload);
    } catch (error) {
      const payload = errorPayload(error);
      const durationMs = durationSince(startedAt);
      await audit(config, {
        tool: "read-file",
        path: typeof rawPath === "string" ? rawPath.slice(0, 256) : undefined,
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

  app.post("/list-dir", async (request, response) => {
    const startedAt = performance.now();
    const rawPath = request.body?.path;
    const operation = createOperation(request, config, "list-dir", {
      path: requestText(rawPath),
    });
    publishStage(activity, operation, "started");

    try {
      const requestedPath = assertPathAllowed(rawPath, config.security.allowedPaths);
      operation.request = {
        path: requestedPath,
      };
      publishStage(activity, operation, "validated");

      const result = await listRemoteDir(requestedPath, { config });
      const payload = {
        ok: true,
        path: result.path,
        entries: result.entries,
        durationMs: durationSince(startedAt),
      };

      await audit(config, {
        tool: "list-dir",
        path: result.path,
        ok: true,
        durationMs: payload.durationMs,
        contentLength: JSON.stringify(payload.entries).length,
      });

      publishStage(activity, operation, "completed", {
        ok: true,
        result: directorySummary(payload),
      });

      response.json(payload);
    } catch (error) {
      const payload = errorPayload(error);
      const durationMs = durationSince(startedAt);
      await audit(config, {
        tool: "list-dir",
        path: typeof rawPath === "string" ? rawPath.slice(0, 256) : undefined,
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

  return app;
}

function isEntrypointProcess() {
  return Boolean(
    process.argv[1] &&
      path.resolve(__filename) === path.resolve(process.argv[1]),
  );
}

export function startServer(config = loadConfig()) {
  const app = createApp({ config });
  const startedAt = new Date().toISOString();
  let failedToListen = false;
  let listeningStateTimer;
  const server = app.listen(config.agent.port, config.agent.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.agent.port;
    const event = {
      status: "listening",
      startedAt,
      port,
      hasTargetHost: Boolean(config.ssh.host),
      hasTargetUser: Boolean(config.ssh.username),
      hasPrivateKeyPath: Boolean(config.ssh.privateKeyPath),
    };

    listeningStateTimer = setTimeout(() => {
      if (failedToListen) {
        return;
      }

      writeRuntimeState(config, event).catch((error) => {
        console.error("failed to write runtime state", error);
      });
      console.log(JSON.stringify({
        name: "remote-debug-agent",
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
    if (isEntrypointProcess()) {
      process.exitCode = 1;
    }
  });

  return server;
}

if (isEntrypointProcess()) {
  try {
    startServer();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
