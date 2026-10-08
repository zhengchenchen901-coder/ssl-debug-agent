import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InstanceRegistry } from "../instance-registry.js";
import { WorkerManager } from "../worker-manager.js";

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

class FakeWorkerProcess extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.connected = true;
    this.exitCode = null;
    this.signalCode = null;
    this.sent = [];
    this.stdout = new EventEmitter();
    this.stdout.resume = () => {};
    this.stderr = new EventEmitter();
    this.stderr.resume = () => {};
  }

  send(message) {
    this.sent.push(message);
    if (message?.type === "shutdown") {
      this.connected = false;
      setImmediate(() => {
        this.emit("message", {
          type: "health",
          status: "stopped",
          reason: message.reason,
        });
        this.exitCode = 0;
        this.emit("exit", 0, null);
      });
    }
    return true;
  }

  kill() {
    this.connected = false;
    if (this.exitCode === null && this.signalCode === null) {
      this.signalCode = "SIGTERM";
      setImmediate(() => {
        this.emit("exit", null, "SIGTERM");
      });
    }
    return true;
  }
}

test("registry migrates v1 instance records to v3 manager config", async () => {
  const dir = await tempDir("remote-debug-registry-");
  const registryPath = path.join(dir, "instances.json");
  await fs.writeFile(
    registryPath,
    JSON.stringify(
      {
        version: 1,
        defaultInstanceId: "default",
        instances: [
          {
            id: "default",
            name: "默认实例",
            enabled: true,
            host: "prod.example.com",
            port: 22,
            username: "app",
            privateKeyPath: "C:\\Users\\you\\.ssh\\id_ed25519",
            agentPort: 4444,
            approvedCommands: { enabled: true, timeoutMs: 30_000, maxTimeoutMs: 300_000 },
          },
        ],
      },
      null,
      2,
    ),
  );

  const registry = new InstanceRegistry({ cwd: dir, registryPath, env: {} });

  assert.equal(registry.registry.version, 3);
  assert.equal(registry.managerConfig().workerPortRange.start, 4400);
  assert.equal(registry.get("default").name, "默认实例");
  assert.equal(registry.get("default").passphrase, undefined);
  assert.equal(registry.getInternal("default").preferredWorkerPort, 4444);
  assert.equal(registry.getInternal("default").approvedCommands.executionTimeoutMs, 30_000);
  assert.equal(registry.getInternal("default").approvedCommands.maxExecutionTimeoutMs, 300_000);
  assert.equal(registry.getInternal("default").approvedCommands.timeoutMs, undefined);
});

test("registry creates a default instance from env when no registry exists", async () => {
  const dir = await tempDir("remote-debug-env-registry-");
  const registryPath = path.join(dir, "instances.json");
  const registry = new InstanceRegistry({
    cwd: dir,
    registryPath,
    env: {
      REMOTE_DEBUG_HOST: "staging.example.com",
      REMOTE_DEBUG_USER: "app",
      REMOTE_DEBUG_PRIVATE_KEY_PATH: "C:\\Users\\you\\.ssh\\staging",
      REMOTE_DEBUG_APPROVED_COMMANDS: "1",
    },
  });

  assert.equal(registry.registry.defaultInstanceId, "default");
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("default").host, "staging.example.com");
  assert.equal(registry.get("default").approvedCommands.enabled, true);
});

