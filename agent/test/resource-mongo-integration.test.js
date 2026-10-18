import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { RemoteResourceManager } from "../remote-resource-manager.js";
import { WorkerResourceClient } from "../worker-resource-client.js";
import { MongoBulkJobRunner } from "../mongodb-bulk.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) { const deadline = Date.now() + 10000; while (Date.now() < deadline) { const value = check(); if (value) return value; await delay(10); } throw new Error("database resource integration timeout"); }

test("manual priority drains approved database waves before moving resources and preserves the plan", async (t) => {
  const proc = new EventEmitter(), resources = new RemoteResourceManager({ instance: () => ({ host: "fixture", port: 22 }) });
  const sendBack = (frame) => setImmediate(() => proc.emit("message", frame));
  const client = new WorkerResourceClient({ instanceId: "fixture", processObject: proc, send: (frame) => setImmediate(() => {
    if (frame.type === "resource_hello") resources.attach("fixture", frame.epoch, sendBack);
    if (frame.type === "resource_task") resources.report("fixture", frame.epoch, frame.task);
    if (frame.type === "resource_sync") { resources.rebalance(); sendBack({ type: "resource_sync_ack", epoch: frame.epoch, requestId: frame.requestId }); }
  }) });
  t.after(() => { client.close(); resources.close(); });
  await until(() => resources.workers.has("fixture"));
  resources.sample("fixture", client.epoch, { cpuCores: 4, cpuBusyRatio: 0.1, memoryAvailableBytes: 6 * 1024 ** 3, totalMemoryBytes: 8 * 1024 ** 3, load1: 0.1, ioWaitRatio: 0 });
  const calls = [], pending = new Map(), executed = new Set(), verified = new Set();
  const planHash = "a".repeat(64), jobId = "resource-wave-fixture";
  const runner = new MongoBulkJobRunner({ resourceClient: client, config: { bulkEnabled: true, writeEnabled: true,
    configPath: "/srv/app/config.json", driverPath: "/srv/app/node_modules/mongodb", configProfile: "fixture", uriKey: "url",
    database: "fixture", allowedDatabases: ["fixture"], allowedCollections: ["members"], bulkRoot: "/var/lib/remote-debug-agent/bulk-jobs", bulkBatchDocuments: 500, bulkConcurrency: 2 },
    runMongoBulk: async (request) => {
      calls.push(request);
      if (request.action === "get") return { jobId, status: "running", desiredState: "running", batchCount: 4,
        nextBatch: executed.size, nextVerifyBatch: verified.size, committedBatchCount: executed.size, verifiedBatchCount: verified.size };
      if (request.action === "executeBatch") {
        await new Promise((resolve) => pending.set(request.batchIndex, resolve)); executed.add(request.batchIndex);
      }
      if (request.action === "verifyBatch") verified.add(request.batchIndex);
      return { jobId, status: request.action === "finish" ? "completed" : "running" };
    } });
  await runner.start({ jobId, planHash });
  await until(() => pending.has(0) && pending.has(1));
  const dbTaskId = runner.active.resourceTaskId;
  const pinned = resources.tasks.get(dbTaskId).budget.cpuMilliCores;
  const logTaskId = client.register({ type: "log_search", label: "competing log", requested: { cpuMilliCores: 200 } });
  client.update(logTaskId, { status: "running" });
  await until(() => resources.tasks.has(logTaskId));
  resources.setMode("fixture", logTaskId, "manual_max", 1);
  await until(() => resources.tasks.get(logTaskId).budget?.cpuMilliCores === 750 - pinned);
  assert.equal(resources.tasks.get(dbTaskId).budget.cpuMilliCores, pinned);
  pending.get(0)(); pending.get(1)();
  await until(() => resources.tasks.get(logTaskId).budget?.cpuMilliCores === 750);
  await delay(100);
  assert.equal(calls.filter((r) => r.action === "executeBatch").length, 2);
  resources.setMode("fixture", logTaskId, "auto", resources.tasks.get(logTaskId).modeRevision);
  await until(() => pending.has(2) && pending.has(3)); pending.get(2)(); pending.get(3)();
  await until(() => client.registry.tasks.get(dbTaskId).status === "completed");
  assert.deepEqual([...executed], [0, 1, 2, 3]); assert.deepEqual([...verified].sort(), [0, 1, 2, 3]);
  assert.equal(calls.filter((r) => r.action === "finish").length, 1);
  assert.ok(calls.filter((r) => ["dispatch", "executeBatch", "verifyBatch", "finish"].includes(r.action)).every((r) => r.planHash === planHash && r.jobId === jobId));
});
