import assert from "node:assert/strict";
import test from "node:test";
import { createOutputGuard, REDACTED } from "../output-guard.js";
import { OUTPUT_CONTRACTS } from "../output-contracts.js";

function payload(result) { return JSON.parse(result.content[0].text); }

test("background log output preserves progress and redacts evidence and group messages", () => {
  const guard = createOutputGuard();
  for (const name of ["remote_debug_start_log_query", "remote_debug_get_log_query", "remote_debug_control_log_query"]) {
    const result = payload(guard.toolResult(name, { ok: true, jobId: "job-1", status: "completed", countsAreComplete: true,
      matchedLines: 12, progress: { completedFiles: 2, resources: { peakRssBytes: 64000000 } },
      groups: [{ message: 'password="GROUP_PRIVATE"', count: 12 }],
      records: [{ file: "/var/log/app.log", text: 'token="LOG_PRIVATE"' }],
      scanComplete: true, evidenceComplete: false, evidenceTruncated: true, paginationScope: "retained_evidence",
      fileResults: [{ queryId: "job-1", path: "/var/log/archive.tar.gz", status: "completed", scanComplete: true,
        countsAreComplete: true, matchedLines: 12, source: { inode: 123, size: 2048 },
        warnings: [{ code: "EXAMPLE", message: 'token="RECEIPT_PRIVATE"' }] }],
      limits: { cpuPercent: 20 }, unexpected: "MUST_NOT_LEAVE" }));
    assert.equal(result.jobId, "job-1"); assert.equal(result.matchedLines, 12);
    assert.equal(result.progress.completedFiles, 2);
    assert.equal(result.limits.cpuPercent, 20);
    assert.equal(result.paginationScope, "retained_evidence");
    assert.equal(result.fileResults[0].countsAreComplete, true);
    assert.equal(result.fileResults[0].source.inode, 123);
    assert.doesNotMatch(JSON.stringify(result), /GROUP_PRIVATE|LOG_PRIVATE|RECEIPT_PRIVATE|MUST_NOT_LEAVE/);
  }
});

test("closed output contracts omit unknown metadata, including nested instance fields", () => {
  const guard = createOutputGuard();
  const result = payload(guard.toolResult("remote_debug_list_instances", {
    ok: true, surprise: "SHOULD_NOT_LEAVE", instances: [{ id: "default", unexpected: "NESTED_UNKNOWN", mongodb: { enabled: true, futureField: "PRIVATE_FUTURE" } }],
  }));
  assert.equal(result.instances[0].id, "default");
  assert.equal(result.instances[0].mongodb.enabled, true);
  assert.doesNotMatch(JSON.stringify(result), /SHOULD_NOT_LEAVE|NESTED_UNKNOWN|PRIVATE_FUTURE/);
  assert.equal(result.outputGuard.omittedFields, 3);
  assert.deepEqual(payload(guard.toolResult("unregistered_tool", { ok: true })).error.code, "OUTPUT_GUARD_BLOCKED");
  assert.equal(payload(guard.toolResult("constructor", { ok: true })).error.code, "OUTPUT_GUARD_BLOCKED");
});

test("sensitive fields of every JSON type are masked and sibling copies are removed", () => {
  const guard = createOutputGuard();
  const result = payload(guard.toolResult("remote_debug_mongodb_query", {
    ok: true, data: [{ echo: "DB_FAKE_SECRET", PASSWORD: "DB_FAKE_SECRET", access_token: 123456, nested: { clientSecret: { value: "NESTED_FAKE_SECRET" } }, copied: "NESTED_FAKE_SECRET" }], resultCount: 1,
  }));
  assert.equal(result.resultCount, 1);
  assert.equal(result.data[0].access_token, REDACTED);
  assert.doesNotMatch(JSON.stringify(result), /DB_FAKE_SECRET|NESTED_FAKE_SECRET|123456/);
});

