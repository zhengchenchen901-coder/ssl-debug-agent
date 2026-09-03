import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import posixPath from "node:path/posix";
import {
  DEFAULT_APPROVED_EXECUTION_TIMEOUT_MS,
  DEFAULT_APPROVED_COMMAND_TTL_MS,
  MAX_APPROVED_COMMAND_LENGTH,
  MAX_APPROVED_EXECUTION_TIMEOUT_MS,
  MAX_APPROVED_COMMANDS,
} from "./approved-commands.js";
import {
  publicCommandReviewConfig,
  resolveCommandReviewConfig,
} from "./command-review.js";

export const DEFAULT_ALLOWED_PATHS = ["/var/log", "/etc/nginx", "/home/app", "/root/.pm2", "/home/github"];

const SOURCE_ROOT_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_SOURCE_ROOTS = 20;
const MAX_SOURCE_ROOT_LENGTH = 4096;

const DEFAULT_AGENT_PORT = 4343;
const DEFAULT_SSH_PORT = 22;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_FILE_TIMEOUT_MS = 60_000;
const MAX_FILE_TIMEOUT_MS = 300_000;
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

function sourceRootsError(message, cause) {
  const error = new Error(message);
  error.code = "INVALID_SOURCE_ROOTS";
  error.statusCode = 400;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

export function normalizeSourceRoots(value) {
  if (value === undefined || value === null || value === "") {
    return {};
  }

  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw sourceRootsError(`REMOTE_DEBUG_SOURCE_ROOTS is not valid JSON: ${error.message}`, error);
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw sourceRootsError("sourceRoots must be a JSON object");
  }

  const entries = Object.entries(parsed);
  if (entries.length > MAX_SOURCE_ROOTS) {
    throw sourceRootsError(`sourceRoots cannot contain more than ${MAX_SOURCE_ROOTS} entries`);
  }

  const normalized = {};
  for (const [project, rawPath] of entries) {
    if (!SOURCE_ROOT_KEY_PATTERN.test(project)) {
      throw sourceRootsError(`sourceRoots project key is invalid: ${project}`);
    }
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      throw sourceRootsError(`sourceRoots.${project} must be a non-empty absolute path`);
    }

    const trimmed = rawPath.trim();
    if (!trimmed.startsWith("/")) {
      throw sourceRootsError(`sourceRoots.${project} must be an absolute remote path`);
    }
    if (trimmed.length > MAX_SOURCE_ROOT_LENGTH) {
      throw sourceRootsError(`sourceRoots.${project} is too long`);
    }

    const normalizedPath = posixPath.normalize(trimmed);
    if (normalizedPath === "/") {
      throw sourceRootsError(`sourceRoots.${project} cannot grant access to the remote root`);
    }

    normalized[project] = normalizedPath.endsWith("/")
      ? normalizedPath.slice(0, -1)
      : normalizedPath;
  }

  return normalized;
}

export function allowedPathsForSourceRoots(sourceRoots = {}) {
  return [...new Set([...DEFAULT_ALLOWED_PATHS, ...Object.values(sourceRoots)])];
}

