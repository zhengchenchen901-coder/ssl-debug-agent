import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_ALLOWED_PATHS } from "../config.js";
import { SecurityError } from "../security.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const depsInstalled =
  fs.existsSync(path.resolve(here, "..", "node_modules", "express")) &&
  fs.existsSync(path.resolve(here, "..", "node_modules", "ssh2"));

test("server entrypoint is disabled inside worker mode", { skip: !depsInstalled }, async () => {
  const { isServerEntrypointProcess } = await import("../server.js");
  const filePath = path.resolve("runtime", "agent", "worker-entry.cjs");
  const argv = ["node", filePath];

  assert.equal(
    isServerEntrypointProcess({
      argv,
      env: { REMOTE_DEBUG_WORKER: "1" },
      filePath,
    }),
    false,
  );
  assert.equal(isServerEntrypointProcess({ argv, env: {}, filePath }), true);
});

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function closeIfListening(server) {
  if (server?.listening) {
    await close(server);
  }
}

async function waitFor(predicate, message = "condition") {
  const deadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`timed out waiting for ${message}`);
}

function makeConfig(logPath) {
  return {
    agent: { host: "127.0.0.1", port: 0 },
    ssh: {},
    security: {
      allowedPaths: DEFAULT_ALLOWED_PATHS,
      defaultTimeoutMs: 10_000,
      maxTimeoutMs: 30_000,
      defaultReadMaxBytes: 256 * 1024,
      maxCommandOutputBytes: 1024 * 1024,
    },
    audit: { logPath },
    runtime: {
      statePath: path.join(path.dirname(logPath), "agent-state.json"),
      runtimeId: "2.1.0:test-runtime",
    },
  };
}

function makeWorkerManagerStub() {
  const state = {
    shutdownCount: 0,
  };
  return {
    state,
    publicInstances: () => [],
    runtimeFor: () => ({ status: "stopped" }),
    shutdownAll: async () => {
      state.shutdownCount += 1;
    },
  };
}

async function waitForFileJson(filePath, predicate = () => true) {
  const deadline = Date.now() + 3000;
  let lastError;
  let lastValue;

  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await fsPromises.readFile(filePath, "utf8"));
      lastValue = parsed;
      if (predicate(parsed)) {
        return parsed;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (lastValue) {
    throw new Error(`timed out waiting for ${filePath} to match predicate; last status was ${lastValue.status || "unknown"}`);
  }
  throw lastError || new Error(`timed out waiting for ${filePath}`);
}

async function getText(server, route) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${route}`);

  return {
    status: response.status,
    text: await response.text(),
  };
}

async function getJson(server, route) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${route}`);

  return {
    status: response.status,
    body: await response.json(),
  };
}

async function postJson(server, route, body, headers = {}, method = "POST") {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

function collectSseUntil(server, predicate, trigger) {
  const address = server.address();

  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let request;
    let timer;
    let triggered = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    request = http.get(`http://127.0.0.1:${address.port}/events`, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        buffer += chunk;

        if (!triggered && buffer.includes("event: snapshot")) {
          triggered = true;
          trigger?.();
        }

        if (predicate(buffer)) {
          finish(null, buffer);
        }
      });
    });

    timer = setTimeout(() => {
      finish(new Error("timed out waiting for SSE activity"));
    }, 5000);
    timer.unref?.();

    request.on("error", (error) => {
      if (!settled) {
        finish(error);
      }
    });
  });
}

