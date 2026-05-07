import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
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

test("MCP server exposes remote debug tools and forwards calls", async () => {
  const agentStub = await startAgentStub();
  const port = agentStub.address().port;
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      REMOTE_DEBUG_AGENT_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
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

