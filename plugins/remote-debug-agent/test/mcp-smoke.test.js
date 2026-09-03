import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "..", "mcp-server.js");
const pluginManifest = JSON.parse(
  await fs.readFile(path.resolve(here, "..", ".codex-plugin", "plugin.json"), "utf8"),
);
const developmentRuntimeId = `development:${pluginManifest.version}`;
const sharedTestDataDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "remote-debug-mcp-test-data-"),
);

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

function encodeJsonLineMessage(message) {
  return `${JSON.stringify(message)}\n`;
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

function createJsonLineMessageReader(child) {
  let buffer = "";
  const queue = [];
  const waiters = [];

  function deliver(message) {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      queue.push(message);
    }
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) return;

      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (line) {
        deliver(JSON.parse(line));
      }
    }
  });

  return function readMessage() {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift());
    }

    return new Promise((resolve) => waiters.push(resolve));
  };
}

function startAgentStub() {
  const drafts = new Map();
  const leaseRequests = [];
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/status") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        name: "remote-debug-agent",
        mode: "manager",
        apiVersion: 2,
        capabilities: {
          persistentSsh: true,
          operationDeadlines: true,
          cancellation: true,
          structuredHealth: true,
        },
        agent: { port: server.address().port, pid: process.pid },
      }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/instances") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          defaultInstanceId: "default",
          instances: [
            {
              id: "default",
              name: "default",
              host: "prod.example.com",
              runtime: { status: "running", workerPort: 4400, pid: 1234 },
            },
          ],
        }),
      );
      return;
    }
    if (request.method === "GET" && request.url === "/api/capabilities") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        capabilities: {
          schemaVersion: 1,
          policyVersion: "test-policy",
          authority: "remote-debug-agent",
          commands: {
            allowedExecutables: ["netstat", "ps"],
            deniedExecutables: ["rm"],
            commandsRequiringAllowedAbsolutePath: [],
            versionOnlyExecutables: [],
            systemctl: { actions: [], units: [], options: [], additionalOptionPatterns: [] },
            nginxArguments: [],
            pm2: { actions: [] },
            constraints: ["no shell operators"],
            examples: ["netstat -tlnp", "ps aux"],
          },
          paths: { allowedRoots: ["/var/log"] },
          limits: { maxCommandTimeoutMs: 120000, maxFileTimeoutMs: 300000 },
          approvedCommands: { enabled: false },
        },
      }));
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      if (request.url === "/run") {
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
        return;
      }

      if (request.url === "/logs/list") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          category: parsed.category || "all",
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
        }));
        return;
      }

      if (request.url === "/logs/archive-members") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          path: parsed.path,
          compression: "tar-gzip",
          members: [{ name: "error.log", size: 10, type: "file", readable: true }],
          nextCursor: null,
          hasMore: false,
          truncated: false,
          scannedBytes: 10,
        }));
        return;
      }

      if (request.url === "/logs/read") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          path: parsed.path,
          memberPath: parsed.memberPath,
          compression: parsed.memberPath ? "tar-gzip" : "none",
          content: "ERROR\n",
          truncated: false,
          scannedTruncated: false,
          scannedBytes: 6,
          totalLines: 1,
          matchedLines: 1,
        }));
        return;
      }

      if (request.url === "/mongodb/query") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          instanceId: parsed.instanceId || "default",
          operation: parsed.operation,
          database: parsed.database || "yennefer",
          collection: parsed.collection || null,
          data: parsed.operation === "ping" ? { ok: 1 } : [],
          resultCount: parsed.operation === "ping" ? 1 : 0,
          durationMs: 1,
        }));
        return;
      }

      if (request.url === "/api/memory") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            instanceId: parsed.instanceId || "default",
            note: {
              topic: parsed.topic,
              summary: parsed.summary,
              facts: parsed.facts,
              updatedAt: "2026-07-25T00:00:00.000Z",
            },
          }),
        );
        return;
      }

      if (request.url === "/api/instances/default/restart") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          restarted: true,
          action: "restarted",
          previousStatus: "stopped",
          instance: { id: "default", name: "default" },
          runtime: { status: "running", workerPort: 4400, pid: 1234 },
        }));
        return;
      }

      if (request.url === "/approved-command-drafts") {
        const draft = {
          ok: true,
          draftId: "draft-1",
          purpose: parsed.purpose,
          commands: parsed.commands,
          commandHash: "hash-1",
          commandCount: parsed.commands.length,
          commandBlock: parsed.commands.join("\n\n"),
          status: "pending",
          createdAt: "2026-05-19T00:00:00.000Z",
          expiresAt: "2026-05-19T00:30:00.000Z",
          instructions: ["stub"],
        };
        drafts.set(draft.draftId, draft);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(draft));
        return;
      }

      if (request.url === "/approved-command-drafts/get") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(drafts.get(parsed.draftId)));
        return;
      }

      if (request.url === "/approved-command-drafts/review") {
        const draft = drafts.get(parsed.draftId);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          instanceId: parsed.instanceId || "default",
          decision: "manual_review",
          draftId: draft?.draftId,
          commands: draft?.commands,
          commandHash: draft?.commandHash,
          review: {
            reason: "stub_manual_review",
            staticViolations: [],
            violations: [{
              commandIndex: 0,
              code: "STUB_REVIEW",
              severity: "medium",
              reason: "stub review requires human confirmation",
            }],
          },
        }));
        return;
      }

      if (request.url === "/approved-command-drafts/execute") {
        const draft = drafts.get(parsed.draftId);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            commandsOk: true,
            draftId: parsed.draftId,
            commandHash: parsed.commandHash,
            status: "executed",
            executedAt: "2026-05-19T00:01:00.000Z",
            durationMs: 1,
            results: draft.commands.map((command, commandIndex) => ({
              command,
              commandIndex,
              commandPreview: command,
              stdout: `ran:${command}`,
              stderr: "",
              exitCode: 0,
              timedOut: false,
              durationMs: 1,
            })),
          }),
        );
        return;
      }

      if (request.url === "/api/leases") {
        leaseRequests.push(parsed);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { code: "UNKNOWN_ROUTE" } }));
    });
  });
  server.leaseRequests = leaseRequests;

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

