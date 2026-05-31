import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  DEFAULT_APPROVED_COMMAND_TIMEOUT_MS,
  DEFAULT_APPROVED_COMMAND_TTL_MS,
  MAX_APPROVED_COMMAND_LENGTH,
  MAX_APPROVED_COMMAND_TIMEOUT_MS,
  MAX_APPROVED_COMMANDS,
} from "./approved-commands.js";

export const DEFAULT_ALLOWED_PATHS = ["/var/log", "/etc/nginx", "/home/app", "/root/.pm2", "/home/github"];

const DEFAULT_AGENT_PORT = 4343;
const DEFAULT_SSH_PORT = 22;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_READ_MAX_BYTES = 256 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_AGENT_LIFETIME = "manual";

function parseEnvFile(contents) {
  const parsed = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

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

function candidateEnvPaths(cwd) {
  const paths = [
    path.resolve(cwd, "..", ".env"),
    path.resolve(cwd, ".env"),
  ];

  return [...new Set(paths)];
}

export function loadDotEnv(cwd = process.cwd()) {
  const loaded = {};

  for (const envPath of candidateEnvPaths(cwd)) {
    if (!fs.existsSync(envPath)) {
      continue;
    }

    Object.assign(loaded, parseEnvFile(fs.readFileSync(envPath, "utf8")));
  }

  return loaded;
}

function parsePositiveInt(value, fallback, name) {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseBooleanFlag(value) {
  if (value === undefined || value === "") {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseAgentLifetime(value) {
  if (value === undefined || value === "") {
    return DEFAULT_AGENT_LIFETIME;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "manual" || normalized === "desktop") {
    return normalized;
  }

  throw new Error("REMOTE_DEBUG_AGENT_LIFETIME must be manual or desktop");
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const dotEnv = loadDotEnv(cwd);
  const mergedEnv = parseBooleanFlag(env.REMOTE_DEBUG_WORKER)
    ? {
        ...dotEnv,
        ...env,
      }
    : {
        ...env,
        ...dotEnv,
      };
  const agentPort = parsePositiveInt(
    mergedEnv.REMOTE_DEBUG_AGENT_PORT,
    DEFAULT_AGENT_PORT,
    "REMOTE_DEBUG_AGENT_PORT",
  );
  const sshPort = parsePositiveInt(
    mergedEnv.REMOTE_DEBUG_PORT,
    DEFAULT_SSH_PORT,
    "REMOTE_DEBUG_PORT",
  );
  const approvedCommandMaxTimeoutMs = parsePositiveInt(
    mergedEnv.REMOTE_DEBUG_APPROVED_COMMAND_MAX_TIMEOUT_MS,
    MAX_APPROVED_COMMAND_TIMEOUT_MS,
    "REMOTE_DEBUG_APPROVED_COMMAND_MAX_TIMEOUT_MS",
  );
  const approvedCommandDefaultTimeoutMs = Math.min(
    parsePositiveInt(
      mergedEnv.REMOTE_DEBUG_APPROVED_COMMAND_TIMEOUT_MS,
      DEFAULT_APPROVED_COMMAND_TIMEOUT_MS,
      "REMOTE_DEBUG_APPROVED_COMMAND_TIMEOUT_MS",
    ),
    approvedCommandMaxTimeoutMs,
  );
  const lifetimeValue =
    env.REMOTE_DEBUG_AGENT_LIFETIME === undefined || env.REMOTE_DEBUG_AGENT_LIFETIME === ""
      ? mergedEnv.REMOTE_DEBUG_AGENT_LIFETIME
      : env.REMOTE_DEBUG_AGENT_LIFETIME;

  return {
    agent: {
      host: "127.0.0.1",
      port: agentPort,
    },
    ssh: {
      host: mergedEnv.REMOTE_DEBUG_HOST || "",
      port: sshPort,
      username: mergedEnv.REMOTE_DEBUG_USER || "",
      privateKeyPath: mergedEnv.REMOTE_DEBUG_PRIVATE_KEY_PATH || "",
      passphrase: mergedEnv.REMOTE_DEBUG_PRIVATE_KEY_PASSPHRASE || undefined,
      readyTimeout: 10_000,
    },
    security: {
      allowedPaths: DEFAULT_ALLOWED_PATHS,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      maxTimeoutMs: MAX_TIMEOUT_MS,
      defaultReadMaxBytes: DEFAULT_READ_MAX_BYTES,
      maxCommandOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    },
    approvedCommands: {
      enabled: parseBooleanFlag(mergedEnv.REMOTE_DEBUG_APPROVED_COMMANDS),
      ttlMs: DEFAULT_APPROVED_COMMAND_TTL_MS,
      defaultTimeoutMs: approvedCommandDefaultTimeoutMs,
      maxTimeoutMs: approvedCommandMaxTimeoutMs,
      maxCommandLength: MAX_APPROVED_COMMAND_LENGTH,
      maxCommands: MAX_APPROVED_COMMANDS,
    },
    audit: {
      logPath:
        mergedEnv.REMOTE_DEBUG_AUDIT_LOG ||
        path.resolve(cwd, "audit", "remote-debug-agent.jsonl"),
    },
    runtime: {
      statePath:
        mergedEnv.REMOTE_DEBUG_RUNTIME_STATE_PATH ||
        path.resolve(cwd, ".runtime", "agent-state.json"),
    },
    lifecycle: {
      lifetime: parseAgentLifetime(lifetimeValue),
    },
  };
}

export function publicTarget(config) {
  return {
    host: config.ssh.host || "",
    port: config.ssh.port,
    username: config.ssh.username || "",
  };
}

export function publicSecurity(config) {
  return {
    allowedPaths: config.security.allowedPaths,
    defaultTimeoutMs: config.security.defaultTimeoutMs,
    maxTimeoutMs: config.security.maxTimeoutMs,
    defaultReadMaxBytes: config.security.defaultReadMaxBytes,
    maxCommandOutputBytes: config.security.maxCommandOutputBytes,
    approvedCommands: {
      enabled: Boolean(config.approvedCommands?.enabled),
      ttlMs: config.approvedCommands?.ttlMs,
      defaultTimeoutMs: config.approvedCommands?.defaultTimeoutMs,
      maxTimeoutMs: config.approvedCommands?.maxTimeoutMs,
      maxCommandLength: config.approvedCommands?.maxCommandLength,
      maxCommands: config.approvedCommands?.maxCommands,
    },
  };
}

function fingerprintConfig(config) {
  return {
    agent: {
      host: config.agent.host,
      port: config.agent.port,
    },
    ssh: {
      host: config.ssh.host || "",
      port: config.ssh.port,
      username: config.ssh.username || "",
      privateKeyPath: config.ssh.privateKeyPath || "",
      passphrase: config.ssh.passphrase || "",
      readyTimeout: config.ssh.readyTimeout,
    },
    security: publicSecurity(config),
    audit: {
      logPath: config.audit.logPath,
    },
  };
}

export function configFingerprint(config) {
  return createHash("sha256").update(JSON.stringify(fingerprintConfig(config))).digest("hex");
}

export function assertSshConfig(config) {
  const missing = [];
  if (!config.ssh.host) missing.push("REMOTE_DEBUG_HOST");
  if (!config.ssh.username) missing.push("REMOTE_DEBUG_USER");
  if (!config.ssh.privateKeyPath) missing.push("REMOTE_DEBUG_PRIVATE_KEY_PATH");

  if (missing.length > 0) {
    const error = new Error(`Missing SSH configuration: ${missing.join(", ")}`);
    error.statusCode = 503;
    error.code = "SSH_CONFIG_MISSING";
    throw error;
  }
}
