import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { WorkerResourceClient } from "../worker-resource-client.js";
import { RemoteResourceManager } from "../remote-resource-manager.js";
import { LogJobRunner } from "../log-jobs.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, timeout = 20000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = check(); if (value) return value; await sleep(20); } throw new Error("integration timeout"); }

test("real log helpers share a host pool, apply a manual boost and preserve exact completion receipts", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rda-resource-log-")));
  const manager = new RemoteResourceManager({ instance: () => ({ host: "fixture", port: 22 }) }), proc = new EventEmitter();
  const client = new WorkerResourceClient({ instanceId: "test", processObject: proc, send: (m) => setImmediate(() => {
    if (m.type === "resource_hello") manager.attach("test", m.epoch, (f) => setImmediate(() => proc.emit("message", f)));
    if (m.type === "resource_task") manager.report("test", m.epoch, m.task);
  }) });
  const config = { security: { allowedPaths: [dir] }, logs: { projects: { be: { directories: [dir] } } } };
  const children = new Set();
  const runner = new LogJobRunner({ config, resourceClient: client, runSSH: (command, options) => new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", "exec " + command], { env: { ...process.env, PATH: path.dirname(process.execPath) + ":" + process.env.PATH } });
    children.add(child); const cancel = () => child.kill();
    options.operation.signal.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk) => { try { options.onStdoutChunk(chunk); } catch (error) { child.kill(); reject(error); } });
    child.stderr.on("data", () => {}); child.stdin.on("error", () => {});
    child.on("close", (exitCode) => { children.delete(child); options.operation.signal.removeEventListener("abort", cancel); if (options.operation.signal.aborted) reject(options.operation.signal.reason); else resolve({ exitCode }); });
    child.stdin.write(options.stdin); options.onChannel(child.stdin);
  }) });
  t.after(async () => { await runner.close(); client.close(); manager.close(); for (const child of children) child.kill(); await fs.rm(dir, { recursive: true, force: true }); });
  await until(() => manager.workers.has("test"));
  manager.sample("test", client.epoch, { cpuCores: 4, cpuBusyRatio: 0.1, memoryAvailableBytes: 6 * 1024 ** 3, totalMemoryBytes: 8 * 1024 ** 3, load1: 0.1, ioWaitRatio: 0 });
  const file = path.join(dir, "app.log"); await fs.writeFile(file, "match\n".repeat(45000));
  const first = runner.start({ path: file, contains: "match", processBytesPerSecond: 65536, limit: 1 });
  const second = runner.start({ path: file, contains: "match", processBytesPerSecond: 65536, limit: 1 });
  await until(() => runner.find(first.jobId).channel && runner.find(second.jobId).channel);
  const selected = manager.tasks.get(second.resourceTaskId);
  manager.setMode("test", second.resourceTaskId, "manual_max", selected.modeRevision);
  await until(() => manager.tasks.get(second.resourceTaskId).budget?.cpuMilliCores === 750);
  const protectedQuery = client.operation({ signal: new AbortController().signal }, { taskType: "mongo_read" }, async ({ taskId, started }) => { started(); assert.ok(client.budget(taskId).cpuMilliCores > 0); return "query completed"; });
  assert.equal(await protectedQuery, "query completed");
  const boosted = await until(() => { const job = runner.get({ jobId: second.jobId }); return job.status === "completed" && job; });
  assert.equal(boosted.matchedLines, 45000); assert.equal(boosted.countsAreComplete, true);
  assert.equal(boosted.fileResults[0].countsAreComplete, true);
  assert.equal(boosted.resources.budget.cpuMilliCores, 750);
  const other = await until(() => { const job = runner.get({ jobId: first.jobId }); return job.status === "completed" && job; });
  assert.equal(other.matchedLines, 45000); assert.equal(other.fileResults[0].countsAreComplete, true);
  await until(() => manager.tasks.get(second.resourceTaskId).status === "completed");
  assert.equal(manager.tasks.get(second.resourceTaskId).resourceMode, "auto");
});
