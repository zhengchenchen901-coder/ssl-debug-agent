import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installWorkerShutdownHandlers, runMemoryInit, scheduleMemoryInit } from "../worker-entry.js";

test("worker shuts down when manager IPC disconnects", () => {
  const processObject = new EventEmitter();
  const calls = [];

  installWorkerShutdownHandlers((reason, reportStopped) => {
    calls.push({ reason, reportStopped });
  }, processObject);

  processObject.emit("disconnect");

  assert.deepEqual(calls, [
    {
      reason: "manager-disconnect",
      reportStopped: undefined,
    },
  ]);
});

test("worker memory init reports partial redacted discovery", async () => {
  const messages = [];
  const commands = [];
  const config = {
    ssh: {
      host: "prod.example.com",
      port: 22,
      username: "app",
    },
    security: {
      allowedPaths: ["/etc/nginx", "/var/log"],
    },
  };

  const memory = await runMemoryInit(config, {
    env: { REMOTE_DEBUG_MEMORY_INIT: "1" },
    send: (message) => messages.push(message),
    discovery: {
      runSSH: async (cmd) => {
        commands.push(cmd);
        if (cmd === "free -m") {
          throw new Error("free unavailable");
        }
        if (cmd === "mongosh --version") {
          return {
            stdout: "mongodb://user:password@db.example.com/admin",
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        }
        return {
          stdout: `${cmd} output`,
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      },
      listRemoteDir: async (remotePath) => ({
        path: remotePath,
        entries: [{ name: "nginx.conf", size: 10, modifyTime: 1, permissions: 33188 }],
      }),
    },
  });

  assert.ok(commands.includes("free -m"));
  assert.equal(memory.status, "partial");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "memory:update");
  assert.equal(messages[0].ok, true);
  assert.equal(messages[0].memory.status, "partial");
  assert.doesNotMatch(JSON.stringify(messages[0]), /password/);
  assert.match(JSON.stringify(messages[0]), /\[redacted]/);
});

test("worker memory init reports fatal discovery failures without throwing", async () => {
  const messages = [];
  const memory = await runMemoryInit({}, {
    env: { REMOTE_DEBUG_MEMORY_INIT: "1" },
    send: (message) => messages.push(message),
    discoverMemory: async () => {
      throw new Error("fatal discovery failure");
    },
  });

  assert.equal(memory.status, "failed");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "memory:update");
  assert.equal(messages[0].ok, false);
  assert.equal(messages[0].error.message, "fatal discovery failure");
});

test("worker memory init skips when disabled", async () => {
  const messages = [];
  const memory = await runMemoryInit({}, {
    env: { REMOTE_DEBUG_MEMORY_INIT: "0" },
    send: (message) => messages.push(message),
  });

  assert.equal(memory, null);
  assert.deepEqual(messages, []);
});

test("worker schedules memory init after ready without blocking", async () => {
  const events = [];
  let scheduled;

  events.push("ready");
  scheduleMemoryInit({}, {
    schedule: (callback) => {
      events.push("scheduled");
      scheduled = callback;
    },
    run: async () => {
      events.push("memory");
    },
  });

  assert.deepEqual(events, ["ready", "scheduled"]);
  await scheduled();
  assert.deepEqual(events, ["ready", "scheduled", "memory"]);
});

test("scheduled worker memory init reports unexpected failures", async () => {
  const messages = [];
  let scheduled;

  scheduleMemoryInit({}, {
    schedule: (callback) => {
      scheduled = callback;
    },
    send: (message) => messages.push(message),
    run: async () => {
      throw new Error("background failure");
    },
  });

  await scheduled();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "memory:update");
  assert.equal(messages[0].ok, false);
  assert.equal(messages[0].error.message, "background failure");
});

