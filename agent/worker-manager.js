import { fork } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPortInRange } from "./instance-registry.js";
import { MemoryStore } from "./memory-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function managerError(message, code, statusCode = 500, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function publicRuntime(runtime) {
  if (!runtime) {
    return {
      status: "stopped",
      pid: null,
      workerPort: null,
      startedAt: null,
      lastHeartbeatAt: null,
      lastError: null,
      events: [],
    };
  }

  return {
    status: runtime.status,
    pid: runtime.pid || null,
    workerPort: runtime.workerPort || null,
    startedAt: runtime.startedAt || null,
    lastHeartbeatAt: runtime.lastHeartbeatAt || null,
    lastError: runtime.lastError || null,
    events: runtime.events.slice(-20),
  };
}

function event(runtime, type, payload = {}) {
  const entry = {
    time: nowIso(),
    type,
    ...payload,
  };
  runtime.events.push(entry);
  if (runtime.events.length > 50) {
    runtime.events.splice(0, runtime.events.length - 50);
  }
  return entry;
}

function canBindPort(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (ok) => {
      server.removeAllListeners();
      if (server.listening) {
        server.close(() => resolve(ok));
      } else {
        resolve(ok);
      }
    };

    server.once("error", () => finish(false));
    server.listen(port, host, () => finish(true));
  });
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function projectRootFrom(cwd) {
  const normalized = path.resolve(cwd);
  return path.basename(normalized).toLowerCase() === "agent" ? path.dirname(normalized) : normalized;
}

function configEnv(instance, port, manager, cwd, memoryInit) {
  const instanceDir = path.resolve(projectRootFrom(cwd), ".remote-debug", "instances", instance.id);
  return {
    REMOTE_DEBUG_WORKER: "1",
    REMOTE_DEBUG_INSTANCE_ID: instance.id,
    REMOTE_DEBUG_INSTANCE_NAME: instance.name,
    REMOTE_DEBUG_AGENT_PORT: String(port),
    REMOTE_DEBUG_HOST: instance.host,
    REMOTE_DEBUG_PORT: String(instance.port || 22),
    REMOTE_DEBUG_USER: instance.username,
    REMOTE_DEBUG_PRIVATE_KEY_PATH: instance.privateKeyPath,
    REMOTE_DEBUG_PRIVATE_KEY_PASSPHRASE: instance.passphrase || "",
    REMOTE_DEBUG_AUDIT_LOG:
      instance.auditLog || path.resolve(instanceDir, "audit.jsonl"),
    REMOTE_DEBUG_APPROVED_COMMANDS: instance.approvedCommands?.enabled ? "1" : "0",
    REMOTE_DEBUG_APPROVED_COMMAND_TIMEOUT_MS:
      instance.approvedCommands?.timeoutMs === undefined
        ? ""
        : String(instance.approvedCommands.timeoutMs),
    REMOTE_DEBUG_APPROVED_COMMAND_MAX_TIMEOUT_MS:
      instance.approvedCommands?.maxTimeoutMs === undefined
        ? ""
        : String(instance.approvedCommands.maxTimeoutMs),
    REMOTE_DEBUG_HEALTH_INTERVAL_MS: String(manager.healthIntervalMs),
    REMOTE_DEBUG_RUNTIME_STATE_PATH: path.resolve(instanceDir, ".runtime", "agent-state.json"),
    REMOTE_DEBUG_MEMORY_INIT: memoryInit ? "1" : "0",
  };
}

export class WorkerManager {
  constructor(options = {}) {
    this.registry = options.registry;
    this.managerPort = options.managerPort;
    this.cwd = options.cwd || process.cwd();
    this.nodePath = options.nodePath || process.execPath;
    this.workerEntryPath =
      options.workerEntryPath || path.resolve(__dirname, "worker-entry.js");
    this.forkWorker = options.forkWorker || ((entryPath, forkOptions) => fork(entryPath, [], forkOptions));
    this.fetchImpl = options.fetchImpl || fetch;
    this.canBindPort = options.canBindPort || canBindPort;
    this.memoryStore = options.memoryStore || new MemoryStore({ cwd: this.cwd });
    this.runtime = new Map();
    this.portOwners = new Map();
    const monitorEveryMs = Math.max(1000, Math.floor(this.managerConfig().healthIntervalMs || 15_000));
    this.monitorTimer = setInterval(() => {
      this.checkStaleWorkers().catch((error) => {
        console.error("failed to monitor worker health", error);
      });
    }, monitorEveryMs);
    this.monitorTimer.unref?.();
  }

