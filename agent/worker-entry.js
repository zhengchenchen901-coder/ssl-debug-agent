import { loadConfig } from "./config.js";
import { createApp } from "./server.js";
import { checkSSHConnection } from "./ssh.js";

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

async function runHealthCheck(config) {
  await checkSSHConnection(config);
  send({ type: "health", status: "healthy" });
}

async function main() {
  const config = loadConfig();
  const healthIntervalMs = parsePositiveInt(
    process.env.REMOTE_DEBUG_HEALTH_INTERVAL_MS,
    15_000,
  );

  try {
    await checkSSHConnection(config);
  } catch (error) {
    send({ type: "ready", ok: false, error: errorPayload(error) });
    process.exitCode = 1;
    return;
  }

  const app = createApp({ config });
  const server = app.listen(config.agent.port, config.agent.host, () => {
    send({
      type: "ready",
      ok: true,
      instanceId: process.env.REMOTE_DEBUG_INSTANCE_ID || "",
      pid: process.pid,
      port: config.agent.port,
    });
  });

  server.on("error", (error) => {
    send({ type: "ready", ok: false, error: errorPayload(error) });
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 0);
  });

  const healthTimer = setInterval(() => {
    runHealthCheck(config).catch((error) => {
      send({ type: "health", status: "unhealthy", error: errorPayload(error) });
    });
  }, healthIntervalMs);
  healthTimer.unref?.();

  const shutdown = () => {
    clearInterval(healthTimer);
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1000).unref?.();
  };

  process.on("message", (message) => {
    if (message?.type === "shutdown") {
      shutdown();
    }
  });
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error) => {
  send({ type: "ready", ok: false, error: errorPayload(error) });
  process.exitCode = 1;
});
