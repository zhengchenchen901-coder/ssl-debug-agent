import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  migrateLegacyData,
  readRuntimeManifest,
  resolveConfigPath,
  resolveDataDir,
} from "../runtime-support.js";

test("data and config paths follow compatibility precedence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-paths-"));
  const explicitData = path.join(root, "explicit-data");
  const legacyProjectRoot = path.join(root, "legacy-project");
  const localAppData = path.join(root, "local-app-data");

  assert.equal(
    resolveDataDir({
      REMOTE_DEBUG_DATA_DIR: explicitData,
      REMOTE_DEBUG_PROJECT_ROOT: legacyProjectRoot,
      LOCALAPPDATA: localAppData,
    }),
    explicitData,
  );
  assert.equal(
    resolveDataDir({
      REMOTE_DEBUG_PROJECT_ROOT: legacyProjectRoot,
      LOCALAPPDATA: localAppData,
    }),
    legacyProjectRoot,
  );
  assert.equal(
    resolveDataDir({ LOCALAPPDATA: localAppData }),
    path.join(localAppData, "RemoteDebugAgent"),
  );
  assert.equal(
    resolveConfigPath(
      { REMOTE_DEBUG_ENV_PATH: path.join(root, "custom.env") },
      explicitData,
    ),
    path.join(root, "custom.env"),
  );
  assert.equal(resolveConfigPath({}, explicitData), path.join(explicitData, "config.env"));
});

test("legacy migration copies only persistent data and never overwrites targets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-migration-"));
  const legacyRoot = path.join(root, "legacy");
  const dataDir = path.join(root, "data");
  const legacyState = path.join(legacyRoot, ".remote-debug");
  const legacyInstance = path.join(legacyState, "instances", "default");
  const legacyAuditDir = path.join(legacyRoot, "agent", "audit");
  const targetState = path.join(dataDir, ".remote-debug");

  await fs.mkdir(legacyInstance, { recursive: true });
  await fs.mkdir(legacyAuditDir, { recursive: true });
  await fs.mkdir(targetState, { recursive: true });
  await fs.writeFile(path.join(legacyRoot, ".env"), "REMOTE_DEBUG_HOST=legacy\n");
  await fs.writeFile(path.join(legacyState, "instances.json"), '{"legacy":true}\n');
  await fs.writeFile(path.join(legacyState, "command-review.json"), '{"version":1}\n');
  await fs.writeFile(path.join(legacyInstance, "memory.json"), '{"memory":"legacy"}\n');
  await fs.writeFile(path.join(legacyInstance, "audit.jsonl"), '{"audit":"legacy"}\n');
  await fs.writeFile(
    path.join(legacyAuditDir, "remote-debug-agent.jsonl"),
    '{"audit":"manager"}\n',
  );
  await fs.writeFile(path.join(legacyState, "manager-runtime.json"), '{"pid":123}\n');
  await fs.writeFile(path.join(legacyState, "agent-start.lock"), '{"pid":123}\n');
  await fs.writeFile(path.join(targetState, "instances.json"), '{"target":true}\n');

  const result = migrateLegacyData({ legacyRoot, dataDir, env: {} });

  assert.equal(
    await fs.readFile(path.join(dataDir, "config.env"), "utf8"),
    "REMOTE_DEBUG_HOST=legacy\n",
  );
  assert.equal(
    await fs.readFile(path.join(targetState, "instances.json"), "utf8"),
    '{"target":true}\n',
  );
  assert.equal(
    await fs.readFile(path.join(targetState, "command-review.json"), "utf8"),
    '{"version":1}\n',
  );
  assert.equal(
    await fs.readFile(path.join(targetState, "instances", "default", "memory.json"), "utf8"),
    '{"memory":"legacy"}\n',
  );
  assert.equal(
    await fs.readFile(path.join(targetState, "instances", "default", "audit.jsonl"), "utf8"),
    '{"audit":"legacy"}\n',
  );
  assert.equal(
    await fs.readFile(path.join(targetState, "audit", "remote-debug-agent.jsonl"), "utf8"),
    '{"audit":"manager"}\n',
  );
  await assert.rejects(fs.access(path.join(targetState, "manager-runtime.json")));
  await assert.rejects(fs.access(path.join(targetState, "agent-start.lock")));
  assert.ok(result.skipped.includes(path.join(targetState, "instances.json")));
  assert.equal(await fs.access(path.join(legacyRoot, ".env")), undefined);
});

test("legacy project-root mode migrates .env to config.env in place", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-in-place-"));
  await fs.writeFile(path.join(root, ".env"), "REMOTE_DEBUG_HOST=in-place\n");

  migrateLegacyData({ legacyRoot: root, dataDir: root, env: {} });

  assert.equal(
    await fs.readFile(path.join(root, "config.env"), "utf8"),
    "REMOTE_DEBUG_HOST=in-place\n",
  );
});

test("bundled runtime manifest is readable from the plugin root", async () => {
  const pluginRoot = path.resolve(import.meta.dirname, "..");
  const { manifest } = readRuntimeManifest(pluginRoot);
  const pluginManifest = JSON.parse(
    await fs.readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );

  assert.equal(manifest.pluginVersion, pluginManifest.version);
  assert.match(manifest.runtimeId, new RegExp(`^${pluginManifest.version.split("+", 1)[0]}:[a-f0-9]{64}$`));
  assert.equal(manifest.server, "server.cjs");
  assert.equal(manifest.worker, "worker-entry.cjs");
});
