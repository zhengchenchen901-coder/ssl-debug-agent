import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { byteLength, createActivityLog, previewText } from "./activity.js";
import { loadConfig } from "./config.js";
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

function publicTarget(config) {
  return {
    host: config.ssh.host || "",
    port: config.ssh.port,
    username: config.ssh.username || "",
  };
}

function publicSecurity(config) {
  return {
    allowedPaths: config.security.allowedPaths,
    defaultTimeoutMs: config.security.defaultTimeoutMs,
    maxTimeoutMs: config.security.maxTimeoutMs,
    defaultReadMaxBytes: config.security.defaultReadMaxBytes,
    maxCommandOutputBytes: config.security.maxCommandOutputBytes,
  };
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
  const app = express();
  const publicDir = path.join(__dirname, "public");

  app.use(express.json({ limit: "32kb" }));

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

export function startServer(config = loadConfig()) {
  const app = createApp({ config });
  return app.listen(config.agent.port, config.agent.host, () => {
    console.log(
      `remote-debug-agent listening on http://${config.agent.host}:${config.agent.port}`,
    );
  });
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(__filename) === path.resolve(process.argv[1]);

if (isEntrypoint) {
  try {
    startServer();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