test("credentials are removed from stdout, stderr, keys, repeated log content and encoded JSON", () => {
  const cases = [
    ["token=FAKE_TOKEN_ABC", "FAKE_TOKEN_ABC"],
    ['password="FAKE TRUNCATED SECRET', "FAKE TRUNCATED SECRET"],
    ['password="FAKE PASSWORD SPACE"', "FAKE PASSWORD SPACE"],
    ["tool --api-key 'FAKE_CLI_SECRET'", "FAKE_CLI_SECRET"],
    ["Authorization: Bearer FAKE_BEARER_ABC", "FAKE_BEARER_ABC"],
    ["Basic ZmFrZTpwYXNzd29yZA==", "ZmFrZTpwYXNzd29yZA=="],
    ["Cookie: sid=FAKE_COOKIE_ABC; user=app", "FAKE_COOKIE_ABC"],
    ["mongodb://user:FAKE_URI_ABC@db.internal/app", "FAKE_URI_ABC"],
    ["https://user:FAKE_HTTP_ABC@example.test/path", "FAKE_HTTP_ABC"],
    ["-----BEGIN PRIVATE KEY-----\nFAKE_PEM_BODY\n-----END PRIVATE KEY-----", "FAKE_PEM_BODY"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE_PARTIAL_PEM", "FAKE_PARTIAL_PEM"],
    ['{"password":"FAKE_JSON_SECRET","ok":true}', "FAKE_JSON_SECRET"],
    [String.raw`payload={\"password\":\"FAKE_ESCAPED_SECRET\"}`, "FAKE_ESCAPED_SECRET"],
    [String.raw`{"pass\u0077ord":"FAKE_UNICODE_SECRET"}`, "FAKE_UNICODE_SECRET"],
    ["sk-proj-FAKE_API_KEY_12345678901234567890", "FAKE_API_KEY_12345678901234567890"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2lnbmF0dXJl", "eyJhbGciOiJIUzI1NiJ9"],
  ];
  for (const [text, secret] of cases) {
    const guard = createOutputGuard();
    const result = guard.toolResult("remote_debug_query_logs", { ok: true, content: text, records: [{ text }] });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret), text);
    assert.match(JSON.stringify(result), /REDACTED|OUTPUT_GUARD_BLOCKED/);
  }
  const guard = createOutputGuard();
  const result = guard.toolResult("remote_debug_mongodb_query", { data: [{ "token=KEY_FAKE_SECRET": "safe" }] });
  assert.doesNotMatch(JSON.stringify(result), /KEY_FAKE_SECRET/);
});

test("known secrets and secrets discovered late in log strings mask earlier unlabelled copies", () => {
  const guard = createOutputGuard();
  guard.remember("LOCAL_FAKE_AUTH/+=");
  const result = payload(guard.toolResult("remote_debug_run_command", {
    ok: true, stdout: "LOCAL_FAKE_AUTH/+= " + encodeURIComponent("LOCAL_FAKE_AUTH/+=" ) + " LATE_FAKE_SECRET ESCAPED_LATE_SECRET", stderr: '{"token":"LATE_FAKE_SECRET"}\n' + String.raw`payload={\"password\":\"ESCAPED_LATE_SECRET\"}`,
  }));
  assert.doesNotMatch(JSON.stringify(result), /LOCAL_FAKE_AUTH|LATE_FAKE_SECRET|ESCAPED_LATE_SECRET/);
});

test("diagnostic errors have closed contracts and redact message, cause and approved details", () => {
  const result = payload(createOutputGuard().toolResult("remote_debug_run_command", {
    ok: false, error: { code: "SSH_ERROR", message: "token=ERROR_FAKE_SECRET", cause: "Bearer CAUSE_FAKE_SECRET", stack: "RAW_STACK_SECRET" },
    details: { raw: "RAW_PAYLOAD_SECRET", diagnostic: "RAW_DIAGNOSTIC_SECRET", error: { code: "DB_ERROR", message: "password=DETAIL_FAKE_SECRET" } },
  }, true));
  assert.equal(result.error.code, "SSH_ERROR");
  assert.doesNotMatch(JSON.stringify(result), /ERROR_FAKE_SECRET|CAUSE_FAKE_SECRET|RAW_STACK_SECRET|RAW_PAYLOAD_SECRET|RAW_DIAGNOSTIC_SECRET|DETAIL_FAKE_SECRET/);
});

