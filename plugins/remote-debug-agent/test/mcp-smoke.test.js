import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "..", "mcp-server.js");

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

function createMessageReader(child) {
  let buffer = Buffer.alloc(0);
  const queue = [];
  const waiters = [];

  function parse() {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /^Content-Length:\s*(\d+)$/im.exec(header);
      assert.ok(match, "MCP response includes Content-Length");
      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) return;

      const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
      buffer = buffer.subarray(bodyEnd);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        queue.push(message);
      }
    }
  }

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    parse();
  });

  return function readMessage() {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift());
    }

    return new Promise((resolve) => waiters.push(resolve));
  };
}

function startAgentStub() {
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/run") {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          stdout: `ran:${parsed.cmd}`,
          stderr: "",
          exitCode: 0,
          durationMs: 1,
          timedOut: false,
        }),
      );
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await close(server);
  return port;
}

async function canBindPort(port) {
  const server = http.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await close(server);
    }
  }
}

async function getFreeConsecutivePorts() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const first = http.createServer();
    const second = http.createServer();
    try {
      await new Promise((resolve, reject) => {
        first.once("error", reject);
        first.listen(0, "127.0.0.1", resolve);
      });
      const port = first.address().port;
      if (port >= 65535) {
        await close(first);
        continue;
      }

      await new Promise((resolve, reject) => {
        second.once("error", reject);
        second.listen(port + 1, "127.0.0.1", resolve);
      });
      await close(second);
      await close(first);
      return port;
    } catch {
      if (second.listening) {
        await close(second);
      }
      if (first.listening) {
        await close(first);
      }
    }
  }

  throw new Error("failed to find consecutive free ports");
}

async function waitForStatus(port) {
  const deadline = Date.now() + 5000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError || new Error(`timed out waiting for fake agent on ${port}`);
}

function killPid(pid) {
  if (!Number.isInteger(pid)) {
    return;
  }

  try {
    process.kill(pid);
  } catch {
    // The wrapper may already have stopped this process.
  }
}

async function writeFakeAgent(agentDir) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "server.js"),
    `
import { createHash } from "node:crypto";
import http from "node:http";
import path from "node:path";

const port = Number(process.env.REMOTE_DEBUG_AGENT_PORT);
const empty = process.env.FAKE_AGENT_EMPTY === "1";
const DEFAULT_ALLOWED_PATHS = ["/var/log", "/etc/nginx", "/home/app", "/root/.pm2", "/home/github"];

function sshPort() {
  return Number.parseInt(process.env.REMOTE_DEBUG_PORT || "22", 10);
}

function securityConfig() {
  return {
    allowedPaths: DEFAULT_ALLOWED_PATHS,
    defaultTimeoutMs: 10000,
    maxTimeoutMs: 30000,
    defaultReadMaxBytes: 256 * 1024,
    maxCommandOutputBytes: 1024 * 1024
  };
}

function configFingerprint() {
  return createHash("sha256")
    .update(JSON.stringify({
      agent: {
        host: "127.0.0.1",
        port
      },
      ssh: {
        host: process.env.REMOTE_DEBUG_HOST || "",
        port: sshPort(),
        username: process.env.REMOTE_DEBUG_USER || "",
        privateKeyPath: process.env.REMOTE_DEBUG_PRIVATE_KEY_PATH || "",
        passphrase: process.env.REMOTE_DEBUG_PRIVATE_KEY_PASSPHRASE || "",
        readyTimeout: 10000
      },
      security: securityConfig(),
      audit: {
        logPath: process.env.REMOTE_DEBUG_AUDIT_LOG || path.resolve(process.cwd(), "audit", "remote-debug-agent.jsonl")
      }
    }))
    .digest("hex");
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/status") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      name: "remote-debug-agent",
      agent: { port, pid: process.pid, configFingerprint: configFingerprint() },
      target: empty
        ? { host: "", port: sshPort(), username: "" }
        : { host: process.env.REMOTE_DEBUG_HOST || "", port: sshPort(), username: process.env.REMOTE_DEBUG_USER || "" }
    }));
    return;
  }

  if (request.method === "POST" && request.url === "/run") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        stdout: \`ran:\${parsed.cmd}\`,
        stderr: "",
        exitCode: 0,
        durationMs: 1,
        timedOut: false
      }));
    });
    return;
  }

  response.writeHead(404).end();
});

server.listen(port, "127.0.0.1");
`,
    "utf8",
  );
}