function parseMongoConfig(value) {
  if (value === undefined || value === "") {
    return undefined;
  }

  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    const wrapped = new Error(`REMOTE_DEBUG_MONGODB_CONFIG is not valid JSON: ${error.message}`);
    wrapped.code = "INVALID_MONGODB_CONFIG";
    throw wrapped;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error = new Error("REMOTE_DEBUG_MONGODB_CONFIG must be a JSON object");
    error.code = "INVALID_MONGODB_CONFIG";
    throw error;
  }

  return {
    enabled: parsed.enabled !== false,
    configPath: parsed.configPath || "",
    driverPath: parsed.driverPath || "",
    configProfile: parsed.configProfile || "",
    uriKey: parsed.uriKey || "url",
    database: parsed.database || "",
  };
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
  const approvedExecutionMaxTimeoutMs = parsePositiveInt(
    mergedEnv.REMOTE_DEBUG_APPROVED_EXECUTION_MAX_TIMEOUT_MS,
    MAX_APPROVED_EXECUTION_TIMEOUT_MS,
    "REMOTE_DEBUG_APPROVED_EXECUTION_MAX_TIMEOUT_MS",
  );
  const approvedExecutionTimeoutMs = Math.min(
    parsePositiveInt(
      mergedEnv.REMOTE_DEBUG_APPROVED_EXECUTION_TIMEOUT_MS,
      DEFAULT_APPROVED_EXECUTION_TIMEOUT_MS,
      "REMOTE_DEBUG_APPROVED_EXECUTION_TIMEOUT_MS",
    ),
    approvedExecutionMaxTimeoutMs,
  );
  const lifetimeValue =
    env.REMOTE_DEBUG_AGENT_LIFETIME === undefined || env.REMOTE_DEBUG_AGENT_LIFETIME === ""
      ? mergedEnv.REMOTE_DEBUG_AGENT_LIFETIME
      : env.REMOTE_DEBUG_AGENT_LIFETIME;
  const sourceRoots = normalizeSourceRoots(mergedEnv.REMOTE_DEBUG_SOURCE_ROOTS);

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
    mongodb: parseMongoConfig(mergedEnv.REMOTE_DEBUG_MONGODB_CONFIG),
    security: {
      allowedPaths: allowedPathsForSourceRoots(sourceRoots),
      sourceRoots,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      maxTimeoutMs: MAX_TIMEOUT_MS,
      defaultFileTimeoutMs: DEFAULT_FILE_TIMEOUT_MS,
      maxFileTimeoutMs: MAX_FILE_TIMEOUT_MS,
      defaultReadMaxBytes: DEFAULT_READ_MAX_BYTES,
      maxCommandOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    },
    approvedCommands: {
      enabled: parseBooleanFlag(mergedEnv.REMOTE_DEBUG_APPROVED_COMMANDS),
      ttlMs: DEFAULT_APPROVED_COMMAND_TTL_MS,
      executionTimeoutMs: approvedExecutionTimeoutMs,
      maxExecutionTimeoutMs: approvedExecutionMaxTimeoutMs,
      maxCommandLength: MAX_APPROVED_COMMAND_LENGTH,
      maxCommands: MAX_APPROVED_COMMANDS,
    },
    commandReview: resolveCommandReviewConfig({
      cwd,
      env: mergedEnv,
    }),
    audit: {
      logPath:
        mergedEnv.REMOTE_DEBUG_AUDIT_LOG ||
        path.resolve(cwd, "audit", "remote-debug-agent.jsonl"),
    },
    runtime: {
      statePath:
        mergedEnv.REMOTE_DEBUG_RUNTIME_STATE_PATH ||
        path.resolve(cwd, ".runtime", "agent-state.json"),
      runtimeId: mergedEnv.REMOTE_DEBUG_RUNTIME_ID || "development",
    },
    lifecycle: {
      lifetime: parseAgentLifetime(lifetimeValue),
    },
    sshNetwork: {
      keepaliveIntervalMs: parsePositiveInt(
        mergedEnv.REMOTE_DEBUG_SSH_KEEPALIVE_INTERVAL_MS,
        15_000,
        "REMOTE_DEBUG_SSH_KEEPALIVE_INTERVAL_MS",
      ),
      keepaliveCountMax: parsePositiveInt(
        mergedEnv.REMOTE_DEBUG_SSH_KEEPALIVE_COUNT_MAX,
        3,
        "REMOTE_DEBUG_SSH_KEEPALIVE_COUNT_MAX",
      ),
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 30_000,
      reconnectJitter: 0.2,
      maxBusinessChannels: parsePositiveInt(
        mergedEnv.REMOTE_DEBUG_SSH_MAX_BUSINESS_CHANNELS,
        4,
        "REMOTE_DEBUG_SSH_MAX_BUSINESS_CHANNELS",
      ),
      maxControlChannels: 1,
      maxBackgroundChannels: 1,
      maxQueueLength: 100,
      backgroundStarvationMs: 10_000,
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
    sourceRoots: { ...(config.security.sourceRoots || {}) },
    defaultTimeoutMs: config.security.defaultTimeoutMs,
    maxTimeoutMs: config.security.maxTimeoutMs,
    defaultFileTimeoutMs: config.security.defaultFileTimeoutMs,
    maxFileTimeoutMs: config.security.maxFileTimeoutMs,
    defaultReadMaxBytes: config.security.defaultReadMaxBytes,
    maxCommandOutputBytes: config.security.maxCommandOutputBytes,
    approvedCommands: {
      enabled: Boolean(config.approvedCommands?.enabled),
      ttlMs: config.approvedCommands?.ttlMs,
      executionTimeoutMs: config.approvedCommands?.executionTimeoutMs,
      maxExecutionTimeoutMs: config.approvedCommands?.maxExecutionTimeoutMs,
      maxCommandLength: config.approvedCommands?.maxCommandLength,
      maxCommands: config.approvedCommands?.maxCommands,
    },
    commandReview: publicCommandReviewConfig(config.commandReview),
  };
}

function commandReviewFingerprint(config = {}) {
  return {
    configPath: config.configPath,
    autoExecuteEnabled: Boolean(config.autoExecuteEnabled),
    refresh: Boolean(config.refresh),
    reviewTimeoutMs: config.reviewTimeoutMs,
    maxRetries: config.maxRetries,
  };
}

function fingerprintConfig(config) {
  const security = publicSecurity(config);
  security.commandReview = commandReviewFingerprint(config.commandReview);
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
    security,
    mongodb: config.mongodb
      ? {
          enabled: Boolean(config.mongodb.enabled),
          configPath: config.mongodb.configPath,
          driverPath: config.mongodb.driverPath,
          configProfile: config.mongodb.configProfile,
          uriKey: config.mongodb.uriKey,
          database: config.mongodb.database,
        }
      : null,
    commandReview: publicCommandReviewConfig(config.commandReview),
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
