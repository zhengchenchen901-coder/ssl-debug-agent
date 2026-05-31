import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installWorkerShutdownHandlers } from "../worker-entry.js";

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