  managerConfig() {
    return this.registry.managerConfig();
  }

  publicInstance(id) {
    const instance = this.registry.get(id);
    return instance
      ? {
          ...instance,
          memory: this.memoryStore.summary(instance),
        }
      : null;
  }

  publicInstances() {
    return this.registry.list().map((instance) => ({
      ...instance,
      runtime: publicRuntime(this.runtime.get(instance.id)),
      memory: this.memoryStore.summary(instance),
    }));
  }

  runtimeFor(id) {
    return publicRuntime(this.runtime.get(id));
  }

  async allocatePort(instance) {
    const manager = this.managerConfig();
    const candidates = [];
    if (
      instance.preferredWorkerPort &&
      isPortInRange(instance.preferredWorkerPort, manager.workerPortRange)
    ) {
      candidates.push(instance.preferredWorkerPort);
    }
    for (let port = manager.workerPortRange.start; port <= manager.workerPortRange.end; port += 1) {
      candidates.push(port);
    }

    for (const port of [...new Set(candidates)]) {
      if (
        port === this.managerPort ||
        !isPortInRange(port, manager.workerPortRange) ||
        this.portOwners.has(port)
      ) {
        continue;
      }
      if (await this.canBindPort(port, manager.host)) {
        this.portOwners.set(port, instance.id);
        return port;
      }
    }

    throw managerError(
      "no available worker port in configured range",
      "WORKER_PORT_EXHAUSTED",
      503,
      {
        range: manager.workerPortRange,
        excludedPort: this.managerPort,
      },
    );
  }

  releasePort(port) {
    if (port) {
      this.portOwners.delete(port);
    }
  }

  ensureRunnable(instance) {
    if (!instance.enabled) {
      throw managerError(`instance is disabled: ${instance.id}`, "INSTANCE_DISABLED", 409);
    }
  }

  async startInstance(id) {
    const instance = this.registry.getInternal(id);
    if (!instance) {
      throw managerError(`instance not found: ${id}`, "INSTANCE_NOT_FOUND", 404);
    }
    this.ensureRunnable(instance);

    const current = this.runtime.get(id);
    if (current?.status === "running" || current?.status === "starting") {
      return {
        instance: this.publicInstance(id),
        runtime: publicRuntime(current),
      };
    }

    const manager = this.managerConfig();
    const workerPort = await this.allocatePort(instance);
    let shouldInitializeMemory = this.memoryStore.shouldInitialize(instance);
    const runtime = {
      status: "starting",
      child: null,
      pid: null,
      workerPort,
      startedAt: nowIso(),
      lastHeartbeatAt: null,
      lastError: null,
      intentionalStop: false,
      events: [],
    };
    this.runtime.set(id, runtime);
    event(runtime, "starting", { workerPort });
    if (shouldInitializeMemory) {
      try {
        await this.memoryStore.markInitializing(instance);
        event(runtime, "memory-initializing");
      } catch (error) {
        shouldInitializeMemory = false;
        event(runtime, "memory-init-skipped", {
          error: {
            code: error.code || "MEMORY_INIT_STATE_FAILED",
            message: error.message,
          },
        });
        console.error("failed to prepare instance memory", error);
      }
    }

    let child;
    try {
      child = this.forkWorker(this.workerEntryPath, {
        cwd: this.cwd,
        env: {
          ...process.env,
          ...configEnv(instance, workerPort, manager, this.cwd, shouldInitializeMemory),
        },
        execPath: this.nodePath,
        silent: true,
        windowsHide: true,
      });
    } catch (error) {
      this.releasePort(workerPort);
      this.runtime.delete(id);
      const wrapped = managerError(
        `worker process could not be spawned: ${error.message}`,
        "WORKER_SPAWN_FAILED",
        500,
      );
      if (shouldInitializeMemory) {
        await this.memoryStore.markFailed(instance, wrapped, "worker-spawn-failed").catch((memoryError) => {
          console.error("failed to mark instance memory failed", memoryError);
        });
      }
      throw wrapped;
    }

    runtime.child = child;
    runtime.pid = child.pid;
    event(runtime, "spawned", { pid: child.pid });
    child.stdout?.resume();
    child.stderr?.resume();

    child.on("message", (message) => {
      this.handleWorkerMessage(id, message).catch((error) => {
        this.markUnhealthy(id, error);
      });
    });
    child.once("exit", (code, signal) => {
      this.handleWorkerExit(id, code, signal);
    });

    try {
      await this.waitForReady(id, child, manager.startTimeoutMs);
      runtime.status = "running";
      runtime.lastHeartbeatAt = nowIso();
      runtime.lastError = null;
      event(runtime, "running", { pid: child.pid, workerPort });
      return {
        instance: this.publicInstance(id),
        runtime: publicRuntime(runtime),
      };
    } catch (error) {
      runtime.lastError = {
        code: error.code || "WORKER_START_FAILED",
        message: error.message,
      };
      event(runtime, "start-failed", { error: runtime.lastError });
      if (shouldInitializeMemory) {
        await this.memoryStore.markFailed(instance, error, "worker-start-failed").catch((memoryError) => {
          console.error("failed to mark instance memory failed", memoryError);
        });
      }
      await this.stopInstance(id, "start-failed");
      throw error;
    }
  }

