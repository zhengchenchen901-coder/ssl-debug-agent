import path from "node:path/posix";
import { createHash } from "node:crypto";

export const SERVICE_START_CONFIRMATION = "启动服务";
export const SERVICE_ENV_KEYS = ["NODE_ENV", "PORT", "WS_PORT", "CRON_PRIMARY", "TRANSLATION_ENABLED", "ORDER_AI_ENABLED", "ORDER_AI_ALLOWED_RESTAURANTS"];
export const SERVICE_CAPABILITIES = Object.freeze({
  version: 1, modes: ["fork"], actions: ["inspect", "start"],
  explicitInstance: true, savedProfileRequired: true, confirmation: SERVICE_START_CONFIRMATION,
  arbitraryCommands: false, restart: false, delete: false, envFileContentsReturned: false,
  maxProfiles: 8, maxProcesses: 8, environmentKeys: SERVICE_ENV_KEYS,
});

export function serviceError(code, message = code) {
  return Object.assign(new Error(message), { code, statusCode: 400, retriable: false });
}
function invalid(message) { throw serviceError("INVALID_SERVICE_PROFILE", message); }
export function assertServiceId(id) {
  if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(id)) invalid("invalid serviceId");
}
function object(value, fields, field) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) invalid(`invalid ${field} fields`);
}
function integer(value, min, max, field) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`invalid ${field}`);
  return value;
}
function absolute(value, roots, field) {
  if (typeof value !== "string" || value.length > 1024 || !/^\/[A-Za-z0-9_./+-]+$/.test(value) || path.normalize(value) !== value || value === "/") invalid(`invalid absolute ${field}`);
  if (roots && !roots.some((root) => value === root || value.startsWith(`${root}/`))) invalid(`${field} is outside approved roots`);
  return value;
}

