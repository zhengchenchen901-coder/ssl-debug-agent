import { randomUUID, createHash } from "node:crypto";
import { normalizeMongoConfig, MONGODB_REMOTE_COMMAND, MONGODB_RESULT_MARKER } from "./mongodb.js";
import { normalizeMongoBulkConfig } from "./mongodb-bulk.js";
import { operationError } from "./operation.js";
import { sandboxAccessRuntime } from "./mongodb-sandbox-access-runtime.js";

function fail(code, message = code) {
  return operationError(message, { code, statusCode: 400, layer: "sandbox-access", phase: "validation", retriable: false });
}

function accessSettings(rawConfig, instanceId) {
  const base = normalizeMongoConfig(rawConfig);
  const policy = normalizeMongoBulkConfig(rawConfig, { requireBulkEnabled: false });
  const managementProfile = rawConfig.sandboxManagementProfile || "remote_debug_manager";
  const managementUriKey = rawConfig.sandboxManagementUriKey || "url";
  const password = rawConfig.sandboxManagementPassword;
  if (typeof password !== "string" || password.length < 16 || password.length > 256 || /[\r\n\0]/.test(password)) throw fail("SANDBOX_MANAGEMENT_PASSWORD_REQUIRED", "Configure this instance's sandbox management password (16–256 characters) before preparing setup");
  // Credential writes deliberately support a single new top-level profile/key.
  // No caller-supplied role, privilege, URI, user or JavaScript is accepted.
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(managementProfile) || managementProfile === base.configProfile || managementUriKey !== "url") {
    throw fail("SANDBOX_MANAGEMENT_PROFILE_INVALID");
  }
  const config = { ...base, instanceId, sandboxDatabase: policy.sandboxDatabase, managementProfile, managementUriKey,
    managementPassword: password,
    receiptsCollection: policy.bulkReceiptsCollection, journalRoot: "/tmp/remote-debug-agent/sandbox-access" };
  return config;
}

export function sandboxSettingsHash(rawConfig, instanceId) {
  return createHash("sha256").update(JSON.stringify(accessSettings(rawConfig, instanceId))).digest("hex");
}

export function buildSandboxAccessScript(request, rawConfig, instanceId) {
  return `(${sandboxAccessRuntime.toString()})(${JSON.stringify(request)}, ${JSON.stringify(accessSettings(rawConfig, instanceId))}, ${JSON.stringify(MONGODB_RESULT_MARKER)});`;
}

export async function runSandboxAccess(input = {}, options = {}) {
  const action = options.action;
  const rawConfig = options.config?.mongodb || options.config || {};
  const instanceId = options.instanceId || process.env.REMOTE_DEBUG_INSTANCE_ID || "standalone";
  if (options.expectedSettingsHash && options.expectedSettingsHash !== sandboxSettingsHash(rawConfig, instanceId)) throw fail("SANDBOX_SETUP_CONFIG_STALE", "Reload this instance's configuration before preparing or applying sandbox setup");
  const allowed = action === "prepare" ? ["purpose", "operationId", "timeoutMs", "deadlineAt"] : ["setupId", "planHash", "confirmation", "operationId", "timeoutMs", "deadlineAt"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw fail("SANDBOX_SETUP_INPUT_INVALID");
  if (!["prepare", "execute"].includes(action)) throw fail("SANDBOX_SETUP_ACTION_INVALID");
  if (action === "execute" && (!/^[a-f0-9-]{36}$/.test(input.setupId || "") || !/^[a-f0-9]{64}$/.test(input.planHash || "") || input.confirmation !== "确认配置沙盒")) {
    throw fail("SANDBOX_SETUP_CONFIRMATION_REQUIRED");
  }
  const request = action === "prepare" ? { action, setupId: randomUUID() } : { action, setupId: input.setupId, planHash: input.planHash, confirmation: input.confirmation };
  const script = buildSandboxAccessScript(request, rawConfig, instanceId);
  if (typeof options.runSSH !== "function") throw fail("MONGODB_RUNNER_UNAVAILABLE");
  let remote;
  try { remote = await options.runSSH(MONGODB_REMOTE_COMMAND, { config: options.config, operation: options.operation, stdin: script }); }
  catch (error) {
    throw operationError("Sandbox setup transport failed; inspect the plan before retrying", { code: error.code || "SANDBOX_SETUP_TRANSPORT_FAILED", statusCode: 502, layer: "sandbox-access", phase: action, retriable: false });
  }
  if (remote.stdoutTruncated || Buffer.byteLength(remote.stdout || "") > 65536) throw fail("SANDBOX_SETUP_RESPONSE_TOO_LARGE");
  const line = String(remote.stdout || "").split(/\r?\n/).filter((item) => item.startsWith(MONGODB_RESULT_MARKER)).pop();
  let payload;
  try { payload = JSON.parse(line.slice(MONGODB_RESULT_MARKER.length)); } catch { throw fail("SANDBOX_SETUP_INVALID_RESPONSE"); }
  if (!payload.ok || remote.exitCode !== 0 || remote.timedOut) {
    const phases = ["storage", "preflight", "lock", "journal-start", "create-manager-role", "create-executor-role", "create-manager-user", "reset-manager-password", "grant-executor-role", "verify-manager", "write-config", "journal-complete"];
    const diagnostic = payload.error?.diagnostic || {};
    const stage = phases.includes(diagnostic.phase) ? diagnostic.phase : "unknown";
    const code = Number.isSafeInteger(diagnostic.databaseCode) ? `; database code ${diagnostic.databaseCode}` : "";
    const filesystem = ["EACCES", "EPERM", "EIO", "EEXIST", "EROFS", "ENOSPC", "ELOOP", "EINVAL", "EMFILE", "ENFILE", "ENOTDIR"].includes(diagnostic.filesystemCode) ? `; filesystem code ${diagnostic.filesystemCode}` : "";
    throw fail(payload.error?.code || "SANDBOX_SETUP_FAILED", `Sandbox setup failed at ${stage}${code}${filesystem}; prepare again to inspect partial configuration safely`);
  }
  return payload.data;
}