test("registry preserves per-instance MongoDB profile metadata", async () => {
  const dir = await tempDir("remote-debug-mongodb-registry-");
  const registry = new InstanceRegistry({
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    env: {},
  });
  const created = registry.create({
    id: "test-server",
    name: "test-server",
    host: "test.example.com",
    port: 22,
    username: "app",
    privateKeyPath: "C:\\test",
    mongodb: {
      enabled: true,
      configPath: "/home/github/app/config.json",
      driverPath: "/home/github/app/node_modules/mongodb",
      configProfile: "test",
      uriKey: "url",
      database: "yennefer",
    },
  });

  assert.equal(created.mongodb.configProfile, "test");
  assert.equal(created.mongodb.database, "yennefer");
  assert.equal(created.mongodb.uri, undefined);
  assert.equal(registry.getInternal("test-server").mongodb.driverPath, "/home/github/app/node_modules/mongodb");
  registry.create({
    id: "default", name: "production", host: "prod.example.com",
    username: "app", privateKeyPath: "C:\\test", mongodb: created.mongodb,
  });
  const defaultBefore = registry.getInternal("default");
  registry.update("test-server", { mongodb: {
    writeEnabled: true,
    allowedDatabases: ["yennefer"],
    allowedCollections: ["Customer", "CustomerRestaurantRelation"],
    maxImportBatchDocuments: 1500,
  } });
  const reopened = new InstanceRegistry({ cwd: dir, registryPath: path.join(dir, "instances.json"), env: {} });
  assert.deepEqual(reopened.get("test-server").mongodb, {
    ...created.mongodb,
    writeEnabled: true,
    allowedDatabases: ["yennefer"],
    allowedCollections: ["Customer", "CustomerRestaurantRelation"],
    maxImportBatchDocuments: 1500,
  });
  assert.deepEqual(reopened.getInternal("default"), defaultBefore);
  reopened.update("test-server", { mongodb: {
    configPath: "/home/github/app/shared/config.json",
    configProfile: "development",
    database: "",
  } });
  const afterConnectionEdit = new InstanceRegistry({ cwd: dir, registryPath: path.join(dir, "instances.json"), env: {} });
  assert.deepEqual(afterConnectionEdit.get("test-server").mongodb, {
    ...reopened.get("test-server").mongodb,
    configPath: "/home/github/app/shared/config.json",
    configProfile: "development",
    database: "",
    writeEnabled: true,
    allowedDatabases: ["yennefer"],
    allowedCollections: ["Customer", "CustomerRestaurantRelation"],
    maxImportBatchDocuments: 1500,
  });
  assert.deepEqual(afterConnectionEdit.getInternal("default"), defaultBefore);
});

test("registry preserves labeled per-instance source roots", async () => {
  const dir = await tempDir("remote-debug-source-roots-registry-");
  const registry = new InstanceRegistry({
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    env: {},
  });
  const created = registry.create({
    id: "test-server",
    name: "test-server",
    host: "test.example.com",
    port: 22,
    username: "app",
    privateKeyPath: "C:\\test",
    sourceRoots: {
      be: "/home/github/app/current/",
      h5: "/var/www/new_od_order",
      mgr: "/var/www/ner_od_backoffice",
    },
  });

  assert.deepEqual(created.sourceRoots, {
    be: "/home/github/app/current",
    h5: "/var/www/new_od_order",
    mgr: "/var/www/ner_od_backoffice",
  });
  assert.deepEqual(registry.getInternal("test-server").sourceRoots, created.sourceRoots);
});

test("worker manager forwards MongoDB profile metadata to the selected worker", async () => {
  const dir = await tempDir("remote-debug-mongodb-worker-");
  const registry = new InstanceRegistry({
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    env: {},
  });
  registry.create({
    id: "default",
    name: "default",
    host: "prod.example.com",
    port: 22,
    username: "app",
    privateKeyPath: "C:\\prod",
    sourceRoots: {
      be: "/home/github/app/current",
      h5: "/var/www/new_od_order",
    },
    mongodb: {
      enabled: true,
      configPath: "/home/github/app/config.json",
      driverPath: "/home/github/app/node_modules/mongodb",
      configProfile: "production",
      uriKey: "url",
      database: "yenneferbak",
    },
  });
  let workerEnv;
  const child = new FakeWorkerProcess(4321);
  const manager = new WorkerManager({
    registry,
    managerPort: 4343,
    cwd: dir,
    canBindPort: async () => true,
    forkWorker: (_entryPath, options) => {
      workerEnv = options.env;
      setImmediate(() => child.emit("message", { type: "ready", ok: true, protocolVersion: 2 }));
      return child;
    },
  });

  try {
    await manager.startInstance("default");
    assert.deepEqual(JSON.parse(workerEnv.REMOTE_DEBUG_MONGODB_CONFIG), {
      enabled: true,
      configPath: "/home/github/app/config.json",
      driverPath: "/home/github/app/node_modules/mongodb",
      configProfile: "production",
      uriKey: "url",
      database: "yenneferbak",
    });
    assert.deepEqual(JSON.parse(workerEnv.REMOTE_DEBUG_SOURCE_ROOTS), {
      be: "/home/github/app/current",
      h5: "/var/www/new_od_order",
    });
  } finally {
    await manager.shutdownAll();
  }
});

