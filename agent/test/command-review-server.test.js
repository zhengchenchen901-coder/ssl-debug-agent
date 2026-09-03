import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_ALLOWED_PATHS } from "../config.js";
import { createManagerApp } from "../server.js";

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

async function postJson(server, route, body) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function reviewConfig({ approvedEnabled = true, autoExecuteEnabled = true } = {}) {
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
      enabled: approvedEnabled,
      executionTimeoutMs: 300_000,
      maxExecutionTimeoutMs: 900_000,
    },
    commandReview: {
      status: "ready",
      configPath: "C:\\review\\command-review.json",
      codexConfigPath: "C:\\Users\\test\\.codex\\config.toml",
      source: "file",
      autoExecuteEnabled,
      reviewTimeoutMs: 1_000,
      maxRetries: 1,
      codex: {
        codexHome: "C:\\Users\\test\\.codex",
        command: "codex",
        provider: "OpenAI",
        name: "OpenAI",
        model: "review-model",
        baseUrl: "https://api.example.test/v1",
      },
    },
  };
}

function makeRegistry(instance) {
  return {
    registry: { defaultInstanceId: instance.id },
    resolveId(instanceId) {
      if (instanceId && instanceId !== instance.id) {
        const error = new Error(`instance not found: ${instanceId}`);
        error.code = "INSTANCE_NOT_FOUND";
        error.statusCode = 404;
        throw error;
      }
      return instance.id;
    },
    getInternal(instanceId) {
      return instanceId === instance.id ? instance : undefined;
    },
    managerConfig() {
      return {
        host: "127.0.0.1",
        workerPortRange: { start: 4400, end: 4499 },
        healthIntervalMs: 15_000,
        startTimeoutMs: 10_000,
        stopTimeoutMs: 5_000,
        sshNetwork: {},
      };
    },
    list() {
      return [instance];
    },
  };
}

function makeWorkerManager(draft, state) {
  return {
    publicInstances: () => [],
    runtimeFor: () => ({ status: "running", workerPort: 4400 }),
    shutdownAll: async () => {},
    callInstance: async (instanceId, pathName, payload) => {
      state.calls.push({ instanceId, pathName, payload });
      if (pathName === "/approved-command-drafts/get") {
        return { ...draft };
      }
      if (pathName === "/approved-command-drafts/execute") {
        state.executed = true;
        return {
          ok: true,
          draftId: payload.draftId,
          commandHash: payload.commandHash,
          status: "executed",
          commandsOk: true,
          results: draft.commands.map((command, commandIndex) => ({
            command,
            commandIndex,
            stdout: "ok",
            stderr: "",
            exitCode: 0,
            timedOut: false,
          })),
          stopped: undefined,
        };
      }
      throw new Error(`unexpected worker route: ${pathName}`);
    },
  };
}

async function startReviewServer({
  commands = ["netstat -tlnp"],
  approvedEnabled = true,
  autoExecuteEnabled = true,
  modelReview,
  runCodexReview,
} = {}) {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "remote-debug-command-review-http-"));
  const instance = {
    id: "prod",
    approvedCommands: { enabled: approvedEnabled },
  };
  const state = { calls: [], executed: false };
  const draft = {
    ok: true,
    draftId: "draft-1",
    purpose: "inspect the service",
    commands,
    commandBlock: commands.join("\n\n"),
    commandHash: "hash-1",
    commandCount: commands.length,
    status: "pending",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const app = createManagerApp({
    cwd: dir,
    config: {
      ...reviewConfig({ approvedEnabled, autoExecuteEnabled }),
      audit: { logPath: path.join(dir, "audit.jsonl") },
      runtime: { statePath: path.join(dir, "runtime.json"), runtimeId: "test" },
    },
    registry: makeRegistry(instance),
    workerManager: makeWorkerManager(draft, state),
    lifecycle: { publicStatus: () => ({ lifetime: "manual" }), stop: () => {} },
    runCodexReview: runCodexReview || (async () => ({
      review: modelReview || {
          decision: "approve",
          isReadOnly: true,
          riskLevel: "low",
          summary: "The diagnostic is safe.",
          violations: [],
        },
        attempts: 1,
        durationMs: 5,
      })),
  });
  const server = await listen(app);
  return { dir, server, state };
}