function startMcp(env, targetServerPath = serverPath) {
  return spawn(process.execPath, [targetServerPath], {
    cwd: path.dirname(targetServerPath),
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function callRunTool(child) {
  const readMessage = createMessageReader(child);
  child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }));
  await readMessage();
  child.stdin.write(
    encodeMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "remote_debug_run_command",
        arguments: { cmd: "netstat -tlnp" },
      },
    }),
  );
  return readMessage();
}

async function initializeMcp(child, readMessage, id = 1) {
  child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method: "initialize" }));
  return readMessage();
}

async function callRunToolWithReader(child, readMessage, id) {
  child.stdin.write(
    encodeMessage({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "remote_debug_run_command",
        arguments: { cmd: "netstat -tlnp" },
      },
    }),
  );
  return readMessage();
}

test("MCP server exposes remote debug tools and forwards calls", async () => {
  const agentStub = await startAgentStub();
  const port = agentStub.address().port;
  const child = startMcp({ REMOTE_DEBUG_AGENT_URL: `http://127.0.0.1:${port}` });
  const readMessage = createMessageReader(child);

  try {
    child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    const initialize = await readMessage();
    assert.equal(initialize.result.serverInfo.name, "remote-debug-agent");

    child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const list = await readMessage();
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name),
      [
        "remote_debug_run_command",
        "remote_debug_read_file",
        "remote_debug_list_dir",
      ],
    );

    child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }));
    const resources = await readMessage();
    assert.deepEqual(resources.result.resources, []);

    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "remote_debug_run_command",
          arguments: { cmd: "netstat -tlnp" },
        },
      }),
    );
    const call = await readMessage();
    assert.match(call.result.content[0].text, /ran:netstat -tlnp/);
  } finally {
    child.kill();
    await close(agentStub);
  }
});

test("MCP starts the local agent from .env port when no service is listening", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-mcp-start-"));
  const agentDir = path.join(dir, "agent");
  const envPath = path.join(dir, ".env");
  const port = await getFreePort();
  await writeFakeAgent(agentDir);
  await fs.writeFile(
    envPath,
    [
      "REMOTE_DEBUG_HOST=prod.example.com",
      "REMOTE_DEBUG_USER=app",
      `REMOTE_DEBUG_AGENT_PORT=${port}`,
    ].join("\n"),
  );

  const child = startMcp({
    REMOTE_DEBUG_AGENT_URL: "",
    REMOTE_DEBUG_ENV_PATH: envPath,
    REMOTE_DEBUG_AGENT_DIR: agentDir,
  });

  try {
    const call = await callRunTool(child);
    assert.match(call.result.content[0].text, /ran:netstat -tlnp/);
  } finally {
    child.kill();
    const status = await waitForStatus(port);
    process.kill(status.agent.pid);
  }
});

test("MCP uses 4343 as the default local agent port", async (t) => {
  if (!(await canBindPort(4343))) {
    t.skip("port 4343 is already in use");
    return;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-mcp-default-port-"));
  const agentDir = path.join(dir, "agent");
  const envPath = path.join(dir, ".env");
  await writeFakeAgent(agentDir);
  await fs.writeFile(
    envPath,
    [
      "REMOTE_DEBUG_HOST=prod.example.com",
      "REMOTE_DEBUG_USER=app",
    ].join("\n"),
  );

  const child = startMcp({
    REMOTE_DEBUG_AGENT_URL: "",
    REMOTE_DEBUG_AGENT_PORT: "",
    REMOTE_DEBUG_ENV_PATH: envPath,
    REMOTE_DEBUG_AGENT_DIR: agentDir,
  });

  try {
    const call = await callRunTool(child);
    assert.match(call.result.content[0].text, /ran:netstat -tlnp/);
    const status = await waitForStatus(4343);
    assert.equal(status.agent.port, 4343);
    process.kill(status.agent.pid);
  } finally {
    child.kill();
  }
});

test("MCP prewarms the local agent after initialize", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-mcp-prewarm-"));
  const agentDir = path.join(dir, "agent");
  const envPath = path.join(dir, ".env");
  const port = await getFreePort();
  await writeFakeAgent(agentDir);
  await fs.writeFile(
    envPath,
    [
      "REMOTE_DEBUG_HOST=prod.example.com",
      "REMOTE_DEBUG_USER=app",
      `REMOTE_DEBUG_AGENT_PORT=${port}`,
    ].join("\n"),
  );

  const child = startMcp({
    REMOTE_DEBUG_AGENT_URL: "",
    REMOTE_DEBUG_ENV_PATH: envPath,
    REMOTE_DEBUG_AGENT_DIR: agentDir,
  });
  const readMessage = createMessageReader(child);

  try {
    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    );
    const initialize = await readMessage();
    assert.equal(initialize.result.serverInfo.name, "remote-debug-agent");
    assert.equal(initialize.result.protocolVersion, "2025-06-18");

    const status = await waitForStatus(port);
    assert.equal(status.name, "remote-debug-agent");
    assert.equal(status.agent.port, port);
    process.kill(status.agent.pid);
  } finally {
    child.kill();
  }
});