async function waitForStatus(port, predicate = () => true, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  let lastStatus;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      lastStatus = await response.json();
      if (predicate(lastStatus)) {
        return lastStatus;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (lastStatus) {
    throw new Error(`timed out waiting for fake agent on ${port} to match predicate`);
  }
  throw lastError || new Error(`timed out waiting for fake agent on ${port}`);
}

async function waitForPortRelease(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canBindPort(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for port ${port} to be released`);
}

function startOperationAgentStub(mode) {
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/status") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        name: "remote-debug-agent",
        mode: "manager",
        apiVersion: 2,
        capabilities: {
          persistentSsh: true,
          operationDeadlines: true,
          cancellation: true,
          structuredHealth: true,
        },
        agent: { port: server.address().port, pid: process.pid },
      }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/run") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      if (mode === "deadline") {
        response.writeHead(408, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          ok: false,
          error: {
            operationId: parsed.operationId,
            code: "OPERATION_DEADLINE_EXCEEDED",
            message: "command printed output but did not exit",
            layer: "ssh",
            phase: "exec",
            retriable: false,
          },
        }));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function managerSourceFingerprint(agentUrl, port, explicitUrl = "") {
  return createHash("sha256")
    .update(JSON.stringify({
      runtimeId: developmentRuntimeId,
      agentUrl,
      port,
      explicitUrl,
    }))
    .digest("hex");
}

function agentStartLockPath(runtimeDir, agentUrl, sourceFingerprint) {
  const hash = createHash("sha256")
    .update(JSON.stringify({ agentUrl, sourceFingerprint }))
    .digest("hex");
  return path.resolve(runtimeDir, `agent-start-${hash}.lock`);
}

async function readMarkerPids(markerPath) {
  try {
    const text = await fs.readFile(markerPath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readMcpLogEvents(dataDir = sharedTestDataDir) {
  const logPath = path.resolve(dataDir, "logs", "mcp-error.log");
  try {
    const text = await fs.readFile(logPath, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
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
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const port = Number(process.env.REMOTE_DEBUG_AGENT_PORT);
const empty = process.env.FAKE_AGENT_EMPTY === "1";
const apiVersion = positiveInt(process.env.FAKE_AGENT_API_VERSION, 2);
const startDelayMs = Number.parseInt(process.env.FAKE_AGENT_START_DELAY_MS || "0", 10);
const startMarkerPath = process.env.FAKE_AGENT_START_MARKER || "";
const DEFAULT_ALLOWED_PATHS = ["/var/log", "/etc/nginx", "/home/app", "/root/.pm2", "/home/github"];

if (startMarkerPath) {
  fs.appendFileSync(startMarkerPath, \`\${process.pid}\\n\`, "utf8");
}

function sshPort() {
  return Number.parseInt(process.env.REMOTE_DEBUG_PORT || "22", 10);
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function flag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function securityConfig() {
  const approvedMaxTimeoutMs = positiveInt(process.env.REMOTE_DEBUG_APPROVED_EXECUTION_MAX_TIMEOUT_MS, 900000);
  const approvedDefaultTimeoutMs = Math.min(
    positiveInt(process.env.REMOTE_DEBUG_APPROVED_EXECUTION_TIMEOUT_MS, 300000),
    approvedMaxTimeoutMs
  );

  return {
    allowedPaths: DEFAULT_ALLOWED_PATHS,
    defaultTimeoutMs: 10000,
    maxTimeoutMs: 30000,
    defaultFileTimeoutMs: 60000,
    maxFileTimeoutMs: 300000,
    defaultReadMaxBytes: 256 * 1024,
    maxCommandOutputBytes: 1024 * 1024,
    approvedCommands: {
      enabled: flag(process.env.REMOTE_DEBUG_APPROVED_COMMANDS),
      ttlMs: 30 * 60 * 1000,
      executionTimeoutMs: approvedDefaultTimeoutMs,
      maxExecutionTimeoutMs: approvedMaxTimeoutMs,
      maxCommandLength: 16 * 1024,
      maxCommands: 20
    }
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

const leases = new Map();
let leaseRequestCount = 0;

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/status") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      name: "remote-debug-agent",
      mode: "manager",
      apiVersion,
      capabilities: {
        persistentSsh: true,
        operationDeadlines: true,
        cancellation: true,
        structuredHealth: true
      },
      agent: {
        port,
        pid: process.pid,
        configFingerprint: configFingerprint(),
        runtimeId: process.env.REMOTE_DEBUG_RUNTIME_ID || ${JSON.stringify(developmentRuntimeId)}
      },
      lifecycle: {
        lifetime: process.env.REMOTE_DEBUG_AGENT_LIFETIME || "manual",
        activeLeaseCount: leases.size,
        leaseRequestCount,
        clients: Array.from(leases.keys())
      },
      target: empty
        ? { host: "", port: sshPort(), username: "" }
        : { host: process.env.REMOTE_DEBUG_HOST || "", port: sshPort(), username: process.env.REMOTE_DEBUG_USER || "" }
    }));
    return;
  }

  if (request.method === "DELETE" && request.url.startsWith("/api/leases/")) {
    const clientId = decodeURIComponent(request.url.slice("/api/leases/".length));
    const released = leases.delete(clientId);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, released }));
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

  if (request.method === "POST" && request.url === "/api/leases") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      leaseRequestCount += 1;
      leases.set(parsed.clientId, parsed);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        lease: parsed,
        lifecycle: {
          lifetime: process.env.REMOTE_DEBUG_AGENT_LIFETIME || "manual",
          activeLeaseCount: leases.size
        }
      }));
    });
    return;
  }

  response.writeHead(404).end();
});

setTimeout(() => {
  server.listen(port, "127.0.0.1");
}, Number.isInteger(startDelayMs) && startDelayMs > 0 ? startDelayMs : 0);
`,
    "utf8",
  );
}

function startMcp(env, targetServerPath = serverPath) {
  return spawn(process.execPath, [targetServerPath], {
    cwd: path.dirname(targetServerPath),
    env: {
      ...process.env,
      REMOTE_DEBUG_DATA_DIR: sharedTestDataDir,
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

async function callListInstances(child) {
  const readMessage = createMessageReader(child);
  child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }));
  await readMessage();
  child.stdin.write(
    encodeMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "remote_debug_list_instances",
        arguments: {},
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

function assertStrictCompatibleSchema(schema, path = "inputSchema") {
  assert.equal(typeof schema, "object", `${path} is an object`);
  assert.equal(schema.additionalProperties, false, `${path} disables extra properties`);

  const properties = schema.properties || {};
  const required = schema.required || [];
  for (const propertyName of Object.keys(properties)) {
    if ([
      "instanceId",
      "timeoutMs",
      "maxBytes",
      "database",
      "collection",
      "filter",
      "projection",
      "sort",
      "pipeline",
      "limit",
      "skip",
      "category",
      "cursor",
      "prefix",
      "memberPath",
      "tailLines",
      "contains",
      "caseSensitive",
    ].includes(propertyName)) {
      continue;
    }
    assert.ok(required.includes(propertyName), `${path}.${propertyName} is required`);
  }
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
        "remote_debug_list_instances",
        "remote_debug_get_capabilities",
        "remote_debug_mongodb_query",
        "remote_debug_restart_instance",
        "remote_debug_update_memory",
        "remote_debug_run_command",
        "remote_debug_read_file",
        "remote_debug_list_dir",
        "remote_debug_list_logs",
        "remote_debug_list_log_archive_members",
        "remote_debug_read_log",
        "remote_debug_prepare_command_draft",
        "remote_debug_get_command_draft",
        "remote_debug_review_command_draft",
        "remote_debug_execute_command_draft",
      ],
    );
    for (const tool of list.result.tools) {
      assertStrictCompatibleSchema(tool.inputSchema, `${tool.name}.inputSchema`);
    }
    const runCommand = list.result.tools.find((tool) => tool.name === "remote_debug_run_command");
    assert.equal(runCommand.inputSchema.properties.timeoutMs.maximum, 120_000);
    const readFile = list.result.tools.find((tool) => tool.name === "remote_debug_read_file");
    assert.equal(readFile.inputSchema.properties.timeoutMs.maximum, 300_000);
    assert.equal(readFile.inputSchema.properties.maxBytes.maximum, 256 * 1024);
    assert.ok(readFile.inputSchema.properties.instanceId);
    const reviewDraft = list.result.tools.find((tool) => tool.name === "remote_debug_review_command_draft");
    assert.equal(reviewDraft.inputSchema.properties.timeoutMs.maximum, 930_000);
    assert.deepEqual(reviewDraft.inputSchema.required, ["draftId"]);

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

    child.stdin.write(encodeMessage({
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "remote_debug_list_logs",
        arguments: { instanceId: "default", category: "nginx", limit: 1 },
      },
    }));
    const logs = JSON.parse((await readMessage()).result.content[0].text);
    assert.equal(logs.entries[0].path, "/var/log/nginx/error.log");

    child.stdin.write(encodeMessage({
      jsonrpc: "2.0",
      id: 401,
      method: "tools/call",
      params: {
        name: "remote_debug_list_log_archive_members",
        arguments: { instanceId: "default", path: "/home/github/logs.tar.gz" },
      },
    }));
    const members = JSON.parse((await readMessage()).result.content[0].text);
    assert.equal(members.members[0].name, "error.log");

    child.stdin.write(encodeMessage({
      jsonrpc: "2.0",
      id: 402,
      method: "tools/call",
      params: {
        name: "remote_debug_read_log",
        arguments: {
          instanceId: "default",
          path: "/home/github/logs.tar.gz",
          memberPath: "error.log",
          contains: "error",
        },
      },
    }));
    const readLogResult = JSON.parse((await readMessage()).result.content[0].text);
    assert.equal(readLogResult.content, "ERROR\n");

    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: {
          name: "remote_debug_mongodb_query",
          arguments: { instanceId: "default", operation: "ping" },
        },
      }),
    );
    const mongo = JSON.parse((await readMessage()).result.content[0].text);
    assert.equal(mongo.instanceId, "default");
    assert.equal(mongo.operation, "ping");

    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "remote_debug_list_instances",
          arguments: {},
        },
      }),
    );
    const instances = JSON.parse((await readMessage()).result.content[0].text);
    assert.equal(instances.instances[0].id, "default");
    assert.equal(agentStub.leaseRequests.length, 0);

    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 50,
        method: "tools/call",
        params: {
          name: "remote_debug_get_capabilities",
          arguments: {},
        },
      }),
    );
    const capabilities = JSON.parse((await readMessage()).result.content[0].text);
    assert.equal(capabilities.capabilities.authority, "remote-debug-agent");
    assert.deepEqual(capabilities.capabilities.commands.examples, ["netstat -tlnp", "ps aux"]);

    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 51,
        method: "tools/call",
        params: {
          name: "remote_debug_restart_instance",
          arguments: { instanceId: "default" },
        },
      }),
    );
    const restarted = JSON.parse((await readMessage()).result.content[0].text);
    assert.equal(restarted.restarted, true);
    assert.equal(restarted.runtime.status, "running");

    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "remote_debug_update_memory",
          arguments: {
            instanceId: "default",
            topic: "database",
            summary: "Production database metadata",
            facts: ["database=yenneferbak"],
          },
        },
      }),
    );
    const memory = JSON.parse((await readMessage()).result.content[0].text);
    assert.equal(memory.note.topic, "database");
    assert.deepEqual(memory.note.facts, ["database=yenneferbak"]);
  } finally {
    child.kill();
    await close(agentStub);
  }
});

