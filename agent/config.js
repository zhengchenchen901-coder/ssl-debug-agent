import fs from "node:fs";
import path from "node:path";

export const DEFAULT_ALLOWED_PATHS = ["/var/log", "/etc/nginx", "/home/app"];

const DEFAULT_AGENT_PORT = 3000;
const DEFAULT_SSH_PORT = 22;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_READ_MAX_BYTES = 256 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

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

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const mergedEnv = {
    ...env,
    ...loadDotEnv(cwd),
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
    audit: {
      logPath:
        mergedEnv.REMOTE_DEBUG_AUDIT_LOG ||
        path.resolve(cwd, "audit", "remote-debug-agent.jsonl"),
    },
    runtime: {
      statePath: path.resolve(cwd, ".runtime", "agent-state.json"),
    },
  };
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