  waitForReady(id, child, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const runtime = this.runtime.get(id);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        if (error) reject(error);
        else resolve();
      };

      const onMessage = (message) => {
        if (message?.type !== "ready") {
          return;
        }
        if (message.ok) {
          finish();
        } else {
          finish(
            managerError(
              message.error?.message || "worker failed readiness check",
              message.error?.code || "WORKER_READY_FAILED",
              502,
            ),
          );
        }
      };

      const onExit = (code, signal) => {
        finish(
          managerError(
            `worker exited before readiness (code ${code ?? "null"}, signal ${signal ?? "null"})`,
            "WORKER_EXITED_BEFORE_READY",
            502,
          ),
        );
      };

      const timer = setTimeout(() => {
        finish(managerError("worker did not become ready before timeout", "WORKER_START_TIMEOUT", 504));
      }, timeoutMs);
      timer.unref?.();

      child.on("message", onMessage);
      child.once("exit", onExit);
      if (runtime) {
        event(runtime, "waiting-ready", { timeoutMs });
      }
    });
  }

  async handleWorkerMessage(id, message) {
    const runtime = this.runtime.get(id);
    if (!runtime || !message) {
      return;
    }

    if (message.type === "health") {
      runtime.lastHeartbeatAt = nowIso();
      if (message.status === "healthy") {
        runtime.lastError = null;
        if (runtime.status !== "starting") {
          runtime.status = "running";
        }
        event(runtime, "health", { status: "healthy" });
        return;
      }
      if (message.status === "stopped") {
        runtime.intentionalStop = true;
        runtime.status = "stopped";
        runtime.lastError = null;
        event(runtime, "health", { status: "stopped", reason: message.reason });
        return;
      }

      runtime.lastError = message.error || {
        code: "WORKER_UNHEALTHY",
        message: "worker reported unhealthy status",
      };
      runtime.status = "unhealthy";
      event(runtime, "health", { status: "unhealthy", error: runtime.lastError });
      await this.stopInstance(id, "unhealthy");
      return;
    }

    if (message.type === "memory:update") {
      const instance = this.registry.getInternal(id);
      if (!instance) {
        return;
      }
      try {
        if (message.ok === false) {
          await this.memoryStore.markFailed(instance, message.error, "worker-init");
          event(runtime, "memory-failed", { error: message.error });
          return;
        }

        const memory = await this.memoryStore.merge(instance, message.memory || {}, "worker-init");
        event(runtime, "memory-updated", {
          status: memory.status,
          changedSections: memory.changedSections,
        });
      } catch (error) {
        event(runtime, "memory-update-failed", {
          error: {
            code: error.code || "MEMORY_UPDATE_FAILED",
            message: error.message,
          },
        });
        console.error("failed to update instance memory", error);
      }
    }
  }

  handleWorkerExit(id, code, signal) {
    const runtime = this.runtime.get(id);
    if (!runtime) {
      return;
    }

    const lastPort = runtime.workerPort;
    this.releasePort(lastPort);
    const stopped = runtime.intentionalStop;
    runtime.child = null;
    runtime.pid = null;
    runtime.workerPort = null;
    runtime.status = stopped ? "stopped" : "unhealthy";
    runtime.lastError = stopped
      ? null
      : {
          code: "WORKER_EXITED",
          message: `worker exited (code ${code ?? "null"}, signal ${signal ?? "null"})`,
        };
    event(runtime, "exit", { code, signal, stopped });
  }

  markUnhealthy(id, error) {
    const runtime = this.runtime.get(id);
    if (!runtime) {
      return;
    }
    runtime.status = "unhealthy";
    runtime.lastError = {
      code: error.code || "WORKER_UNHEALTHY",
      message: error.message || "worker became unhealthy",
    };
    event(runtime, "unhealthy", { error: runtime.lastError });
  }

  async checkStaleWorkers() {
    const maxAgeMs = (this.managerConfig().healthIntervalMs || 15_000) * 3;
    const now = Date.now();
    for (const [id, runtime] of this.runtime.entries()) {
      if (runtime.status !== "running" || !runtime.lastHeartbeatAt) {
        continue;
      }
      const lastHeartbeatMs = Date.parse(runtime.lastHeartbeatAt);
      if (Number.isNaN(lastHeartbeatMs) || now - lastHeartbeatMs <= maxAgeMs) {
        continue;
      }
      runtime.status = "unhealthy";
      runtime.lastError = {
        code: "WORKER_HEARTBEAT_TIMEOUT",
        message: "worker heartbeat timed out",
      };
      event(runtime, "heartbeat-timeout", { error: runtime.lastError });
      await this.stopInstance(id, "unhealthy");
    }
  }

  async stopInstance(id, reason = "stopped") {
    const instance = this.registry.get(id);
    if (!instance) {
      throw managerError(`instance not found: ${id}`, "INSTANCE_NOT_FOUND", 404);
    }

    const runtime = this.runtime.get(id);
    if (!runtime) {
      return {
        instance: this.publicInstance(id),
        runtime: publicRuntime(null),
      };
    }

    const manager = this.managerConfig();
    const child = runtime.child;
    runtime.intentionalStop = true;
    runtime.status = reason === "unhealthy" ? "unhealthy" : "stopping";
    event(runtime, "stopping", { reason });

    if (child && child.connected) {
      child.send({ type: "shutdown", reason });
    }

    await waitForExit(child, manager.stopTimeoutMs);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await sleep(100);
    }

    this.releasePort(runtime.workerPort);
    runtime.child = null;
    runtime.pid = null;
    runtime.workerPort = null;
    runtime.status = reason === "unhealthy" ? "unhealthy" : "stopped";
    if (!["unhealthy", "start-failed"].includes(reason)) {
      runtime.lastError = null;
    }
    event(runtime, runtime.status, { reason });

    return {
      instance: this.publicInstance(id),
      runtime: publicRuntime(runtime),
    };
  }

  async refreshInstance(id) {
    await this.stopInstance(id, "refresh");
    return this.startInstance(id);
  }

  async deleteInstance(id) {
    await this.stopInstance(id, "delete");
    const removed = this.registry.delete(id);
    this.runtime.delete(id);
    await this.memoryStore.deleteInstance(id);
    return removed;
  }

  resolveInstanceId(instanceId) {
    return this.registry.resolveId(instanceId);
  }

  async callInstance(instanceId, pathName, payload, headers = {}) {
    const resolvedId = this.resolveInstanceId(instanceId);
    const runtime = this.runtime.get(resolvedId);
    if (!runtime || runtime.status !== "running" || !runtime.workerPort) {
      throw managerError(
        `instance is not running: ${resolvedId}`,
        "INSTANCE_NOT_RUNNING",
        409,
        {
          instances: this.publicInstances(),
        },
      );
    }

    const url = `http://${this.managerConfig().host}:${runtime.workerPort}${pathName}`;
    const controller = new AbortController();
    const timeoutMs = payload?.timeoutMs || 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Remote-Debug-Source": headers["x-remote-debug-source"] || headers["X-Remote-Debug-Source"] || "http-api",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      throw managerError(
        `worker is unavailable for instance ${resolvedId}: ${error.message}`,
        "WORKER_UNAVAILABLE",
        502,
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { ok: false, raw: text };
    }

    if (!response.ok || parsed.ok === false) {
      throw managerError(
        parsed.error?.message || `worker request failed with HTTP ${response.status}`,
        parsed.error?.code || "WORKER_REQUEST_FAILED",
        response.status || 502,
        { payload: parsed },
      );
    }

    return {
      ...parsed,
      instanceId: resolvedId,
    };
  }

  async shutdownAll() {
    clearInterval(this.monitorTimer);
    await Promise.all([...this.runtime.keys()].map((id) => this.stopInstance(id, "manager-shutdown")));
  }
}