test("MCP server supports newline-delimited stdio clients", async () => {
  const agentStub = await startAgentStub();
  const port = agentStub.address().port;
  const child = startMcp({ REMOTE_DEBUG_AGENT_URL: `http://127.0.0.1:${port}` });
  const readMessage = createJsonLineMessageReader(child);

  try {
    child.stdin.write(encodeJsonLineMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    const initialize = await readMessage();
    assert.equal(initialize.result.serverInfo.name, "remote-debug-agent");

    child.stdin.write(encodeJsonLineMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const list = await readMessage();
    assert.ok(
      list.result.tools.some((tool) => tool.name === "remote_debug_run_command"),
      "tools/list includes remote_debug_run_command",
    );
  } finally {
    child.kill();
    await close(agentStub);
  }
});

test("MCP forwards approved command draft tools", async () => {
  const agentStub = await startAgentStub();
  const port = agentStub.address().port;
  const child = startMcp({ REMOTE_DEBUG_AGENT_URL: `http://127.0.0.1:${port}` });
  const readMessage = createMessageReader(child);

  try {
    child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    await readMessage();

    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "remote_debug_prepare_command_draft",
          arguments: {
            purpose: "manual fix",
            commands: ["echo ok | tee /tmp/approved-command-test"],
          },
        },
      }),
    );
    const prepare = JSON.parse((await readMessage()).result.content[0].text);
    assert.equal(prepare.draftId, "draft-1");
    assert.match(prepare.commandBlock, /tee/);

    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "remote_debug_get_command_draft",
          arguments: { draftId: prepare.draftId },
        },
      }),
    );
    const view = JSON.parse((await readMessage()).result.content[0].text);
    assert.equal(view.commandHash, prepare.commandHash);

    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "remote_debug_review_command_draft",
          arguments: { draftId: prepare.draftId },
        },
      }),
    );
    const review = JSON.parse((await readMessage()).result.content[0].text);
    assert.equal(review.decision, "manual_review");
    assert.equal(review.draftId, prepare.draftId);

    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "remote_debug_execute_command_draft",
          arguments: {
            draftId: prepare.draftId,
            commandHash: prepare.commandHash,
            confirmation: "使用命令",
          },
        },
      }),
    );
    const execute = JSON.parse((await readMessage()).result.content[0].text);
    assert.equal(execute.commandsOk, true);
    assert.match(execute.results[0].stdout, /ran:echo ok/);
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

