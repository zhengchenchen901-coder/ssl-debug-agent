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
