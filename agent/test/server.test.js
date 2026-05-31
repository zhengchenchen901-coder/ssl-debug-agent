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
    runtime: { statePath: path.join(path.dirname(logPath), "agent-state.json") },
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
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.instance.id, "staging");
    assert.equal(created.body.instance.hasPassphrase, true);
    assert.equal(created.body.instance.passphrase, undefined);

    const listed = await getJson(server, "/api/instances");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.instances.length, 1);
    assert.equal(listed.body.instances[0].runtime.status, "stopped");

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
