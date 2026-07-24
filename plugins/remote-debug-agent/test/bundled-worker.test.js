import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForExit(child, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error(`bundled worker did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("bundled worker does not start the manager entrypoint", async () => {
  const pluginRoot = path.resolve(import.meta.dirname, "..");
  const workerPath = path.join(pluginRoot, "runtime", "agent", "worker-entry.cjs");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-bundled-worker-"));
  const runtimeStatePath = path.join(tempRoot, "agent-state.json");
  const port = await getFreePort();
  const child = spawn(process.execPath, [workerPath], {
    cwd: tempRoot,
    env: {
      ...process.env,
      REMOTE_DEBUG_WORKER: "1",
      REMOTE_DEBUG_AGENT_LIFETIME: "manual",
      REMOTE_DEBUG_AGENT_PORT: String(port),
      REMOTE_DEBUG_HOST: "127.0.0.1",
      REMOTE_DEBUG_PORT: "1",
      REMOTE_DEBUG_USER: "test",
      REMOTE_DEBUG_PRIVATE_KEY_PATH: path.join(tempRoot, "missing-key"),
      REMOTE_DEBUG_RUNTIME_STATE_PATH: runtimeStatePath,
      REMOTE_DEBUG_MEMORY_INIT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const [code, signal] = await waitForExit(child, 5000);

  assert.equal(code, 1);
  assert.equal(signal, null);
  await assert.rejects(() => fs.access(runtimeStatePath), /ENOENT/);
});