test("operation IDs, hashes, confirmations, counts and normal diagnostics survive", () => {
  const guard = createOutputGuard();
  const hash = "b".repeat(64);
  const result = payload(guard.toolResult("remote_debug_prepare_sandbox_access", {
    ok: true, setupId: "setup-1", planHash: hash, passwordReset: false,
    confirmation: "确认配置沙盒", requiresConfirmation: true, environment: { deployment: "replicaSet" },
  }));
  assert.equal(result.planHash, hash);
  assert.equal(result.setupId, "setup-1");
  assert.equal(result.passwordReset, false);
  assert.equal(result.confirmation, "确认配置沙盒");
  const draft = payload(guard.toolResult("remote_debug_get_command_draft", { ok: true, commands: ["ps aux"], commandHash: hash, draftId: "draft-1" }));
  assert.deepEqual(draft.commands, ["ps aux"]);
  assert.equal(draft.commandHash, hash);
});

test("limits, malformed shapes, cycles, getters and unsupported values fail closed", () => {
  const cycle = {}; cycle.self = cycle;
  const getter = Object.defineProperty({}, "stdout", { enumerable: true, get() { throw new Error("GETTER_FAKE_SECRET"); } });
  const cases = [
    [createOutputGuard({ maxBytes: 32 }), { stdout: "OVERSIZE_FAKE_SECRET".repeat(20) }],
    [createOutputGuard({ maxNodes: 3 }), { stdout: "NODE_FAKE_SECRET" }],
    [createOutputGuard({ maxDepth: 1 }), { data: [[["DEPTH_FAKE_SECRET"]]] }],
    [createOutputGuard({ budgetMs: -1 }), { stdout: "TIME_FAKE_SECRET" }],
    [createOutputGuard(), cycle], [createOutputGuard(), getter],
    [createOutputGuard(), { stdout: 1n }], [createOutputGuard(), { stdout: { raw: "TYPE_FAKE_SECRET" } }],
  ];
  for (const [guard, raw] of cases) {
    const result = guard.toolResult("remote_debug_run_command", raw);
    assert.equal(result.isError, true);
    assert.equal(payload(result).error.code, "OUTPUT_GUARD_BLOCKED");
    assert.doesNotMatch(JSON.stringify(result), /FAKE_SECRET/);
  }
});

test("final transport sanitizes protocol errors and serializes UTF-8 bytes", () => {
  const guard = createOutputGuard();
  const bytes = guard.serialize({ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "错误 token=PROTOCOL_FAKE_SECRET" } });
  const result = JSON.parse(bytes.toString());
  assert.equal(result.id, 7);
  assert.match(result.error.message, /错误/);
  assert.doesNotMatch(bytes.toString(), /PROTOCOL_FAKE_SECRET/);
  const failed = JSON.parse(createOutputGuard({ maxBytes: 1 }).serialize({ id: 9, result: "secret" }));
  assert.equal(failed.id, 9);
  assert.equal(payload(failed.result).error.code, "OUTPUT_GUARD_BLOCKED");
});

