import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, loadDotEnv } from "../config.js";

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

test("real environment values override .env defaults", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-config-"));
  await fs.writeFile(path.join(projectDir, ".env"), "REMOTE_DEBUG_HOST=from-file\n");

  const config = loadConfig({ REMOTE_DEBUG_HOST: "from-env" }, projectDir);

  assert.equal(config.ssh.host, "from-env");
});

test("agent .env can override project root .env for local experiments", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-config-"));
  const agentDir = path.join(projectDir, "agent");
  await fs.mkdir(agentDir);
  await fs.writeFile(path.join(projectDir, ".env"), "REMOTE_DEBUG_HOST=from-root\n");
  await fs.writeFile(path.join(agentDir, ".env"), "REMOTE_DEBUG_HOST=from-agent\n");

  assert.equal(loadDotEnv(agentDir).REMOTE_DEBUG_HOST, "from-agent");
});

