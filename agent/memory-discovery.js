import { DEFAULT_ALLOWED_PATHS, publicTarget } from "./config.js";
import {
  listRemoteDir as defaultListRemoteDir,
  runSSH as defaultRunSSH,
} from "./ssh.js";
import { sanitizeMemoryValue } from "./memory-store.js";

const DISCOVERY_TIMEOUT_MS = 5_000;
const DIRECTORY_ENTRY_LIMIT = 50;
const DISCOVERY_DIRECTORIES = [
  "/etc/nginx",
  "/etc/nginx/conf.d",
  "/etc/nginx/sites-enabled",
  "/var/log",
  "/var/log/nginx",
  "/home/app",
  "/home/app/logs",
  "/home/github",
  "/home/github/logs",
  "/root/.pm2",
  "/root/.pm2/logs",
];
const DISCOVERY_COMMANDS = [
  { key: "kernel", section: "system", cmd: "uname -a" },
  { key: "hostname", section: "system", cmd: "hostname" },
  { key: "disk", section: "resources", cmd: "df -h" },
  { key: "memory", section: "resources", cmd: "free -m" },
  { key: "nginxActive", section: "services", cmd: "systemctl is-active nginx" },
  { key: "nginxEnabled", section: "services", cmd: "systemctl is-enabled nginx" },
  { key: "nginxConfig", section: "services", cmd: "nginx -t" },
  { key: "mongodActive", section: "services", cmd: "systemctl is-active mongod" },
  { key: "mongodEnabled", section: "services", cmd: "systemctl is-enabled mongod" },
  { key: "pm2", section: "services", cmd: "pm2 list" },
  { key: "mongodump", section: "database", cmd: "mongodump --version" },
  { key: "mongo", section: "database", cmd: "mongo --version" },
  { key: "mongosh", section: "database", cmd: "mongosh --version" },
  { key: "node", section: "services", cmd: "which node" },
];

function nowIso() {
  return new Date().toISOString();
}

function outputPreview(result) {
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr : "";
  const text = stdout.trim() || stderr.trim();
  return text.split(/\r?\n/).filter(Boolean).slice(0, 4).join("\n");
}

function commandSummary(result) {
  return sanitizeMemoryValue({
    exitCode: result?.exitCode ?? null,
    timedOut: Boolean(result?.timedOut),
    output: outputPreview(result),
  });
}

function directoryEntry(entry) {
  return sanitizeMemoryValue({
    name: entry.name,
    size: entry.size,
    modifyTime: entry.modifyTime,
    permissions: entry.permissions,
  });
}

function addUnique(list, value) {
  if (!value) {
    return list;
  }
  list.add(value);
  return list;
}

function joinRemotePath(parent, child) {
  const root = String(parent || "").replace(/\/+$/, "");
  return `${root}/${String(child || "").replace(/^\/+/, "")}`;
}

function collectInterestingPaths(pathName, entries, configPaths, logPaths) {
  for (const entry of entries) {
    const name = entry?.name || "";
    const remotePath = joinRemotePath(pathName, name);
    if (pathName.startsWith("/etc/nginx") && name.endsWith(".conf")) {
      addUnique(configPaths, remotePath);
    }
    if (name.endsWith(".log") || pathName.includes("/log")) {
      addUnique(logPaths, remotePath);
    }
  }
}

async function probeCommand(command, { config, runSSH, timeoutMs }) {
  try {
    const result = await runSSH(command.cmd, { config, timeoutMs });
    return {
      ok: true,
      command: command.cmd,
      result: commandSummary(result),
    };
  } catch (error) {
    return {
      ok: false,
      command: command.cmd,
      error: {
        code: error.code || "COMMAND_PROBE_FAILED",
        message: error.message || "command probe failed",
      },
    };
  }
}

async function probeDirectory(remotePath, { config, listRemoteDir }) {
  try {
    const result = await listRemoteDir(remotePath, { config });
    const entries = Array.isArray(result.entries) ? result.entries : [];
    return {
      ok: true,
      path: result.path || remotePath,
      entryCount: entries.length,
      entries: entries.slice(0, DIRECTORY_ENTRY_LIMIT).map(directoryEntry),
    };
  } catch (error) {
    return {
      ok: false,
      path: remotePath,
      error: {
        code: error.code || "DIRECTORY_PROBE_FAILED",
        message: error.message || "directory probe failed",
      },
    };
  }
}

