import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadDotEnv } from "./config.js";

export const REGISTRY_VERSION = 2;
export const DEFAULT_WORKER_PORT_RANGE = { start: 4400, end: 4499 };
export const DEFAULT_HEALTH_INTERVAL_MS = 15_000;
export const DEFAULT_START_TIMEOUT_MS = 10_000;
export const DEFAULT_STOP_TIMEOUT_MS = 5_000;

function parsePort(value, fallback, fieldName) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    const error = new Error(`${fieldName} must be a valid TCP port`);
    error.code = "INVALID_INSTANCE_FIELD";
    error.statusCode = 400;
    throw error;
  }

  return parsed;
}

export function isPortInRange(port, range) {
  return Number.isInteger(port) && port >= range.start && port <= range.end;
}

function parsePositiveInt(value, fallback, fieldName) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${fieldName} must be a positive integer`);
    error.code = "INVALID_INSTANCE_FIELD";
    error.statusCode = 400;
    throw error;
  }

  return parsed;
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function slugify(value, fallback = "instance") {
  const base = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return base || fallback;
}

function assertInstanceId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    const error = new Error("instance id must use 1-64 letters, numbers, dashes, or underscores");
    error.code = "INVALID_INSTANCE_ID";
    error.statusCode = 400;
    throw error;
  }
}

function managerDefaults(rawManager = {}) {
  const range = rawManager.workerPortRange || {};
  const start = parsePort(range.start, DEFAULT_WORKER_PORT_RANGE.start, "workerPortRange.start");
  const end = parsePort(range.end, DEFAULT_WORKER_PORT_RANGE.end, "workerPortRange.end");
  if (end < start) {
    const error = new Error("workerPortRange.end must be greater than or equal to workerPortRange.start");
    error.code = "INVALID_MANAGER_CONFIG";
    error.statusCode = 400;
    throw error;
  }

  return {
    host: rawManager.host || "127.0.0.1",
    workerPortRange: { start, end },
    healthIntervalMs: parsePositiveInt(
      rawManager.healthIntervalMs,
      DEFAULT_HEALTH_INTERVAL_MS,
      "healthIntervalMs",
    ),
    startTimeoutMs: parsePositiveInt(
      rawManager.startTimeoutMs,
      DEFAULT_START_TIMEOUT_MS,
      "startTimeoutMs",
    ),
    stopTimeoutMs: parsePositiveInt(
      rawManager.stopTimeoutMs,
      DEFAULT_STOP_TIMEOUT_MS,
      "stopTimeoutMs",
    ),
  };
}

function normalizeApprovedCommands(value = {}) {
  return {
    enabled: parseBooleanFlag(value.enabled, false),
    timeoutMs: value.timeoutMs === undefined || value.timeoutMs === ""
      ? undefined
      : parsePositiveInt(value.timeoutMs, undefined, "approvedCommands.timeoutMs"),
    maxTimeoutMs: value.maxTimeoutMs === undefined || value.maxTimeoutMs === ""
      ? undefined
      : parsePositiveInt(value.maxTimeoutMs, undefined, "approvedCommands.maxTimeoutMs"),
  };
}

function normalizeInstance(input, existing = {}) {
  const id = input.id || existing.id || slugify(input.name || input.host || randomUUID());
  assertInstanceId(id);

  const name = String(input.name ?? existing.name ?? id).trim();
  if (!name) {
    const error = new Error("instance name is required");
    error.code = "INVALID_INSTANCE_FIELD";
    error.statusCode = 400;
    throw error;
  }

  const host = String(input.host ?? existing.host ?? "").trim();
  const username = String(input.username ?? existing.username ?? "").trim();
  const privateKeyPath = String(input.privateKeyPath ?? existing.privateKeyPath ?? "").trim();
  if (!host || !username || !privateKeyPath) {
    const error = new Error("host, username, and privateKeyPath are required");
    error.code = "INVALID_INSTANCE_FIELD";
    error.statusCode = 400;
    throw error;
  }

  const passphrase =
    input.passphrase === "" || input.passphrase === undefined
      ? existing.passphrase
      : input.passphrase;
  const preferredWorkerPort = input.preferredWorkerPort ?? input.workerPort ?? input.agentPort;

  return {
    id,
    name,
    enabled: parseBooleanFlag(input.enabled, existing.enabled ?? true),
    host,
    port: parsePort(input.port, existing.port || 22, "port"),
    username,
    privateKeyPath,
    passphrase: passphrase || undefined,
    auditLog: input.auditLog === "" ? undefined : input.auditLog ?? existing.auditLog,
    preferredWorkerPort: preferredWorkerPort === undefined || preferredWorkerPort === ""
      ? existing.preferredWorkerPort
      : parsePort(preferredWorkerPort, undefined, "preferredWorkerPort"),
    approvedCommands: normalizeApprovedCommands({
      ...existing.approvedCommands,
      ...input.approvedCommands,
    }),
    createdAt: existing.createdAt || input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function sanitizeInstanceForManager(instance, manager, managerPort) {
  if (
    instance.preferredWorkerPort !== undefined &&
    (
      !isPortInRange(instance.preferredWorkerPort, manager.workerPortRange) ||
      instance.preferredWorkerPort === managerPort
    )
  ) {
    const { preferredWorkerPort, ...sanitized } = instance;
    return sanitized;
  }

  return instance;
}

function rawPreferredWorkerPort(input = {}) {
  return input.preferredWorkerPort ?? input.workerPort ?? input.agentPort;
}

function hasUnavailablePreferredWorkerPort(rawInstances, manager, managerPort) {
  if (!Array.isArray(rawInstances)) {
    return false;
  }

  return rawInstances.some((instance) => {
    const value = rawPreferredWorkerPort(instance);
    if (value === undefined || value === null || value === "") {
      return false;
    }

    const parsed = Number.parseInt(value, 10);
    return (
      Number.isInteger(parsed) &&
      (
        !isPortInRange(parsed, manager.workerPortRange) ||
        parsed === managerPort
      )
    );
  });
}

function registryRootFrom(cwd) {
  const normalized = path.resolve(cwd);
  if (path.basename(normalized).toLowerCase() === "agent") {
    return path.dirname(normalized);
  }

  return normalized;
}

export function defaultRegistryPath(cwd = process.cwd(), env = process.env) {
  if (env.REMOTE_DEBUG_INSTANCE_REGISTRY) {
    return path.resolve(env.REMOTE_DEBUG_INSTANCE_REGISTRY);
  }

  const root = env.REMOTE_DEBUG_PROJECT_ROOT
    ? path.resolve(env.REMOTE_DEBUG_PROJECT_ROOT)
    : registryRootFrom(cwd);
  return path.resolve(root, ".remote-debug", "instances.json");
}

function envDefaultInstance(env, cwd) {
  const dotEnv = loadDotEnv(cwd);
  const merged = { ...env, ...dotEnv };
  const host = merged.REMOTE_DEBUG_HOST || "";
  const username = merged.REMOTE_DEBUG_USER || "";
  const privateKeyPath = merged.REMOTE_DEBUG_PRIVATE_KEY_PATH || "";
  if (!host || !username || !privateKeyPath) {
    return null;
  }

  return normalizeInstance({
    id: "default",
    name: "default",
    enabled: true,
    host,
    port: merged.REMOTE_DEBUG_PORT || 22,
    username,
    privateKeyPath,
    passphrase: merged.REMOTE_DEBUG_PRIVATE_KEY_PASSPHRASE,
    auditLog: merged.REMOTE_DEBUG_AUDIT_LOG,
    approvedCommands: {
      enabled: merged.REMOTE_DEBUG_APPROVED_COMMANDS,
      timeoutMs: merged.REMOTE_DEBUG_APPROVED_COMMAND_TIMEOUT_MS,
      maxTimeoutMs: merged.REMOTE_DEBUG_APPROVED_COMMAND_MAX_TIMEOUT_MS,
    },
  });
}

function emptyRegistry(cwd, env) {
  const defaultInstance = envDefaultInstance(env, cwd);
  return {
    version: REGISTRY_VERSION,
    manager: managerDefaults(),
    defaultInstanceId: defaultInstance?.id || "",
    instances: defaultInstance ? [defaultInstance] : [],
  };
}

function normalizeRegistry(raw, cwd, env, managerPort) {
  const manager = managerDefaults(raw.manager);
  const instances = Array.isArray(raw.instances)
    ? raw.instances.map((instance) =>
        sanitizeInstanceForManager(normalizeInstance(instance), manager, managerPort))
    : [];
  const ids = new Set();
  for (const instance of instances) {
    if (ids.has(instance.id)) {
      const error = new Error(`duplicate instance id: ${instance.id}`);
      error.code = "DUPLICATE_INSTANCE_ID";
      error.statusCode = 400;
      throw error;
    }
    ids.add(instance.id);
  }

  const fallback = emptyRegistry(cwd, env);
  const defaultInstanceId =
    raw.defaultInstanceId && ids.has(raw.defaultInstanceId)
      ? raw.defaultInstanceId
      : instances[0]?.id || fallback.defaultInstanceId || "";

  return {
    version: REGISTRY_VERSION,
    manager,
    defaultInstanceId,
    instances: instances.length > 0 ? instances : fallback.instances,
  };
}

function publicInstance(instance) {
  const { passphrase, ...rest } = instance;
  return {
    ...rest,
    hasPassphrase: Boolean(passphrase),
  };
}

export class InstanceRegistry {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || process.env;
    this.managerPort = options.managerPort;
    this.registryPath = options.registryPath || defaultRegistryPath(this.cwd, this.env);
    this.registry = this.load();
  }

  load() {
    let registry;
    let shouldWrite = false;

    if (fs.existsSync(this.registryPath)) {
      const raw = JSON.parse(fs.readFileSync(this.registryPath, "utf8").replace(/^\uFEFF/, ""));
      const rawInstanceCount = Array.isArray(raw.instances) ? raw.instances.length : 0;
      registry = normalizeRegistry(raw, this.cwd, this.env, this.managerPort);
      shouldWrite =
        raw.version !== REGISTRY_VERSION ||
        !raw.manager ||
        hasUnavailablePreferredWorkerPort(raw.instances, registry.manager, this.managerPort) ||
        (rawInstanceCount === 0 && registry.instances.length > 0);
    } else {
      registry = emptyRegistry(this.cwd, this.env);
      shouldWrite = registry.instances.length > 0;
    }

    if (shouldWrite) {
      this.save(registry);
    }

    return registry;
  }

  save(nextRegistry = this.registry) {
    this.registry = nextRegistry;
    fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
    const tempPath = `${this.registryPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.registry, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, this.registryPath);
  }

  managerConfig() {
    return this.registry.manager;
  }

  list() {
    return this.registry.instances.map(publicInstance);
  }

  listInternal() {
    return this.registry.instances.map((instance) => ({ ...instance }));
  }

  get(id) {
    const instance = this.registry.instances.find((candidate) => candidate.id === id);
    return instance ? publicInstance(instance) : null;
  }

  getInternal(id) {
    const instance = this.registry.instances.find((candidate) => candidate.id === id);
    return instance ? { ...instance } : null;
  }

  create(input) {
    const instance = sanitizeInstanceForManager(
      normalizeInstance(input),
      this.managerConfig(),
      this.managerPort,
    );
    if (this.registry.instances.some((candidate) => candidate.id === instance.id)) {
      const error = new Error(`instance already exists: ${instance.id}`);
      error.code = "INSTANCE_ALREADY_EXISTS";
      error.statusCode = 409;
      throw error;
    }

    this.registry.instances.push(instance);
    if (!this.registry.defaultInstanceId) {
      this.registry.defaultInstanceId = instance.id;
    }
    this.save();
    return publicInstance(instance);
  }

  update(id, input) {
    const index = this.registry.instances.findIndex((instance) => instance.id === id);
    if (index === -1) {
      const error = new Error(`instance not found: ${id}`);
      error.code = "INSTANCE_NOT_FOUND";
      error.statusCode = 404;
      throw error;
    }

    const updated = sanitizeInstanceForManager(
      normalizeInstance(
        {
          ...input,
          id,
          updatedAt: new Date().toISOString(),
        },
        this.registry.instances[index],
      ),
      this.managerConfig(),
      this.managerPort,
    );
    this.registry.instances[index] = updated;
    this.save();
    return publicInstance(updated);
  }

  delete(id) {
    const index = this.registry.instances.findIndex((instance) => instance.id === id);
    if (index === -1) {
      const error = new Error(`instance not found: ${id}`);
      error.code = "INSTANCE_NOT_FOUND";
      error.statusCode = 404;
      throw error;
    }

    const [removed] = this.registry.instances.splice(index, 1);
    if (this.registry.defaultInstanceId === id) {
      this.registry.defaultInstanceId = this.registry.instances[0]?.id || "";
    }
    this.save();
    return publicInstance(removed);
  }

  resolveId(instanceId) {
    if (instanceId) {
      const instance = this.getInternal(instanceId);
      if (!instance) {
        const error = new Error(`instance not found: ${instanceId}`);
        error.code = "INSTANCE_NOT_FOUND";
        error.statusCode = 404;
        error.instances = this.list();
        throw error;
      }
      return instance.id;
    }

    const instances = this.listInternal();
    if (instances.length === 1) {
      return instances[0].id;
    }

    const error = new Error("instanceId is required when multiple instances are configured");
    error.code = instances.length === 0 ? "INSTANCE_NOT_FOUND" : "INSTANCE_ID_REQUIRED";
    error.statusCode = instances.length === 0 ? 404 : 400;
    error.instances = this.list();
    throw error;
  }
}
