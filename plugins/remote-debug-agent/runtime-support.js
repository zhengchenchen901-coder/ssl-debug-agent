import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_DATA_DIRECTORY_NAME = "RemoteDebugAgent";
export const DEFAULT_CONFIG_FILE_NAME = "config.env";

export function normalizeWindowsExtendedPath(inputPath) {
  return String(inputPath || "").replace(/^\\\\\?\\/, "");
}

export function resolveDataDir(env = process.env) {
  const explicit = env.REMOTE_DEBUG_DATA_DIR || env.REMOTE_DEBUG_PROJECT_ROOT;
  if (explicit) {
    return path.resolve(normalizeWindowsExtendedPath(explicit));
  }

  if (env.LOCALAPPDATA) {
    return path.resolve(
      normalizeWindowsExtendedPath(env.LOCALAPPDATA),
      DEFAULT_DATA_DIRECTORY_NAME,
    );
  }

  return path.resolve(os.homedir(), ".remote-debug-agent");
}

export function resolveConfigPath(env = process.env, dataDir = resolveDataDir(env)) {
  if (env.REMOTE_DEBUG_ENV_PATH) {
    return path.resolve(normalizeWindowsExtendedPath(env.REMOTE_DEBUG_ENV_PATH));
  }
  return path.resolve(dataDir, DEFAULT_CONFIG_FILE_NAME);
}

function copyFileIfMissing(sourcePath, targetPath, copied, skipped) {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  if (fs.existsSync(targetPath)) {
    skipped.push(targetPath);
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  copied.push(targetPath);
}

function persistentInstanceFiles(legacyStateDir) {
  const instancesDir = path.resolve(legacyStateDir, "instances");
  if (!fs.existsSync(instancesDir)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(instancesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    for (const fileName of ["memory.json", "audit.jsonl"]) {
      files.push({
        relativePath: path.join("instances", entry.name, fileName),
        sourcePath: path.join(instancesDir, entry.name, fileName),
      });
    }
  }
  return files;
}

export function migrateLegacyData({
  legacyRoot,
  dataDir,
  env = process.env,
} = {}) {
  const resolvedDataDir = path.resolve(dataDir || resolveDataDir(env));
  const resolvedLegacyRoot = legacyRoot ? path.resolve(legacyRoot) : "";
  const copied = [];
  const skipped = [];

  if (!resolvedLegacyRoot) {
    return { copied, skipped, legacyRoot: resolvedLegacyRoot, dataDir: resolvedDataDir };
  }

  fs.mkdirSync(resolvedDataDir, { recursive: true });

  if (!env.REMOTE_DEBUG_ENV_PATH) {
    copyFileIfMissing(
      path.resolve(resolvedLegacyRoot, ".env"),
      path.resolve(resolvedDataDir, DEFAULT_CONFIG_FILE_NAME),
      copied,
      skipped,
    );
  }

  if (resolvedLegacyRoot === resolvedDataDir) {
    return { copied, skipped, legacyRoot: resolvedLegacyRoot, dataDir: resolvedDataDir };
  }

  const legacyStateDir = path.resolve(resolvedLegacyRoot, ".remote-debug");
  const targetStateDir = path.resolve(resolvedDataDir, ".remote-debug");
  copyFileIfMissing(
    path.resolve(legacyStateDir, "instances.json"),
    path.resolve(targetStateDir, "instances.json"),
    copied,
    skipped,
  );

  for (const legacyAuditPath of [
    path.resolve(resolvedLegacyRoot, "agent", "audit", "remote-debug-agent.jsonl"),
    path.resolve(resolvedLegacyRoot, "audit", "remote-debug-agent.jsonl"),
  ]) {
    copyFileIfMissing(
      legacyAuditPath,
      path.resolve(targetStateDir, "audit", "remote-debug-agent.jsonl"),
      copied,
      skipped,
    );
  }

  for (const candidate of persistentInstanceFiles(legacyStateDir)) {
    copyFileIfMissing(
      candidate.sourcePath,
      path.resolve(targetStateDir, candidate.relativePath),
      copied,
      skipped,
    );
  }

  return {
    copied,
    skipped,
    legacyRoot: resolvedLegacyRoot,
    dataDir: resolvedDataDir,
  };
}

export function readRuntimeManifest(pluginRoot) {
  const manifestPath = path.resolve(
    pluginRoot,
    "runtime",
    "agent",
    "runtime-manifest.json",
  );
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (
      manifest?.version !== 1 ||
      typeof manifest.runtimeId !== "string" ||
      !manifest.runtimeId ||
      typeof manifest.server !== "string" ||
      typeof manifest.worker !== "string"
    ) {
      return { manifestPath, manifest: null };
    }
    return { manifestPath, manifest };
  } catch {
    return { manifestPath, manifest: null };
  }
}
