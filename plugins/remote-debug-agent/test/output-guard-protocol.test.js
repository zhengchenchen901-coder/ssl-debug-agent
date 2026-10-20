import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import localAuth from "../local-auth.cjs";

async function fixture(t, framing) {
  const previews = [], delivered = [];
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rda-output-guard-"));
  const authFile = localAuth.resolveAuthFile(dataDir);
  const token = localAuth.ensureAuthToken(authFile);
  const registrySecret = "FIXTURE_LOCAL_REGISTRY_PASSWORD";
  await fs.mkdir(path.join(dataDir, ".remote-debug"), { recursive: true });
  await fs.writeFile(path.join(dataDir, ".remote-debug", "instances.json"), JSON.stringify({ instances: [{ passphrase: registrySecret }] }));
  const upstream = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ name: "remote-debug-agent", apiVersion: 2, localAuthentication: true,
      authProof: localAuth.healthProof(token, req.headers["x-remote-debug-challenge"], `http://${req.headers.host}`) }));
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.url === "/status") return res.end(JSON.stringify({ ok: true, name: "remote-debug-agent", mode: "manager", apiVersion: 2,
      capabilities: { persistentSsh: true, operationDeadlines: true, cancellation: true, structuredHealth: true, localAuthentication: true } }));
    if (req.url === "/api/instances") return res.end(JSON.stringify({ ok: true, defaultInstanceId: "fixture",
      instances: [{ id: "fixture", host: "127.0.0.1", mongodb: { database: "fixture" } }] }));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (req.url === "/api/output-preview/records") {
      previews.push(input);
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === "/run") res.setHeader("X-Remote-Debug-Instance-Id", "resolved-fixture");
    if (req.url === "/run" && input.cmd === "failure") {
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: { code: "SSH_TEST_ERROR", message: "password=FIXTURE_ERROR_PASSWORD", cause: "Bearer FIXTURE_ERROR_BEARER" }, raw: "FIXTURE_RAW_ERROR_PAYLOAD" }));
    }
    if (req.url === "/run" && input.cmd === "oversize") return res.end(JSON.stringify({ ok: true, stdout: "FIXTURE_OVERSIZE_SECRET" + "x".repeat(8 * 1024 * 1024) }));
    if (req.url === "/run") return res.end(JSON.stringify({ ok: true, stdout: `正常诊断\n${token}\n${registrySecret}\nENV_FIXTURE_PASSPHRASE\nAuthorization: Bearer FIXTURE_SUCCESS_BEARER\n`, stderr: "", exitCode: 0, timedOut: false, unexpected: "FIXTURE_UNKNOWN_FIELD" }));
    if (req.url === "/read-file") return res.end(JSON.stringify({ ok: true, path: input.path, content: "prefix\n-----BEGIN PRIVATE KEY-----\nFIXTURE_PRIVATE_BODY\n-----END PRIVATE KEY-----\nsuffix", truncated: false }));
    if (req.url === "/logs/query") {
      const text = String.raw`embedded={\"apiKey\":\"FIXTURE_LOG_SECRET\"}`;
      return res.end(JSON.stringify({ ok: true, content: text, records: [{ text, path: "/logs/app.log" }], returnedLines: 1 }));
    }
    if (req.url === "/mongodb/query") return res.end(JSON.stringify({ ok: true, resultCount: 1, data: [{ name: "sample", copied: "FIXTURE_DOC_SECRET", nested: { refreshToken: "FIXTURE_DOC_SECRET" } }] }));
    if (req.url === "/approved-command-drafts/get") return res.end(JSON.stringify({ ok: true, draftId: input.draftId, commandHash: "a".repeat(64), commands: ["ps aux"], status: "pending" }));
    res.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../mcp-server.js")], {
    env: { ...process.env, REMOTE_DEBUG_DATA_DIR: dataDir, REMOTE_DEBUG_PROJECT_ROOT: "", REMOTE_DEBUG_INSTANCE_REGISTRY: "",
      REMOTE_DEBUG_ENV_PATH: path.join(dataDir, "config.env"), REMOTE_DEBUG_AUTH_FILE: authFile,
      REMOTE_DEBUG_AGENT_URL: `http://127.0.0.1:${upstream.address().port}`, REMOTE_DEBUG_PRIVATE_KEY_PASSPHRASE: "ENV_FIXTURE_PASSPHRASE" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const wire = [], diagnostics = [], waiters = [], messages = [];
  let buffer = Buffer.alloc(0);
  child.stderr.on("data", (chunk) => diagnostics.push(chunk));
  child.stdout.on("data", (chunk) => {
    wire.push(chunk);
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      let body;
      if (framing === "json-line") {
        const end = buffer.indexOf(10);
        if (end < 0) return;
        body = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      } else {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const match = /^Content-Length: (\d+)$/m.exec(buffer.subarray(0, headerEnd).toString());
        assert.ok(match);
        const start = headerEnd + 4, end = start + Number(match[1]);
        if (buffer.length < end) return;
        body = buffer.subarray(start, end); buffer = buffer.subarray(end);
      }
      const message = JSON.parse(body.toString());
      delivered.push(body.toString());
      if (waiters.length) waiters.shift()(message); else messages.push(message);
    }
  });
  const read = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiters.push(resolve));
  const send = (message) => {
    const body = JSON.stringify(message);
    child.stdin.write(framing === "json-line" ? body + "\n" : `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  t.after(async () => {
    child.kill();
    await once(child, "exit");
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  let id = 0;
  async function call(name, args = {}) {
    send({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
    const message = await read();
    assert.equal(message.id, id);
    return { ...message.result, payload: JSON.parse(message.result.content[0].text) };
  }
  return { call, send, read, wire, diagnostics, token, previews, delivered, writeRaw: (text) => child.stdin.write(text) };
}

for (const framing of ["json-line", "content-length"]) {
  test(`real MCP ${framing} output guards success, errors, files, logs and documents`, { timeout: 20000 }, async (t) => {
    const f = await fixture(t, framing);
    const run = await f.call("remote_debug_run_command", { cmd: "ps aux" });
    assert.equal(run.payload.exitCode, 0);
    assert.match(run.payload.stdout, /正常诊断/);
    assert.equal(run.payload.unexpected, undefined);
    const error = await f.call("remote_debug_run_command", { cmd: "failure" });
    assert.equal(error.isError, true);
    assert.equal(error.payload.error.code, "SSH_TEST_ERROR");
    const file = await f.call("remote_debug_read_file", { path: "/app/config" });
    assert.match(file.payload.content, /prefix/);
    await f.call("remote_debug_query_logs", { mode: "latest" });
    const docs = await f.call("remote_debug_mongodb_query", { operation: "find" });
    assert.equal(docs.payload.data[0].name, "sample");
    const draft = await f.call("remote_debug_get_command_draft", { draftId: "draft-1" });
    assert.equal(draft.payload.commandHash, "a".repeat(64));
    assert.deepEqual(draft.payload.commands, ["ps aux"]);
    const blocked = await f.call("remote_debug_run_command", { cmd: "oversize" });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.payload.error.code, "OUTPUT_GUARD_BLOCKED");
    f.send({ jsonrpc: "2.0", id: "protocol-error", method: "token=FIXTURE_PROTOCOL_SECRET" });
    assert.equal((await f.read()).error.code, -32601);
    f.send({ jsonrpc: "2.0", id: "tools", method: "tools/list" });
    const tools = (await f.read()).result.tools;
    assert.ok(tools.find((tool) => tool.name === "remote_debug_run_command").inputSchema.properties.cmd);
    const deadline = Date.now() + 5000;
    while (f.previews.length < 7 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.previews.length, 7);
    assert.deepEqual(f.previews.map((event) => event.wireMessage), f.delivered.slice(0, 7));
    assert.equal(f.previews[0].instanceId, "resolved-fixture");
    assert.equal(f.previews[1].instanceId, "resolved-fixture");
    assert.match(f.previews[6].wireMessage, /OUTPUT_GUARD_BLOCKED/);
    assert.doesNotMatch(JSON.stringify(f.previews), /FIXTURE_(?:LOCAL_REGISTRY_PASSWORD|PASSPHRASE|SUCCESS_BEARER|ERROR_PASSWORD|PRIVATE_BODY|DOC_SECRET)/);
    const output = Buffer.concat([...f.wire, ...f.diagnostics]).toString();
    assert.ok(!output.includes(f.token));
    assert.doesNotMatch(output, /FIXTURE_(?:LOCAL_REGISTRY_PASSWORD|PASSPHRASE|SUCCESS_BEARER|UNKNOWN_FIELD|ERROR_PASSWORD|ERROR_BEARER|RAW_ERROR_PAYLOAD|PRIVATE_BODY|LOG_SECRET|DOC_SECRET|OVERSIZE_SECRET|PROTOCOL_SECRET)/);
  });
}

test("malformed JSON cannot expose parser input through stderr", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, "json-line");
  f.send(null);
  assert.equal((await f.read()).error.code, -32600);
  f.writeRaw('{"raw":"FIXTURE_MALFORMED_SECRET",invalid}\n');
  assert.equal((await f.read()).error.code, -32700);
  assert.doesNotMatch(Buffer.concat([...f.wire, ...f.diagnostics]).toString(), /FIXTURE_MALFORMED_SECRET/);
  assert.doesNotMatch(Buffer.concat(f.diagnostics).toString(), /SyntaxError|TypeError/);
});
