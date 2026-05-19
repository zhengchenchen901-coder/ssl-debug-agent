import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const PLUGIN_VERSION = "1.0.5";
const DEFAULT_AGENT_PORT = 4343;
const DEFAULT_SSH_PORT = 22;
const PROBE_TIMEOUT_MS = 1500;
const START_TIMEOUT_MS = 7000;
const FALLBACK_PORT_ATTEMPTS = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_READ_MAX_BYTES = 256 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_ALLOWED_PATHS = ["/var/log", "/etc/nginx", "/home/app", "/root/.pm2", "/home/github"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizeWindowsExtendedPath(inputPath) {
  return inputPath.replace(/^\\\\\?\\/, "");
}

function codexHomeDir() {
  return process.env.CODEX_HOME ||
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
}

function marketplaceNameFromCachePath() {
  const parts = path.normalize(__dirname).split(path.sep);
  const cacheIndex = parts.lastIndexOf("cache");
  if (cacheIndex === -1 || cacheIndex + 1 >= parts.length) {
    return "";
  }

  return parts[cacheIndex + 1];
}

function readMarketplaceSource(marketplaceName) {
  if (!marketplaceName) {
    return "";
  }

  const configPath = path.join(codexHomeDir(), "config.toml");
  if (!fs.existsSync(configPath)) {
    return "";
  }

  const sectionNames = new Set([
    `[marketplaces.${marketplaceName}]`,
    `[marketplaces."${marketplaceName}"]`,
  ]);
  let inSection = false;

  for (const line of fs.readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inSection = sectionNames.has(trimmed);
      continue;
    }

    if (!inSection) {
      continue;
    }

    const match = /^source\s*=\s*(['"])(.*)\1\s*$/.exec(trimmed);
    if (match) {
      return normalizeWindowsExtendedPath(match[2]);
    }
  }

  return "";
}

function resolveProjectRoot() {
  if (process.env.REMOTE_DEBUG_PROJECT_ROOT) {
    return path.resolve(normalizeWindowsExtendedPath(process.env.REMOTE_DEBUG_PROJECT_ROOT));
  }

  const marketplaceSource = readMarketplaceSource(marketplaceNameFromCachePath());
  if (marketplaceSource) {
    return path.resolve(marketplaceSource);
  }

  return path.resolve(__dirname, "..", "..");
}

const projectRoot = resolveProjectRoot();
let activeAgentSettings = null;

const tools = [
  {
    name: "remote_debug_run_command",
    description:
      "Run a whitelisted read-only Linux diagnostic command through the local Remote Debug Agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["cmd"],
      properties: {
        cmd: {
          type: "string",
          description:
            "Command such as 'netstat -tlnp', 'systemctl status nginx', or 'tail -n 100 /var/log/nginx/error.log'.",
        },
        timeoutMs: {
          type: "number",
          description: "Optional timeout in milliseconds. The agent clamps it to the configured maximum.",
        },
      },
    },
  },
  {
    name: "remote_debug_read_file",
    description:
      "Read a remote file under /var/log, /etc/nginx, /home/app, /root/.pm2, or /home/github through SFTP path checks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Absolute remote file path.",
        },
        maxBytes: {
          type: "number",
          description: "Optional maximum bytes to return. The agent clamps it to the configured maximum.",
        },
      },
    },
  },
  {
    name: "remote_debug_list_dir",
    description:
      "List a remote directory under /var/log, /etc/nginx, /home/app, /root/.pm2, or /home/github through SFTP path checks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Absolute remote directory path.",
        },
      },
    },
  },
];

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
  if (!envPath || !fs.existsSync(envPath)) {
    return {};
  }

  return parseEnvFile(fs.readFileSync(envPath, "utf8"));
}

function loadDotEnv() {
  const explicitEnvPath = process.env.REMOTE_DEBUG_ENV_PATH;
  if (explicitEnvPath) {
    return readEnvFile(explicitEnvPath);
  }

  return {
    ...readEnvFile(path.resolve(projectRoot, ".env")),
    ...readEnvFile(path.resolve(projectRoot, "agent", ".env")),
  };
}