test("registry drops preferred worker ports outside the manager range", async () => {
  const dir = await tempDir("remote-debug-registry-range-");
  const registryPath = path.join(dir, "instances.json");
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      version: 2,
      manager: { workerPortRange: { start: 4400, end: 4499 } },
      defaultInstanceId: "default",
      instances: [
        {
          id: "default",
          name: "default",
          host: "prod.example.com",
          port: 22,
          username: "app",
          privateKeyPath: "C:\\Users\\you\\.ssh\\id_ed25519",
          preferredWorkerPort: 4343,
        },
      ],
    }),
  );

  const registry = new InstanceRegistry({ cwd: dir, registryPath, env: {} });

  assert.equal(registry.getInternal("default").preferredWorkerPort, undefined);
  const saved = JSON.parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(saved.instances[0].preferredWorkerPort, undefined);
});

test("registry does not persist manager port as an instance worker port", async () => {
  const dir = await tempDir("remote-debug-registry-manager-port-");
  const registryPath = path.join(dir, "instances.json");
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      version: 2,
      manager: { workerPortRange: { start: 4343, end: 4344 } },
      defaultInstanceId: "",
      instances: [],
    }),
  );
  const registry = new InstanceRegistry({
    cwd: dir,
    registryPath,
    env: {},
    managerPort: 4343,
  });

  const created = registry.create({
    id: "a",
    name: "a",
    host: "a.example.com",
    port: 22,
    username: "app",
    privateKeyPath: "C:\\a",
    preferredWorkerPort: 4343,
  });
  assert.equal(created.preferredWorkerPort, undefined);

  const valid = registry.update("a", {
    preferredWorkerPort: 4344,
  });
  assert.equal(valid.preferredWorkerPort, 4344);

  const managerPort = registry.update("a", {
    preferredWorkerPort: 4343,
  });
  assert.equal(managerPort.preferredWorkerPort, undefined);
});

test("worker manager requires instanceId only when multiple instances are configured", async () => {
  const dir = await tempDir("remote-debug-worker-route-");
  const registryPath = path.join(dir, "instances.json");
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      version: 2,
      manager: { workerPortRange: { start: 4500, end: 4510 } },
      defaultInstanceId: "a",
      instances: [
        {
          id: "a",
          name: "a",
          host: "a.example.com",
          port: 22,
          username: "app",
          privateKeyPath: "C:\\a",
        },
        {
          id: "b",
          name: "b",
          host: "b.example.com",
          port: 22,
          username: "app",
          privateKeyPath: "C:\\b",
        },
      ],
    }),
  );
  const registry = new InstanceRegistry({ cwd: dir, registryPath, env: {} });
  const manager = new WorkerManager({ registry, managerPort: 4343, cwd: dir });

  assert.throws(
    () => manager.resolveInstanceId(),
    (error) => error.code === "INSTANCE_ID_REQUIRED" && error.instances.length === 2,
  );

  assert.equal(manager.resolveInstanceId("b"), "b");
  await manager.shutdownAll();
});

test("worker manager rejects a worker without protocolVersion 2", async () => {
  const dir = await tempDir("remote-debug-worker-protocol-");
  const registry = new InstanceRegistry({
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    env: {
      REMOTE_DEBUG_HOST: "a.example.com",
      REMOTE_DEBUG_USER: "app",
      REMOTE_DEBUG_PRIVATE_KEY_PATH: "C:\\a",
    },
  });
  const manager = new WorkerManager({ registry, managerPort: 4343, cwd: dir });
  const child = new FakeWorkerProcess(1234);
  const ready = manager.waitForReady("default", child, 1_000);
  setImmediate(() => child.emit("message", { type: "ready", ok: true, protocolVersion: 1 }));

  await assert.rejects(ready, (error) => error.code === "WORKER_PROTOCOL_MISMATCH");
  await manager.shutdownAll();
});