test("HTTP API works with mocked SSH", { skip: !depsInstalled }, async () => {
  const { createApp } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-http-"));
  const app = createApp({
    config: makeConfig(path.join(dir, "audit.jsonl")),
    runSSH: async (cmd) => ({
      stdout: `ran:${cmd}`,
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }),
    readRemoteFile: async (remotePath) => ({
      path: remotePath,
      content: "worker_processes auto;",
      truncated: false,
    }),
    listRemoteDir: async (remotePath) => ({
      path: remotePath,
      entries: [{ name: "error.log", size: 10 }],
    }),
    listLogs: async ({ category }) => ({
      category,
      entries: [{
        name: "error.log.1.gz",
        path: "/var/log/nginx/error.log.1.gz",
        category,
        source: "nginx:/var/log/nginx",
        compression: "gzip",
        kind: "log",
        isArchive: false,
        readable: true,
        size: 10,
        modifyTime: 1,
      }],
      nextCursor: null,
      hasMore: false,
      truncated: false,
      warnings: [],
      scannedEntries: 1,
      sourceCount: 1,
    }),
    listLogArchiveMembers: async ({ path }) => ({
      path,
      compression: "tar-gzip",
      members: [{ name: "error.log", size: 12, type: "file", readable: true }],
      nextCursor: null,
      hasMore: false,
      truncated: false,
      scannedBytes: 20,
    }),
    readLog: async ({ path, memberPath, contains }) => ({
      path,
      memberPath,
      compression: memberPath ? "tar-gzip" : "gzip",
      content: contains ? "ERROR\n" : "line\n",
      truncated: false,
      scannedTruncated: false,
      scannedBytes: 5,
      totalLines: 1,
      matchedLines: 1,
    }),
    resolveRemotePaths: async (remotePaths) => remotePaths,
  });
  const server = await listen(app);

  try {
    const run = await postJson(server, "/run", { cmd: "netstat -tlnp" });
    assert.equal(run.status, 200);
    assert.equal(run.body.stdout, "ran:netstat -tlnp");

    const rejected = await postJson(server, "/run", { cmd: "ls /tmp" });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.ok, false);

    const file = await postJson(server, "/read-file", {
      path: "/etc/nginx/nginx.conf",
    });
    assert.equal(file.status, 200);
    assert.equal(file.body.content, "worker_processes auto;");

    const list = await postJson(server, "/list-dir", { path: "/var/log" });
    assert.equal(list.status, 200);
    assert.equal(list.body.entries[0].name, "error.log");

    const logs = await postJson(server, "/logs/list", { category: "nginx", limit: 1 });
    assert.equal(logs.status, 200);
    assert.equal(logs.body.entries[0].compression, "gzip");

    const archive = await postJson(server, "/logs/archive-members", {
      path: "/home/github/app-logs.tar.gz",
    });
    assert.equal(archive.status, 200);
    assert.equal(archive.body.members[0].name, "error.log");

    const log = await postJson(server, "/logs/read", {
      path: "/home/github/app-logs.tar.gz",
      memberPath: "error.log",
      contains: "error",
    });
    assert.equal(log.status, 200);
    assert.equal(log.body.content, "ERROR\n");

    const audit = (await fsPromises.readFile(path.join(dir, "audit.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const logAudit = audit.find((entry) => entry.tool === "logs-read");
    assert.equal(logAudit.content, undefined);
    assert.equal(logAudit.memberPath, "error.log");
  } finally {
    await close(server);
  }
});

test("HTTP MongoDB query endpoint is instance-scoped and read-only", { skip: !depsInstalled }, async () => {
  const { createApp } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-mongodb-api-"));
  const config = makeConfig(path.join(dir, "audit.jsonl"));
  config.mongodb = {
    enabled: true,
    configPath: "/home/github/app/config.json",
    driverPath: "/home/github/app/node_modules/mongodb",
    configProfile: "test",
    uriKey: "url",
    database: "yennefer",
  };
  const calls = [];
  const app = createApp({
    config,
    runMongoQuery: async (query) => {
      calls.push(query);
      return {
        operation: query.operation,
        database: query.database,
        collection: query.collection,
        data: [{ status: "open" }],
        resultCount: 1,
        timing: { queueMs: 0, connectMs: 0, executionMs: 1 },
      };
    },
  });
  const server = await listen(app);

  try {
    const query = await postJson(server, "/mongodb/query", {
      operation: "find",
      collection: "orders",
      filter: { status: "open" },
      limit: 2,
    });
    assert.equal(query.status, 200);
    assert.equal(query.body.database, "yennefer");
    assert.deepEqual(query.body.data, [{ status: "open" }]);
    assert.equal(calls[0].limit, 2);

    const rejected = await postJson(server, "/mongodb/query", {
      operation: "find",
      collection: "orders",
      filter: { $where: "return true" },
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "MONGODB_OPERATOR_REJECTED");
    assert.equal(calls.length, 1);

    const audit = (await fsPromises.readFile(config.audit.logPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(audit[0].tool, "mongodb-query");
    assert.equal(audit[0].operation, "find");
    assert.equal(audit[0].resultCount, 1);
  } finally {
    await close(server);
  }
});

test("HTTP MongoDB mutation endpoints expose prepare, execute, rollback, and list", { skip: !depsInstalled }, async () => {
  const { createApp } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-mongodb-mutation-api-"));
  const config = makeConfig(path.join(dir, "audit.jsonl"));
  config.mongodb = {
    enabled: true,
    configPath: "/home/github/app/config.json",
    driverPath: "/home/github/app/node_modules/mongodb",
    configProfile: "test",
    uriKey: "url",
    database: "yennefer",
    writeEnabled: true,
    allowedDatabases: ["yennefer"],
    allowedCollections: ["members"],
  };
  const calls = [];
  const app = createApp({
    config,
    runMongoMutation: async (input) => {
      calls.push(input);
      if (input.mode === "list") {
        return { entries: [] };
      }
      return {
        mutationId: input.mutationId || "mutation-1",
        operationId: "operation-1",
        kind: input.kind || "document",
        operation: input.operation || "insertOne",
        status: input.mode === "commit" ? "committed" : input.mode === "rollback" ? "rolled_back" : "planned",
        rollbackMode: "transactional",
        planHash: input.planHash || "a".repeat(64),
        affectedCount: 1,
        changedFields: ["status"],
      };
    },
  });
  const server = await listen(app);

  try {
    const prepared = await postJson(server, "/mongodb/mutations/prepare", {
      operation: "insertOne",
      collection: "members",
      document: { _id: "m1", status: "active" },
    });
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.status, "planned");

    const executed = await postJson(server, "/mongodb/mutations/execute", {
      mutationId: "mutation-1",
      planHash: "a".repeat(64),
      confirmation: "确认执行",
    });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.status, "committed");

    const rolledBack = await postJson(server, "/mongodb/mutations/rollback", {
      mutationId: "mutation-1",
      planHash: "a".repeat(64),
      confirmation: "确认回滚",
    });
    assert.equal(rolledBack.status, 200);
    assert.equal(rolledBack.body.status, "rolled_back");

    const listed = await postJson(server, "/mongodb/mutations/list", {});
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.entries, []);
    assert.deepEqual(calls.map((item) => item.mode), ["prepare", "commit", "rollback", "list"]);
  } finally {
    await close(server);
  }
});

test("dashboard serves status and streams remote interaction activity", { skip: !depsInstalled }, async () => {
  const { createApp } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-dashboard-"));
  const app = createApp({
    config: makeConfig(path.join(dir, "audit.jsonl")),
    runSSH: async (cmd, options) => {
      options.onStdout?.("streamed output");
      return {
        stdout: `ran:${cmd}`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    },
    resolveRemotePaths: async (remotePaths) => remotePaths,
  });
  const server = await listen(app);

  try {
    const page = await getText(server, "/");
    assert.equal(page.status, 200);
    assert.match(page.text, /Remote Debug Agent/);

    const status = await getJson(server, "/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.agent.pid, process.pid);
    assert.equal(status.body.agent.runtimeId, "2.1.0:test-runtime");
    assert.equal(typeof status.body.agent.configFingerprint, "string");
    assert.deepEqual(status.body.security.allowedPaths, DEFAULT_ALLOWED_PATHS);

    let runPromise;
    const streamPromise = collectSseUntil(
      server,
      (buffer) =>
        buffer.includes('"stage":"completed"') && buffer.includes('"source":"codex-plugin"'),
      () => {
        runPromise = postJson(
          server,
          "/run",
          { cmd: "netstat -tlnp" },
          { "X-Remote-Debug-Source": "codex-plugin" },
        );
      },
    );

    const stream = await streamPromise;
    const run = await runPromise;
    assert.equal(run.status, 200);
    assert.match(stream, /"stage":"started"/);
    assert.match(stream, /"stage":"stdout"/);
    assert.match(stream, /streamed output/);
  } finally {
    await close(server);
  }
});

test("manager API creates, lists, updates, and deletes instances", { skip: !depsInstalled }, async () => {
  const { createManagerApp } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-manager-api-"));
  const app = createManagerApp({
    config: makeConfig(path.join(dir, "audit.jsonl")),
    cwd: dir,
    env: {},
    registryPath: path.join(dir, "instances.json"),
  });
  const server = await listen(app);

  try {
    const created = await postJson(server, "/api/instances", {
      id: "staging",
      name: "Staging",
      host: "staging.example.com",
      port: 22,
      username: "app",
      privateKeyPath: "C:\\Users\\you\\.ssh\\staging",
      passphrase: "secret",
      sourceRoots: {
        be: "/home/github/staging-be",
        h5: "/var/www/staging-h5",
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.instance.id, "staging");
    assert.equal(created.body.instance.hasPassphrase, true);
    assert.equal(created.body.instance.passphrase, undefined);

    const listed = await getJson(server, "/api/instances");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.instances.length, 1);
    assert.equal(listed.body.instances[0].runtime.status, "stopped");
    assert.deepEqual(listed.body.instances[0].sourceRoots, {
      be: "/home/github/staging-be",
      h5: "/var/www/staging-h5",
    });

    const capabilities = await getJson(server, "/api/capabilities");
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.body.capabilities.authority, "remote-debug-agent");
    assert.match(capabilities.body.capabilities.policyVersion, /^[a-f0-9]{64}$/);
    assert.ok(capabilities.body.capabilities.commands.allowedExecutables.includes("netstat"));
    assert.deepEqual(capabilities.body.capabilities.paths.allowedRoots, DEFAULT_ALLOWED_PATHS);
    assert.deepEqual(capabilities.body.capabilities.paths.byInstance.staging, {
      sourceRoots: {
        be: "/home/github/staging-be",
        h5: "/var/www/staging-h5",
      },
      allowedRoots: [
        ...DEFAULT_ALLOWED_PATHS,
        "/home/github/staging-be",
        "/var/www/staging-h5",
      ],
    });

    const updated = await postJson(
      server,
      "/api/instances/staging",
      {
        name: "Staging Updated",
        host: "staging.example.com",
        port: 22,
        username: "app",
        privateKeyPath: "C:\\Users\\you\\.ssh\\staging",
        passphrase: "",
      },
      {},
      "PUT",
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.instance.name, "Staging Updated");
    assert.equal(updated.body.instance.hasPassphrase, true);

    const stopped = await postJson(server, "/api/instances/staging/stop", {});
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.instance.id, "staging");
    assert.equal(stopped.body.runtime.status, "stopped");
    assert.equal(stopped.body.runtime.pid, null);
    assert.equal(stopped.body.runtime.workerPort, null);

    const afterStop = await getJson(server, "/api/instances");
    assert.equal(afterStop.status, 200);
    assert.equal(afterStop.body.instances.length, 1);
    assert.equal(afterStop.body.instances[0].id, "staging");

    const missingStop = await postJson(server, "/api/instances/missing/stop", {});
    assert.equal(missingStop.status, 404);
    assert.equal(missingStop.body.error.code, "INSTANCE_NOT_FOUND");

    const removed = await postJson(server, "/api/instances/staging", {}, {}, "DELETE");
    assert.equal(removed.status, 200);
    assert.equal(removed.body.instance.id, "staging");
  } finally {
    await close(server);
  }
});

test("manager API includes memory and updates it from proxied tool results", { skip: !depsInstalled }, async () => {
  const { createManagerApp } = await import("../server.js");
  const { InstanceRegistry } = await import("../instance-registry.js");
  const { MemoryStore } = await import("../memory-store.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-manager-memory-api-"));
  const registry = new InstanceRegistry({
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    env: {},
  });
  registry.create({
    id: "a",
    name: "a",
    host: "prod.example.com",
    port: 22,
    username: "app",
    privateKeyPath: "C:\\a",
  });
  const memoryStore = new MemoryStore({ memoryRoot: path.join(dir, "memory") });
  const workerManager = {
    memoryStore,
    publicInstances: () =>
      registry.list().map((instance) => ({
        ...instance,
        runtime: { status: "running" },
        memory: memoryStore.summary(instance),
      })),
    runtimeFor: () => ({ status: "running" }),
    shutdownAll: async () => {},
    callInstance: async (_instanceId, pathName, payload) => pathName === "/logs/list"
      ? {
          ok: true,
          instanceId: "a",
          category: payload.category || "all",
          entries: [{
            name: "error.log",
            path: "/var/log/nginx/error.log",
            compression: "none",
            readable: true,
          }],
          nextCursor: null,
          hasMore: false,
          truncated: false,
          warnings: [],
          scannedEntries: 1,
          sourceCount: 1,
          durationMs: 1,
        }
      : {
          ok: true,
          instanceId: "a",
          path: payload.path,
          entries: [{ name: "nginx.conf", size: 10, modifyTime: 1, permissions: 33188 }],
          durationMs: 1,
        },
  };
  const app = createManagerApp({
    config: makeConfig(path.join(dir, "audit.jsonl")),
    cwd: dir,
    registry,
    workerManager,
  });
  const server = await listen(app);

  try {
    const before = await getJson(server, "/api/instances");
    assert.equal(before.status, 200);
    assert.equal(before.body.instances[0].memory.status, "missing");

    const updatedMemory = await postJson(server, "/api/memory", {
      instanceId: "a",
      topic: "database",
      summary: "Production database metadata",
      facts: ["database=yenneferbak"],
    });
    assert.equal(updatedMemory.status, 200);
    assert.equal(updatedMemory.body.note.topic, "database");
    assert.equal(updatedMemory.body.memory.status, "partial");
    assert.equal(updatedMemory.body.memory.summary.notes[0].facts[0], "database=yenneferbak");

    const logs = await postJson(server, "/logs/list", {
      instanceId: "a",
      category: "nginx",
      limit: 1,
    });
    assert.equal(logs.status, 200);
    assert.equal(logs.body.entries[0].path, "/var/log/nginx/error.log");
    assert.deepEqual(logs.body.memory.summary.logPaths, ["/var/log/nginx/error.log"]);

    const listed = await postJson(server, "/list-dir", {
      instanceId: "a",
      path: "/etc/nginx",
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.memory.status, "partial");
    assert.deepEqual(listed.body.memory.summary.configPaths, ["/etc/nginx/nginx.conf"]);

    const after = await getJson(server, "/api/instances");
    assert.equal(after.body.instances[0].memory.summary.configPaths[0], "/etc/nginx/nginx.conf");
    assert.equal(after.body.instances[0].memory.summary.notes[0].topic, "database");
  } finally {
    await close(server);
  }
});

test("manager lease registration schedules instance restore", { skip: !depsInstalled }, async () => {
  const { createManagerApp } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-manager-lease-restore-"));
  const config = makeConfig(path.join(dir, "audit.jsonl"));
  config.lifecycle = { lifetime: "desktop" };
  const workerManager = {
    ...makeWorkerManagerStub(),
    restoreCount: 0,
    restoreInstancesFromSnapshot: async () => {
      workerManager.restoreCount += 1;
      return { restored: ["a"], skipped: [], failed: [] };
    },
  };
  const app = createManagerApp({
    config,
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    workerManager,
  });
  const server = await listen(app);

  try {
    const lease = await postJson(server, "/api/leases", {
      clientId: "test-client",
      ttlMs: 30_000,
      source: "test",
      pid: 1234,
    });
    assert.equal(lease.status, 200);
    assert.equal(lease.body.lifecycle.activeLeaseCount, 1);

    await waitFor(() => workerManager.restoreCount === 1, "manager restore after lease");
  } finally {
    await close(server);
    app.locals.lifecycle.stop();
  }
});

test("manager lease restore check publishes missing snapshot diagnostics", { skip: !depsInstalled }, async () => {
  const { createManagerApp } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-manager-lease-missing-snapshot-"));
  const config = makeConfig(path.join(dir, "audit.jsonl"));
  config.lifecycle = { lifetime: "desktop" };
  const workerManager = {
    ...makeWorkerManagerStub(),
    restoreCount: 0,
    restoreInstancesFromSnapshot: async () => {
      workerManager.restoreCount += 1;
      return {
        restored: [],
        skipped: [],
        failed: [],
        diagnostic: {
          status: "missing",
          path: path.join(dir, ".remote-debug", "manager-runtime.json"),
          clearedAt: "2026-06-02T08:00:00.000Z",
          clearedByPid: 4321,
          clearedByReason: "empty",
          previousSnapshotSummary: {
            instanceCount: 1,
            instanceIds: ["a"],
          },
        },
      };
    },
  };
  const app = createManagerApp({
    config,
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    workerManager,
  });
  const server = await listen(app);

  try {
    const lease = await postJson(server, "/api/leases", {
      clientId: "test-client",
      ttlMs: 30_000,
      source: "test",
      pid: 1234,
    });
    assert.equal(lease.status, 200);

    await waitFor(() => workerManager.restoreCount === 1, "manager missing snapshot restore check");
    await new Promise((resolve) => setImmediate(resolve));

    const status = await getJson(server, "/status");
    assert.equal(status.status, 200);
    assert.ok(
      status.body.recentEvents.some(
        (event) =>
          event.stage === "instances-restore-checked" &&
          event.diagnostic?.status === "missing" &&
          event.diagnostic?.clearedByReason === "empty" &&
          event.diagnostic?.previousSnapshotSummary?.instanceIds?.[0] === "a",
      ),
    );
  } finally {
    await close(server);
    app.locals.lifecycle.stop();
  }
});

test("manual manager lifetime does not shut down when no lease exists", { skip: !depsInstalled }, async () => {
  const { startServer } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-manual-lifecycle-"));
  const config = makeConfig(path.join(dir, "audit.jsonl"));
  config.lifecycle = { lifetime: "manual" };
  const workerManager = makeWorkerManagerStub();
  const server = startServer(config, {
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    workerManager,
    lifecycleOptions: {
      startupGraceMs: 20,
      checkIntervalMs: 5,
    },
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(server.listening, true);
    assert.equal(workerManager.state.shutdownCount, 0);
  } finally {
    await server.gracefulShutdown("test");
  }
});

test("desktop manager lifetime shuts down when no lease arrives", { skip: !depsInstalled }, async () => {
  const { startServer } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-desktop-no-lease-"));
  const config = makeConfig(path.join(dir, "audit.jsonl"));
  config.lifecycle = { lifetime: "desktop" };
  const workerManager = makeWorkerManagerStub();
  const server = startServer(config, {
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    workerManager,
    lifecycleOptions: {
      startupGraceMs: 20,
      checkIntervalMs: 5,
    },
  });

  try {
    await waitFor(
      () => !server.listening && workerManager.state.shutdownCount === 1,
      "desktop manager shutdown without lease",
    );
  } finally {
    await closeIfListening(server);
  }
});

test("desktop manager lifetime shuts down after lease expiry", { skip: !depsInstalled }, async () => {
  const { startServer } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-desktop-lease-expiry-"));
  const config = makeConfig(path.join(dir, "audit.jsonl"));
  config.lifecycle = { lifetime: "desktop" };
  const workerManager = makeWorkerManagerStub();
  const server = startServer(config, {
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    workerManager,
    lifecycleOptions: {
      startupGraceMs: 1000,
      checkIntervalMs: 5,
      minLeaseTtlMs: 5,
      maxLeaseTtlMs: 50,
    },
  });

  try {
    await waitFor(() => Boolean(server.address()), "manager listen");
    const lease = await postJson(server, "/api/leases", {
      clientId: "test-client",
      ttlMs: 5,
      source: "test",
      pid: 1234,
    });
    assert.equal(lease.status, 200);
    assert.equal(lease.body.lifecycle.activeLeaseCount, 1);

    await waitFor(
      () => !server.listening && workerManager.state.shutdownCount === 1,
      "desktop manager shutdown after lease expiry",
    );
  } finally {
    await closeIfListening(server);
  }
});

test("manual manager shutdown API triggers graceful shutdown", { skip: !depsInstalled }, async () => {
  const { startServer } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-manual-shutdown-api-"));
  const config = makeConfig(path.join(dir, "audit.jsonl"));
  config.lifecycle = { lifetime: "manual" };
  const workerManager = makeWorkerManagerStub();
  const server = startServer(config, {
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    workerManager,
  });

  try {
    await waitFor(() => Boolean(server.address()), "manager listen");
    const shutdown = await postJson(server, "/api/shutdown", {});
    assert.equal(shutdown.status, 202);
    assert.equal(shutdown.body.status, "shutting-down");
    await waitFor(
      () => !server.listening && workerManager.state.shutdownCount === 1,
      "manual manager shutdown",
    );
  } finally {
    await closeIfListening(server);
  }
});

test("desktop manager shutdown API is rejected", { skip: !depsInstalled }, async () => {
  const { startServer } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-desktop-shutdown-api-"));
  const config = makeConfig(path.join(dir, "audit.jsonl"));
  config.lifecycle = { lifetime: "desktop" };
  const workerManager = makeWorkerManagerStub();
  const server = startServer(config, {
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    workerManager,
    lifecycleOptions: {
      startupGraceMs: 1000,
      checkIntervalMs: 5,
    },
  });

  try {
    await waitFor(() => Boolean(server.address()), "manager listen");
    const shutdown = await postJson(server, "/api/shutdown", {});
    assert.equal(shutdown.status, 409);
    assert.equal(shutdown.body.error.code, "LIFECYCLE_MANAGED_BY_CODEX");
    assert.equal(server.listening, true);
    assert.equal(workerManager.state.shutdownCount, 0);
  } finally {
    await server.gracefulShutdown("test");
  }
});

test("manager signal handlers perform graceful shutdown", { skip: !depsInstalled }, async () => {
  const { startServer } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-signal-shutdown-"));
  const config = makeConfig(path.join(dir, "audit.jsonl"));
  config.lifecycle = { lifetime: "manual" };
  const signalProcess = new EventEmitter();
  const workerManager = makeWorkerManagerStub();
  let exitCode = null;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const server = startServer(config, {
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
    workerManager,
    installSignalHandlers: true,
    signalProcess,
    exit: (code) => {
      exitCode = code;
      resolveExit();
    },
  });

  await waitFor(() => Boolean(server.address()), "manager listen");
  signalProcess.emit("SIGTERM", "SIGTERM");
  await exitPromise;

  try {
    assert.equal(exitCode, 0);
    assert.equal(workerManager.state.shutdownCount, 1);
    assert.equal(server.listening, false);
  } finally {
    await closeIfListening(server);
  }
});

test("startServer records port binding errors in runtime state", { skip: !depsInstalled }, async () => {
  const { startServer } = await import("../server.js");
  const blocker = http.createServer((_request, response) => response.end("busy"));
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });

  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-bind-"));
  const config = makeConfig(path.join(dir, "audit.jsonl"));
  config.agent.port = blocker.address().port;
  const failedServer = startServer(config, {
    cwd: dir,
    registryPath: path.join(dir, "instances.json"),
  });

  try {
    const state = await waitForFileJson(
      config.runtime.statePath,
      (candidate) => candidate.status === "error",
    );
    assert.equal(state.status, "error");
    assert.equal(state.lastError.code, "EADDRINUSE");
  } finally {
    failedServer.close();
    await close(blocker);
  }
});

test("HTTP /run rejects canonical path escape detected before command execution", { skip: !depsInstalled }, async () => {
  const { createApp } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-escape-"));
  let executed = false;
  const app = createApp({
    config: makeConfig(path.join(dir, "audit.jsonl")),
    runSSH: async () => {
      executed = true;
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    },
    resolveRemotePaths: async () => {
      throw new SecurityError("path is outside allowed roots: /etc/passwd", "PATH_NOT_ALLOWED");
    },
  });
  const server = await listen(app);

  try {
    const response = await postJson(server, "/run", {
      cmd: "cat /var/log/passwd-link",
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "PATH_NOT_ALLOWED");
    assert.equal(executed, false);
  } finally {
    await close(server);
  }
});