test("MCP resolves project root from Codex local marketplace config when running from cache", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-project-"));
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-codex-home-"));
  const agentDir = path.join(projectDir, "agent");
  const cacheDir = path.join(
    codexHome,
    "plugins",
    "cache",
    "remote-debug-local",
    "remote-debug-agent",
    "1.0.5",
  );
  const installedServerPath = path.join(cacheDir, "mcp-server.js");
  const port = await getFreePort();

  await writeFakeAgent(agentDir);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.copyFile(serverPath, installedServerPath);
  await fs.writeFile(
    path.join(projectDir, ".env"),
    [
      "REMOTE_DEBUG_HOST=prod.example.com",
      "REMOTE_DEBUG_USER=app",
      `REMOTE_DEBUG_AGENT_PORT=${port}`,
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    [
      "[marketplaces.remote-debug-local]",
      'source_type = "local"',
      `source = '${projectDir}'`,
    ].join("\n"),
  );

  const child = startMcp(
    {
      CODEX_HOME: codexHome,
      REMOTE_DEBUG_AGENT_URL: "",
      REMOTE_DEBUG_AGENT_DIR: "",
      REMOTE_DEBUG_ENV_PATH: "",
    },
    installedServerPath,
  );

  try {
    const call = await callRunTool(child);
    assert.match(call.result.content[0].text, /ran:netstat -tlnp/);
  } finally {
    child.kill();
    const status = await waitForStatus(port);
    process.kill(status.agent.pid);
  }
});

test("MCP restarts an unhealthy Remote Debug Agent on the configured port", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-mcp-restart-"));
  const agentDir = path.join(dir, "agent");
  const envPath = path.join(dir, ".env");
  const port = await getFreePort();
  await writeFakeAgent(agentDir);
  await fs.writeFile(
    envPath,
    [
      "REMOTE_DEBUG_HOST=prod.example.com",
      "REMOTE_DEBUG_USER=app",
      `REMOTE_DEBUG_AGENT_PORT=${port}`,
    ].join("\n"),
  );

  const unhealthy = spawn(process.execPath, [path.join(agentDir, "server.js")], {
    cwd: agentDir,
    env: {
      ...process.env,
      REMOTE_DEBUG_AGENT_PORT: String(port),
      FAKE_AGENT_EMPTY: "1",
    },
    stdio: "ignore",
  });
  await waitForStatus(port);

  const child = startMcp({
    REMOTE_DEBUG_AGENT_URL: "",
    REMOTE_DEBUG_ENV_PATH: envPath,
    REMOTE_DEBUG_AGENT_DIR: agentDir,
  });

  try {
    const call = await callRunTool(child);
    assert.match(call.result.content[0].text, /ran:netstat -tlnp/);
    const status = await waitForStatus(port);
    assert.notEqual(status.agent.pid, unhealthy.pid);
    process.kill(status.agent.pid);
  } finally {
    child.kill();
    if (!unhealthy.killed) {
      unhealthy.kill();
    }
  }
});

