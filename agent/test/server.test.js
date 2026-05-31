import assert from "node:assert/strict";
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

    const removed = await postJson(server, "/api/instances/staging", {}, {}, "DELETE");
    assert.equal(removed.status, 200);
    assert.equal(removed.body.instance.id, "staging");
  } finally {
    await close(server);
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