// Profiles are local, privileged configuration. Start requests never supply paths,
// environment values, executable flags, or code. Binding prevents cross-instance reuse.
export function normalizeServiceProfiles(value, context) {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { invalid("serviceProfiles must be JSON"); } }
  value ??= {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 8) invalid("serviceProfiles must contain at most eight profiles");
  const result = {}, names = new Set(), ports = new Set();
  for (const [id, p] of Object.entries(value)) {
    assertServiceId(id);
    object(p, ["instanceId", "target", "enabled", "cwd", "releaseRoot", "entry", "mode", "interpreter", "nodeVersion", "pm2Path", "pm2Home", "envFiles", "processes", "maxMemoryRestart", "restartDelayMs", "stableMs", "startupTimeoutMs", "startupMarker", "persist"], id);
    object(p.target, ["host", "port", "username"], "target");
    if (p.instanceId !== context.id || p.target.host !== context.host || p.target.username !== context.username || p.target.port !== context.port) invalid("service profile target must match this exact instance, host, SSH port and user");
    if (typeof p.enabled !== "boolean" || typeof p.persist !== "boolean") invalid("enabled and persist must be explicit booleans");
    if (p.mode !== "fork") invalid("only explicit fork mode is supported; ecosystem/cluster startup is not supported");
    if (typeof p.nodeVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(p.nodeVersion) || Number(p.nodeVersion.split(".")[0]) < 20) invalid("exact Node version >=20 is required");
    if (typeof p.entry !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*\.m?js$/.test(p.entry) || path.normalize(p.entry) !== p.entry || p.entry.split("/").includes("..")) invalid("entry must be a relative JavaScript file");
    if (/\.config\.m?js$/i.test(p.entry) || /^ecosystem(?:\.|$)/i.test(path.basename(p.entry))) invalid("PM2 ecosystem/config entries are not supported");
    if (!["/usr/local/bin/pm2", "/usr/bin/pm2"].includes(p.pm2Path)) invalid("pm2Path must be /usr/local/bin/pm2 or /usr/bin/pm2");
    const roots = context.allowedPaths;
    const cwd = absolute(p.cwd, roots, "cwd");
    const releaseRoot = p.releaseRoot ? absolute(p.releaseRoot, roots, "releaseRoot") : undefined;
    if (releaseRoot && cwd !== `${releaseRoot}/current`) invalid("release profiles must use releaseRoot/current as cwd");
    const interpreter = absolute(p.interpreter, roots, "interpreter");
    if (path.basename(interpreter) !== "node") invalid("interpreter must name an absolute node binary");
    const pm2Home = absolute(p.pm2Home, roots, "pm2Home");
    if (!Array.isArray(p.envFiles) || p.envFiles.length > 4) invalid("envFiles must contain 0–4 paths, never secret values");
    const envFiles = p.envFiles.map((file) => absolute(file, roots, "envFiles"));
    if (new Set(envFiles).size !== envFiles.length) invalid("duplicate env file");
    if (!Array.isArray(p.processes) || !p.processes.length || p.processes.length > 8) invalid("processes must contain 1–8 entries");
    const processes = p.processes.map((proc) => {
      object(proc, ["name", "env", "ports"], "process");
      if (typeof proc.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(proc.name) || names.has(proc.name)) invalid("process names must be unique within an instance");
      names.add(proc.name);
      object(proc.env, SERVICE_ENV_KEYS, "environment (only non-secret allowlisted values are accepted)");
      const env = {};
      for (const [key, val] of Object.entries(proc.env).sort(([a], [b]) => a.localeCompare(b))) {
        if (typeof val !== "string" || val.length > 256) invalid("environment values must be bounded strings");
        if (key === "NODE_ENV" && !["development", "test", "production", "staging"].includes(val)) invalid("invalid NODE_ENV");
        if (["CRON_PRIMARY", "TRANSLATION_ENABLED", "ORDER_AI_ENABLED"].includes(key) && !["true", "false"].includes(val)) invalid(`invalid ${key}`);
        if (key === "ORDER_AI_ALLOWED_RESTAURANTS" && !/^(?:\*|[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)$/.test(val)) invalid("invalid ORDER_AI_ALLOWED_RESTAURANTS");
        if (["PORT", "WS_PORT"].includes(key) && (!/^\d{1,5}$/.test(val) || +val < 1 || +val > 65535)) invalid(`invalid ${key}`);
        env[key] = val;
      }
      if (!env.NODE_ENV) invalid("NODE_ENV is required");
      if (!Array.isArray(proc.ports) || !proc.ports.length || proc.ports.length > 8) invalid("expected TCP ports are required");
      const expected = proc.ports.map((port) => integer(port, 1, 65535, "port"));
      for (const port of expected) { if (ports.has(port)) invalid("ports must be unique within an instance"); ports.add(port); }
      for (const key of ["PORT", "WS_PORT"]) if (env[key] && !expected.includes(+env[key])) invalid(`${key} must be an expected port`);
      return { name: proc.name, env, ports: expected };
    });
    if (!/^[1-9]\d{0,3}[MG]$/.test(p.maxMemoryRestart || "")) invalid("maxMemoryRestart must be a bounded M/G value");
    if (typeof p.startupMarker !== "string" || !p.startupMarker.length || p.startupMarker.length > 128 || /[^\x20-\x7e]/.test(p.startupMarker)) invalid("a bounded literal startupMarker is required");
    const stableMs = integer(p.stableMs ?? 5000, 3000, 30000, "stableMs");
    const startupTimeoutMs = integer(p.startupTimeoutMs ?? 60000, stableMs + 1000, 90000, "startupTimeoutMs");
    result[id] = { instanceId: p.instanceId, target: { host: p.target.host, port: p.target.port, username: p.target.username }, enabled: p.enabled,
      cwd, ...(releaseRoot ? { releaseRoot } : {}), entry: p.entry, mode: "fork", interpreter, nodeVersion: p.nodeVersion,
      pm2Path: p.pm2Path, pm2Home, envFiles, processes, maxMemoryRestart: p.maxMemoryRestart,
      restartDelayMs: integer(p.restartDelayMs ?? 5000, 1000, 60000, "restartDelayMs"), stableMs, startupTimeoutMs,
      startupMarker: p.startupMarker, persist: p.persist };
  }
  return result;
}

export function serviceProfileHash(profile) {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}
export function serviceTargetHash(target, allowedPaths) {
  return createHash("sha256").update(JSON.stringify({ host: target.host, port: target.port, username: target.username,
    hostKeyFingerprints: [...(target.hostKeyFingerprints || [])].sort(), allowedPaths: [...allowedPaths].sort(),
  })).digest("hex");
}
export function serviceAuditFields(input = {}) {
  return {
    serviceId: typeof input.serviceId === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(input.serviceId) ? input.serviceId : undefined,
    profileHash: typeof input.profileHash === "string" && /^[a-f0-9]{64}$/.test(input.profileHash) ? input.profileHash : undefined,
  };
}
export function selectServiceProfile(profiles, input) {
  assertServiceId(input.serviceId);
  const profile = profiles?.[input.serviceId];
  if (!profile) throw serviceError("SERVICE_PROFILE_NOT_FOUND", "Configure a verified service profile for this instance first; no defaults are inferred");
  if (!profile.enabled) throw serviceError("SERVICE_START_DISABLED", "This instance service profile is disabled");
  if (input.profileHash !== serviceProfileHash(profile)) throw serviceError("SERVICE_PROFILE_STALE", "List service profiles again and use the current profileHash");
  return profile;
}
