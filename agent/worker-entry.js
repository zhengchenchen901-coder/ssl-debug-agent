import { loadConfig } from "./config.js";
import { createApp } from "./server.js";
import { createSSHOperations } from "./ssh.js";
import { SshConnectionSupervisor } from "./ssh-connection-supervisor.js";
import { discoverMemory } from "./memory-discovery.js";
import { API_VERSION } from "./operation.js";
import { WorkerResourceClient } from "./worker-resource-client.js";
import { RemoteResourceSampler } from "./remote-resource-sampler.js";
import { REMOTE_RESOURCE_PROBE_SOURCE } from "./remote-resource-runtime-source.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleFilePath =
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function send(message) {
  if (typeof process.send === "function" && process.connected) {
    process.send(message, () => {});
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
      path.resolve(moduleFilePath) === path.resolve(process.argv[1]),
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

export function receiveWorkerAuth(processObject = process, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const finish = (error, token) => {
      clearTimeout(timer);
      processObject.off("message", onMessage);
      processObject.off("disconnect", onDisconnect);
      if (error) reject(error); else resolve(token);
    };
    const failure = () => Object.assign(new Error("worker initialization requires private IPC credentials"), { code: "LOCAL_AUTH_REQUIRED" });
    const onMessage = (message) => {
      if (message?.type !== "initialize-auth") return;
      if (!/^[a-f0-9]{64}$/.test(message.token || "")) finish(failure());
      else finish(null, message.token);
    };
    const onDisconnect = () => finish(failure());
    const timer = setTimeout(onDisconnect, timeoutMs);
    if (!processObject.connected) { finish(failure()); return; }
    processObject.on("message", onMessage);
    processObject.once("disconnect", onDisconnect);
  });
}

async function main() {
  const config = loadConfig();
  const authToken = await receiveWorkerAuth();
  const supervisor = new SshConnectionSupervisor(config);
  const resourceClient = new WorkerResourceClient({ instanceId: process.env.REMOTE_DEBUG_INSTANCE_ID || "default", send });
  supervisor.resourceClient = resourceClient;
  supervisor.scheduler.reserveInteractive = true;
  supervisor.scheduler.maxBackground = Math.min(2, Math.max(1, supervisor.scheduler.maxBusiness - 1));
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

  const sampler = new RemoteResourceSampler({ script: REMOTE_RESOURCE_PROBE_SOURCE,
    runSSH: (command, options) => sshOperations.runSSH(command, { config, ...options }),
    report: (sample) => resourceClient.reportSample(sample) });
  resourceClient.probeNow = () => { if (resourceClient.samplerEnabled && supervisor.state === "ready" && Date.now() - (sampler.lastAttemptAt || 0) >= 1000) sampler.sample(); };
  const samplingTimer = setInterval(() => {
    const busy = [...resourceClient.registry.tasks.values()].some((task) => !task.finishedAt);
    if (resourceClient.samplerEnabled && supervisor.state === "ready" && (busy || Date.now() - (sampler.lastAttemptAt || 0) >= 30000)) sampler.sample();
  }, config.resources.sampleIntervalMs);
  samplingTimer.unref?.();
  const app = createApp({ config, authToken, sshSupervisor: supervisor, resourceClient, ...sshOperations });
  const server = app.listen(config.agent.port, config.agent.host, () => {
    send({
      type: "ready",
      ok: true,
      instanceId: process.env.REMOTE_DEBUG_INSTANCE_ID || "",
      pid: process.pid,
      port: config.agent.port,
      protocolVersion: API_VERSION,
      localAuthentication: true,
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
    clearInterval(samplingTimer);
    supervisor.off("state", reportHealth);
    if (reportStopped) {
      send({ type: "health", status: "stopped", reason });
    }
    Promise.resolve()
      .then(() => app.locals.closeLogJobs())
      .then(() => app.locals.pauseMongoBulkJobRunner())
      .catch(() => {})
      .then(() => supervisor.stop(reason))
      .then(() => resourceClient.close())
      .finally(() => {
        server.close(() => {
          process.exit(0);
        });
      });
    setTimeout(() => process.exit(0), 12_000).unref?.();
  };

  installWorkerShutdownHandlers(shutdown);
}

if (isEntrypointProcess()) {
  main().catch((error) => {
    send({ type: "ready", ok: false, error: errorPayload(error) });
    process.exitCode = 1;
  });
}
