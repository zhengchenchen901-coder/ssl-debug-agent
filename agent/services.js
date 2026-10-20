import { serviceStartRuntime } from "./service-start-runtime.js";
import { selectServiceProfile, serviceError, SERVICE_START_CONFIRMATION } from "./service-profiles.js";

export const SERVICE_RESULT_MARKER = "__REMOTE_DEBUG_SERVICE__";
const RESULT_CODES = new Set([
  "SERVICE_START_TIMEOUT", "SERVICE_EVIDENCE_TOO_LARGE", "SERVICE_PM2_COMMAND_FAILED", "SERVICE_PM2_RESPONSE_INVALID",
  "SERVICE_RELEASE_PATH_INVALID", "SERVICE_CWD_SYMLINK_REQUIRES_RELEASE_ROOT", "SERVICE_CANONICAL_PATH_DENIED", "SERVICE_PM2_HOME_SYMLINK",
  "SERVICE_DUPLICATE_PROCESS", "SERVICE_MODE_MISMATCH", "SERVICE_PROCESS_PATH_CONFLICT", "SERVICE_NODE_ARGS_MISMATCH",
  "SERVICE_NODE_VERSION_MISMATCH", "SERVICE_ENV_MISMATCH", "SERVICE_PROCESS_NOT_RUNNING", "SERVICE_PROCESS_METADATA_INVALID",
  "SERVICE_ACTUAL_PROCESS_MISMATCH", "SERVICE_ACTUAL_ENV_MISMATCH", "SERVICE_UNEXPECTED_NODE_OPTIONS", "SERVICE_LOG_PATH_CONFLICT",
  "SERVICE_CWD_INVALID", "SERVICE_ENTRY_PATH_INVALID", "SERVICE_ENV_FILE_INVALID", "SERVICE_PM2_DAEMON_UNAVAILABLE", "SERVICE_START_BUSY",
  "SERVICE_EXISTING_PROCESS_UNHEALTHY", "SERVICE_PORT_OWNER_MISMATCH", "SERVICE_PORT_CONFLICT", "SERVICE_UNEXPECTED_REGISTRATION",
  "SERVICE_RELEASE_CHANGED", "SERVICE_CONCURRENT_PROCESS_CHANGE", "SERVICE_PROCESS_DISAPPEARED", "SERVICE_PROCESS_EXITED", "SERVICE_PROCESS_UNSTABLE",
  ...["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"].map(code => `SERVICE_FILESYSTEM_${code}`), "SERVICE_START_FAILED",
]);
function safeReceipt(payload, profile) {
  const invalid = () => { throw serviceError("SERVICE_START_OUTCOME_UNKNOWN", "Invalid service evidence; inspect this instance before retrying"); };
  const names = new Set(profile.processes.map(p => p.name));
  const nameList = value => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > names.size || value.some(name => !names.has(name)) || new Set(value).size !== value.length) invalid();
    return value;
  };
  if (!["healthy", "missing", "blocked", "partial", "unknown"].includes(payload.status)) invalid();
  const verified = (payload.verified || []).map(item => {
    const proc = profile.processes.find(p => p.name === item.name);
    if (!proc || !Number.isSafeInteger(item.pid) || item.pid < 1 || item.status !== "online" || !Number.isSafeInteger(item.restarts) || item.restarts < 0 ||
      JSON.stringify(proc.ports) !== JSON.stringify(item.ports) || item.startupMarkerSeen !== true || item.interpreterVerified !== true || item.environmentVerified !== true) invalid();
    return { name: item.name, pid: item.pid, status: "online", restarts: item.restarts, ports: proc.ports,
      startupMarkerSeen: true, interpreterVerified: true, environmentVerified: true };
  });
  if (new Set(verified.map(item => item.name)).size !== verified.length) invalid();
  if (payload.status === "healthy" && verified.length !== profile.processes.length) invalid();
  const result = { status: payload.status, phase: ["preflight", "paths", "runtime", "env-files", "pm2-daemon", "lock", "process-preflight", "start", "verify", "persist", "complete"].includes(payload.phase) ? payload.phase : "unknown",
    started: nameList(payload.started), attempted: nameList(payload.attempted), verified, nodeVersion: profile.nodeVersion, mode: "fork",
    persisted: payload.status === "healthy" && payload.persisted === true };
  if (payload.resolvedCwd) {
    const prefix = `${profile.releaseRoot}/releases/`;
    if (typeof payload.resolvedCwd !== "string" || (profile.releaseRoot
      ? !payload.resolvedCwd.startsWith(prefix) || !/^[A-Za-z0-9_.+-]+$/.test(payload.resolvedCwd.slice(prefix.length))
      : payload.resolvedCwd !== profile.cwd)) invalid();
    result.resolvedCwd = payload.resolvedCwd;
  }
  if (payload.missing) result.missing = nameList(payload.missing);
  if (payload.unchanged === true) result.unchanged = true;
  if (payload.persistenceWarning === "SERVICE_PM2_SAVE_SKIPPED_UNHEALTHY_NAMESPACE") result.persistenceWarning = payload.persistenceWarning;
  if (payload.error) result.error = { code: RESULT_CODES.has(payload.error.code) ? payload.error.code : "SERVICE_START_FAILED" };
  if (!["healthy", "missing"].includes(payload.status)) result.recovery = "Inspect this instance before retrying; destructive recovery requires separate authorization";
  return result;
}
export function validateServiceRequest(input, action) {
  const allowed = ["serviceId", "profileHash", "operationId", "deadlineAt", "timeoutMs", ...(action === "start" ? ["confirmation"] : [])];
  if (!["start", "inspect"].includes(action) || !input || Object.keys(input).some((key) => !allowed.includes(key))) throw serviceError("SERVICE_INPUT_INVALID", "Only a saved serviceId and current profileHash are accepted");
  if (action === "start" && input.confirmation !== SERVICE_START_CONFIRMATION) throw serviceError("SERVICE_START_AUTHORIZATION_REQUIRED", "An explicit user request to start this instance service is required");
}
export function buildServiceScript(action, profile, deadlineAt, allowedRoots) {
  const request = { action, deadlineAt, allowedRoots };
  return `(${serviceStartRuntime.toString()})(${JSON.stringify(request)}, ${JSON.stringify(profile)}).then(result => console.log(${JSON.stringify(SERVICE_RESULT_MARKER)} + JSON.stringify(result))).catch(() => { process.exitCode = 1; });`;
}

