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

async function writeFakeAgent(agentDir) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "server.js"),
    `
import http from "node:http";

const port = Number(process.env.REMOTE_DEBUG_AGENT_PORT);
const empty = process.env.FAKE_AGENT_EMPTY === "1";
const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/status") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      name: "remote-debug-agent",
      agent: { port, pid: process.pid },
      target: empty
        ? { host: "", username: "" }
        : { host: process.env.REMOTE_DEBUG_HOST || "", username: process.env.REMOTE_DEBUG_USER || "" }
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

function startMcp(env) {
  return spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
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

    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 3,
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

test("MCP refuses to stop a non-agent service on the configured port", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-mcp-occupied-"));
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
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /AGENT_PORT_OCCUPIED/);
    const response = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(response.status, 200);
  } finally {
    child.kill();
    await close(occupied);
  }
});