test("MCP preserves worker deadline errors instead of reporting AGENT_UNAVAILABLE", async () => {
  const agentStub = await startOperationAgentStub("deadline");
  const port = agentStub.address().port;
  const child = startMcp({ REMOTE_DEBUG_AGENT_URL: `http://127.0.0.1:${port}` });
  const readMessage = createMessageReader(child);

  try {
    await initializeMcp(child, readMessage);
    const call = await callRunToolWithReader(child, readMessage, 2);
    const payload = JSON.parse(call.result.content[0].text);
    assert.equal(call.result.isError, true);
    assert.equal(payload.error.code, "OPERATION_DEADLINE_EXCEEDED");
    assert.equal(payload.error.layer, "ssh");
    assert.equal(payload.error.phase, "exec");
    assert.ok(payload.error.operationId);
  } finally {
    child.kill();
    await close(agentStub);
  }
});

test("MCP notifications/cancelled aborts an in-flight manager request", async () => {
  const agentStub = await startOperationAgentStub("pending");
  const port = agentStub.address().port;
  const child = startMcp({ REMOTE_DEBUG_AGENT_URL: `http://127.0.0.1:${port}` });
  const readMessage = createMessageReader(child);

  try {
    await initializeMcp(child, readMessage);
    child.stdin.write(encodeMessage({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "remote_debug_run_command",
        arguments: { cmd: "uptime", timeoutMs: 5_000 },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    child.stdin.write(encodeMessage({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 9, reason: "test cancellation" },
    }));
    const call = await readMessage();
    const payload = JSON.parse(call.result.content[0].text);
    assert.equal(payload.error.code, "OPERATION_CANCELLED");
    assert.equal(payload.error.layer, "mcp");
    assert.ok(payload.error.operationId);
  } finally {
    child.kill();
    await close(agentStub);
  }
});

test("MCP serializes concurrent local agent startup across processes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-mcp-lock-"));
  const agentDir = path.join(dir, "agent");
  const envPath = path.join(dir, ".env");
  const markerPath = path.join(dir, "agent-starts.txt");
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

  const env = {
    REMOTE_DEBUG_AGENT_URL: "",
    REMOTE_DEBUG_ENV_PATH: envPath,
    REMOTE_DEBUG_AGENT_DIR: agentDir,
    FAKE_AGENT_START_DELAY_MS: "1000",
    FAKE_AGENT_START_MARKER: markerPath,
  };
  const first = startMcp(env);
  const second = startMcp(env);

  try {
    const [firstCall, secondCall] = await Promise.all([
      callRunTool(first),
      callRunTool(second),
    ]);
    assert.match(firstCall.result.content[0].text, /ran:netstat -tlnp/);
    assert.match(secondCall.result.content[0].text, /ran:netstat -tlnp/);

    const status = await waitForStatus(port);
    const markerPids = await readMarkerPids(markerPath);
    assert.equal(new Set(markerPids).size, 1);

    const events = await readMcpLogEvents();
    assert.ok(events.some((event) => event.code === "AGENT_START_LOCK_ACQUIRED"));
    assert.ok(events.some((event) => event.code === "AGENT_START_LOCK_WAITING"));
    assert.ok(events.some((event) => event.code === "AGENT_START_LOCK_RELEASED"));

    killPid(status.agent.pid);
  } finally {
    first.kill();
    second.kill();
  }
});

