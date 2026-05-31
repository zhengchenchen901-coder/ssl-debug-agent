import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const MEMORY_VERSION = 1;
export const MEMORY_STATUSES = new Set([
  "missing",
  "initializing",
  "ready",
  "partial",
  "failed",
  "stale",
]);

const MAX_CHANGES = 50;
const MAX_STRING_LENGTH = 2048;
const MAX_ARRAY_LENGTH = 200;
const MAX_DEPTH = 8;
const REDACTED = "[redacted]";
const SENSITIVE_KEY_PATTERN = /pass(word|phrase)?|secret|token|credential|auth|private.?key|connection.?string|dsn/i;
const SENSITIVE_VALUE_PATTERN =
  /(mongodb(?:\+srv)?:\/\/|mysql:\/\/|postgres(?:ql)?:\/\/|redis:\/\/|:\/\/[^/\s:@]+:[^@\s]+@|access[_-]?token=|password=|passwd=|pwd=|secret=|token=)/i;

function nowIso() {
  return new Date().toISOString();
}

function projectRootFrom(cwd) {
  const normalized = path.resolve(cwd);
  return path.basename(normalized).toLowerCase() === "agent" ? path.dirname(normalized) : normalized;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function sanitizeString(value) {
  if (SENSITIVE_VALUE_PATTERN.test(value)) {
    return REDACTED;
  }

  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`
    : value;
}

export function sanitizeMemoryValue(value, key = "", depth = 0) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizeString(value);
  }
  if (depth >= MAX_DEPTH) {
    return "[max-depth]";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => sanitizeMemoryValue(item, key, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    const sanitized = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const nextValue = sanitizeMemoryValue(childValue, childKey, depth + 1);
      if (nextValue !== undefined) {
        sanitized[childKey] = nextValue;
      }
    }
    return sanitized;
  }

  return String(value);
}

export function targetFingerprint(instance = {}) {
  return createHash("sha256")
    .update(stableJson({
      host: instance.host || "",
      port: instance.port || 22,
      username: instance.username || "",
    }))
    .digest("hex");
}

function targetSummary(instance = {}) {
  return {
    host: instance.host || "",
    port: instance.port || 22,
    username: instance.username || "",
  };
}

function memoryRootFromOptions(options) {
  if (options.memoryRoot) {
    return path.resolve(options.memoryRoot);
  }
  return path.resolve(projectRootFrom(options.cwd || process.cwd()), ".remote-debug", "instances");
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeObjects(base = {}, patch = {}) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (isObject(value) && isObject(merged[key])) {
      merged[key] = mergeObjects(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function normalizeStatus(status, fallback = "ready") {
  return MEMORY_STATUSES.has(status) ? status : fallback;
}

function publicDirectorySummary(filesystem = {}) {
  const directories = filesystem.directories || {};
  return Object.entries(directories).slice(0, 12).map(([remotePath, info]) => ({
    path: remotePath,
    entryCount: info?.entryCount ?? info?.entries?.length ?? 0,
    updatedAt: info?.updatedAt,
  }));
}

function publicPathList(values) {
  return Array.isArray(values) ? values.slice(0, 20) : [];
}

function buildSummary(memory) {
  const sections = memory?.sections || {};
  const target = sections.target || {};
  const services = sections.services || {};
  const database = sections.database || {};
  const filesystem = sections.filesystem || {};
  const resources = sections.resources || {};

  return sanitizeMemoryValue({
    target,
    system: sections.system?.summary || sections.system?.kernel || "",
    resources: {
      disk: resources.disk?.summary || "",
      memory: resources.memory?.summary || "",
    },
    services: {
      nginx: services.nginx?.summary || services.nginx?.active || "",
      mongod: services.mongod?.summary || services.mongod?.active || "",
      pm2: services.pm2?.summary || "",
    },
    database: {
      clients: database.clients || {},
      service: database.service || "",
    },
    configPaths: publicPathList(filesystem.configPaths),
    logPaths: publicPathList(filesystem.logPaths),
    directories: publicDirectorySummary(filesystem),
  });
}

function publicMemory(memory, instance) {
  if (!memory) {
    return {
      status: "missing",
      updatedAt: null,
      initializedAt: null,
      summary: {
        target: targetSummary(instance),
      },
      changedSections: [],
    };
  }

  const fingerprint = targetFingerprint(instance);
  const stale = memory.targetFingerprint && memory.targetFingerprint !== fingerprint;
  const status = stale ? "stale" : normalizeStatus(memory.status, "ready");
  const latestChange = Array.isArray(memory.changes) ? memory.changes[memory.changes.length - 1] : null;

  return {
    status,
    updatedAt: memory.updatedAt || null,
    initializedAt: memory.initializedAt || null,
    lastCheckedAt: memory.lastCheckedAt || null,
    summary: buildSummary(memory),
    changedSections: latestChange?.sections || [],
  };
}

function addUniquePath(list, item) {
  if (!item || typeof item !== "string") {
    return list || [];
  }

  const next = [...(Array.isArray(list) ? list : []), item];
  return [...new Set(next)].sort();
}

function joinRemotePath(parent, child) {
  const root = String(parent || "").replace(/\/+$/, "");
  return `${root}/${String(child || "").replace(/^\/+/, "")}`;
}

function previewOutput(value) {
  if (typeof value !== "string") {
    return "";
  }
  return sanitizeMemoryValue(value.split(/\r?\n/).filter(Boolean).slice(0, 3).join("\n"));
}

function observationPatch(pathName, payload = {}, result = {}, observedAt = nowIso()) {
  if (!result || result.ok === false) {
    return null;
  }

  if (pathName === "/list-dir" && typeof result.path === "string") {
    const entries = Array.isArray(result.entries) ? result.entries : [];
    let configPaths = [];
    let logPaths = [];

    for (const entry of entries) {
      const name = entry?.name || "";
      if (result.path.startsWith("/etc/nginx") && name.endsWith(".conf")) {
        configPaths = addUniquePath(configPaths, joinRemotePath(result.path, name));
      }
      if (name.endsWith(".log") || result.path.includes("/log")) {
        logPaths = addUniquePath(logPaths, joinRemotePath(result.path, name));
      }
    }

    return {
      filesystem: {
        directories: {
          [result.path]: {
            entryCount: entries.length,
            entries: entries.slice(0, 50).map((entry) => ({
              name: entry.name,
              size: entry.size,
              modifyTime: entry.modifyTime,
              permissions: entry.permissions,
            })),
            updatedAt: observedAt,
          },
        },
        configPaths,
        logPaths,
      },
    };
  }

  if (pathName === "/read-file" && typeof result.path === "string") {
    const filesystem = {
      files: {
        [result.path]: {
          truncated: Boolean(result.truncated),
          observedAt,
        },
      },
    };
    if (result.path.startsWith("/etc/nginx") || result.path.endsWith(".conf")) {
      filesystem.configPaths = [result.path];
    }
    if (result.path.endsWith(".log") || result.path.includes("/logs/")) {
      filesystem.logPaths = [result.path];
    }
    return { filesystem };
  }

  if (pathName === "/run" && typeof payload.cmd === "string") {
    const cmd = payload.cmd;
    const stdoutPreview = previewOutput(result.stdout);
    const stderrPreview = previewOutput(result.stderr);

    if (/^systemctl\s+/.test(cmd)) {
      const service = cmd.includes("mongod") ? "mongod" : cmd.includes("nginx") ? "nginx" : "";
      if (service) {
        return {
          services: {
            [service]: {
              summary: stdoutPreview || stderrPreview || `exit ${result.exitCode}`,
              exitCode: result.exitCode,
              observedAt,
            },
          },
        };
      }
    }

    if (/^nginx\s+/.test(cmd)) {
      return {
        services: {
          nginx: {
            summary: stdoutPreview || stderrPreview || `exit ${result.exitCode}`,
            exitCode: result.exitCode,
            observedAt,
          },
        },
      };
    }

    if (/^(mongo|mongosh|mongodump)\s+--version$/.test(cmd)) {
      const clientName = cmd.split(/\s+/)[0];
      return {
        database: {
          clients: {
            [clientName]: stdoutPreview || stderrPreview || `exit ${result.exitCode}`,
          },
        },
      };
    }

    if (cmd === "df -h") {
      return {
        resources: {
          disk: {
            summary: stdoutPreview,
            observedAt,
          },
        },
      };
    }

    if (cmd === "free -m") {
      return {
        resources: {
          memory: {
            summary: stdoutPreview,
            observedAt,
          },
        },
      };
    }

    if (cmd === "pm2 list") {
      return {
        services: {
          pm2: {
            summary: stdoutPreview || stderrPreview || `exit ${result.exitCode}`,
            exitCode: result.exitCode,
            observedAt,
          },
        },
      };
    }
  }

  return null;
}

export class MemoryStore {
  constructor(options = {}) {
    this.root = memoryRootFromOptions(options);
    this.now = options.now || nowIso;
    this.records = new Map();
  }

  memoryPath(instanceId) {
    return path.resolve(this.root, instanceId, "memory.json");
  }

  ensureLoaded(instanceId) {
    if (this.records.has(instanceId)) {
      return this.records.get(instanceId);
    }

    const filePath = this.memoryPath(instanceId);
    if (!fs.existsSync(filePath)) {
      this.records.set(instanceId, null);
      return null;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
      if (parsed?.version !== MEMORY_VERSION || parsed.instanceId !== instanceId) {
        this.records.set(instanceId, null);
        return null;
      }
      const sanitized = sanitizeMemoryValue(parsed);
      this.records.set(instanceId, sanitized);
      return sanitized;
    } catch {
      this.records.set(instanceId, null);
      return null;
    }
  }

  summary(instance) {
    return publicMemory(this.ensureLoaded(instance.id), instance);
  }

  shouldInitialize(instance) {
    const memory = this.ensureLoaded(instance.id);
    if (!memory) {
      return true;
    }
    if (memory.targetFingerprint !== targetFingerprint(instance)) {
      return true;
    }
    return !["ready", "partial"].includes(memory.status);
  }

  async write(instanceId, memory) {
    const filePath = this.memoryPath(instanceId);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await fsp.writeFile(tempPath, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
    await fsp.rename(tempPath, filePath);
    this.records.set(instanceId, memory);
  }

  async markInitializing(instance, source = "worker-start") {
    const previous = this.ensureLoaded(instance.id);
    const timestamp = this.now();
    const next = sanitizeMemoryValue({
      version: MEMORY_VERSION,
      instanceId: instance.id,
      targetFingerprint: targetFingerprint(instance),
      status: "initializing",
      initializedAt: previous?.initializedAt || null,
      updatedAt: timestamp,
      lastCheckedAt: timestamp,
      sections: {
        ...(previous?.sections || {}),
        target: targetSummary(instance),
      },
      changes: [
        ...((previous?.changes || []).slice(-(MAX_CHANGES - 1))),
        {
          time: timestamp,
          source,
          sections: ["status", "target"],
        },
      ],
    });
    await this.write(instance.id, next);
    return this.summary(instance);
  }

  async markFailed(instance, error, source = "worker-start") {
    const previous = this.ensureLoaded(instance.id);
    const timestamp = this.now();
    const next = sanitizeMemoryValue({
      version: MEMORY_VERSION,
      instanceId: instance.id,
      targetFingerprint: targetFingerprint(instance),
      status: "failed",
      initializedAt: previous?.initializedAt || null,
      updatedAt: timestamp,
      lastCheckedAt: timestamp,
      sections: {
        ...(previous?.sections || {}),
        target: targetSummary(instance),
      },
      lastError: {
        code: error?.code || "MEMORY_INIT_FAILED",
        message: error?.message || "memory init failed",
      },
      changes: [
        ...((previous?.changes || []).slice(-(MAX_CHANGES - 1))),
        {
          time: timestamp,
          source,
          sections: ["status"],
        },
      ],
    });
    await this.write(instance.id, next);
    return this.summary(instance);
  }

  async merge(instance, update = {}, source = "worker") {
    const previous = this.ensureLoaded(instance.id);
    const timestamp = this.now();
    const incomingSections = sanitizeMemoryValue(update.sections || {});
    const baseSections = {
      ...(previous?.sections || {}),
      target: targetSummary(instance),
    };
    const nextSections = mergeObjects(baseSections, incomingSections);
    if (incomingSections.filesystem?.configPaths) {
      nextSections.filesystem = {
        ...(nextSections.filesystem || {}),
        configPaths: [
          ...new Set([
            ...((previous?.sections?.filesystem?.configPaths) || []),
            ...incomingSections.filesystem.configPaths,
          ]),
        ].sort(),
      };
    }
    if (incomingSections.filesystem?.logPaths) {
      nextSections.filesystem = {
        ...(nextSections.filesystem || {}),
        logPaths: [
          ...new Set([
            ...((previous?.sections?.filesystem?.logPaths) || []),
            ...incomingSections.filesystem.logPaths,
          ]),
        ].sort(),
      };
    }

    const changedSections = [];
    for (const key of new Set([...Object.keys(baseSections), ...Object.keys(nextSections)])) {
      if (!deepEqual(baseSections[key], nextSections[key])) {
        changedSections.push(key);
      }
    }

    const status = normalizeStatus(update.status, changedSections.length > 0 ? "ready" : previous?.status || "ready");
    const next = sanitizeMemoryValue({
      version: MEMORY_VERSION,
      instanceId: instance.id,
      targetFingerprint: targetFingerprint(instance),
      status,
      initializedAt: previous?.initializedAt || update.initializedAt || timestamp,
      updatedAt: changedSections.length > 0 || previous?.status !== status ? timestamp : previous?.updatedAt || timestamp,
      lastCheckedAt: update.lastCheckedAt || timestamp,
      sections: nextSections,
      lastError: update.lastError,
      changes: [
        ...((previous?.changes || []).slice(-(MAX_CHANGES - 1))),
        ...(changedSections.length > 0 || previous?.status !== status
          ? [
              {
                time: timestamp,
                source,
                sections: changedSections.length > 0 ? changedSections : ["status"],
              },
            ]
          : []),
      ],
    });

    await this.write(instance.id, next);
    return this.summary(instance);
  }

  async recordToolObservation(instance, pathName, payload, result) {
    const patch = observationPatch(pathName, payload, result, this.now());
    if (!patch) {
      return this.summary(instance);
    }

    return this.merge(
      instance,
      {
        status: this.summary(instance).status === "missing" ? "partial" : undefined,
        sections: patch,
      },
      `tool:${pathName}`,
    );
  }

  async deleteInstance(instanceId) {
    this.records.delete(instanceId);
    await fsp.rm(this.memoryPath(instanceId), { force: true });
  }
}