function loadRemoteDebugEnv() {
  const env = { ...process.env };
  const dotEnv = loadDotEnv();

  for (const [key, value] of Object.entries(dotEnv)) {
    if (key.startsWith("REMOTE_DEBUG_")) {
      env[key] = value;
    }
  }

  return env;
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

function parsePositivePort(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    const error = new Error(`REMOTE_DEBUG_AGENT_PORT must be a valid TCP port: ${value}`);
    error.code = "INVALID_AGENT_PORT";
    throw error;
  }

  return parsed;
}

function parseSshPort(value) {
  if (value === undefined || value === "") {
    return DEFAULT_SSH_PORT;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    const error = new Error(`REMOTE_DEBUG_PORT must be a valid TCP port: ${value}`);
    error.code = "INVALID_SSH_PORT";
    throw error;
  }

  return parsed;
}

function publicTargetFromEnv(env) {
  return {
    host: env.REMOTE_DEBUG_HOST || "",
    port: parseSshPort(env.REMOTE_DEBUG_PORT),
    username: env.REMOTE_DEBUG_USER || "",
  };
}

function publicSecurityConfig() {
  return {
    allowedPaths: DEFAULT_ALLOWED_PATHS,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: MAX_TIMEOUT_MS,
    defaultReadMaxBytes: DEFAULT_READ_MAX_BYTES,
    maxCommandOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  };
}

function fingerprintConfigFromEnv(env, agentDir, port) {
  return {
    agent: {
      host: "127.0.0.1",
      port,
    },
    ssh: {
      host: env.REMOTE_DEBUG_HOST || "",
      port: parseSshPort(env.REMOTE_DEBUG_PORT),
      username: env.REMOTE_DEBUG_USER || "",
      privateKeyPath: env.REMOTE_DEBUG_PRIVATE_KEY_PATH || "",
      passphrase: env.REMOTE_DEBUG_PRIVATE_KEY_PASSPHRASE || "",
      readyTimeout: 10_000,
    },
    security: publicSecurityConfig(),
    audit: {
      logPath: env.REMOTE_DEBUG_AUDIT_LOG || path.resolve(agentDir, "audit", "remote-debug-agent.jsonl"),
    },
  };
}

function configFingerprintFromEnv(env, agentDir, port) {
  return createHash("sha256")
    .update(JSON.stringify(fingerprintConfigFromEnv(env, agentDir, port)))
    .digest("hex");
}

function agentSettings() {
  const env = loadRemoteDebugEnv();
  const explicitUrl = env.REMOTE_DEBUG_AGENT_URL || "";
  const port = parsePositivePort(env.REMOTE_DEBUG_AGENT_PORT, DEFAULT_AGENT_PORT);
  const agentUrl = explicitUrl || `http://127.0.0.1:${port}`;
  const agentDir = path.resolve(env.REMOTE_DEBUG_AGENT_DIR || path.resolve(projectRoot, "agent"));
  const statePath = path.resolve(agentDir, ".runtime", "agent-state.json");
  const runtimeDir = path.resolve(__dirname, ".runtime");
  const target = publicTargetFromEnv(env);
  const configFingerprint = configFingerprintFromEnv(env, agentDir, port);

  return {
    env,
    explicitUrl: Boolean(explicitUrl),
    agentUrl,
    port,
    preferredPort: port,
    target,
    configFingerprint,
    sourceFingerprint: configFingerprint,
    agentDir,
    serverPath: path.resolve(agentDir, "server.js"),
    statePath,
    runtimeDir,
    logPath: path.resolve(runtimeDir, "mcp-error.log"),
  };
}

function agentSettingsWithPort(settings, port) {
  return {
    ...settings,
    agentUrl: `http://127.0.0.1:${port}`,
    port,
    configFingerprint: configFingerprintFromEnv(settings.env, settings.agentDir, port),
  };
}