test("MCP clears stale startup locks before starting the local agent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-mcp-stale-lock-"));
  const agentDir = path.join(dir, "agent");
  const envPath = path.join(dir, ".env");
  const markerPath = path.join(dir, "agent-starts.txt");
  const port = await getFreePort();
  const agentUrl = `http://127.0.0.1:${port}`;
  await writeFakeAgent(agentDir);
  await fs.writeFile(
    envPath,
    [
      "REMOTE_DEBUG_HOST=prod.example.com",
      "REMOTE_DEBUG_USER=app",
      `REMOTE_DEBUG_AGENT_PORT=${port}`,
    ].join("\n"),
  );

  const runtimeDir = path.resolve(sharedTestDataDir, "logs");
  await fs.mkdir(runtimeDir, { recursive: true });
  const sourceFingerprint = managerSourceFingerprint(agentUrl, port);
  const lockPath = agentStartLockPath(runtimeDir, agentUrl, sourceFingerprint);
  await fs.writeFile(
    lockPath,
    `${JSON.stringify(
      {
        lockId: "stale-test-lock",
        mcpPid: 1,
        agentUrl,
        serverPath: path.join(agentDir, "server.js"),
        reason: "stale test",
        createdAt: new Date(Date.now() - 31_000).toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const child = startMcp({
    REMOTE_DEBUG_AGENT_URL: "",
    REMOTE_DEBUG_ENV_PATH: envPath,
    REMOTE_DEBUG_AGENT_DIR: agentDir,
    FAKE_AGENT_START_MARKER: markerPath,
  });
  let agentPid;

  try {
    const call = await callRunTool(child);
    assert.match(call.result.content[0].text, /ran:netstat -tlnp/);
    const status = await waitForStatus(port);
    agentPid = status.agent.pid;
    const markerPids = await readMarkerPids(markerPath);
    assert.equal(new Set(markerPids).size, 1);

    const events = await readMcpLogEvents();
    assert.ok(
      events.some((event) => event.code === "AGENT_START_LOCK_STALE" && event.lockPath === lockPath),
    );

  } finally {
    killPid(agentPid);
    child.kill();
  }
});

test("MCP registers and renews a desktop lease for plugin-started local agents", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-mcp-lease-"));
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
    const call = await readMessage();
    assert.match(call.result.content[0].text, /ran:netstat -tlnp/);
    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "remote_debug_list_instances",
          arguments: {},
        },
      }),
    );
    await readMessage();
    const status = await waitForStatus(
      port,
      (candidate) =>
        candidate.lifecycle?.activeLeaseCount === 1 &&
        candidate.lifecycle?.leaseRequestCount >= 2,
    );
    assert.equal(status.lifecycle.lifetime, "desktop");
    assert.equal(status.lifecycle.clients.length, 1);
    process.kill(status.agent.pid);
  } finally {
    child.kill();
  }
});

test("MCP heartbeat restarts a missing plugin-started local agent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-mcp-heartbeat-recovery-"));
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
    const firstStatus = await waitForStatus(
      port,
      (candidate) => candidate.lifecycle?.activeLeaseCount === 1,
    );

    killPid(firstStatus.agent.pid);

    const recoveredStatus = await waitForStatus(
      port,
      (candidate) =>
        candidate.agent?.pid !== firstStatus.agent.pid &&
        candidate.lifecycle?.activeLeaseCount === 1,
      25_000,
    );
    assert.equal(recoveredStatus.lifecycle.lifetime, "desktop");
    killPid(recoveredStatus.agent.pid);
  } finally {
    child.kill();
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

test("bundled MCP runs from an isolated cache after the clone directory is renamed", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-cache-"));
  const projectDir = path.join(tempRoot, "源码 克隆");
  const renamedProjectDir = path.join(tempRoot, "源码 克隆 已移除");
  const codexHome = path.join(tempRoot, "Codex Home");
  const dataDir = path.join(tempRoot, "用户 数据");
  const cacheDir = path.join(
    codexHome,
    "plugins",
    "cache",
    "remote-debug-local",
    "remote-debug-agent",
    "2.1.0",
  );
  const installedServerPath = path.join(cacheDir, "mcp-server.js");
  const port = await getFreePort();
  const pluginRoot = path.resolve(here, "..");
  const legacyStateDir = path.join(projectDir, ".remote-debug");

  await fs.mkdir(legacyStateDir, { recursive: true });
  await fs.cp(pluginRoot, cacheDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".env"),
    [
      "REMOTE_DEBUG_HOST=prod.example.com",
      "REMOTE_DEBUG_USER=app",
      "REMOTE_DEBUG_PRIVATE_KEY_PATH=C:\\keys\\id_ed25519",
      `REMOTE_DEBUG_AGENT_PORT=${port}`,
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(legacyStateDir, "instances.json"),
    JSON.stringify({
      version: 3,
      defaultInstanceId: "legacy-instance",
      instances: [
        {
          id: "legacy-instance",
          name: "Legacy Instance",
          enabled: true,
          host: "prod.example.com",
          port: 22,
          username: "app",
          privateKeyPath: "C:\\keys\\id_ed25519",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );
  await fs.mkdir(codexHome, { recursive: true });
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
      NODE_PATH: "",
      REMOTE_DEBUG_DATA_DIR: dataDir,
      REMOTE_DEBUG_AGENT_URL: "",
      REMOTE_DEBUG_AGENT_DIR: "",
      REMOTE_DEBUG_ENV_PATH: "",
    },
    installedServerPath,
  );

  try {
    const call = await callListInstances(child);
    const instances = JSON.parse(call.result.content[0].text);
    assert.equal(instances.instances[0].id, "legacy-instance");
    assert.equal(
      await fs.readFile(path.join(dataDir, "config.env"), "utf8"),
      await fs.readFile(path.join(projectDir, ".env"), "utf8"),
    );

    const status = await waitForStatus(port);
    assert.match(status.agent.runtimeId, /^2\.1\.0:[a-f0-9]{64}$/);
    killPid(status.agent.pid);
    await waitForPortRelease(port);
    child.kill();

    await fs.rename(projectDir, renamedProjectDir);
    const restarted = startMcp(
      {
        CODEX_HOME: codexHome,
        NODE_PATH: "",
        REMOTE_DEBUG_DATA_DIR: dataDir,
        REMOTE_DEBUG_AGENT_URL: "",
        REMOTE_DEBUG_AGENT_DIR: "",
        REMOTE_DEBUG_ENV_PATH: "",
      },
      installedServerPath,
    );
    try {
      const restartedCall = await callListInstances(restarted);
      const restartedInstances = JSON.parse(restartedCall.result.content[0].text);
      assert.equal(restartedInstances.instances[0].id, "legacy-instance");
      const restartedStatus = await waitForStatus(port);
      assert.match(restartedStatus.agent.runtimeId, /^2\.1\.0:[a-f0-9]{64}$/);
      killPid(restartedStatus.agent.pid);
    } finally {
      restarted.kill();
    }
  } finally {
    child.kill();
    try {
      const status = await waitForStatus(port, () => true, 500);
      killPid(status.agent.pid);
    } catch {
      // The test already stopped the bundled manager.
    }
  }
});

test("MCP reports BUNDLED_AGENT_NOT_FOUND instead of falling back to source", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-missing-runtime-"));
  const cacheDir = path.join(tempRoot, "插件 缓存");
  const dataDir = path.join(tempRoot, "用户 数据");
  const installedServerPath = path.join(cacheDir, "mcp-server.js");
  const port = await getFreePort();

  await fs.mkdir(path.join(cacheDir, ".codex-plugin"), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.copyFile(serverPath, installedServerPath);
  await fs.copyFile(
    path.resolve(here, "..", "runtime-support.js"),
    path.join(cacheDir, "runtime-support.js"),
  );
  await fs.copyFile(
    path.resolve(here, "..", ".codex-plugin", "plugin.json"),
    path.join(cacheDir, ".codex-plugin", "plugin.json"),
  );
  await fs.writeFile(
    path.join(dataDir, "config.env"),
    [
      "REMOTE_DEBUG_HOST=prod.example.com",
      "REMOTE_DEBUG_USER=app",
      "REMOTE_DEBUG_PRIVATE_KEY_PATH=C:\\keys\\id_ed25519",
      `REMOTE_DEBUG_AGENT_PORT=${port}`,
    ].join("\n"),
  );

  const child = startMcp(
    {
      NODE_PATH: "",
      REMOTE_DEBUG_DATA_DIR: dataDir,
      REMOTE_DEBUG_AGENT_URL: "",
      REMOTE_DEBUG_AGENT_DIR: "",
      REMOTE_DEBUG_ENV_PATH: "",
    },
    installedServerPath,
  );

  try {
    const call = await callListInstances(child);
    const result = JSON.parse(call.result.content[0].text);
    assert.equal(call.result.isError, true);
    assert.equal(result.error.code, "BUNDLED_AGENT_NOT_FOUND");
    assert.match(result.error.message, /runtime was not found/i);
  } finally {
    child.kill();
  }
});

test("external V2 agent URLs remain usable without a bundled runtime", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-external-v2-"));
  const cacheDir = path.join(tempRoot, "插件 缓存");
  const dataDir = path.join(tempRoot, "用户 数据");
  const installedServerPath = path.join(cacheDir, "mcp-server.js");
  const agentStub = await startAgentStub();

  await fs.mkdir(path.join(cacheDir, ".codex-plugin"), { recursive: true });
  await fs.copyFile(serverPath, installedServerPath);
  await fs.copyFile(
    path.resolve(here, "..", "runtime-support.js"),
    path.join(cacheDir, "runtime-support.js"),
  );
  await fs.copyFile(
    path.resolve(here, "..", ".codex-plugin", "plugin.json"),
    path.join(cacheDir, ".codex-plugin", "plugin.json"),
  );

  const child = startMcp(
    {
      NODE_PATH: "",
      REMOTE_DEBUG_DATA_DIR: dataDir,
      REMOTE_DEBUG_AGENT_URL: `http://127.0.0.1:${agentStub.address().port}`,
      REMOTE_DEBUG_AGENT_DIR: "",
      REMOTE_DEBUG_ENV_PATH: "",
    },
    installedServerPath,
  );

  try {
    const call = await callListInstances(child);
    const result = JSON.parse(call.result.content[0].text);
    assert.equal(result.instances[0].id, "default");
  } finally {
    child.kill();
    await close(agentStub);
  }
});