export async function runService(input, { action, config, operation, runSSH }) {
  validateServiceRequest(input, action);
  const profile = selectServiceProfile(config.serviceProfiles, input);
  if (profile.instanceId !== config.instanceId || profile.target.host !== config.ssh.host || profile.target.port !== config.ssh.port || profile.target.username !== config.ssh.username) throw serviceError("SERVICE_INSTANCE_MISMATCH");
  let remote;
  try {
    remote = await runSSH("node", { config, operation,
      stdin: buildServiceScript(action, profile, operation.deadlineAt - 1000, config.security.allowedPaths) });
  } catch {
    throw serviceError("SERVICE_START_OUTCOME_UNKNOWN", "Transport interrupted; inspect this instance before retrying. A start may have partially completed; no automatic cleanup or replay is performed");
  }
  if (remote.exitCode !== 0 || remote.timedOut || remote.stdoutTruncated || Buffer.byteLength(remote.stdout || "") > 65536) throw serviceError("SERVICE_START_OUTCOME_UNKNOWN", "Incomplete service receipt; inspect this instance before retrying");
  let payload;
  try {
    const lines = String(remote.stdout || "").split(/\r?\n/).filter((line) => line.startsWith(SERVICE_RESULT_MARKER));
    if (lines.length !== 1) throw new Error();
    payload = JSON.parse(lines[0].slice(SERVICE_RESULT_MARKER.length));
    payload = safeReceipt(payload, profile);
  } catch { throw serviceError("SERVICE_START_OUTCOME_UNKNOWN", "Invalid service receipt; inspect this instance before retrying"); }
  // All diagnostic fields are structured and helper-owned. Never return PM2
  // output, environment snapshots, env-file contents, command stdout or stderr.
  return { serviceId: input.serviceId, profileHash: input.profileHash, ...payload };
}