async function appendPluginLog(settings, event) {
  const entry = {
    time: new Date().toISOString(),
    component: "mcp-server",
    pluginVersion: PLUGIN_VERSION,
    projectRoot,
    mcpServerPath: __filename,
    pid: process.pid,
    agentUrl: settings.agentUrl,
    port: settings.port,
    agentDir: settings.agentDir,
    explicitAgentUrl: settings.explicitUrl,
    ...event,
  };

  try {
    await fsp.mkdir(settings.runtimeDir, { recursive: true });
    await fsp.appendFile(settings.logPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error("failed to write MCP runtime log", error);
  }
}

function fallbackLogSettings(error) {
  const runtimeDir = path.resolve(__dirname, ".runtime");

  return {
    agentUrl: "",
    port: null,
    agentDir: "",
    explicitUrl: false,
    runtimeDir,
    logPath: path.resolve(runtimeDir, "mcp-error.log"),
    settingsError: {
      code: error?.code || "AGENT_SETTINGS_ERROR",
      message: error?.message || "failed to resolve Remote Debug Agent settings",
    },
  };
}

function logSettings() {
  try {
    return agentSettings();
  } catch (error) {
    return fallbackLogSettings(error);
  }
}

function toolArgumentSummary(name, args = {}) {
  if (name === "remote_debug_run_command") {
    return {
      cmd: typeof args.cmd === "string" ? args.cmd.slice(0, 256) : undefined,
      timeoutMs: args.timeoutMs,
    };
  }

  if (name === "remote_debug_read_file") {
    return {
      path: typeof args.path === "string" ? args.path.slice(0, 512) : undefined,
      maxBytes: args.maxBytes,
    };
  }

  if (name === "remote_debug_list_dir") {
    return {
      path: typeof args.path === "string" ? args.path.slice(0, 512) : undefined,
    };
  }

  return {
    keys: Object.keys(args).slice(0, 20),
  };
}

async function logMcpLifecycle(code, message, event = {}) {
  const settings = logSettings();
  const details = {
    level: "info",
    code,
    message,
    settingsError: settings.settingsError,
    ...event,
  };

  await appendPluginLog(settings, details);
}

function sendMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function protocolVersionFor(params) {
  return typeof params?.protocolVersion === "string" && params.protocolVersion
    ? params.protocolVersion
    : DEFAULT_PROTOCOL_VERSION;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { ok: false, raw: text };
    }

    return { response, parsed };
  } finally {
    clearTimeout(timer);
  }
}

function isConnectionRefused(error) {
  const code = error?.cause?.code || error?.code;
  return code === "ECONNREFUSED" || code === "ENOENT";
}

async function probeAgent(settings) {
  try {
    const { response, parsed } = await fetchJson(new URL("/status", settings.agentUrl));
    if (parsed?.name === "remote-debug-agent") {
      return { kind: "agent", response, status: parsed };
    }

    return { kind: "occupied", response, status: parsed };
  } catch (error) {
    if (isConnectionRefused(error)) {
      return { kind: "unreachable", error };
    }

    return { kind: "occupied", error };
  }
}

function agentStatusIsHealthy(status, settings) {
  const agentPort = status?.agent?.port;
  const portMatches = agentPort === undefined || agentPort === settings.port;
  const target = status?.target || {};
  const targetMatches =
    target.host === settings.target.host &&
    target.port === settings.target.port &&
    target.username === settings.target.username;
  const fingerprintMatches = status?.agent?.configFingerprint === settings.configFingerprint;

  return Boolean(
    status?.name === "remote-debug-agent" &&
      portMatches &&
      targetMatches &&
      fingerprintMatches,
  );
}

function agentSourceMatches(settings, currentSettings) {
  return settings?.sourceFingerprint === currentSettings?.sourceFingerprint;
}

function statusSummary(status) {
  return {
    pid: status?.agent?.pid,
    port: status?.agent?.port,
    configFingerprint: status?.agent?.configFingerprint,
    target: status?.target,
  };
}

function expectedSummary(settings) {
  return {
    port: settings.port,
    preferredPort: settings.preferredPort,
    configFingerprint: settings.configFingerprint,
    sourceFingerprint: settings.sourceFingerprint,
    target: settings.target,
  };
}

async function logAgentConfigChanged(settings, status, previousSettings) {
  await appendPluginLog(settings, {
    level: "warn",
    code: "AGENT_CONFIG_CHANGED",
    message: "Remote Debug Agent configuration changed; restarting local agent.",
    previous: previousSettings ? expectedSummary(previousSettings) : undefined,
    actual: statusSummary(status),
    expected: expectedSummary(settings),
  });
}

async function stopStaleAgent(settings, status, currentSettings) {
  try {
    await stopConfirmedAgent(
      settings,
      status,
      "Stopping stale Remote Debug Agent after configuration change.",
    );
    return true;
  } catch (error) {
    await appendPluginLog(currentSettings, {
      level: "warn",
      code: error.code || "AGENT_RESTART_UNSAFE",
      message: `Skipping stale Remote Debug Agent stop: ${error.message}`,
      details: error.payload,
    });

    if (settings.port === currentSettings.port) {
      throw error;
    }

    return false;
  }
}

