import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InstanceRegistry } from "../instance-registry.js";
import { MemoryStore } from "../memory-store.js";
import { WorkerManager } from "../worker-manager.js";

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function instance(overrides = {}) {
  return {
    id: "a",
    name: "a",
    host: "prod.example.com",
    port: 22,
    username: "app",
    privateKeyPath: "C:\\a",
    enabled: true,
    ...overrides,
  };
}

class FakeWorkerProcess extends EventEmitter {
  constructor(pid = 1000) {
    super();
    this.pid = pid;
    this.connected = true;
    this.exitCode = null;
    this.signalCode = null;
    this.sent = [];
    this.stdout = { resume() {} };
    this.stderr = { resume() {} };
  }

  send(message) {
    this.sent.push(message);
    if (message?.type === "shutdown") {
      this.connected = false;
      setImmediate(() => {
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
      setImmediate(() => this.emit("exit", null, "SIGTERM"));
    }
    return true;
  }
}

async function registryWithInstance(dir, item = instance()) {
  const registryPath = path.join(dir, "instances.json");
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
      defaultInstanceId: item.id,
      instances: [item],
    }),
  );
  return new InstanceRegistry({ cwd: dir, registryPath, env: {} });
}

test("memory store persists, redacts sensitive values, marks stale targets, and deletes cache", async () => {
  const dir = await tempDir("remote-debug-memory-store-");
  const store = new MemoryStore({ memoryRoot: dir });
  const target = instance();

  await store.merge(
    target,
    {
      status: "ready",
      sections: {
        database: {
          clients: {
            mongosh: "mongodb://user:password@db.example.com/admin",
          },
        },
        filesystem: {
          logPaths: ["/var/log/nginx/error.log"],
        },
      },
    },
    "test",
  );

  const summary = store.summary(target);
  assert.equal(summary.status, "ready");
  assert.deepEqual(summary.summary.logPaths, ["/var/log/nginx/error.log"]);

  const saved = await fs.readFile(path.join(dir, "a", "memory.json"), "utf8");
  assert.doesNotMatch(saved, /password/);
  assert.match(saved, /\[redacted]/);

  assert.equal(store.summary(instance({ host: "staging.example.com" })).status, "stale");

  await fs.writeFile(path.join(dir, "a", "audit.jsonl"), "{}\n");
  await store.deleteInstance("a");
  await assert.rejects(() => fs.stat(path.join(dir, "a", "memory.json")));
  assert.equal((await fs.readFile(path.join(dir, "a", "audit.jsonl"), "utf8")).trim(), "{}");
});

test("worker manager requests memory init when cache is missing and persists worker updates", async () => {
  const dir = await tempDir("remote-debug-memory-manager-");
  const registry = await registryWithInstance(dir);
  const memoryStore = new MemoryStore({ memoryRoot: path.join(dir, "memory") });
  let forkEnv;
  const worker = new FakeWorkerProcess();
  const manager = new WorkerManager({
    registry,
    managerPort: 4343,
    cwd: dir,
    memoryStore,
    canBindPort: async () => true,
    forkWorker: (_entryPath, options) => {
      forkEnv = options.env;
      setImmediate(() => worker.emit("message", { type: "ready", ok: true }));
      return worker;
    },
  });

  try {
    const started = await manager.startInstance("a");
    assert.equal(started.runtime.status, "running");
    assert.equal(forkEnv.REMOTE_DEBUG_MEMORY_INIT, "1");
    assert.equal(manager.publicInstances()[0].memory.status, "initializing");

    await manager.handleWorkerMessage("a", {
      type: "memory:update",
      ok: true,
      memory: {
        status: "ready",
        sections: {
          system: { summary: "Linux prod" },
        },
      },
    });

    const listed = manager.publicInstances();
    assert.equal(listed[0].memory.status, "ready");
    assert.equal(listed[0].memory.summary.system, "Linux prod");
  } finally {
    await manager.shutdownAll();
  }
});

test("worker manager skips init when usable memory exists", async () => {
  const dir = await tempDir("remote-debug-memory-manager-existing-");
  const registry = await registryWithInstance(dir);
  const memoryStore = new MemoryStore({ memoryRoot: path.join(dir, "memory") });
  await memoryStore.merge(instance(), {
    status: "ready",
    sections: {
      system: { summary: "cached" },
    },
  });

  let forkEnv;
  const manager = new WorkerManager({
    registry,
    managerPort: 4343,
    cwd: dir,
    memoryStore,
    canBindPort: async () => true,
    forkWorker: (_entryPath, options) => {
      forkEnv = options.env;
      const worker = new FakeWorkerProcess();
      setImmediate(() => worker.emit("message", { type: "ready", ok: true }));
      return worker;
    },
  });

  try {
    await manager.startInstance("a");
    assert.equal(forkEnv.REMOTE_DEBUG_MEMORY_INIT, "0");
    assert.equal(manager.publicInstances()[0].memory.summary.system, "cached");
  } finally {
    await manager.shutdownAll();
  }
});