test("worker manager restart recovers stopped instances without disrupting running ones", async () => {
  const dir = await tempDir("remote-debug-worker-restart-");
  const registry = new InstanceRegistry({
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    env: {
      REMOTE_DEBUG_HOST: "a.example.com",
      REMOTE_DEBUG_USER: "app",
      REMOTE_DEBUG_PRIVATE_KEY_PATH: "C:\\a",
    },
  });
  let nextPid = 2000;
  const children = [];
  const manager = new WorkerManager({
    registry,
    managerPort: 4343,
    cwd: dir,
    canBindPort: async () => true,
    forkWorker: () => {
      const child = new FakeWorkerProcess(nextPid += 1);
      children.push(child);
      setImmediate(() => child.emit("message", { type: "ready", ok: true, protocolVersion: 2 }));
      return child;
    },
  });

  try {
    const recovered = await manager.restartInstance("default");
    assert.equal(recovered.restarted, true);
    assert.equal(recovered.previousStatus, "stopped");
    assert.equal(recovered.runtime.status, "running");
    assert.equal(children.length, 1);

    const running = await manager.restartInstance("default");
    assert.equal(running.restarted, false);
    assert.equal(running.action, "not-needed");
    assert.equal(children.length, 1);

    await manager.stopInstance("default", "stopped");
    const restarted = await manager.restartInstance("default");
    assert.equal(restarted.restarted, true);
    assert.equal(restarted.previousStatus, "stopped");
    assert.equal(restarted.runtime.status, "running");
    assert.equal(children.length, 2);
  } finally {
    await manager.shutdownAll();
  }
});

test("worker manager preserves bounded stderr when a worker exits", async () => {
  const dir = await tempDir("remote-debug-worker-stderr-");
  const registry = new InstanceRegistry({
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    env: {
      REMOTE_DEBUG_HOST: "a.example.com",
      REMOTE_DEBUG_USER: "app",
      REMOTE_DEBUG_PRIVATE_KEY_PATH: "C:\\a",
    },
  });
  const child = new FakeWorkerProcess(1235);
  const manager = new WorkerManager({
    registry,
    managerPort: 4343,
    cwd: dir,
    canBindPort: async () => true,
    forkWorker: () => {
      setImmediate(() => child.emit("message", { type: "ready", ok: true, protocolVersion: 2 }));
      return child;
    },
  });

  try {
    await manager.startInstance("default");
    child.stderr.emit("data", Buffer.from(`${"x".repeat(5000)}EADDRINUSE 127.0.0.1:4400`));
    child.exitCode = 1;
    child.emit("exit", 1, null);

    const runtime = manager.runtimeFor("default");
    assert.equal(runtime.status, "unhealthy");
    assert.equal(runtime.lastError.code, "WORKER_EXITED");
    assert.match(runtime.lastError.stderrTail, /EADDRINUSE 127\.0\.0\.1:4400$/);
    assert.ok(runtime.lastError.stderrTail.length <= 4096);
    assert.equal(runtime.events.at(-1).stderrTail, runtime.lastError.stderrTail);
  } finally {
    await manager.shutdownAll();
  }
});

test("worker manager allocates only from the manager range and excludes manager port", async () => {
  const dir = await tempDir("remote-debug-worker-port-");
  const registryPath = path.join(dir, "instances.json");
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      version: 2,
      manager: { workerPortRange: { start: 4501, end: 4502 } },
      defaultInstanceId: "a",
      instances: [
        {
          id: "a",
          name: "a",
          host: "a.example.com",
          port: 22,
          username: "app",
          privateKeyPath: "C:\\a",
          preferredWorkerPort: 4501,
        },
      ],
    }),
  );
  const checkedPorts = [];
  const registry = new InstanceRegistry({ cwd: dir, registryPath, env: {} });
  const manager = new WorkerManager({
    registry,
    managerPort: 4501,
    cwd: dir,
    canBindPort: async (port) => {
      checkedPorts.push(port);
      return true;
    },
  });

  try {
    const port = await manager.allocatePort(registry.getInternal("a"));

    assert.equal(port, 4502);
    assert.deepEqual(checkedPorts, [4502]);
  } finally {
    await manager.shutdownAll();
  }
});

test("worker manager ignores preferred worker ports outside the manager range", async () => {
  const dir = await tempDir("remote-debug-worker-port-outside-");
  const registryPath = path.join(dir, "instances.json");
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      version: 2,
      manager: { workerPortRange: { start: 4510, end: 4511 } },
      defaultInstanceId: "a",
      instances: [
        {
          id: "a",
          name: "a",
          host: "a.example.com",
          port: 22,
          username: "app",
          privateKeyPath: "C:\\a",
          preferredWorkerPort: 4999,
        },
      ],
    }),
  );
  const checkedPorts = [];
  const registry = new InstanceRegistry({ cwd: dir, registryPath, env: {} });
  const manager = new WorkerManager({
    registry,
    managerPort: 4509,
    cwd: dir,
    canBindPort: async (port) => {
      checkedPorts.push(port);
      return true;
    },
  });

  try {
    const port = await manager.allocatePort(registry.getInternal("a"));

    assert.equal(port, 4510);
    assert.deepEqual(checkedPorts, [4510]);
  } finally {
    await manager.shutdownAll();
  }
});