test("MCP restarts the local agent when .env target config changes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-mcp-env-change-"));
  const agentDir = path.join(dir, "agent");
  const envPath = path.join(dir, ".env");
  const port = await getFreePort();
  await writeFakeAgent(agentDir);
  await fs.writeFile(
    envPath,
    [
      "REMOTE_DEBUG_HOST=prod.example.com",
      "REMOTE_DEBUG_USER=app",
      `REMOTE_DEBUG_AGENT_PORT=${port}`,
    ].join("\n"),
  );

  const child = startMcp({
    REMOTE_DEBUG_AGENT_URL: "",
    REMOTE_DEBUG_ENV_PATH: envPath,
    REMOTE_DEBUG_AGENT_DIR: agentDir,
  });
  const readMessage = createMessageReader(child);
  let firstStatus;
  let secondStatus;

  try {
    await initializeMcp(child, readMessage);
    const firstCall = await callRunToolWithReader(child, readMessage, 2);
    assert.match(firstCall.result.content[0].text, /ran:netstat -tlnp/);
    firstStatus = await waitForStatus(port);
    assert.equal(firstStatus.target.host, "prod.example.com");

    await fs.writeFile(
      envPath,
      [
        "REMOTE_DEBUG_HOST=staging.example.com",
        "REMOTE_DEBUG_USER=app",
        `REMOTE_DEBUG_AGENT_PORT=${port}`,
      ].join("\n"),
    );

    const secondCall = await callRunToolWithReader(child, readMessage, 3);
    assert.match(secondCall.result.content[0].text, /ran:netstat -tlnp/);
    secondStatus = await waitForStatus(port);
    assert.equal(secondStatus.target.host, "staging.example.com");
    assert.notEqual(secondStatus.agent.pid, firstStatus.agent.pid);
    assert.notEqual(secondStatus.agent.configFingerprint, firstStatus.agent.configFingerprint);
  } finally {
    child.kill();
    killPid(secondStatus?.agent?.pid);
    killPid(firstStatus?.agent?.pid);
  }
});

test("MCP starts a new local agent when .env port changes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-mcp-port-change-"));
  const agentDir = path.join(dir, "agent");
  const envPath = path.join(dir, ".env");
  const port = await getFreeConsecutivePorts();
  const nextPort = port + 1;
  await writeFakeAgent(agentDir);
  await fs.writeFile(
    envPath,
    [
      "REMOTE_DEBUG_HOST=prod.example.com",
      "REMOTE_DEBUG_USER=app",
      `REMOTE_DEBUG_AGENT_PORT=${port}`,
    ].join("\n"),
  );

  const child = startMcp({
    REMOTE_DEBUG_AGENT_URL: "",
    REMOTE_DEBUG_ENV_PATH: envPath,
    REMOTE_DEBUG_AGENT_DIR: agentDir,
  });
  const readMessage = createMessageReader(child);
  let firstStatus;
  let secondStatus;

  try {
    await initializeMcp(child, readMessage);
    const firstCall = await callRunToolWithReader(child, readMessage, 2);
    assert.match(firstCall.result.content[0].text, /ran:netstat -tlnp/);
    firstStatus = await waitForStatus(port);
    assert.equal(firstStatus.agent.port, port);

    await fs.writeFile(
      envPath,
      [
        "REMOTE_DEBUG_HOST=prod.example.com",
        "REMOTE_DEBUG_USER=app",
        `REMOTE_DEBUG_AGENT_PORT=${nextPort}`,
      ].join("\n"),
    );

    const secondCall = await callRunToolWithReader(child, readMessage, 3);
    assert.match(secondCall.result.content[0].text, /ran:netstat -tlnp/);
    secondStatus = await waitForStatus(nextPort);
    assert.equal(secondStatus.agent.port, nextPort);
    assert.notEqual(secondStatus.agent.pid, firstStatus.agent.pid);
    assert.notEqual(secondStatus.agent.configFingerprint, firstStatus.agent.configFingerprint);
  } finally {
    child.kill();
    killPid(secondStatus?.agent?.pid);
    killPid(firstStatus?.agent?.pid);
  }
});

test("MCP starts the local agent on a fallback port when the configured port is occupied", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-mcp-occupied-"));
  const agentDir = path.join(dir, "agent");
  const envPath = path.join(dir, ".env");
  const port = await getFreeConsecutivePorts();
  const fallbackPort = port + 1;
  await writeFakeAgent(agentDir);
  await fs.writeFile(
    envPath,
    [
      "REMOTE_DEBUG_HOST=prod.example.com",
      "REMOTE_DEBUG_USER=app",
      `REMOTE_DEBUG_AGENT_PORT=${port}`,
    ].join("\n"),
  );

  const occupied = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ name: "not-remote-debug-agent" }));
  });
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(port, "127.0.0.1", resolve);
  });

  const child = startMcp({
    REMOTE_DEBUG_AGENT_URL: "",
    REMOTE_DEBUG_ENV_PATH: envPath,
    REMOTE_DEBUG_AGENT_DIR: agentDir,
  });

  try {
    const call = await callRunTool(child);
    assert.match(call.result.content[0].text, /ran:netstat -tlnp/);
    const status = await waitForStatus(fallbackPort);
    assert.equal(status.agent.port, fallbackPort);
    assert.notEqual(status.agent.port, port);

    const response = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).name, "not-remote-debug-agent");
    process.kill(status.agent.pid);
  } finally {
    child.kill();
    await close(occupied);
  }
});