async function readState(settings) {
  try {
    return JSON.parse(await fsp.readFile(settings.statePath, "utf8"));
  } catch {
    return null;
  }
}

function execFileText(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
}

async function findListeningPid(port) {
  if (process.platform === "win32") {
    const output = await execFileText("netstat", ["-ano", "-p", "tcp"]);
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;

      const parts = line.trim().split(/\s+/);
      const localAddress = parts[1] || "";
      const pid = Number.parseInt(parts[4], 10);
      if (localAddress.endsWith(`:${port}`) && Number.isInteger(pid)) {
        return pid;
      }
    }
  } else {
    const output = await execFileText("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    const pid = Number.parseInt(output.trim().split(/\s+/)[0], 10);
    if (Number.isInteger(pid)) {
      return pid;
    }
  }

  return null;
}

async function stopConfirmedAgent(settings, status, reason = "Stopping unhealthy Remote Debug Agent before restart.") {
  const state = await readState(settings);
  const pid =
    status?.agent?.pid ||
    (state?.name === "remote-debug-agent" && state?.port === settings.port ? state.pid : null) ||
    (await findListeningPid(settings.port));

  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    const error = new Error("Remote Debug Agent is unhealthy, but no safe local pid was found to restart it.");
    error.code = "AGENT_RESTART_UNSAFE";
    error.payload = { agentUrl: settings.agentUrl, port: settings.port, status, state };
    throw error;
  }

  await appendPluginLog(settings, {
    level: "warn",
    code: "AGENT_RESTARTING",
    message: reason,
    pid,
  });
  process.kill(pid);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const probe = await probeAgent(settings);
    if (probe.kind === "unreachable") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function startAgent(settings, reason) {
  if (!fs.existsSync(settings.serverPath)) {
    const error = new Error(`Remote Debug Agent server not found: ${settings.serverPath}`);
    error.code = "AGENT_SERVER_NOT_FOUND";
    error.payload = { agentDir: settings.agentDir, serverPath: settings.serverPath };
    throw error;
  }

  await appendPluginLog(settings, {
    level: "info",
    code: "AGENT_STARTING",
    message: reason,
    serverPath: settings.serverPath,
  });

  let child;
  try {
    child = spawn(process.execPath, [settings.serverPath], {
      cwd: settings.agentDir,
      detached: true,
      env: mergeEnvironment(process.env, settings.env, {
        REMOTE_DEBUG_AGENT_PORT: String(settings.port),
      }),
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    const wrapped = new Error(`Remote Debug Agent process could not be spawned: ${error.message}`);
    wrapped.code = "AGENT_SPAWN_FAILED";
    wrapped.payload = {
      serverPath: settings.serverPath,
      agentDir: settings.agentDir,
      spawnError: {
        code: error.code,
        message: error.message,
      },
    };
    await appendPluginLog(settings, {
      level: "error",
      code: wrapped.code,
      message: wrapped.message,
      details: wrapped.payload,
    });
    throw wrapped;
  }

  let agentReady = false;
  let spawnError = null;
  let childExit = null;

  child.once("error", (error) => {
    spawnError = {
      code: error.code,
      message: error.message,
    };
    appendPluginLog(settings, {
      level: "error",
      code: "AGENT_SPAWN_ERROR",
      message: `Remote Debug Agent process emitted an error: ${error.message}`,
      details: {
        serverPath: settings.serverPath,
        agentDir: settings.agentDir,
        error: spawnError,
      },
    }).catch((logError) => {
      console.error("failed to write MCP spawn error log", logError);
    });
  });

  child.once("exit", (code, signal) => {
    childExit = {
      pid: child.pid,
      code,
      signal,
    };
    appendPluginLog(settings, {
      level: agentReady ? "warn" : "error",
      code: "AGENT_PROCESS_EXITED",
      message: agentReady
        ? "Remote Debug Agent process exited after readiness."
        : "Remote Debug Agent process exited before readiness.",
      details: childExit,
    }).catch((logError) => {
      console.error("failed to write MCP process exit log", logError);
    });
  });

  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastProbe;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (spawnError || childExit) {
      break;
    }

    lastProbe = await probeAgent(settings);
    if (lastProbe.kind === "agent" && agentStatusIsHealthy(lastProbe.status, settings)) {
      agentReady = true;
      await appendPluginLog(settings, {
        level: "info",
        code: "AGENT_READY",
        message: "Remote Debug Agent is ready.",
        pid: lastProbe.status?.agent?.pid,
      });
      return;
    }
    if (lastProbe.kind === "occupied") {
      break;
    }
  }

  const state = await readState(settings);
  const error = new Error(`Remote Debug Agent did not become ready at ${settings.agentUrl}`);
  error.code = "AGENT_START_FAILED";
  error.payload = {
    agentUrl: settings.agentUrl,
    port: settings.port,
    lastProbe,
    spawnError,
    childExit,
    lastError: state?.lastError,
  };
  await appendPluginLog(settings, {
    level: "error",
    code: error.code,
    message: error.message,
    details: error.payload,
  });
  throw error;
}

async function resolveFallbackAgentSettings(settings, initialProbe) {
  const attempted = [];
  const endPort = Math.min(65535, settings.port + FALLBACK_PORT_ATTEMPTS);

  await appendPluginLog(settings, {
    level: "warn",
    code: "AGENT_PORT_OCCUPIED",
    message: "Configured Remote Debug Agent port is occupied; looking for a fallback port.",
    details: {
      port: settings.port,
      agentUrl: settings.agentUrl,
      status: initialProbe.status,
      error: initialProbe.error?.message,
      fallbackStartPort: settings.port + 1,
      fallbackEndPort: endPort,
    },
  });

  for (let port = settings.port + 1; port <= endPort; port += 1) {
    const candidate = agentSettingsWithPort(settings, port);
    const probe = await probeAgent(candidate);

    if (probe.kind === "unreachable") {
      await appendPluginLog(candidate, {
        level: "info",
        code: "AGENT_FALLBACK_PORT_SELECTED",
        message: "Selected fallback Remote Debug Agent port.",
        preferredPort: settings.port,
        port,
      });
      return { settings: candidate, action: "start" };
    }

    if (probe.kind === "agent" && agentStatusIsHealthy(probe.status, candidate)) {
      await appendPluginLog(candidate, {
        level: "info",
        code: "AGENT_FALLBACK_REUSED",
        message: "Reusing healthy Remote Debug Agent on fallback port.",
        preferredPort: settings.port,
        port,
        pid: probe.status?.agent?.pid,
      });
      return { settings: candidate, action: "reuse" };
    }

    attempted.push({
      port,
      kind: probe.kind,
      statusName: probe.status?.name,
      error: probe.error?.message,
    });
  }

  const error = new Error(
    `Port ${settings.port} is occupied and no fallback Remote Debug Agent port is available.`,
  );
  error.code = "AGENT_PORT_OCCUPIED";
  error.payload = {
    agentUrl: settings.agentUrl,
    port: settings.port,
    status: initialProbe.status,
    error: initialProbe.error?.message,
    fallbackStartPort: settings.port + 1,
    fallbackEndPort: endPort,
    attempted,
  };
  await appendPluginLog(settings, {
    level: "error",
    code: error.code,
    message: error.message,
    details: error.payload,
  });
  throw error;
}

async function performEnsureAgentReady() {
  const settings = agentSettings();
  if (settings.explicitUrl) {
    if (
      !activeAgentSettings ||
      activeAgentSettings.agentUrl !== settings.agentUrl ||
      activeAgentSettings.sourceFingerprint !== settings.sourceFingerprint
    ) {
      await appendPluginLog(settings, {
        level: "info",
        code: "AGENT_EXTERNAL_URL",
        message: "External Remote Debug Agent URL configured; skipping local restart management.",
      });
    }
    activeAgentSettings = settings;
    return settings;
  }

  if (activeAgentSettings) {
    const activeProbe = await probeAgent(activeAgentSettings);
    const sameSource = agentSourceMatches(activeAgentSettings, settings);

    if (
      activeProbe.kind === "agent" &&
      sameSource &&
      agentStatusIsHealthy(activeProbe.status, activeAgentSettings)
    ) {
      return activeAgentSettings;
    }

    if (activeProbe.kind === "agent") {
      const previousSettings = activeAgentSettings;
      if (!sameSource) {
        await logAgentConfigChanged(settings, activeProbe.status, previousSettings);
        await stopStaleAgent(previousSettings, activeProbe.status, settings);
        activeAgentSettings = null;
      } else {
        await appendPluginLog(previousSettings, {
          level: "warn",
          code: "AGENT_UNHEALTHY",
          message: "Fallback Remote Debug Agent responded but does not match the configured target.",
          status: activeProbe.status,
          expected: expectedSummary(previousSettings),
        });
        await stopConfirmedAgent(previousSettings, activeProbe.status);
        await startAgent(previousSettings, "Restarting unhealthy fallback Remote Debug Agent.");
        return previousSettings;
      }
    } else {
      activeAgentSettings = null;
    }
  }

  const probe = await probeAgent(settings);
  if (probe.kind === "agent" && agentStatusIsHealthy(probe.status, settings)) {
    activeAgentSettings = settings;
    return settings;
  }

  if (probe.kind === "agent") {
    if (probe.status?.agent?.configFingerprint !== settings.configFingerprint) {
      await logAgentConfigChanged(settings, probe.status, null);
      await stopStaleAgent(settings, probe.status, settings);
    } else {
      await appendPluginLog(settings, {
        level: "warn",
        code: "AGENT_UNHEALTHY",
        message: "Remote Debug Agent responded but does not match the configured target.",
        status: probe.status,
        expected: expectedSummary(settings),
      });
      await stopConfirmedAgent(settings, probe.status);
    }
    await startAgent(settings, "Restarting unhealthy Remote Debug Agent.");
    activeAgentSettings = settings;
    return settings;
  }

  if (probe.kind === "unreachable") {
    await startAgent(settings, "Starting missing Remote Debug Agent.");
    activeAgentSettings = settings;
    return settings;
  }

  const fallback = await resolveFallbackAgentSettings(settings, probe);
  if (fallback.action === "start") {
    await startAgent(fallback.settings, "Starting Remote Debug Agent on fallback port.");
  }
  activeAgentSettings = fallback.settings;
  return fallback.settings;
}

let ensureAgentReadyPromise = null;

function ensureAgentReady() {
  if (!ensureAgentReadyPromise) {
    ensureAgentReadyPromise = performEnsureAgentReady().finally(() => {
      ensureAgentReadyPromise = null;
    });
  }

  return ensureAgentReadyPromise;
}

function scheduleAgentPrewarm(trigger) {
  let settings;
  try {
    settings = agentSettings();
  } catch (error) {
    console.error(`failed to resolve Remote Debug Agent settings during ${trigger}: ${error.message}`);
    const fallbackSettings = fallbackLogSettings(error);
    appendPluginLog(fallbackSettings, {
      level: "error",
      code: error.code || "AGENT_PREWARM_SETTINGS_FAILED",
      message: `Remote Debug Agent prewarm could not resolve settings during ${trigger}: ${error.message}`,
      details: fallbackSettings.settingsError,
    }).catch((logError) => {
      console.error("failed to write MCP prewarm settings failure log", logError);
    });
    return;
  }

  if (settings.explicitUrl || ensureAgentReadyPromise) {
    return;
  }

  ensureAgentReady().catch((error) => {
    appendPluginLog(settings, {
      level: "error",
      code: error.code || "AGENT_PREWARM_FAILED",
      message: `Remote Debug Agent prewarm failed during ${trigger}: ${error.message}`,
      details: error.payload,
    }).catch((logError) => {
      console.error("failed to write MCP prewarm failure log", logError);
    });
  });
}

async function callAgent(pathName, payload) {
  const settings = await ensureAgentReady();
  let response;
  let parsed;

  try {
    const result = await fetchJson(new URL(pathName, settings.agentUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Remote-Debug-Source": "codex-plugin",
      },
      body: JSON.stringify(payload),
      timeoutMs: payload?.timeoutMs || 30_000,
    });
    response = result.response;
    parsed = result.parsed;
  } catch (error) {
    const wrapped = new Error(`Remote Debug Agent is unavailable at ${settings.agentUrl}: ${error.message}`);
    wrapped.code = "AGENT_UNAVAILABLE";
    wrapped.payload = { agentUrl: settings.agentUrl, port: settings.port };
    throw wrapped;
  }

  if (!response.ok || parsed.ok === false) {
    const message = parsed.error?.message || `agent request failed with HTTP ${response.status}`;
    const code = parsed.error?.code || "AGENT_REQUEST_FAILED";
    const error = new Error(message);
    error.code = code;
    error.payload = {
      agentUrl: settings.agentUrl,
      port: settings.port,
      ...parsed,
    };
    throw error;
  }

  return parsed;
}

