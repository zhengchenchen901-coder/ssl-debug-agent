import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InstanceRegistry } from "../instance-registry.js";
import { WorkerManager } from "../worker-manager.js";

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("registry migrates v1 instance records to v2 manager config", async () => {
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
            approvedCommands: { enabled: true },
          },
        ],
      },
      null,
      2,
    ),
  );

  const registry = new InstanceRegistry({ cwd: dir, registryPath, env: {} });

  assert.equal(registry.registry.version, 2);
  assert.equal(registry.managerConfig().workerPortRange.start, 4400);
  assert.equal(registry.get("default").name, "默认实例");
  assert.equal(registry.get("default").passphrase, undefined);
  assert.equal(registry.getInternal("default").preferredWorkerPort, 4444);
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
