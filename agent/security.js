import posixPath from "node:path/posix";

export const ALLOWED_COMMANDS = new Set([
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
  "pm2",
]);

export const DENIED_COMMANDS = new Set([
  "rm",
  "shutdown",
  "reboot",
  "mkfs",
  "sudo",
  "chmod",
  "chown",
]);

const SHELL_CONTROL_PATTERN = /[;&|`$<>(){}[\]\\\n\r\0]/;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const VERSION_ONLY_COMMANDS = new Set(["mongodump", "mongo", "mongosh"]);
const ALLOWED_SYSTEMCTL_ACTIONS = new Set(["status", "is-active", "is-enabled"]);
const ALLOWED_SYSTEMCTL_UNITS = new Set(["mongod", "mongod.service", "nginx", "nginx.service"]);
const ALLOWED_SYSTEMCTL_OPTIONS = new Set(["--no-pager", "--plain", "--full"]);
const SYSTEMCTL_LINES_PATTERN = /^--lines=\d+$/;
const ALLOWED_NGINX_ARGS = new Set(["-t", "-T", "-v", "-V"]);
const PM2_ID_PATTERN = /^\d+$/;

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
  const commandsThatMayReadPaths = new Set(["ls", "cat", "tail", "grep"]);
  const absolutePaths = [];
  if (!commandsThatMayReadPaths.has(command)) {
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
