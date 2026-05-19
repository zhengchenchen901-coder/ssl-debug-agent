import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configFingerprint, loadConfig, loadDotEnv } from "../config.js";

test("loads root .env when agent starts from the agent directory", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-config-"));
  const agentDir = path.join(projectDir, "agent");
  await fs.mkdir(agentDir);
  await fs.writeFile(
    path.join(projectDir, ".env"),
    [
      "REMOTE_DEBUG_HOST=prod.example.com",
      "REMOTE_DEBUG_PORT=2222",
      "REMOTE_DEBUG_USER=app",
      "REMOTE_DEBUG_PRIVATE_KEY_PATH=C:\\Users\\you\\.ssh\\id_ed25519",
      "REMOTE_DEBUG_AGENT_PORT=3001",
    ].join("\n"),
  );

  const config = loadConfig({}, agentDir);

  assert.equal(config.ssh.host, "prod.example.com");
  assert.equal(config.ssh.port, 2222);
  assert.equal(config.ssh.username, "app");
  assert.equal(config.ssh.privateKeyPath, "C:\\Users\\you\\.ssh\\id_ed25519");
  assert.equal(config.agent.port, 3001);
});

test(".env overrides inherited environment for remote debug config", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-config-"));
  await fs.writeFile(path.join(projectDir, ".env"), "REMOTE_DEBUG_HOST=from-file\n");

  const config = loadConfig({ REMOTE_DEBUG_HOST: "from-env" }, projectDir);

  assert.equal(config.ssh.host, "from-file");
});

test("agent .env can override project root .env for local experiments", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-config-"));
  const agentDir = path.join(projectDir, "agent");
  await fs.mkdir(agentDir);
  await fs.writeFile(path.join(projectDir, ".env"), "REMOTE_DEBUG_HOST=from-root\n");
  await fs.writeFile(path.join(agentDir, ".env"), "REMOTE_DEBUG_HOST=from-agent\n");

  assert.equal(loadDotEnv(agentDir).REMOTE_DEBUG_HOST, "from-agent");
});

test("approved command execution is disabled by default and enabled by explicit env flag", () => {
  const disabled = loadConfig({}, "C:\\remote-debug-agent\\agent");
  assert.equal(disabled.approvedCommands.enabled, false);
  assert.equal(disabled.approvedCommands.defaultTimeoutMs, 30_000);
  assert.equal(disabled.approvedCommands.maxTimeoutMs, 300_000);

  const enabled = loadConfig(
    {
      REMOTE_DEBUG_APPROVED_COMMANDS: "1",
      REMOTE_DEBUG_APPROVED_COMMAND_TIMEOUT_MS: "60000",
      REMOTE_DEBUG_APPROVED_COMMAND_MAX_TIMEOUT_MS: "120000",
    },
    "C:\\remote-debug-agent\\agent",
  );
  assert.equal(enabled.approvedCommands.enabled, true);
  assert.equal(enabled.approvedCommands.defaultTimeoutMs, 60_000);
  assert.equal(enabled.approvedCommands.maxTimeoutMs, 120_000);
});

test("runtime config fingerprint changes when sensitive .env-backed settings change", () => {
  const baseEnv = {
    REMOTE_DEBUG_HOST: "prod.example.com",
    REMOTE_DEBUG_PORT: "22",
    REMOTE_DEBUG_USER: "app",
    REMOTE_DEBUG_PRIVATE_KEY_PATH: "C:\\Users\\you\\.ssh\\id_ed25519",
    REMOTE_DEBUG_PRIVATE_KEY_PASSPHRASE: "first",
    REMOTE_DEBUG_AGENT_PORT: "3001",
    REMOTE_DEBUG_AUDIT_LOG: "C:\\logs\\remote-debug.jsonl",
  };
  const cwd = "C:\\remote-debug-agent\\agent";
  const base = configFingerprint(loadConfig(baseEnv, cwd));

  for (const [key, value] of [
    ["REMOTE_DEBUG_PRIVATE_KEY_PATH", "C:\\Users\\you\\.ssh\\other_ed25519"],
    ["REMOTE_DEBUG_PRIVATE_KEY_PASSPHRASE", "second"],
    ["REMOTE_DEBUG_AUDIT_LOG", "C:\\logs\\other-remote-debug.jsonl"],
    ["REMOTE_DEBUG_APPROVED_COMMANDS", "1"],
  ]) {
    assert.notEqual(
      configFingerprint(loadConfig({ ...baseEnv, [key]: value }, cwd)),
      base,
      `${key} should affect the runtime config fingerprint`,
    );
  }
});