test("manager auto-review executes only after static and model approval", async () => {
  const { dir, server, state } = await startReviewServer();
  try {
    const result = await postJson(server, "/approved-command-drafts/review", {
      instanceId: "prod",
      draftId: "draft-1",
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.decision, "auto_executed");
    assert.equal(result.body.review.model.decision, "approve");
    assert.equal(state.executed, true);
    const executeCall = state.calls.find((call) => call.pathName.endsWith("/execute"));
    assert.equal(executeCall.instanceId, "prod");
    assert.equal(executeCall.payload.confirmation, "使用命令");
    assert.equal(executeCall.payload.draftId, "draft-1");

    const audit = await fsPromises.readFile(path.join(dir, "audit.jsonl"), "utf8");
    assert.match(audit, /"decision":"auto_executed"/);
    assert.doesNotMatch(audit, /netstat -tlnp/);
  } finally {
    await close(server);
  }
});

test("static violations return the complete draft and skip the model and worker execution", async () => {
  const { server, state } = await startReviewServer({
    commands: ["rm -rf /"],
    modelReview: {
      decision: "approve",
      isReadOnly: true,
      riskLevel: "low",
      summary: "should never be used",
      violations: [],
    },
  });
  try {
    const result = await postJson(server, "/approved-command-drafts/review", {
      instanceId: "prod",
      draftId: "draft-1",
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.decision, "manual_review");
    assert.deepEqual(result.body.commands, ["rm -rf /"]);
    assert.equal(result.body.review.model, undefined);
    assert.equal(result.body.review.violations[0].code, "COMMAND_DENIED");
    assert.equal(state.executed, false);
    assert.equal(state.calls.some((call) => call.pathName.endsWith("/execute")), false);
  } finally {
    await close(server);
  }
});

test("model rejection is returned as human review with model violation points", async () => {
  const { server, state } = await startReviewServer({
    modelReview: {
      decision: "manual_review",
      isReadOnly: true,
      riskLevel: "medium",
      summary: "The requested purpose is too broad.",
      violations: [
        {
          commandIndex: 0,
          code: "BROAD_SCOPE",
          severity: "medium",
          reason: "The command scope is broader than the stated purpose.",
        },
      ],
    },
  });
  try {
    const result = await postJson(server, "/approved-command-drafts/review", {
      instanceId: "prod",
      draftId: "draft-1",
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.decision, "manual_review");
    assert.equal(result.body.review.violations[0].code, "BROAD_SCOPE");
    assert.equal(result.body.review.model.summary, "The requested purpose is too broad.");
    assert.equal(state.executed, false);
  } finally {
    await close(server);
  }
});

test("model failure is converted to human review without executing the draft", async () => {
  const modelError = new Error("Codex output was not valid JSON");
  modelError.code = "COMMAND_REVIEW_MODEL_OUTPUT_INVALID";
  modelError.details = { attempts: 2, durationMs: 900 };
  const { server, state } = await startReviewServer({
    runCodexReview: async () => {
      throw modelError;
    },
  });
  try {
    const result = await postJson(server, "/approved-command-drafts/review", {
      instanceId: "prod",
      draftId: "draft-1",
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.decision, "manual_review");
    assert.equal(result.body.review.reason, "model_review_unavailable");
    assert.equal(result.body.review.violations[0].code, "COMMAND_REVIEW_MODEL_OUTPUT_INVALID");
    assert.equal(result.body.review.model.attempts, 2);
    assert.equal(state.executed, false);
  } finally {
    await close(server);
  }
});

test("manager limits command-draft model reviews to one in-flight request", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const { server } = await startReviewServer({
    runCodexReview: async () => {
      await held;
      return {
        review: {
          decision: "manual_review",
          isReadOnly: true,
          riskLevel: "medium",
          summary: "human review",
          violations: [{
            commandIndex: 0,
            code: "NEEDS_HUMAN",
            severity: "medium",
            reason: "human review is required",
          }],
        },
        attempts: 1,
        durationMs: 1,
      };
    },
  });
  try {
    const first = postJson(server, "/approved-command-drafts/review", {
      instanceId: "prod",
      draftId: "draft-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await postJson(server, "/approved-command-drafts/review", {
      instanceId: "prod",
      draftId: "draft-1",
    });
    assert.equal(second.status, 429);
    assert.equal(second.body.error.code, "COMMAND_REVIEW_BUSY");
    release();
    const firstResult = await first;
    assert.equal(firstResult.status, 200);
  } finally {
    release();
    await close(server);
  }
});

test("both approval flags are required before the model can be called", async () => {
  const { server, state } = await startReviewServer({ autoExecuteEnabled: false });
  try {
    const result = await postJson(server, "/approved-command-drafts/review", {
      instanceId: "prod",
      draftId: "draft-1",
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.decision, "manual_review");
    assert.equal(result.body.review.violations[0].code, "COMMAND_REVIEW_AUTO_EXECUTION_DISABLED");
    assert.equal(state.executed, false);
    assert.equal(state.calls.some((call) => call.pathName.endsWith("/execute")), false);
  } finally {
    await close(server);
  }
});

test("an instance with approved commands disabled cannot enter automatic review", async () => {
  const { server, state } = await startReviewServer({ approvedEnabled: false });
  try {
    const result = await postJson(server, "/approved-command-drafts/review", {
      instanceId: "prod",
      draftId: "draft-1",
    });

    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, "APPROVED_COMMANDS_DISABLED");
    assert.equal(state.calls.length, 0);
  } finally {
    await close(server);
  }
});