async function callTool(name, args) {
  if (name === "remote_debug_run_command") {
    return callAgent("/run", {
      cmd: args?.cmd,
      timeoutMs: args?.timeoutMs,
    });
  }

  if (name === "remote_debug_read_file") {
    return callAgent("/read-file", {
      path: args?.path,
      maxBytes: args?.maxBytes,
    });
  }

  if (name === "remote_debug_list_dir") {
    return callAgent("/list-dir", {
      path: args?.path,
    });
  }

  const error = new Error(`unknown tool: ${name}`);
  error.code = "UNKNOWN_TOOL";
  throw error;
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    const protocolVersion = protocolVersionFor(params);
    await logMcpLifecycle("MCP_INITIALIZE", "MCP initialize received.", {
      requestId: id,
      method,
      protocolVersion,
      clientName: params?.clientInfo?.name,
      clientVersion: params?.clientInfo?.version,
    });
    sendResult(id, {
      protocolVersion,
      capabilities: {
        resources: {},
        tools: {},
      },
      serverInfo: {
        name: "remote-debug-agent",
        version: PLUGIN_VERSION,
      },
    });
    scheduleAgentPrewarm("initialize");
    return;
  }

  if (method === "tools/list") {
    await logMcpLifecycle("MCP_TOOLS_LIST", "MCP tools/list received.", {
      requestId: id,
      method,
      toolNames: tools.map((tool) => tool.name),
      toolCount: tools.length,
    });
    sendResult(id, { tools });
    scheduleAgentPrewarm("tools/list");
    return;
  }

  if (method === "resources/list") {
    await logMcpLifecycle("MCP_RESOURCES_LIST", "MCP resources/list received.", {
      requestId: id,
      method,
    });
    sendResult(id, { resources: [] });
    return;
  }

  if (method === "tools/call") {
    const startedAt = Date.now();
    const toolName = params?.name;
    const toolArguments = params?.arguments || {};
    await logMcpLifecycle("MCP_TOOLS_CALL_STARTED", "MCP tools/call started.", {
      requestId: id,
      method,
      toolName,
      arguments: toolArgumentSummary(toolName, toolArguments),
    });

    try {
      const result = await callTool(toolName, toolArguments);
      await logMcpLifecycle("MCP_TOOLS_CALL_COMPLETED", "MCP tools/call completed.", {
        requestId: id,
        method,
        toolName,
        durationMs: Date.now() - startedAt,
        ok: true,
      });
      sendResult(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      });
    } catch (error) {
      await logMcpLifecycle("MCP_TOOLS_CALL_FAILED", "MCP tools/call failed.", {
        requestId: id,
        method,
        toolName,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: {
          code: error.code || "TOOL_CALL_FAILED",
          message: error.message,
        },
      });
      sendResult(id, {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                error: {
                  code: error.code || "TOOL_CALL_FAILED",
                  message: error.message,
                },
                details: error.payload,
              },
              null,
              2,
            ),
          },
        ],
      });
    }
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `method not found: ${method}`);
  }
}

let inputBuffer = Buffer.alloc(0);

function parseMessages() {
  while (true) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }

    const header = inputBuffer.subarray(0, headerEnd).toString("utf8");
    const contentLengthMatch = /^Content-Length:\s*(\d+)$/im.exec(header);
    if (!contentLengthMatch) {
      throw new Error("missing Content-Length header");
    }

    const contentLength = Number.parseInt(contentLengthMatch[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (inputBuffer.length < bodyEnd) {
      return;
    }

    const body = inputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
    inputBuffer = inputBuffer.subarray(bodyEnd);
    const message = JSON.parse(body);

    if (message.method && message.id === undefined) {
      continue;
    }

    handleRequest(message).catch((error) => {
      if (message.id !== undefined) {
        sendError(message.id, -32603, error.message);
      }
    });
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  parseMessages();
});

process.stdin.on("error", (error) => {
  console.error(error);
});
