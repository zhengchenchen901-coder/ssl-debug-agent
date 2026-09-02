import { fork } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPortInRange } from "./instance-registry.js";
import { MemoryStore } from "./memory-store.js";
import {
  API_VERSION,
  operationError,
  operationErrorForSignal,
  remainingOperationMs,
} from "./operation.js";

const moduleFilePath =
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
const moduleDirectory =
  typeof __dirname === "string" ? __dirname : path.dirname(moduleFilePath);
const RESTORE_SNAPSHOT_VERSION = 1;
const RESTORE_SHUTDOWN_REASONS = new Set(["lease-expired"]);
const RESTORE_SNAPSHOT_REASONS = new Set(["active-runtime", ...RESTORE_SHUTDOWN_REASONS]);
const RESTORE_RUNTIME_STATUSES = new Set(["running", "starting"]);
const RESTORE_PRESERVING_STOP_REASONS = new Set(["lease-expired"]);
const WORKER_STDERR_TAIL_MAX_LENGTH = 4096;

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
      health: {
        overall: "stopped",
        worker: { status: "stopped", lastHeartbeatAt: null },
      },
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
    health: runtime.health || null,
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

function appendOutputTail(current, chunk, maxLength = WORKER_STDERR_TAIL_MAX_LENGTH) {
  const next = `${current || ""}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)}`;
  return next.length > maxLength ? next.slice(-maxLength) : next;
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

function defaultRestoreSnapshotPath(cwd) {
  return path.resolve(projectRootFrom(cwd), ".remote-debug", "manager-runtime.json");
}

function defaultRestoreSnapshotDiagnosticPath(cwd) {
  return path.resolve(projectRootFrom(cwd), ".remote-debug", "manager-runtime.last.json");
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
    REMOTE_DEBUG_APPROVED_EXECUTION_TIMEOUT_MS:
      instance.approvedCommands?.executionTimeoutMs === undefined
        ? ""
        : String(instance.approvedCommands.executionTimeoutMs),
    REMOTE_DEBUG_APPROVED_EXECUTION_MAX_TIMEOUT_MS:
      instance.approvedCommands?.maxExecutionTimeoutMs === undefined
        ? ""
        : String(instance.approvedCommands.maxExecutionTimeoutMs),
    REMOTE_DEBUG_MONGODB_CONFIG: instance.mongodb
      ? JSON.stringify(instance.mongodb)
      : "",
    REMOTE_DEBUG_SSH_KEEPALIVE_INTERVAL_MS: String(manager.sshNetwork.keepaliveIntervalMs),
    REMOTE_DEBUG_SSH_KEEPALIVE_COUNT_MAX: String(manager.sshNetwork.keepaliveCountMax),
    REMOTE_DEBUG_SSH_MAX_BUSINESS_CHANNELS: String(manager.sshNetwork.maxBusinessChannels),
    REMOTE_DEBUG_HEALTH_INTERVAL_MS: String(manager.healthIntervalMs),
    REMOTE_DEBUG_RUNTIME_STATE_PATH: path.resolve(instanceDir, ".runtime", "agent-state.json"),
    REMOTE_DEBUG_RUNTIME_ID: process.env.REMOTE_DEBUG_RUNTIME_ID || "development",
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
      options.workerEntryPath ||
      process.env.REMOTE_DEBUG_WORKER_ENTRY_PATH ||
      path.resolve(moduleDirectory, "worker-entry.js");
    this.forkWorker = options.forkWorker || ((entryPath, forkOptions) => fork(entryPath, [], forkOptions));
    this.fetchImpl = options.fetchImpl || fetch;
    this.canBindPort = options.canBindPort || canBindPort;
    this.memoryStore = options.memoryStore || new MemoryStore({ cwd: this.cwd });
    this.restoreSnapshotPath = options.restoreSnapshotPath || defaultRestoreSnapshotPath(this.cwd);
    this.restoreSnapshotDiagnosticPath =
      options.restoreSnapshotDiagnosticPath || defaultRestoreSnapshotDiagnosticPath(this.cwd);
    this.restorePromise = null;
    this.restoreSnapshotWritePromise = Promise.resolve();
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

  restoreCandidates() {
    const instances = [];
    for (const [id, runtime] of this.runtime.entries()) {
      if (!RESTORE_RUNTIME_STATUSES.has(runtime?.status)) {
        continue;
      }
      const instance = this.registry.get(id);
      if (!instance) {
        continue;
      }
      instances.push({
        id,
        runtime: publicRuntime(runtime),
      });
    }
    return instances;
  }

  restoreSnapshotSummary(snapshot) {
    const instances = Array.isArray(snapshot?.instances) ? snapshot.instances : [];
    return {
      version: snapshot?.version ?? null,
      reason: snapshot?.reason || null,
      createdAt: snapshot?.createdAt || null,
      updatedAt: snapshot?.updatedAt || null,
      ownerPid: Number.isInteger(snapshot?.ownerPid) ? snapshot.ownerPid : null,
      sourcePid: Number.isInteger(snapshot?.sourcePid) ? snapshot.sourcePid : null,
      lastAction: snapshot?.lastAction || null,
      lastReason: snapshot?.lastReason || null,
      instanceCount: instances.length,
      instanceIds: instances
        .map((item) => (typeof item?.id === "string" ? item.id : ""))
        .filter(Boolean),
    };
  }

  async readRestoreSnapshotDiagnostic() {
    try {
      return JSON.parse(await fsp.readFile(this.restoreSnapshotDiagnosticPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.error("failed to read manager restore snapshot diagnostic", error);
      }
      return null;
    }
  }

  async writeRestoreSnapshotDiagnostic(diagnostic) {
    try {
      await fsp.mkdir(path.dirname(this.restoreSnapshotDiagnosticPath), { recursive: true });
      const tempPath = `${this.restoreSnapshotDiagnosticPath}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tempPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
      await fsp.rename(tempPath, this.restoreSnapshotDiagnosticPath);
    } catch (error) {
      console.error("failed to write manager restore snapshot diagnostic", error);
    }
  }

  async diagnosticFromLastSnapshot(baseDiagnostic) {
    const last = await this.readRestoreSnapshotDiagnostic();
    if (!last) {
      return baseDiagnostic;
    }
    return {
      ...baseDiagnostic,
      lastDiagnosticPath: this.restoreSnapshotDiagnosticPath,
      clearedAt: last.clearedAt || null,
      clearedByPid: Number.isInteger(last.clearedByPid) ? last.clearedByPid : null,
      clearedByReason: last.clearedByReason || null,
      previousSnapshotSummary: last.previousSnapshotSummary || null,
    };
  }

  async clearRestoreSnapshot(options = {}) {
    const {
      reason = "cleared",
      action = "clear",
      writeDiagnostic = true,
    } = options;
    let previousSnapshot = null;
    let previousSnapshotReadError = null;
    try {
      previousSnapshot = JSON.parse(await fsp.readFile(this.restoreSnapshotPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        previousSnapshotReadError = {
          code: error.code || "RESTORE_SNAPSHOT_READ_ERROR",
          message: error.message,
        };
      }
    }

    if (writeDiagnostic && (previousSnapshot || previousSnapshotReadError)) {
      await this.writeRestoreSnapshotDiagnostic({
        version: RESTORE_SNAPSHOT_VERSION,
        status: "cleared",
        path: this.restoreSnapshotPath,
        diagnosticPath: this.restoreSnapshotDiagnosticPath,
        clearedAt: nowIso(),
        clearedByPid: process.pid,
        clearedByReason: reason,
        lastAction: action,
        previousSnapshotSummary: previousSnapshot ? this.restoreSnapshotSummary(previousSnapshot) : null,
        previousSnapshotReadError,
      });
    }

    try {
      await fsp.rm(this.restoreSnapshotPath, { force: true });
    } catch (error) {
      console.error("failed to clear manager restore snapshot", error);
    }
  }

  async writeRestoreSnapshot(reason = "active-runtime", action = "maintain") {
    const instances = this.restoreCandidates();
    if (instances.length === 0) {
      await this.clearRestoreSnapshot({ reason: "empty", action });
      return { written: false, reason: "empty", instances: [] };
    }

    const timestamp = nowIso();
    const snapshot = {
      version: RESTORE_SNAPSHOT_VERSION,
      reason,
      createdAt: timestamp,
      updatedAt: timestamp,
      ownerPid: process.pid,
      sourcePid: process.pid,
      lastAction: action,
      lastReason: reason,
      instances,
    };
    await fsp.mkdir(path.dirname(this.restoreSnapshotPath), { recursive: true });
    const tempPath = `${this.restoreSnapshotPath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await fsp.rename(tempPath, this.restoreSnapshotPath);
    return {
      written: true,
      reason,
      instances: instances.map((instance) => instance.id),
    };
  }

  queueRestoreSnapshotTask(task) {
    const queued = this.restoreSnapshotWritePromise.then(task, task);
    this.restoreSnapshotWritePromise = queued.catch(() => {});
    return queued;
  }

  async maintainRestoreSnapshot(reason = "active-runtime", action = "maintain") {
    try {
      return await this.queueRestoreSnapshotTask(() => this.writeRestoreSnapshot(reason, action));
    } catch (error) {
      console.error("failed to update manager restore snapshot", error);
      return { written: false, reason: "error", error };
    }
  }

  async discardRestoreSnapshot(reason = "cleared", action = "discard") {
    try {
      return await this.queueRestoreSnapshotTask(async () => {
        await this.clearRestoreSnapshot({ reason, action });
        return { written: false, reason, instances: [] };
      });
    } catch (error) {
      console.error("failed to clear manager restore snapshot", error);
      return { written: false, reason: "error", error };
    }
  }

  async saveRestoreSnapshotForShutdown(reason) {
    if (!RESTORE_SHUTDOWN_REASONS.has(reason)) {
      await this.discardRestoreSnapshot(reason, "shutdown");
      return;
    }

    await this.maintainRestoreSnapshot(reason, "shutdown");
  }

  async readRestoreSnapshot() {
    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(this.restoreSnapshotPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.error("failed to read manager restore snapshot", error);
        return {
          snapshot: null,
          diagnostic: {
            status: "read-error",
            path: this.restoreSnapshotPath,
            error: {
              code: error.code || "RESTORE_SNAPSHOT_READ_ERROR",
              message: error.message,
            },
          },
        };
      }
      console.info("manager restore snapshot missing", { path: this.restoreSnapshotPath });
      return {
        snapshot: null,
        diagnostic: await this.diagnosticFromLastSnapshot({
          status: "missing",
          path: this.restoreSnapshotPath,
        }),
      };
    }

    if (
      parsed?.version !== RESTORE_SNAPSHOT_VERSION ||
      !RESTORE_SNAPSHOT_REASONS.has(parsed.reason) ||
      !Array.isArray(parsed.instances)
    ) {
      await this.clearRestoreSnapshot({ reason: "invalid", action: "read" });
      console.warn("manager restore snapshot invalid", { path: this.restoreSnapshotPath });
      return {
        snapshot: null,
        diagnostic: await this.diagnosticFromLastSnapshot({
          status: "invalid",
          path: this.restoreSnapshotPath,
        }),
      };
    }

    if (parsed.instances.length === 0) {
      await this.clearRestoreSnapshot({ reason: "empty", action: "read" });
      console.info("manager restore snapshot empty", { path: this.restoreSnapshotPath });
      return {
        snapshot: null,
        diagnostic: await this.diagnosticFromLastSnapshot({
          status: "empty",
          path: this.restoreSnapshotPath,
        }),
      };
    }

    return {
      snapshot: parsed,
      diagnostic: {
        status: "ready",
        path: this.restoreSnapshotPath,
        reason: parsed.reason,
        instanceCount: parsed.instances.length,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        ownerPid: parsed.ownerPid,
        sourcePid: parsed.sourcePid,
        lastAction: parsed.lastAction,
        lastReason: parsed.lastReason,
      },
    };
  }

  recordRestoreFailure(id, error) {
    const instance = this.registry.get(id);
    if (!instance) {
      return;
    }

    const runtime = this.runtime.get(id) || {
      status: "stopped",
      child: null,
      pid: null,
      workerPort: null,
      startedAt: null,
      lastHeartbeatAt: null,
      lastError: null,
      intentionalStop: true,
      preserveRestoreSnapshot: false,
      events: [],
    };
    runtime.status = "stopped";
    runtime.lastError = {
      code: error.code || "RESTORE_FAILED",
      message: error.message || "worker restore failed",
    };
    event(runtime, "restore-failed", { error: runtime.lastError });
    this.runtime.set(id, runtime);
  }

  async restoreInstancesFromSnapshot() {
    if (!this.restorePromise) {
      this.restorePromise = (async () => {
        const { snapshot, diagnostic } = await this.readRestoreSnapshot();
        if (!snapshot) {
          return { restored: [], skipped: [], failed: [], diagnostic };
        }

        await this.clearRestoreSnapshot({ reason: "restore-consumed", action: "restore" });

        const restored = [];
        const skipped = [];
        const failed = [];
        const ids = [
          ...new Set(
            snapshot.instances
              .map((item) => (typeof item?.id === "string" ? item.id : ""))
              .filter(Boolean),
          ),
        ];

        for (const id of ids) {
          const instance = this.registry.getInternal(id);
          if (!instance) {
            skipped.push({ id, reason: "missing" });
            continue;
          }
          if (!instance.enabled) {
            skipped.push({ id, reason: "disabled" });
            this.recordRestoreFailure(id, managerError(`instance is disabled: ${id}`, "INSTANCE_DISABLED", 409));
            continue;
          }

          try {
            await this.startInstance(id);
            restored.push(id);
          } catch (error) {
            failed.push({
              id,
              error: {
                code: error.code || "RESTORE_FAILED",
                message: error.message || "worker restore failed",
              },
            });
            this.recordRestoreFailure(id, error);
          }
        }

        const result = {
          restored,
          skipped,
          failed,
          diagnostic: {
            ...diagnostic,
            status: "processed",
          },
        };
        if (restored.length > 0 || skipped.length > 0 || failed.length > 0) {
          console.info("manager restore snapshot processed", result);
        }
        return result;
      })().finally(() => {
        this.restorePromise = null;
      });
    }

    return this.restorePromise;
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
      await this.maintainRestoreSnapshot("active-runtime", "start-reused");
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
      stderrTail: "",
      health: {
        overall: "unhealthy",
        worker: { status: "starting", lastHeartbeatAt: null },
      },
      intentionalStop: false,
      preserveRestoreSnapshot: false,
      events: [],
    };
    this.runtime.set(id, runtime);
    event(runtime, "starting", { workerPort });
    await this.maintainRestoreSnapshot("active-runtime", "starting");
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
      await this.maintainRestoreSnapshot("active-runtime", "start-failed");
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
    child.stderr?.on?.("data", (chunk) => {
      runtime.stderrTail = appendOutputTail(runtime.stderrTail, chunk);
    });
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
      await this.maintainRestoreSnapshot("active-runtime", "running");
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
          if (message.protocolVersion !== API_VERSION) {
            finish(
              managerError(
                `worker protocol version mismatch: expected ${API_VERSION}, received ${message.protocolVersion ?? "missing"}`,
                "WORKER_PROTOCOL_MISMATCH",
                502,
              ),
            );
          } else {
            if (runtime && message.health) {
              runtime.health = message.health;
            }
            finish();
          }
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
      if (message.health) {
        runtime.health = {
          ...message.health,
          worker: {
            ...(message.health.worker || {}),
            status: "healthy",
            lastHeartbeatAt: runtime.lastHeartbeatAt,
          },
        };
      }
      if (message.status === "healthy") {
        runtime.lastError = message.health?.transport?.lastError || null;
        let statusChanged = false;
        if (runtime.status !== "starting") {
          runtime.status = "running";
          statusChanged = true;
        }
        event(runtime, "health", {
          status: "healthy",
          overall: runtime.health?.overall || "healthy",
          transport: runtime.health?.transport?.status,
        });
        if (statusChanged) {
          await this.maintainRestoreSnapshot("active-runtime", "health-running");
        }
        return;
      }
      if (message.status === "stopped") {
        runtime.intentionalStop = true;
        runtime.status = "stopped";
        runtime.lastError = null;
        event(runtime, "health", { status: "stopped", reason: message.reason });
        if (!runtime.preserveRestoreSnapshot) {
          await this.maintainRestoreSnapshot("active-runtime", "health-stopped");
        }
        return;
      }

      runtime.lastError = message.error || {
        code: "WORKER_UNHEALTHY",
        message: "worker reported unhealthy status",
      };
      runtime.status = "unhealthy";
      runtime.health = {
        ...(runtime.health || {}),
        overall: "unhealthy",
        worker: {
          status: "unhealthy",
          lastHeartbeatAt: runtime.lastHeartbeatAt,
        },
      };
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
    const stderrTail = runtime.stderrTail.trim();
    runtime.child = null;
    runtime.pid = null;
    runtime.workerPort = null;
    runtime.status = stopped ? "stopped" : "unhealthy";
    runtime.lastError = stopped
      ? null
      : {
          code: "WORKER_EXITED",
          message: `worker exited (code ${code ?? "null"}, signal ${signal ?? "null"})`,
          ...(stderrTail ? { stderrTail } : {}),
        };
    event(runtime, "exit", {
      code,
      signal,
      stopped,
      ...(stderrTail ? { stderrTail } : {}),
    });
    if (!runtime.preserveRestoreSnapshot) {
      void this.maintainRestoreSnapshot("active-runtime", "worker-exit");
    }
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
    void this.maintainRestoreSnapshot("active-runtime", "worker-unhealthy");
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
      runtime.health = {
        ...(runtime.health || {}),
        overall: "unhealthy",
        worker: {
          status: "unhealthy",
          lastHeartbeatAt: runtime.lastHeartbeatAt,
          lastError: runtime.lastError,
        },
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
    runtime.preserveRestoreSnapshot = RESTORE_PRESERVING_STOP_REASONS.has(reason);
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
    runtime.health = {
      ...(runtime.health || {}),
      overall: reason === "unhealthy" ? "unhealthy" : "stopped",
      worker: {
        status: reason === "unhealthy" ? "unhealthy" : "stopped",
        lastHeartbeatAt: runtime.lastHeartbeatAt,
      },
    };
    if (!["unhealthy", "start-failed"].includes(reason)) {
      runtime.lastError = null;
    }
    event(runtime, runtime.status, { reason });
    if (!RESTORE_PRESERVING_STOP_REASONS.has(reason)) {
      await this.maintainRestoreSnapshot("active-runtime", `stop:${reason}`);
    }

    return {
      instance: this.publicInstance(id),
      runtime: publicRuntime(runtime),
    };
  }

  async refreshInstance(id) {
    await this.stopInstance(id, "refresh");
    return this.startInstance(id);
  }

  async restartInstance(id) {
    const instance = this.registry.getInternal(id);
    if (!instance) {
      throw managerError(`instance not found: ${id}`, "INSTANCE_NOT_FOUND", 404);
    }
    this.ensureRunnable(instance);

    const previousStatus = this.runtime.get(id)?.status || "stopped";
    if (previousStatus === "running") {
      return {
        restarted: false,
        action: "not-needed",
        previousStatus,
        instance: this.publicInstance(id),
        runtime: publicRuntime(this.runtime.get(id)),
      };
    }
    if (previousStatus === "starting" || previousStatus === "stopping") {
      throw managerError(
        `instance lifecycle transition is already in progress: ${id} (${previousStatus})`,
        "INSTANCE_TRANSITION_IN_PROGRESS",
        409,
      );
    }
    if (previousStatus !== "stopped" && previousStatus !== "unhealthy") {
      throw managerError(
        `instance restart is not allowed from status ${previousStatus}: ${id}`,
        "INSTANCE_RESTART_NOT_ALLOWED",
        409,
      );
    }

    if (previousStatus === "unhealthy") {
      await this.stopInstance(id, "restart-recovery");
    }
    const result = await this.startInstance(id);
    return {
      restarted: true,
      action: "restarted",
      previousStatus,
      ...result,
    };
  }

  async deleteInstance(id) {
    await this.stopInstance(id, "delete");
    const removed = this.registry.delete(id);
    this.runtime.delete(id);
    await this.maintainRestoreSnapshot("active-runtime", "delete");
    await this.memoryStore.deleteInstance(id);
    return removed;
  }

  resolveInstanceId(instanceId) {
    return this.registry.resolveId(instanceId);
  }

  async callInstance(instanceId, pathName, payload, headers = {}, options = {}) {
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
    const operation = {
      operationId: payload?.operationId || `manager-${Date.now()}`,
      deadlineAt: Number.isInteger(payload?.deadlineAt)
        ? payload.deadlineAt
        : Date.now() + (payload?.timeoutMs || 30_000),
    };
    const controller = new AbortController();
    let deadlineExpired = false;
    const abortFromUpstream = () => {
      if (!controller.signal.aborted) {
        controller.abort(operationErrorForSignal(options.signal, operation, {
          layer: "manager",
          phase: "worker-request",
        }));
      }
    };
    if (options.signal?.aborted) abortFromUpstream();
    else options.signal?.addEventListener("abort", abortFromUpstream, { once: true });
    const timer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort(operationError("worker response cleanup grace exceeded", {
        code: "OPERATION_DEADLINE_EXCEEDED",
        statusCode: 408,
        operationId: operation.operationId,
        layer: "manager",
        phase: "worker-response",
      }));
    }, remainingOperationMs(operation) + 2_000);
    timer.unref?.();
    let response;
    let parsed;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Remote-Debug-Source": headers["x-remote-debug-source"] || headers["X-Remote-Debug-Source"] || "http-api",
          "X-Remote-Debug-Operation-Id": operation.operationId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { ok: false, raw: text };
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw operationErrorForSignal(options.signal, operation, {
          layer: "manager",
          phase: "worker-request",
        });
      }
      if (deadlineExpired || controller.signal.reason?.code === "OPERATION_DEADLINE_EXCEEDED") {
        throw controller.signal.reason;
      }
      throw operationError(`worker is unavailable for instance ${resolvedId}: ${error.message}`, {
        code: "WORKER_UNAVAILABLE",
        statusCode: 502,
        operationId: operation.operationId,
        layer: "manager",
        phase: "worker-request",
        retriable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromUpstream);
    }

    if (!response.ok || parsed.ok === false) {
      const error = operationError(
        parsed.error?.message || `worker request failed with HTTP ${response.status}`,
        {
          code: parsed.error?.code || "WORKER_REQUEST_FAILED",
          statusCode: response.status || 502,
          operationId: parsed.error?.operationId || operation.operationId,
          layer: parsed.error?.layer || "worker",
          phase: parsed.error?.phase || "request",
          retriable: parsed.error?.retriable,
          cause: parsed.error?.cause,
          details: parsed.details,
        },
      );
      error.payload = parsed;
      throw error;
    }

    return {
      ...parsed,
      instanceId: resolvedId,
    };
  }

  async shutdownAll(reason = "manager-shutdown") {
    try {
      await this.saveRestoreSnapshotForShutdown(reason);
    } catch (error) {
      console.error("failed to save manager restore snapshot", error);
    }
    clearInterval(this.monitorTimer);
    await Promise.all([...this.runtime.keys()].map((id) => this.stopInstance(id, reason)));
  }
}