test("each registered tool must have an output contract", async () => {
  const fs = await import("node:fs/promises");
  const source = (await Promise.all(["../mcp-server.js", "../final-results.js"].map((file) => fs.readFile(new URL(file, import.meta.url), "utf8")))).join("\n");
  const names = [...source.matchAll(/(?:name:\s*|\[)"(remote_debug_[a-z_]+)"/g)].map((match) => match[1]);
  for (const name of new Set(names)) assert.ok(Object.hasOwn(OUTPUT_CONTRACTS, name), name);
});

test("unknown media/structured responses are blocked and credential presence flags stay boolean", () => {
  const guard = createOutputGuard();
  for (const result of [
    { content: [{ type: "image", data: "MEDIA_FAKE_SECRET", mimeType: "image/png" }] },
    { content: [{ type: "text", text: '{}' }], structuredContent: { raw: "STRUCTURED_FAKE_SECRET" } },
    { content: [{ type: "text", text: '{"data":"UNCONTRACTED_FAKE_SECRET"}' }] },
    { unexpected: "UNKNOWN_RESULT_FAKE_SECRET" },
  ]) {
    const message = JSON.parse(guard.serialize({ jsonrpc: "2.0", id: "request-1", result }));
    assert.equal(message.id, "request-1");
    assert.equal(payload(message.result).error.code, "OUTPUT_GUARD_BLOCKED");
    assert.doesNotMatch(JSON.stringify(message), /FAKE_SECRET/);
  }
  const tool = guard.toolResult("remote_debug_list_instances", { instances: [{ id: "default", hasPassphrase: true, runtime: { lastError: { code: "SSH_ERROR", message: "disconnected" } }, mongodb: { hasSandboxManagementPassword: false } }] });
  const message = JSON.parse(guard.serialize({ jsonrpc: "2.0", id: 1, result: tool }));
  const instance = payload(message.result).instances[0];
  assert.equal(instance.hasPassphrase, true);
  assert.equal(instance.mongodb.hasSandboxManagementPassword, false);
  assert.equal(instance.runtime.lastError.code, "SSH_ERROR");
});

test("a large normal log stays useful and one response cannot poison subsequent results", () => {
  const guard = createOutputGuard();
  const content = "normal diagnostics line\n".repeat(30_000);
  const result = guard.toolResult("remote_debug_read_log", { content });
  assert.equal(payload(result).content, content);
  const tooManySecrets = Object.fromEntries(Array.from({ length: 2050 }, (_, index) => [`token_${index}_password`, `FAKE_MANY_${index}`]));
  assert.equal(payload(guard.toolResult("remote_debug_mongodb_query", { data: tooManySecrets })).error.code, "OUTPUT_GUARD_BLOCKED");
  assert.equal(payload(guard.toolResult("remote_debug_run_command", { stdout: "ok" })).stdout, "ok");
});

test("known-secret overlaps cannot obscure credential syntax or leak suffixes", () => {
  const guard = createOutputGuard();
  for (const secret of ["PRIVATE", "mongodb", "REDACTED", "OVERLAP", "OVERLAP_LONG_SECRET", "PREFIX[REDACTED]SUFFIX"]) guard.remember(secret);
  const raw = "-----BEGIN PRIVATE KEY-----\nOVERLAP_PEM_BODY\n-----END PRIVATE KEY-----\nmongodb://user:OVERLAP_URI_PASSWORD@host/db\nOVERLAP_LONG_SECRET\nPREFIX[REDACTED]SUFFIX";
  const result = guard.toolResult("remote_debug_run_command", { stdout: raw });
  assert.doesNotMatch(result.content[0].text, /PEM_BODY|URI_PASSWORD|LONG_SECRET|PREFIX|SUFFIX/);
  assert.equal(payload(result).stdout.includes(REDACTED), true);
});

test("service output contracts preserve evidence and omit arbitrary environment or PM2 payloads", () => {
  const guard = createOutputGuard();
  const result = payload(guard.toolResult("remote_debug_start_service", {
    ok: true, instanceId: "test-server", serviceId: "be", profileHash: "a".repeat(64), status: "partial", persisted: false,
    attempted: ["A", "B"], started: ["A"], verified: [{ name: "A", pid: 321, ports: [9999,3333], environmentVerified: true, env: { PASSWORD: "PRIVATE_SERVICE_ENV" } }],
    error: { code: "SERVICE_PROCESS_EXITED", rawPM2: "PRIVATE_PM2_RESPONSE" }, stdout: "PRIVATE_SERVICE_STDOUT",
  }));
  assert.equal(result.serviceId, "be"); assert.equal(result.status, "partial"); assert.equal(result.verified[0].environmentVerified, true);
  assert.deepEqual(result.verified[0].ports, [9999,3333]); assert.equal(result.error.code, "SERVICE_PROCESS_EXITED");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SERVICE_ENV|PRIVATE_PM2_RESPONSE|PRIVATE_SERVICE_STDOUT/);
  const listed = payload(guard.toolResult("remote_debug_list_service_profiles", { ok: true, instances: [{ instanceId: "test-server", profiles: [{
    serviceId: "be", profileHash: "a".repeat(64), profile: { cwd: "/home/github/current", envFiles: ["/home/github/backend-secrets.env"],
      processes: [{ name: "A", ports: [9999], env: { NODE_ENV: "development", PASSWORD: "PRIVATE_CONFIG_SECRET" } }], unexpected: "PRIVATE_UNEXPECTED" },
  }] }] }));
  assert.equal(listed.instances[0].profiles[0].profile.envFiles[0], "/home/github/backend-secrets.env");
  assert.doesNotMatch(JSON.stringify(listed), /PRIVATE_CONFIG_SECRET|PRIVATE_UNEXPECTED/);
});
