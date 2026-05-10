import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(pluginRoot, "..", "..");
const serverPath = path.resolve(pluginRoot, "mcp-server.js");
const logPath = path.resolve(pluginRoot, ".runtime", "mcp-error.log");
const expectedTools = [
  "remote_debug_run_command",
  "remote_debug_read_file",
  "remote_debug_list_dir",
];

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

  function deliver(message) {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      queue.push(message);
    }
  }

  function parse() {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /^Content-Length:\s*(\d+)$/im.exec(header);
      if (!match) {
        throw new Error("MCP response is missing Content-Length");
      }

      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) return;

      const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
      buffer = buffer.subarray(bodyEnd);
      deliver(message);
    }
  }

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    parse();
  });

  return function readMessage(timeoutMs = 5000) {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift());
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting ${timeoutMs}ms for MCP response`));
      }, timeoutMs);

      waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  };
}

function parseEnvFile(contents) {
  const parsed = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
      if (line.includes("\"")) {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, "\"");
      }
    } else {
      value = value.replace(/\s+#.*$/, "");
    }

    parsed[key] = value;
  }

  return parsed;
}

function readEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return {};
  }

  return parseEnvFile(fs.readFileSync(envPath, "utf8"));
}

function effectiveRemoteDebugEnv() {
  const dotEnv = {
    ...readEnvFile(path.resolve(projectRoot, ".env")),
    ...readEnvFile(path.resolve(projectRoot, "agent", ".env")),
  };
  const env = { ...process.env };

  for (const [key, value] of Object.entries(dotEnv)) {
    if (key.startsWith("REMOTE_DEBUG_")) {
      env[key] = value;
    }
  }

  return env;
}

function agentUrlFromEnv(env) {
  if (env.REMOTE_DEBUG_AGENT_URL) {
    return env.REMOTE_DEBUG_AGENT_URL;
  }

  const port = Number.parseInt(env.REMOTE_DEBUG_AGENT_PORT || "3000", 10);
  return `http://127.0.0.1:${Number.isInteger(port) ? port : 3000}`;
}

async function fetchAgentStatus(agentUrl) {
  const deadline = Date.now() + 7000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/status", agentUrl));
      const text = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }

      return { response, parsed };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw lastError || new Error(`agent did not respond at ${agentUrl}`);
}

function printLine(label, value) {
  console.log(`${label}: ${value}`);
}

async function main() {
  const env = effectiveRemoteDebugEnv();
  const agentUrl = agentUrlFromEnv(env);
  const child = spawn(process.execPath, [serverPath], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const readMessage = createMessageReader(child);
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

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
    if (initialize.error) {
      throw new Error(`initialize failed: ${initialize.error.message}`);
    }

    child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const list = await readMessage();
    if (list.error) {
      throw new Error(`tools/list failed: ${list.error.message}`);
    }

    const toolNames = (list.result?.tools || []).map((tool) => tool.name);
    const missingTools = expectedTools.filter((name) => !toolNames.includes(name));
    printLine("MCP initialize", `ok (${initialize.result?.serverInfo?.name || "unknown"} ${initialize.result?.serverInfo?.version || ""})`);
    printLine("MCP tools", toolNames.length > 0 ? toolNames.join(", ") : "none");

    if (missingTools.length > 0) {
      throw new Error(`missing expected MCP tools: ${missingTools.join(", ")}`);
    }

    try {
      const { response, parsed } = await fetchAgentStatus(agentUrl);
      const status = response.ok && parsed?.name === "remote-debug-agent" ? "ok" : "unexpected";
      const target = parsed?.target
        ? `${parsed.target.username || "unknown"}@${parsed.target.host || "unknown"}:${parsed.target.port || ""}`
        : "unknown";
      printLine("HTTP agent", `${status} (${agentUrl}, target ${target})`);
    } catch (error) {
      printLine("HTTP agent", `warning (${agentUrl}, ${error.message})`);
    }

    printLine("MCP log", logPath);
    if (stderr.trim()) {
      printLine("MCP stderr", stderr.trim());
    }
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(`diagnose failed: ${error.message}`);
  process.exitCode = 1;
});
