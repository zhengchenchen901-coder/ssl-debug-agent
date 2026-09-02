import posixPath from "node:path/posix";
import { createHash } from "node:crypto";
import {
  MONGODB_CONFIG_ROOTS,
  MONGODB_QUERY_OPERATIONS,
  MAX_MONGODB_LIMIT,
} from "./mongodb.js";

const SECURITY_POLICY = {
  schemaVersion: 1,
  allowedExecutables: [
    "ls",
    "cat",
    "ps",
    "netstat",
    "df",
    "free",
    "tail",
    "grep",
    "mongodump",
    "mongo",
    "mongosh",
    "systemctl",
    "nginx",
    "which",
    "pm2",
  ],
  deniedExecutables: ["rm", "shutdown", "reboot", "mkfs", "sudo", "chmod", "chown"],
  commandsRequiringAllowedAbsolutePath: ["ls", "cat", "tail", "grep"],
  versionOnlyExecutables: ["mongodump", "mongo", "mongosh"],
  systemctl: {
    actions: ["status", "is-active", "is-enabled"],
    units: ["mongod", "mongod.service", "nginx", "nginx.service"],
    options: ["--no-pager", "--plain", "--full"],
    additionalOptionPatterns: ["--lines=<positive integer>"],
  },
  nginxArguments: ["-t", "-T", "-v", "-V"],
  pm2: {
    actions: ["list", "describe <app-name-or-id>", "env <numeric-process-id>"],
  },
  mongodb: {
    readOnly: true,
    operations: [...MONGODB_QUERY_OPERATIONS],
    maxLimit: MAX_MONGODB_LIMIT,
    allowedConfigRoots: [...MONGODB_CONFIG_ROOTS],
  },
  lifecycle: {
    instanceRestart: {
      allowedFrom: ["stopped", "unhealthy"],
      runningBehavior: "no-op",
      transitionalBehavior: "reject",
    },
  },
  constraints: [
    "Commands are parsed as tokens and never executed through a shell.",
    "Shell control characters, redirects, substitutions, newlines, and unsafe tokens are rejected.",
    "Commands that read paths require at least one absolute path under an allowed root.",
    "tail follow mode (-f or --follow) is rejected; reads must be bounded by returned output limits.",
    "The dedicated MongoDB tool is read-only and bounded; database writes require an approved-command draft.",
  ],
  examples: [
    "netstat -tlnp",
    "ps aux",
    "df -h",
    "free -m",
    "ls /var/log",
    "cat /var/log/app.log",
    "tail -n 100 /var/log/nginx/error.log",
    "grep error /var/log/app.log",
    "systemctl --no-pager status nginx.service",
    "nginx -t",
    "which node",
    "pm2 list",
    "pm2 describe api-server",
    "pm2 env 1",
    "mongosh --version",
  ],
};

const SECURITY_POLICY_VERSION = createHash("sha256")
  .update(JSON.stringify(SECURITY_POLICY))
  .digest("hex");

export const ALLOWED_COMMANDS = new Set(SECURITY_POLICY.allowedExecutables);
export const DENIED_COMMANDS = new Set(SECURITY_POLICY.deniedExecutables);

