import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import localAuth from "../../local-auth.cjs";

// A fresh authenticated loopback Manager stub and real MCP process. The supplied
// handler owns its isolated database/runtime; this cannot load saved instances.
export async function localMcp(t, { instance, handler, framing = "json-line" }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rda-privacy-mcp-"));
  const token = localAuth.ensureAuthToken(localAuth.resolveAuthFile(root));
  const requests = [], previews = [], wire = [], diagnostics = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ name: "remote-debug-agent", apiVersion: 2, localAuthentication: true,
      authProof: localAuth.healthProof(token, req.headers["x-remote-debug-challenge"], `http://${req.headers.host}`) }));
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.url === "/status") return res.end(JSON.stringify({ ok: true, mode: "manager", apiVersion: 2, name: "remote-debug-agent",
      capabilities: { persistentSsh: true, operationDeadlines: true, cancellation: true, structuredHealth: true, localAuthentication: true } }));
    if (req.url === "/api/instances") return res.end(JSON.stringify({ ok: true, defaultInstanceId: instance.id, instances: [instance] }));
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (req.url === "/api/output-preview/records") { previews.push(input); return res.end('{"ok":true}'); }
    if (!req.url.startsWith("/mongodb/")) return res.end('{"ok":true}');
    requests.push({ path: req.url, input });
    res.setHeader("X-Remote-Debug-Instance-Id", instance.id);
    try { res.end(JSON.stringify({ ok: true, instanceId: instance.id, ...await handler(req.url, input) })); }
    catch (error) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: { code: error.code || "FIXTURE_ERROR", message: error.message } })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../mcp-server.js")], {
    env: { ...process.env, REMOTE_DEBUG_DATA_DIR: root, REMOTE_DEBUG_PROJECT_ROOT: "", REMOTE_DEBUG_INSTANCE_REGISTRY: "",
      REMOTE_DEBUG_ENV_PATH: path.join(root, "config.env"), REMOTE_DEBUG_AUTH_FILE: localAuth.resolveAuthFile(root),
      REMOTE_DEBUG_AGENT_URL: `http://127.0.0.1:${server.address().port}` }, stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [], waiters = []; let buffer = Buffer.alloc(0), id = 0;
  child.stderr.on("data", (chunk) => diagnostics.push(chunk.toString()));
  child.stdout.on("data", (chunk) => {
    wire.push(chunk.toString()); buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      let start = 0, end;
      if (framing === "json-line") { end = buffer.indexOf(10); if (end < 0) return; }
      else {
        const header = buffer.indexOf("\r\n\r\n"); if (header < 0) return;
        start = header + 4; end = start + Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, header).toString())[1]);
        if (buffer.length < end) return;
      }
      const message = JSON.parse(buffer.subarray(start, end)); buffer = buffer.subarray(end + (framing === "json-line" ? 1 : 0));
      const waiter = waiters.shift(); if (waiter) waiter(message); else messages.push(message);
    }
  });
  t.after(async () => {
    const exited = child.exitCode !== null ? Promise.resolve() : once(child, "exit"); child.kill(); await exited;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true });
  });
  async function call(name, args = {}) {
    const requestId = ++id, body = JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } });
    child.stdin.write(framing === "json-line" ? body + "\n" : `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Local MCP response timed out")), 20_000); });
    const message = await Promise.race([messages.length ? messages.shift() : new Promise((resolve) => waiters.push(resolve)), timeout]).finally(() => clearTimeout(timer));
    assert.equal(message.id, requestId);
    return { ...message.result, payload: JSON.parse(message.result.content[0].text) };
  }
  return { call, requests, previews, wire, diagnostics, root };
}