test("worker manager stops workers after stopped health and reuses released ports", async () => {
  const dir = await tempDir("remote-debug-worker-stop-");
  const registryPath = path.join(dir, "instances.json");
  const restoreSnapshotPath = path.join(dir, ".remote-debug", "manager-runtime.json");
  const restoreSnapshotDiagnosticPath = path.join(dir, ".remote-debug", "manager-runtime.last.json");
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      version: 2,
      manager: {
        workerPortRange: { start: 4520, end: 4520 },
        healthIntervalMs: 1000,
        startTimeoutMs: 1000,
        stopTimeoutMs: 1000,
      },
      defaultInstanceId: "a",
      instances: [
        {
          id: "a",
          name: "a",
          host: "a.example.com",
          port: 22,
          username: "app",
          privateKeyPath: "C:\\a",
        },
      ],
    }),
  );

  const workers = [];
  let nextPid = 1000;
  const registry = new InstanceRegistry({ cwd: dir, registryPath, env: {} });
  const manager = new WorkerManager({
    registry,
    managerPort: 4343,
    cwd: dir,
    restoreSnapshotPath,
    restoreSnapshotDiagnosticPath,
    canBindPort: async (port) => port === 4520,
    forkWorker: () => {
      const child = new FakeWorkerProcess(nextPid);
      nextPid += 1;
      workers.push(child);
      setImmediate(() => {
        child.emit("message", { type: "ready", ok: true, protocolVersion: 2 });
      });
      return child;
    },
  });

  try {
    const started = await manager.startInstance("a");
    assert.equal(started.runtime.status, "running");
    assert.equal(started.runtime.workerPort, 4520);
    assert.equal(started.runtime.pid, 1000);
    const runningSnapshot = JSON.parse(await fs.readFile(restoreSnapshotPath, "utf8"));
    assert.equal(runningSnapshot.reason, "active-runtime");
    assert.equal(runningSnapshot.ownerPid, process.pid);
    assert.equal(runningSnapshot.sourcePid, process.pid);
    assert.equal(runningSnapshot.lastAction, "running");
    assert.equal(runningSnapshot.lastReason, "active-runtime");
    assert.ok(runningSnapshot.updatedAt);
    assert.deepEqual(runningSnapshot.instances.map((item) => item.id), ["a"]);

    const stopped = await manager.stopInstance("a", "stopped");
    assert.deepEqual(workers[0].sent[0], { type: "shutdown", reason: "stopped" });
    assert.equal(stopped.instance.id, "a");
    assert.equal(stopped.runtime.status, "stopped");
    assert.equal(stopped.runtime.pid, null);
    assert.equal(stopped.runtime.workerPort, null);
    assert.equal(registry.get("a").id, "a");
    assert.ok(
      stopped.runtime.events.some((item) => item.type === "health" && item.status === "stopped"),
    );
    await assert.rejects(() => fs.readFile(restoreSnapshotPath, "utf8"), /ENOENT/);
    const lastSnapshotDiagnostic = JSON.parse(await fs.readFile(restoreSnapshotDiagnosticPath, "utf8"));
    assert.equal(lastSnapshotDiagnostic.status, "cleared");
    assert.equal(lastSnapshotDiagnostic.clearedByPid, process.pid);
    assert.equal(lastSnapshotDiagnostic.clearedByReason, "empty");
    assert.equal(lastSnapshotDiagnostic.previousSnapshotSummary.instanceCount, 1);
    assert.deepEqual(lastSnapshotDiagnostic.previousSnapshotSummary.instanceIds, ["a"]);

    const diagnosticManager = new WorkerManager({
      registry,
      managerPort: 4343,
      cwd: dir,
      restoreSnapshotPath,
      restoreSnapshotDiagnosticPath,
    });
    try {
      const checked = await diagnosticManager.restoreInstancesFromSnapshot();
      assert.equal(checked.diagnostic.status, "missing");
      assert.equal(checked.diagnostic.clearedByReason, "empty");
      assert.equal(checked.diagnostic.clearedByPid, process.pid);
      assert.deepEqual(checked.diagnostic.previousSnapshotSummary.instanceIds, ["a"]);
    } finally {
      await diagnosticManager.shutdownAll();
    }

    const listed = manager.publicInstances();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].runtime.status, "stopped");

    const restarted = await manager.startInstance("a");
    assert.equal(restarted.runtime.status, "running");
    assert.equal(restarted.runtime.workerPort, 4520);
    assert.equal(workers.length, 2);
  } finally {
    await manager.shutdownAll();
  }
});