const SHELL_CONTROL_PATTERN = /[;&|`$<>(){}[\]\\\n\r\0]/;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const VERSION_ONLY_COMMANDS = new Set(SECURITY_POLICY.versionOnlyExecutables);
const ALLOWED_SYSTEMCTL_ACTIONS = new Set(SECURITY_POLICY.systemctl.actions);
const ALLOWED_SYSTEMCTL_UNITS = new Set(SECURITY_POLICY.systemctl.units);
const ALLOWED_SYSTEMCTL_OPTIONS = new Set(SECURITY_POLICY.systemctl.options);
const SYSTEMCTL_LINES_PATTERN = /^--lines=\d+$/;
const ALLOWED_NGINX_ARGS = new Set(SECURITY_POLICY.nginxArguments);
const PM2_ID_PATTERN = /^\d+$/;

export function securityCapabilities(config = {}) {
  const security = config.security || config;
  const approvedCommands = config.approvedCommands || {};
  return {
    schemaVersion: SECURITY_POLICY.schemaVersion,
    policyVersion: SECURITY_POLICY_VERSION,
    authority: "remote-debug-agent",
    commands: {
      allowedExecutables: [...SECURITY_POLICY.allowedExecutables],
      deniedExecutables: [...SECURITY_POLICY.deniedExecutables],
      commandsRequiringAllowedAbsolutePath: [
        ...SECURITY_POLICY.commandsRequiringAllowedAbsolutePath,
      ],
      versionOnlyExecutables: [...SECURITY_POLICY.versionOnlyExecutables],
      systemctl: {
        actions: [...SECURITY_POLICY.systemctl.actions],
        units: [...SECURITY_POLICY.systemctl.units],
        options: [...SECURITY_POLICY.systemctl.options],
        additionalOptionPatterns: [...SECURITY_POLICY.systemctl.additionalOptionPatterns],
      },
      nginxArguments: [...SECURITY_POLICY.nginxArguments],
      pm2: { actions: [...SECURITY_POLICY.pm2.actions] },
      constraints: [...SECURITY_POLICY.constraints],
      examples: [...SECURITY_POLICY.examples],
    },
    paths: {
      allowedRoots: [...(security.allowedPaths || [])],
    },
    limits: {
      defaultCommandTimeoutMs: security.defaultTimeoutMs,
      maxCommandTimeoutMs: security.maxTimeoutMs,
      defaultFileTimeoutMs: security.defaultFileTimeoutMs,
      maxFileTimeoutMs: security.maxFileTimeoutMs,
      defaultReadMaxBytes: security.defaultReadMaxBytes,
      maxCommandOutputBytes: security.maxCommandOutputBytes,
    },
    approvedCommands: {
      enabled: Boolean(approvedCommands.enabled),
      ttlMs: approvedCommands.ttlMs,
      executionTimeoutMs: approvedCommands.executionTimeoutMs,
      maxExecutionTimeoutMs: approvedCommands.maxExecutionTimeoutMs,
      maxCommandLength: approvedCommands.maxCommandLength,
      maxCommands: approvedCommands.maxCommands,
    },
    mongodb: {
      enabled: true,
      configured: Boolean(config.mongodb?.enabled),
      ...SECURITY_POLICY.mongodb,
      operations: [...SECURITY_POLICY.mongodb.operations],
      allowedConfigRoots: [...SECURITY_POLICY.mongodb.allowedConfigRoots],
    },
    lifecycle: {
      instanceRestart: {
        allowedFrom: [...SECURITY_POLICY.lifecycle.instanceRestart.allowedFrom],
        runningBehavior: SECURITY_POLICY.lifecycle.instanceRestart.runningBehavior,
        transitionalBehavior: SECURITY_POLICY.lifecycle.instanceRestart.transitionalBehavior,
      },
    },
  };
}

export class SecurityError extends Error {
  constructor(message, code = "SECURITY_REJECTED") {
    super(message);
    this.name = "SecurityError";
    this.code = code;
    this.statusCode = 400;
  }
}

export function normalizeRemotePath(inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new SecurityError("path must be a non-empty string", "INVALID_PATH");
  }

  if (inputPath.includes("\0")) {
    throw new SecurityError("path contains a null byte", "INVALID_PATH");
  }

  if (!inputPath.startsWith("/")) {
    throw new SecurityError("path must be absolute", "INVALID_PATH");
  }

  const normalized = posixPath.normalize(inputPath);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

export function isPathAllowed(inputPath, allowedPaths) {
  const normalized = normalizeRemotePath(inputPath);

  return allowedPaths.some((allowedRoot) => {
    const root = normalizeRemotePath(allowedRoot);
    return normalized === root || normalized.startsWith(`${root}/`);
  });
}

export function assertPathAllowed(inputPath, allowedPaths) {
  const normalized = normalizeRemotePath(inputPath);
  if (!isPathAllowed(normalized, allowedPaths)) {
    throw new SecurityError(`path is outside allowed roots: ${normalized}`, "PATH_NOT_ALLOWED");
  }

  return normalized;
}

function tokenizeCommand(command) {
  if (typeof command !== "string" || command.trim() === "") {
    throw new SecurityError("cmd must be a non-empty string", "INVALID_COMMAND");
  }

  if (command.length > 4096) {
    throw new SecurityError("cmd is too long", "INVALID_COMMAND");
  }

  if (SHELL_CONTROL_PATTERN.test(command)) {
    throw new SecurityError("cmd contains shell control characters", "SHELL_CONTROL_REJECTED");
  }

  const tokens = command.trim().split(/\s+/);
  for (const token of tokens) {
    if (!SAFE_TOKEN_PATTERN.test(token)) {
      throw new SecurityError(`unsafe token rejected: ${token}`, "UNSAFE_TOKEN");
    }
  }

  return tokens;
}

function containsDeniedCommand(token) {
  return DENIED_COMMANDS.has(token) || [...DENIED_COMMANDS].some((cmd) => token.includes(`/${cmd}`));
}

function validatePathArguments(command, tokens, allowedPaths) {
  const absolutePaths = [];
  if (!SECURITY_POLICY.commandsRequiringAllowedAbsolutePath.includes(command)) {
    return absolutePaths;
  }

  for (const token of tokens.slice(1)) {
    if (!token.includes("/")) {
      continue;
    }

    if (!token.startsWith("/")) {
      throw new SecurityError(`relative or embedded path rejected: ${token}`, "PATH_NOT_ALLOWED");
    }

    absolutePaths.push(assertPathAllowed(token, allowedPaths));
  }

  if (absolutePaths.length === 0) {
    throw new SecurityError(
      `${command} requires at least one allowed absolute path`,
      "PATH_REQUIRED",
    );
  }

  return absolutePaths;
}

function validateTail(tokens) {
  if (tokens.includes("-f") || tokens.includes("--follow")) {
    throw new SecurityError("tail -f is not supported in v1", "STREAMING_NOT_SUPPORTED");
  }
}

function validateVersionOnlyCommand(executable, tokens) {
  if (tokens.length !== 2 || tokens[1] !== "--version") {
    throw new SecurityError(
      `${executable} only supports --version`,
      "UNSUPPORTED_COMMAND_ARGUMENTS",
    );
  }
}

function isAllowedSystemctlOption(token) {
  return ALLOWED_SYSTEMCTL_OPTIONS.has(token) || SYSTEMCTL_LINES_PATTERN.test(token);
}

function validateSystemctl(tokens) {
  const commandTokens = [];

  for (const token of tokens.slice(1)) {
    if (token.startsWith("-")) {
      if (!isAllowedSystemctlOption(token)) {
        throw new SecurityError(
          `unsupported systemctl option: ${token}`,
          "UNSUPPORTED_COMMAND_ARGUMENTS",
        );
      }
      continue;
    }

    commandTokens.push(token);
  }

  if (commandTokens.length !== 2) {
    throw new SecurityError(
      "systemctl requires one read-only action and one supported unit",
      "UNSUPPORTED_COMMAND_ARGUMENTS",
    );
  }

  const [action, unit] = commandTokens;
  if (!ALLOWED_SYSTEMCTL_ACTIONS.has(action)) {
    throw new SecurityError(
      `unsupported systemctl action: ${action}`,
      "UNSUPPORTED_COMMAND_ARGUMENTS",
    );
  }

  if (!ALLOWED_SYSTEMCTL_UNITS.has(unit)) {
    throw new SecurityError(
      `unsupported systemctl unit: ${unit}`,
      "UNSUPPORTED_COMMAND_ARGUMENTS",
    );
  }
}

function validateNginx(tokens) {
  const args = tokens.slice(1);
  if (args.length === 0) {
    throw new SecurityError(
      "nginx requires a supported diagnostic flag",
      "UNSUPPORTED_COMMAND_ARGUMENTS",
    );
  }

  for (const arg of args) {
    if (!ALLOWED_NGINX_ARGS.has(arg)) {
      throw new SecurityError(
        `unsupported nginx argument: ${arg}`,
        "UNSUPPORTED_COMMAND_ARGUMENTS",
      );
    }
  }
}

function validatePm2(tokens) {
  const [, action, subject, ...extra] = tokens;

  if (action === "list") {
    if (subject !== undefined || extra.length > 0) {
      throw new SecurityError(
        "pm2 list does not support additional arguments",
        "UNSUPPORTED_COMMAND_ARGUMENTS",
      );
    }
    return;
  }

  if (action === "describe") {
    if (subject === undefined || extra.length > 0) {
      throw new SecurityError(
        "pm2 describe requires exactly one app name or id",
        "UNSUPPORTED_COMMAND_ARGUMENTS",
      );
    }
    return;
  }

  if (action === "env") {
    if (subject === undefined || extra.length > 0 || !PM2_ID_PATTERN.test(subject)) {
      throw new SecurityError(
        "pm2 env requires exactly one numeric process id",
        "UNSUPPORTED_COMMAND_ARGUMENTS",
      );
    }
    return;
  }

  throw new SecurityError(
    `unsupported pm2 action: ${action || ""}`,
    "UNSUPPORTED_COMMAND_ARGUMENTS",
  );
}

export function validateCommand(command, options = {}) {
  const allowedPaths = options.allowedPaths || [];
  const tokens = tokenizeCommand(command);
  const executable = tokens[0];

  if (containsDeniedCommand(executable)) {
    throw new SecurityError(`dangerous command rejected: ${executable}`, "COMMAND_DENIED");
  }

  if (!ALLOWED_COMMANDS.has(executable)) {
    throw new SecurityError(`command is not whitelisted: ${executable}`, "COMMAND_NOT_ALLOWED");
  }

  for (const token of tokens) {
    if (containsDeniedCommand(token)) {
      throw new SecurityError(`dangerous token rejected: ${token}`, "COMMAND_DENIED");
    }
  }

  if (executable === "tail") {
    validateTail(tokens);
  }

  if (VERSION_ONLY_COMMANDS.has(executable)) {
    validateVersionOnlyCommand(executable, tokens);
  }

  if (executable === "systemctl") {
    validateSystemctl(tokens);
  }

  if (executable === "nginx") {
    validateNginx(tokens);
  }

  if (executable === "pm2") {
    validatePm2(tokens);
  }

  const absolutePaths = validatePathArguments(executable, tokens, allowedPaths);

  return {
    executable,
    tokens,
    normalizedCommand: tokens.join(" "),
    absolutePaths,
  };
}

export function normalizeTimeoutMs(value, securityConfig) {
  if (value === undefined || value === null) {
    return securityConfig.defaultTimeoutMs;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SecurityError("timeoutMs must be a positive integer", "INVALID_TIMEOUT");
  }

  return Math.min(parsed, securityConfig.maxTimeoutMs);
}

export function normalizeMaxBytes(value, securityConfig) {
  if (value === undefined || value === null) {
    return securityConfig.defaultReadMaxBytes;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SecurityError("maxBytes must be a positive integer", "INVALID_MAX_BYTES");
  }

  return Math.min(parsed, securityConfig.defaultReadMaxBytes);
}
