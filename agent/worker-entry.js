import { loadConfig } from "./config.js";
import { createApp } from "./server.js";
import { createSSHOperations } from "./ssh.js";
import { SshConnectionSupervisor } from "./ssh-connection-supervisor.js";
import { discoverMemory } from "./memory-discovery.js";
import { API_VERSION } from "./operation.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function send(message) {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

function errorPayload(error) {
  return {
    code: error.code || "WORKER_ERROR",
    message: error.message || "worker operation failed",
  };
}

function parseBooleanFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function healthSnapshot(supervisor) {
  const health = supervisor.snapshot();
  return {
    ...health,
    worker: {
      status: "healthy",
      pid: process.pid,
      lastHeartbeatAt: new Date().toISOString(),
    },
  };
}

async function runHealthCheck(supervisor) {
  send({
    type: "health",
    status: "healthy",
    apiVersion: API_VERSION,
    health: healthSnapshot(supervisor),
  });
}

export async function runMemoryInit(config, options = {}) {
  const env = options.env || process.env;
  const sendMessage = options.send || send;
  const discover = options.discoverMemory || discoverMemory;
  if (!parseBooleanFlag(env.REMOTE_DEBUG_MEMORY_INIT)) {
    return null;
  }

  try {
    const memory = await discover(config, options.discovery || {});
    sendMessage({
      type: "memory:update",
      ok: true,
      memory,
    });
    return memory;
  } catch (error) {
    const payload = errorPayload(error);
    sendMessage({
      type: "memory:update",
      ok: false,
      error: payload,
    });
    return {
      status: "failed",
      lastError: payload,
    };
  }
}

export function scheduleMemoryInit(config, options = {}) {
  const schedule = options.schedule || setImmediate;
  const sendMessage = options.send || send;
  const run = options.run || (() => runMemoryInit(config, options.runOptions || {}));

  schedule(() =>
    Promise.resolve()
      .then(run)
      .catch((error) => {
        sendMessage({
          type: "memory:update",
          ok: false,
          error: errorPayload(error),
        });
      }),
  );
}

function isEntrypointProcess() {
  return Boolean(
    process.argv[1] &&
      path.resolve(__filename) === path.resolve(process.argv[1]),
  );
}

export function installWorkerShutdownHandlers(shutdown, processObject = process) {
  processObject.on("message", (message) => {
    if (message?.type === "shutdown") {
      shutdown(message.reason || "stopped", true);
    }
  });
  processObject.once("disconnect", () => shutdown("manager-disconnect"));
  processObject.once("SIGTERM", () => shutdown("SIGTERM"));
  processObject.once("SIGINT", () => shutdown("SIGINT"));
}

async function main() {
  const config = loadConfig();
  const supervisor = new SshConnectionSupervisor(config);
  const sshOperations = createSSHOperations(supervisor);
  const backgroundSshOperations = createSSHOperations(supervisor, { priority: "background" });
  const healthIntervalMs = parsePositiveInt(
    process.env.REMOTE_DEBUG_HEALTH_INTERVAL_MS,
    15_000,
  );

  try {
    await supervisor.start();
  } catch (error) {
    send({ type: "ready", ok: false, apiVersion: API_VERSION, error: errorPayload(error) });
    process.exitCode = 1;
    return;
  }

  const app = createApp({ config, sshSupervisor: supervisor, ...sshOperations });
  const server = app.listen(config.agent.port, config.agent.host, () => {
    send({
      type: "ready",
      ok: true,
      instanceId: process.env.REMOTE_DEBUG_INSTANCE_ID || "",
      pid: process.pid,
      port: config.agent.port,
      protocolVersion: API_VERSION,
      health: healthSnapshot(supervisor),
    });
    scheduleMemoryInit(config, {
      runOptions: {
        discovery: backgroundSshOperations,
      },
    });
  });

  server.on("error", (error) => {
    send({ type: "ready", ok: false, error: errorPayload(error) });
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 0);
  });

  const reportHealth = () => {
    runHealthCheck(supervisor).catch((error) => {
      send({
        type: "health",
        status: "healthy",
        apiVersion: API_VERSION,
        health: {
          ...healthSnapshot(supervisor),
          overall: "degraded",
          lastError: errorPayload(error),
        },
      });
    });
  };
  const healthTimer = setInterval(reportHealth, healthIntervalMs);
  healthTimer.unref?.();
  supervisor.on("state", reportHealth);

  let shuttingDown = false;
  const shutdown = (reason = "stopped", reportStopped = false) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(healthTimer);
    supervisor.off("state", reportHealth);
    if (reportStopped) {
      send({ type: "health", status: "stopped", reason });
    }
    supervisor.stop(reason).finally(() => {
      server.close(() => {
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(0), 1000).unref?.();
  };

  installWorkerShutdownHandlers(shutdown);
}

if (isEntrypointProcess()) {
  main().catch((error) => {
    send({ type: "ready", ok: false, error: errorPayload(error) });
    process.exitCode = 1;
  });
}