test("worker manager restores running workers from a maintained runtime snapshot", async () => {
  const dir = await tempDir("remote-debug-worker-restore-");
  const registryPath = path.join(dir, "instances.json");
  const restoreSnapshotPath = path.join(dir, ".remote-debug", "manager-runtime.json");
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      version: 2,
      manager: {
        workerPortRange: { start: 4540, end: 4540 },
        healthIntervalMs: 1000,
        startTimeoutMs: 1000,
        stopTimeoutMs: 1000,
      },
      defaultInstanceId: "a",
      instances: [
        {
          id: "a",
          name: "a",
          host: "a.example.com",
          port: 22,
          username: "app",
          privateKeyPath: "C:\\a",
        },
      ],
    }),
  );

  const workers = [];
  let nextPid = 2000;
  const forkWorker = () => {
    const child = new FakeWorkerProcess(nextPid);
    nextPid += 1;
    workers.push(child);
    setImmediate(() => {
      child.emit("message", { type: "ready", ok: true, protocolVersion: 2 });
    });
    return child;
  };
  const registry = new InstanceRegistry({ cwd: dir, registryPath, env: {} });
  const manager = new WorkerManager({
    registry,
    managerPort: 4343,
    cwd: dir,
    restoreSnapshotPath,
    canBindPort: async (port) => port === 4540,
    forkWorker,
  });

  try {
    const started = await manager.startInstance("a");
    assert.equal(started.runtime.status, "running");

    const snapshot = JSON.parse(await fs.readFile(restoreSnapshotPath, "utf8"));
    assert.equal(snapshot.reason, "active-runtime");
    assert.equal(snapshot.ownerPid, process.pid);
    assert.equal(snapshot.sourcePid, process.pid);
    assert.equal(snapshot.lastAction, "running");
    assert.equal(snapshot.lastReason, "active-runtime");
    assert.ok(snapshot.updatedAt);
    assert.deepEqual(snapshot.instances.map((item) => item.id), ["a"]);
  } finally {
    clearInterval(manager.monitorTimer);
  }

  const nextRegistry = new InstanceRegistry({ cwd: dir, registryPath, env: {} });
  const nextManager = new WorkerManager({
    registry: nextRegistry,
    managerPort: 4343,
    cwd: dir,
    restoreSnapshotPath,
    canBindPort: async (port) => port === 4540,
    forkWorker,
  });

  try {
    const restored = await nextManager.restoreInstancesFromSnapshot();
    assert.deepEqual(restored.restored, ["a"]);
    assert.deepEqual(restored.skipped, []);
    assert.deepEqual(restored.failed, []);
    assert.equal(nextManager.publicInstances()[0].runtime.status, "running");
    assert.equal(nextManager.publicInstances()[0].runtime.pid, 2001);
    const refreshedSnapshot = JSON.parse(await fs.readFile(restoreSnapshotPath, "utf8"));
    assert.equal(refreshedSnapshot.reason, "active-runtime");
    assert.equal(refreshedSnapshot.ownerPid, process.pid);
    assert.equal(refreshedSnapshot.sourcePid, process.pid);
    assert.equal(refreshedSnapshot.lastAction, "running");
    assert.equal(refreshedSnapshot.lastReason, "active-runtime");
    assert.deepEqual(refreshedSnapshot.instances.map((item) => item.id), ["a"]);
  } finally {
    await nextManager.shutdownAll();
  }
});

