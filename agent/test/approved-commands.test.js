import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  APPROVED_COMMAND_CONFIRMATION,
  DEFAULT_APPROVED_COMMAND_TIMEOUT_MS,
  DEFAULT_APPROVED_COMMAND_TTL_MS,
  MAX_APPROVED_COMMAND_LENGTH,
  MAX_APPROVED_COMMAND_TIMEOUT_MS,
  MAX_APPROVED_COMMANDS,
} from "../approved-commands.js";
import { DEFAULT_ALLOWED_PATHS } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const depsInstalled =
  fs.existsSync(path.resolve(here, "..", "node_modules", "express")) &&
  fs.existsSync(path.resolve(here, "..", "node_modules", "ssh2"));

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function makeConfig(logPath, approvedCommands = {}) {
  return {
    agent: { host: "127.0.0.1", port: 0 },
    ssh: {},
    security: {
      allowedPaths: DEFAULT_ALLOWED_PATHS,
      defaultTimeoutMs: 10_000,
      maxTimeoutMs: 30_000,
      defaultReadMaxBytes: 256 * 1024,
      maxCommandOutputBytes: 1024 * 1024,
    },
    approvedCommands: {
      enabled: false,
      ttlMs: DEFAULT_APPROVED_COMMAND_TTL_MS,
      defaultTimeoutMs: DEFAULT_APPROVED_COMMAND_TIMEOUT_MS,
      maxTimeoutMs: MAX_APPROVED_COMMAND_TIMEOUT_MS,
      maxCommandLength: MAX_APPROVED_COMMAND_LENGTH,
      maxCommands: MAX_APPROVED_COMMANDS,
      ...approvedCommands,
    },
    audit: { logPath },
    runtime: { statePath: path.join(path.dirname(logPath), "agent-state.json") },
  };
}

async function postJson(server, route, body) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

async function startApprovedApp({ approvedCommands = {}, runSSH } = {}) {
  const { createApp } = await import("../server.js");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-approved-"));
  const app = createApp({
    config: makeConfig(path.join(dir, "audit.jsonl"), approvedCommands),
    runSSH: runSSH || (async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    })),
  });
  const server = await listen(app);
  return { dir, server };
}

async function prepareDraft(server, commands = ["echo ready"]) {
  return postJson(server, "/approved-command-drafts", {
    purpose: "test command draft",
    commands,
  });
}

test("approved command channel is disabled by default", { skip: !depsInstalled }, async () => {
  let executed = false;
  const { server } = await startApprovedApp({
    runSSH: async () => {
      executed = true;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    },
  });

  try {
    const prepare = await prepareDraft(server);
    assert.equal(prepare.status, 403);
    assert.equal(prepare.body.error.code, "APPROVED_COMMANDS_DISABLED");

    const execute = await postJson(server, "/approved-command-drafts/execute", {
      draftId: "missing",
      commandHash: "missing",
      confirmation: APPROVED_COMMAND_CONFIRMATION,
    });
    assert.equal(execute.status, 403);
    assert.equal(execute.body.error.code, "APPROVED_COMMANDS_DISABLED");
    assert.equal(executed, false);
  } finally {
    await close(server);
  }
});

test("creating and viewing a draft does not execute SSH", { skip: !depsInstalled }, async () => {
  let runCount = 0;
  const commands = ["echo hello | tee /tmp/approved-command-test"];
  const { server } = await startApprovedApp({
    approvedCommands: { enabled: true },
    runSSH: async () => {
      runCount += 1;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    },
  });

  try {
    const prepare = await prepareDraft(server, commands);
    assert.equal(prepare.status, 200);
    assert.equal(prepare.body.commandBlock, commands[0]);
    assert.equal(typeof prepare.body.commandHash, "string");
    assert.equal(runCount, 0);

    const view = await postJson(server, "/approved-command-drafts/get", {
      draftId: prepare.body.draftId,
    });
    assert.equal(view.status, 200);
    assert.equal(view.body.commandHash, prepare.body.commandHash);
    assert.deepEqual(view.body.commands, commands);
    assert.equal(runCount, 0);
  } finally {
    await close(server);
  }
});

