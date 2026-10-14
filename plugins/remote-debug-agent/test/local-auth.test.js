import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import localAuth from "../local-auth.cjs";

test("health proofs cannot be replayed for another challenge or listener", () => {
  const token = "a".repeat(64), nonce = "b".repeat(64), origin = "http://127.0.0.1:4343";
  const health = { authProof: localAuth.healthProof(token, nonce, origin) };
  assert.doesNotThrow(() => localAuth.verifyHealthProof(token, nonce, origin, health));
  assert.throws(() => localAuth.verifyHealthProof(token, "c".repeat(64), origin, health), { code: "LOCAL_AUTH_INVALID" });
  assert.throws(() => localAuth.verifyHealthProof(token, nonce, "http://127.0.0.1:4344", health), { code: "LOCAL_AUTH_INVALID" });
});

async function callMcp(t, handler, prepare) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rda-mcp-auth-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const authFile = localAuth.resolveAuthFile(dataDir);
  const token = localAuth.ensureAuthToken(authFile);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    handler(req, res, token);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  if (prepare) await prepare(authFile);
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../mcp-server.js")], {
    env: { ...process.env, REMOTE_DEBUG_DATA_DIR: dataDir, REMOTE_DEBUG_ENV_PATH: path.join(dataDir, "config.env"), REMOTE_DEBUG_PROJECT_ROOT: "", REMOTE_DEBUG_AUTH_FILE: authFile, REMOTE_DEBUG_AGENT_DIR: "", REMOTE_DEBUG_AGENT_URL: `http://127.0.0.1:${server.address().port}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP auth fixture timed out")); }, 15000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 2) { clearTimeout(timer); resolve(message); }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "remote_debug_list_instances", arguments: {} } }) + "\n");
  });
  assert.ok(!stderr.includes(token), "credentials must not be logged");
  return { result, requests, authFile };
}

test("MCP preserves authentication errors and does not restart or fall back", async (t) => {
  const { result, requests } = await callMcp(t, (req, res, token) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ name: "remote-debug-agent", localAuthentication: true, authProof: localAuth.healthProof(token, req.headers["x-remote-debug-challenge"], `http://${req.headers.host}`) }));
    res.writeHead(401); res.end(JSON.stringify({ ok: false, error: { code: "LOCAL_AUTH_INVALID", message: "invalid credential" } }));
  });
  assert.equal(result.result.isError, true);
  assert.match(JSON.stringify(result), /LOCAL_AUTH_INVALID/);
  assert.ok(requests.every((url) => ["/health", "/status"].includes(url)));
});

test("MCP refuses legacy unauthenticated Managers before sending credentials", async (t) => {
  const { result, requests } = await callMcp(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ name: "remote-debug-agent", apiVersion: 2 }));
  });
  assert.match(JSON.stringify(result), /AGENT_AUTH_UPGRADE_REQUIRED/);
  assert.deepEqual(requests, ["/health"]);
});

test("explicit Agent credentials are read-only and never regenerated when absent", async (t) => {
  const { result, requests, authFile } = await callMcp(t, () => assert.fail("must not connect without credentials"), (file) => fs.unlink(file));
  assert.match(JSON.stringify(result), /LOCAL_AUTH_STORAGE_UNSAFE/);
  assert.deepEqual(requests, []);
  await assert.rejects(fs.access(authFile));
});

test("MCP rejects HTTP redirects without forwarding credentials", async (t) => {
  const { result, requests } = await callMcp(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(302, { Location: "/credential-capture" }); res.end();
  });
  assert.equal(result.result.isError, true);
  assert.deepEqual(requests, ["/health"]);
});

test("a process occupying the Agent port cannot obtain the bearer credential by claiming to be an Agent", async (t) => {
  const { result, requests } = await callMcp(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ name: "remote-debug-agent", localAuthentication: true, authProof: "0".repeat(64) }));
  });
  assert.match(JSON.stringify(result), /LOCAL_AUTH_INVALID/);
  assert.deepEqual(requests, ["/health"]);
});