test("worker manager preserves lease-expiry snapshots while stopping workers", async () => {
  const dir = await tempDir("remote-debug-worker-lease-snapshot-");
  const registryPath = path.join(dir, "instances.json");
  const restoreSnapshotPath = path.join(dir, ".remote-debug", "manager-runtime.json");
  const restoreSnapshotDiagnosticPath = path.join(dir, ".remote-debug", "manager-runtime.last.json");
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      version: 2,
      manager: {
        workerPortRange: { start: 4545, end: 4545 },
        healthIntervalMs: 1000,
        startTimeoutMs: 1000,
        stopTimeoutMs: 1000,
      },
      defaultInstanceId: "a",
      instances: [
        {
          id: "a",
          name: "a",
          host: "a.example.com",
          port: 22,
          username: "app",
          privateKeyPath: "C:\\a",
        },
      ],
    }),
  );

  const workers = [];
  const registry = new InstanceRegistry({ cwd: dir, registryPath, env: {} });
  const manager = new WorkerManager({
    registry,
    managerPort: 4343,
    cwd: dir,
    restoreSnapshotPath,
    restoreSnapshotDiagnosticPath,
    canBindPort: async (port) => port === 4545,
    forkWorker: () => {
      const child = new FakeWorkerProcess(2500);
      workers.push(child);
      setImmediate(() => {
        child.emit("message", { type: "ready", ok: true, protocolVersion: 2 });
      });
      return child;
    },
  });

  try {
    await manager.startInstance("a");
    await manager.shutdownAll("lease-expired");
    const snapshot = JSON.parse(await fs.readFile(restoreSnapshotPath, "utf8"));
    assert.equal(snapshot.reason, "lease-expired");
    assert.equal(snapshot.lastAction, "shutdown");
    assert.equal(snapshot.lastReason, "lease-expired");
    assert.deepEqual(snapshot.instances.map((item) => item.id), ["a"]);
    assert.equal(workers[0].sent[0].reason, "lease-expired");
    await assert.rejects(() => fs.readFile(restoreSnapshotDiagnosticPath, "utf8"), /ENOENT/);
  } finally {
    clearInterval(manager.monitorTimer);
  }
});

test("worker manager does not restore instances stopped before lease expiry", async () => {
  const dir = await tempDir("remote-debug-worker-restore-stopped-");
  const registryPath = path.join(dir, "instances.json");
  const restoreSnapshotPath = path.join(dir, ".remote-debug", "manager-runtime.json");
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      version: 2,
      manager: {
        workerPortRange: { start: 4550, end: 4550 },
        healthIntervalMs: 1000,
        startTimeoutMs: 1000,
        stopTimeoutMs: 1000,
      },
      defaultInstanceId: "a",
      instances: [
        {
          id: "a",
          name: "a",
          host: "a.example.com",
          port: 22,
          username: "app",
          privateKeyPath: "C:\\a",
        },
      ],
    }),
  );

  const registry = new InstanceRegistry({ cwd: dir, registryPath, env: {} });
  const manager = new WorkerManager({
    registry,
    managerPort: 4343,
    cwd: dir,
    restoreSnapshotPath,
    canBindPort: async (port) => port === 4550,
    forkWorker: () => {
      const child = new FakeWorkerProcess(3000);
      setImmediate(() => {
        child.emit("message", { type: "ready", ok: true, protocolVersion: 2 });
      });
      return child;
    },
  });

  try {
    await manager.startInstance("a");
    await manager.stopInstance("a", "stopped");
    await manager.shutdownAll("lease-expired");
    await assert.rejects(() => fs.readFile(restoreSnapshotPath, "utf8"), /ENOENT/);
  } finally {
    await manager.shutdownAll();
  }
});

test("worker manager rejects stop for missing instances", async () => {
  const dir = await tempDir("remote-debug-worker-stop-missing-");
  const registryPath = path.join(dir, "instances.json");
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      version: 2,
      manager: { workerPortRange: { start: 4530, end: 4530 } },
      defaultInstanceId: "",
      instances: [],
    }),
  );
  const registry = new InstanceRegistry({ cwd: dir, registryPath, env: {} });
  const manager = new WorkerManager({ registry, managerPort: 4343, cwd: dir });

  try {
    await assert.rejects(
      () => manager.stopInstance("missing"),
      (error) => error.code === "INSTANCE_NOT_FOUND" && error.statusCode === 404,
    );
  } finally {
    await manager.shutdownAll();
  }
});