function applyCommandProbe(sections, probe) {
  const command = DISCOVERY_COMMANDS.find((candidate) => candidate.cmd === probe.command);
  if (!command) {
    return;
  }

  if (!probe.ok) {
    sections.probes.commands[command.key] = probe;
    return;
  }

  if (command.section === "system") {
    sections.system[command.key] = probe.result.output;
    sections.system.summary = sections.system.kernel || sections.system.hostname || "";
  }

  if (command.section === "resources") {
    sections.resources[command.key] = {
      summary: probe.result.output,
      exitCode: probe.result.exitCode,
    };
  }

  if (command.section === "services") {
    if (command.key.startsWith("nginx")) {
      sections.services.nginx = {
        ...(sections.services.nginx || {}),
        [command.key.replace(/^nginx/, "").toLowerCase() || "status"]: probe.result.output,
        summary: probe.result.output || sections.services.nginx?.summary || "",
        exitCode: probe.result.exitCode,
      };
    } else if (command.key.startsWith("mongod")) {
      sections.services.mongod = {
        ...(sections.services.mongod || {}),
        [command.key.replace(/^mongod/, "").toLowerCase() || "status"]: probe.result.output,
        summary: probe.result.output || sections.services.mongod?.summary || "",
        exitCode: probe.result.exitCode,
      };
    } else {
      sections.services[command.key] = {
        summary: probe.result.output,
        exitCode: probe.result.exitCode,
      };
    }
  }

  if (command.section === "database") {
    sections.database.clients[command.key] = probe.result.output || `exit ${probe.result.exitCode}`;
  }

  sections.probes.commands[command.key] = probe;
}

function directoryAllowed(remotePath, allowedPaths) {
  return allowedPaths.some((root) => remotePath === root || remotePath.startsWith(`${root}/`));
}

export async function discoverMemory(config, options = {}) {
  const runSSH = options.runSSH || defaultRunSSH;
  const listRemoteDir = options.listRemoteDir || defaultListRemoteDir;
  const timeoutMs = options.timeoutMs || DISCOVERY_TIMEOUT_MS;
  const allowedPaths = config.security?.allowedPaths || DEFAULT_ALLOWED_PATHS;
  const collectedAt = nowIso();
  const sections = {
    target: publicTarget(config),
    system: {},
    resources: {},
    services: {},
    database: {
      clients: {},
    },
    filesystem: {
      allowedPaths,
      directories: {},
      configPaths: [],
      logPaths: [],
    },
    probes: {
      commands: {},
      directories: {},
    },
  };
  const configPaths = new Set();
  const logPaths = new Set();
  let failedProbeCount = 0;

  for (const command of DISCOVERY_COMMANDS) {
    const probe = await probeCommand(command, { config, runSSH, timeoutMs });
    if (!probe.ok) {
      failedProbeCount += 1;
    }
    applyCommandProbe(sections, probe);
  }

  for (const remotePath of DISCOVERY_DIRECTORIES.filter((item) => directoryAllowed(item, allowedPaths))) {
    const probe = await probeDirectory(remotePath, { config, listRemoteDir });
    sections.probes.directories[remotePath] = probe;
    if (!probe.ok) {
      failedProbeCount += 1;
      continue;
    }
    sections.filesystem.directories[probe.path] = {
      entryCount: probe.entryCount,
      entries: probe.entries,
      updatedAt: collectedAt,
    };
    collectInterestingPaths(probe.path, probe.entries, configPaths, logPaths);
  }

  sections.filesystem.configPaths = [...configPaths].sort();
  sections.filesystem.logPaths = [...logPaths].sort();
  sections.database.service = sections.services.mongod?.summary || "";

  return sanitizeMemoryValue({
    status: failedProbeCount > 0 ? "partial" : "ready",
    initializedAt: collectedAt,
    lastCheckedAt: collectedAt,
    sections,
  });
}
