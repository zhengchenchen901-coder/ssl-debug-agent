import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const serverPath = path.resolve(pluginRoot, "mcp-server.js");
const logPath = path.resolve(pluginRoot, ".runtime", "mcp-error.log");
const pluginName = "remote-debug-agent";
const expectedTools = [
  "remote_debug_list_instances",
  "remote_debug_run_command",
  "remote_debug_read_file",
  "remote_debug_list_dir",
  "remote_debug_prepare_command_draft",
  "remote_debug_get_command_draft",
  "remote_debug_execute_command_draft",
];

function normalizeWindowsExtendedPath(inputPath) {
  return inputPath.replace(/^\\\\\?\\/, "");
}

function codexHomeDir() {
  return process.env.CODEX_HOME ||
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
}

function codexConfigPath() {
  return path.join(codexHomeDir(), "config.toml");
}

function marketplaceNameFromCachePath() {
  const parts = path.normalize(pluginRoot).split(path.sep);
  const cacheIndex = parts.lastIndexOf("cache");
  if (cacheIndex === -1 || cacheIndex + 1 >= parts.length) {
    return "";
  }

  return parts[cacheIndex + 1];
}

function parseTomlScalar(value) {
  const trimmed = value.trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  if (quoted) {
    return normalizeWindowsExtendedPath(quoted[2]);
  }

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  return trimmed;
}

function readCodexSections() {
  const configPath = codexConfigPath();
  if (!fs.existsSync(configPath)) {
    return [];
  }

  const sections = [];
  let current = null;
  for (const line of fs.readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    const sectionMatch = /^\[(.+)]$/.exec(trimmed);
    if (sectionMatch) {
      current = { name: sectionMatch[1], values: {} };
      sections.push(current);
      continue;
    }

    if (!current || !trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const valueMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (valueMatch) {
      current.values[valueMatch[1]] = parseTomlScalar(valueMatch[2]);
    }
  }

  return sections;
}

function marketplaceNameFromSection(sectionName) {
  let match = /^marketplaces\.([A-Za-z0-9_.-]+)$/.exec(sectionName);
  if (match) {
    return match[1];
  }

  match = /^marketplaces\."([^"]+)"$/.exec(sectionName);
  return match ? match[1] : "";
}

function pluginNameFromSection(sectionName) {
  let match = /^plugins\.([A-Za-z0-9_.@-]+)$/.exec(sectionName);
  if (match) {
    return match[1];
  }

  match = /^plugins\."([^"]+)"$/.exec(sectionName);
  return match ? match[1] : "";
}

function readPluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")).version || "unknown";
  } catch {
    // Fall back to package.json for older local checkouts.
  }

  try {
    return JSON.parse(fs.readFileSync(path.resolve(pluginRoot, "package.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

function findMarketplace(sections) {
  const cacheMarketplaceName = marketplaceNameFromCachePath();
  const sourceRoot = path.resolve(pluginRoot, "..", "..");
  const marketplaces = sections
    .map((section) => ({
      name: marketplaceNameFromSection(section.name),
      source: typeof section.values.source === "string" ? path.resolve(section.values.source) : "",
      sourceType: section.values.source_type || "",
      lastUpdated: section.values.last_updated || "",
    }))
    .filter((marketplace) => marketplace.name);

  if (cacheMarketplaceName) {
    return marketplaces.find((marketplace) => marketplace.name === cacheMarketplaceName) || {
      name: cacheMarketplaceName,
      source: "",
    };
  }

  return marketplaces.find((marketplace) => marketplace.source === sourceRoot) || null;
}

function pluginEnabledState(sections, marketplaceName) {
  if (!marketplaceName) {
    return "unknown";
  }

  const installedName = `${pluginName}@${marketplaceName}`;
  const section = sections.find((candidate) => pluginNameFromSection(candidate.name) === installedName);
  if (!section) {
    return "not configured";
  }

  return section.values.enabled === true ? "enabled" : "disabled";
}

function installedCachePath(marketplaceName, version) {
  if (!marketplaceName) {
    return "";
  }

  const candidate = path.join(codexHomeDir(), "plugins", "cache", marketplaceName, pluginName, version);
  return fs.existsSync(candidate) ? candidate : "";
}

function installedRuntimeLogPath(cachePath) {
  return cachePath ? path.join(cachePath, ".runtime", "mcp-error.log") : "";
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function latestLogEvent(logFilePath, code) {
  if (!logFilePath || !fs.existsSync(logFilePath)) {
    return null;
  }

  const lines = fs.readFileSync(logFilePath, "utf8").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = parseJsonLine(lines[index]);
    if (entry?.code === code) {
      return entry;
    }
  }

  return null;
}

function formatLifecycleEvent(event) {
  if (!event) {
    return "not found";
  }

  const parts = [
    event.time || "unknown time",
    `pid ${event.pid || "unknown"}`,
    `path ${event.mcpServerPath || "unknown"}`,
  ];

  if (event.protocolVersion) {
    parts.push(`protocol ${event.protocolVersion}`);
  }

  if (event.code === "MCP_TOOLS_LIST") {
    parts.push(`toolCount ${event.toolCount ?? "unknown"}`);
  }

  return parts.join(", ");
}

function resolveProjectRoot(marketplace) {
  if (process.env.REMOTE_DEBUG_PROJECT_ROOT) {
    return path.resolve(normalizeWindowsExtendedPath(process.env.REMOTE_DEBUG_PROJECT_ROOT));
  }

  if (marketplace?.source) {
    return path.resolve(marketplace.source);
  }

  return path.resolve(pluginRoot, "..", "..");
}

function mergeEnvironment(...sources) {
  const merged = {};
  const keysByNormalizedName = new Map();

  for (const source of sources) {
    for (const [key, value] of Object.entries(source || {})) {
      if (value === undefined) {
        continue;
      }

      const normalizedKey = process.platform === "win32" ? key.toUpperCase() : key;
      const existingKey = keysByNormalizedName.get(normalizedKey);
      if (existingKey && existingKey !== key) {
        delete merged[existingKey];
      }

      merged[key] = String(value);
      keysByNormalizedName.set(normalizedKey, key);
    }
  }

  return merged;
}

const codexSections = readCodexSections();
const marketplace = findMarketplace(codexSections);
const projectRoot = resolveProjectRoot(marketplace);

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

  const port = Number.parseInt(env.REMOTE_DEBUG_AGENT_PORT || "4343", 10);
  return `http://127.0.0.1:${Number.isInteger(port) ? port : 4343}`;
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
    env: mergeEnvironment(process.env, env),
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
    const pluginVersion = readPluginVersion();
    const cachePath = installedCachePath(marketplace?.name, pluginVersion);
    const cacheLogPath = installedRuntimeLogPath(cachePath);
    const cacheInitialize = latestLogEvent(cacheLogPath, "MCP_INITIALIZE");
    const cacheToolsList = latestLogEvent(cacheLogPath, "MCP_TOOLS_LIST");

    printLine("Source root", projectRoot);
    printLine("Installed cache", cachePath || "not found");
    printLine(
      "Codex plugin",
      marketplace?.name
        ? `${pluginName}@${marketplace.name} (${pluginEnabledState(codexSections, marketplace.name)})`
        : "not configured",
    );
    printLine("MCP server", serverPath);
    printLine("MCP initialize", `ok (${initialize.result?.serverInfo?.name || "unknown"} ${initialize.result?.serverInfo?.version || ""})`);
    printLine("MCP tools", toolNames.length > 0 ? toolNames.join(", ") : "none");
    printLine("Source wrapper self-test", "ok");
    printLine("Installed cache MCP log", cacheLogPath || "not found");
    printLine("Installed cache last initialize", formatLifecycleEvent(cacheInitialize));
    printLine("Installed cache last tools/list", formatLifecycleEvent(cacheToolsList));

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
    printLine(
      "Current thread",
      "diagnose verifies the MCP wrapper only; if this Codex thread still cannot see remote_debug_* tools, restart Codex Desktop or open a new thread after reinstalling/re-enabling the plugin.",
    );
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