test("execution requires matching hash and exact confirmation phrase", { skip: !depsInstalled }, async () => {
  let executedCommand = "";
  const commands = ["printf ok | tee /tmp/approved-command-test"];
  const { server } = await startApprovedApp({
    approvedCommands: { enabled: true },
    runSSH: async (command) => {
      executedCommand = command;
      return { stdout: `ran:${command}`, stderr: "", exitCode: 0, timedOut: false };
    },
  });

  try {
    const prepare = await prepareDraft(server, commands);
    assert.equal(prepare.status, 200);

    const wrongHash = await postJson(server, "/approved-command-drafts/execute", {
      draftId: prepare.body.draftId,
      commandHash: "wrong",
      confirmation: APPROVED_COMMAND_CONFIRMATION,
    });
    assert.equal(wrongHash.status, 400);
    assert.equal(wrongHash.body.error.code, "APPROVED_COMMAND_HASH_MISMATCH");

    const wrongConfirmation = await postJson(server, "/approved-command-drafts/execute", {
      draftId: prepare.body.draftId,
      commandHash: prepare.body.commandHash,
      confirmation: "只生成命令，不执行",
    });
    assert.equal(wrongConfirmation.status, 400);
    assert.equal(wrongConfirmation.body.error.code, "APPROVED_COMMAND_CONFIRMATION_REQUIRED");

    const execute = await postJson(server, "/approved-command-drafts/execute", {
      draftId: prepare.body.draftId,
      commandHash: prepare.body.commandHash,
      confirmation: APPROVED_COMMAND_CONFIRMATION,
    });
    assert.equal(execute.status, 200);
    assert.equal(execute.body.commandsOk, true);
    assert.equal(executedCommand, commands[0]);

    const repeat = await postJson(server, "/approved-command-drafts/execute", {
      draftId: prepare.body.draftId,
      commandHash: prepare.body.commandHash,
      confirmation: APPROVED_COMMAND_CONFIRMATION,
    });
    assert.equal(repeat.status, 409);
    assert.equal(repeat.body.error.code, "APPROVED_COMMAND_DRAFT_ALREADY_USED");
  } finally {
    await close(server);
  }
});

test("expired drafts cannot be executed", { skip: !depsInstalled }, async () => {
  const { server } = await startApprovedApp({
    approvedCommands: { enabled: true, ttlMs: 1 },
  });

  try {
    const prepare = await prepareDraft(server);
    assert.equal(prepare.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const execute = await postJson(server, "/approved-command-drafts/execute", {
      draftId: prepare.body.draftId,
      commandHash: prepare.body.commandHash,
      confirmation: APPROVED_COMMAND_CONFIRMATION,
    });
    assert.equal(execute.status, 409);
    assert.equal(execute.body.error.code, "APPROVED_COMMAND_DRAFT_EXPIRED");
  } finally {
    await close(server);
  }
});

test("non-zero or timed-out commands stop the remaining draft commands", { skip: !depsInstalled }, async () => {
  const executed = [];
  const { server } = await startApprovedApp({
    approvedCommands: { enabled: true },
    runSSH: async (command) => {
      executed.push(command);
      return command.includes("fail")
        ? { stdout: "", stderr: "failed", exitCode: 2, timedOut: false }
        : { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
    },
  });

  try {
    const prepare = await prepareDraft(server, ["echo ok", "echo fail", "echo skipped"]);
    const execute = await postJson(server, "/approved-command-drafts/execute", {
      draftId: prepare.body.draftId,
      commandHash: prepare.body.commandHash,
      confirmation: APPROVED_COMMAND_CONFIRMATION,
    });

    assert.equal(execute.status, 200);
    assert.equal(execute.body.commandsOk, false);
    assert.equal(execute.body.stopped.reason, "non_zero_exit");
    assert.deepEqual(executed, ["echo ok", "echo fail"]);
  } finally {
    await close(server);
  }
});

test("approved command audit entries redact obvious passwords", { skip: !depsInstalled }, async () => {
  const command =
    "mongodump --uri=mongodb://readonly:s3cr3t@example.com/db --password pwvalue > /tmp/dump.archive";
  const { dir, server } = await startApprovedApp({
    approvedCommands: { enabled: true },
    runSSH: async () => ({ stdout: "done", stderr: "", exitCode: 0, timedOut: false }),
  });

  try {
    const prepare = await prepareDraft(server, [command]);
    const execute = await postJson(server, "/approved-command-drafts/execute", {
      draftId: prepare.body.draftId,
      commandHash: prepare.body.commandHash,
      confirmation: APPROVED_COMMAND_CONFIRMATION,
    });
    assert.equal(execute.status, 200);

    const auditLog = await fsPromises.readFile(path.join(dir, "audit.jsonl"), "utf8");
    assert.doesNotMatch(auditLog, /s3cr3t/);
    assert.doesNotMatch(auditLog, /pwvalue/);
    assert.match(auditLog, /\[REDACTED\]/);
  } finally {
    await close(server);
  }
});