test("MCP replaces an outdated source manager when the runtime id differs", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-v2-upgrade-"));
  const agentDir = path.join(tempRoot, "agent");
  const envPath = path.join(tempRoot, ".env");
  const port = await getFreePort();
  await writeFakeAgent(agentDir);
  await fs.writeFile(
    envPath,
    [
      `REMOTE_DEBUG_AGENT_PORT=${port}`,
      "REMOTE_DEBUG_HOST=prod.example.com",
      "REMOTE_DEBUG_USER=app",
      "REMOTE_DEBUG_PRIVATE_KEY_PATH=C:\\keys\\id_ed25519",
    ].join("\n"),
  );
  const oldManager = spawn(process.execPath, [path.join(agentDir, "server.js")], {
    cwd: agentDir,
    env: {
      ...process.env,
      REMOTE_DEBUG_AGENT_PORT: String(port),
      REMOTE_DEBUG_RUNTIME_ID: "development:2.0.0",
    },
    stdio: "ignore",
  });
  const child = startMcp({
    REMOTE_DEBUG_AGENT_URL: "",
      REMOTE_DEBUG_AGENT_PORT: String(port),
      REMOTE_DEBUG_AGENT_DIR: agentDir,
      REMOTE_DEBUG_ENV_PATH: envPath,
    });

  try {
    await waitForStatus(
      port,
      (status) => status.agent.runtimeId === "development:2.0.0",
    );
    const call = await callRunTool(child);
    assert.match(call.result.content[0].text, /ran:netstat -tlnp/);
    const status = await waitForStatus(
      port,
      (candidate) =>
        candidate.agent.runtimeId === developmentRuntimeId &&
        candidate.agent.pid !== oldManager.pid,
    );
    assert.equal(status.agent.runtimeId, developmentRuntimeId);
    killPid(status.agent.pid);
  } finally {
    child.kill();
    killPid(oldManager.pid);
  }
});

test("MCP reuses an online manager even when target fields differ", async () => {
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

  const managerLike = spawn(process.execPath, [path.join(agentDir, "server.js")], {
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
    assert.equal(status.agent.pid, managerLike.pid);
    process.kill(status.agent.pid);
  } finally {
    child.kill();
    if (!managerLike.killed) {
      managerLike.kill();
    }
  }
});

test("MCP keeps the manager process when .env target config changes", async () => {
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
    assert.equal(secondStatus.target.host, "prod.example.com");
    assert.equal(secondStatus.agent.pid, firstStatus.agent.pid);
    assert.equal(secondStatus.agent.configFingerprint, firstStatus.agent.configFingerprint);
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

