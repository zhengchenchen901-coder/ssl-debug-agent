import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { RemoteResourceManager } from "../remote-resource-manager.js";
import { WorkerResourceClient } from "../worker-resource-client.js";
import { TaskRegistry } from "../task-registry.js";
import { normalizeResourcePolicy } from "../resource-policy.js";
import { createRemoteResourceRuntime } from "../remote-resource-runtime.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sample = { cpuCores: 4, cpuBusyRatio: 0.1, memoryAvailableBytes: 6 * 1024 ** 3,
  totalMemoryBytes: 8 * 1024 ** 3, load1: 0.2, ioWaitRatio: 0, scope: "host" };
function fixture(t) {
  let now = 1000;
  const frames = [], manager = new RemoteResourceManager({ now: () => now, instance: () => ({ host: "shared.fixture", port: 22 }) });
  t.after(() => manager.close());
  manager.attach("a", "epoch-a", (f) => frames.push({ instanceId: "a", ...f }));
  manager.attach("b", "epoch-b", (f) => frames.push({ instanceId: "b", ...f }));
  manager.sample("a", "epoch-a", sample);
  const report = (task, patch = {}, instanceId = "a") => manager.report(instanceId, `epoch-${instanceId}`, { ...task, ...patch });
  const task = (type = "log_search") => ({ taskId: randomUUID(), type, status: "running", phase: "executing", requested: {}, usage: {}, capabilities: ["pause"] });
  function ack() {
    for (let wave = 0; wave < 8; wave++) {
      const pending = [...manager.tasks.values()].filter((x) => x.budgetRevision > x.appliedRevision);
      if (!pending.length) return;
      for (const entry of pending) report(entry, { appliedRevision: entry.budgetRevision }, entry.instanceId);
    }
    throw new Error("resource assignment failed to settle");
  }
  return { manager, frames, task, report, ack, advance: (ms) => { now += ms; manager.rebalance(); } };
}

test("shared-host budgets reserve non-bulk resources and manual mode moves the remaining grant", (t) => {
  const f = fixture(t), a = f.task(), b = f.task();
  f.report(a); f.report(b, {}, "b"); f.ack();
  assert.equal(f.manager.tasks.get(a.taskId).budget.cpuMilliCores, 200);
  const selected = f.manager.setMode("b", b.taskId, "manual_max", 1);
  f.ack();
  const boosted = f.manager.tasks.get(b.taskId), ordinary = f.manager.tasks.get(a.taskId);
  assert.equal(boosted.budget.cpuMilliCores, 750);
  assert.equal(ordinary.budget.cpuMilliCores, 0);
  assert.equal(selected.resourceMode, "manual_max");
  const query = f.task("mongo_read"); f.report(query); f.ack();
  assert.ok(f.manager.tasks.get(query.taskId).budget.cpuMilliCores > 0);
  const total = [...f.manager.tasks.values()].reduce((n, x) => n + x.budget.cpuMilliCores, 0);
  assert.ok(total <= 1000);
  const transfer = [...f.manager.tasks.values()].reduce((n, x) => n + x.budget.transferBytesPerSecond, 0);
  assert.ok(transfer <= f.manager.policy.transferBytesPerSecond);
  f.manager.setMode("a", a.taskId, "manual_max", f.manager.tasks.get(a.taskId).modeRevision); f.ack();
  assert.equal(f.manager.tasks.get(b.taskId).resourceMode, "auto");
  assert.equal(f.manager.tasks.get(a.taskId).budget.cpuMilliCores, 750);
  assert.throws(() => f.manager.setMode("a", b.taskId, "manual_max", 1), /不存在/);
  assert.throws(() => f.manager.setMode("a", a.taskId, "auto", 1), /变化/);
});

test("manual mode respects explicit administrative ceilings and follows an approved database resume", (t) => {
  const f = fixture(t), task = f.task("mongo_bulk"); task.referenceId = "same-approved-job";
  task.requested = { cpuMilliCores: 200, maxCpuMilliCores: 400, maxReadBytesPerSecond: 1048576 };
  f.report(task); f.ack(); f.manager.setMode("a", task.taskId, "manual_max", 1); f.ack();
  assert.equal(f.manager.tasks.get(task.taskId).budget.cpuMilliCores, 400);
  assert.ok(f.manager.tasks.get(task.taskId).budget.readBytesPerSecond <= 1048576);
  f.report(task, { status: "paused", appliedRevision: f.manager.tasks.get(task.taskId).budgetRevision }); f.ack();
  f.report(task, { status: "stopped", phase: "resumed_as_new_execution" });
  const resumed = { ...task, taskId: randomUUID() }; f.report(resumed); f.ack();
  assert.equal(f.manager.tasks.get(resumed.taskId).resourceMode, "manual_max");
  assert.equal(f.manager.tasks.get(task.taskId).resourceMode, "auto");
});

test("increases wait for executor acknowledgement of reductions", (t) => {
  const f = fixture(t), a = f.task(), b = f.task(); f.report(a); f.report(b); f.ack();
  f.manager.setMode("a", a.taskId, "manual_max", 1);
  assert.equal(f.manager.tasks.get(b.taskId).budget.cpuMilliCores, 0);
  assert.equal(f.manager.tasks.get(a.taskId).budget.cpuMilliCores, 200);
  f.ack(); assert.equal(f.manager.tasks.get(a.taskId).budget.cpuMilliCores, 750);
});

test("database waves keep their grant until the approved in-flight wave settles", (t) => {
  const f = fixture(t), log = f.task(), db = f.task("mongo_bulk");
  db.requested = { cpuMilliCores: 400, parallelism: 2, rssLimitBytes: 256 * 1048576 };
  f.report(db); f.report(log); f.ack();
  const pinnedCpu = f.manager.tasks.get(db.taskId).budget.cpuMilliCores;
  f.report(db, { inFlight: true, appliedRevision: f.manager.tasks.get(db.taskId).budgetRevision });
  f.manager.setMode("a", log.taskId, "manual_max", 1); f.ack();
  assert.equal(f.manager.tasks.get(db.taskId).budget.cpuMilliCores, pinnedCpu);
  assert.equal(f.manager.tasks.get(log.taskId).budget.cpuMilliCores, 750 - pinnedCpu);
  f.report(db, { inFlight: false, appliedRevision: f.manager.tasks.get(db.taskId).budgetRevision }); f.ack();
  assert.equal(f.manager.tasks.get(db.taskId).budget.cpuMilliCores, 0);
  assert.equal(f.manager.tasks.get(log.taskId).budget.cpuMilliCores, 750);
});

test("pressure and stale sampling suspend bulk work while control still runs", (t) => {
  const f = fixture(t), log = f.task(), control = f.task("control"); f.report(log); f.ack();
  f.manager.sample("a", "epoch-a", { ...sample, cpuBusyRatio: 0.99 }); f.ack();
  assert.equal(f.manager.tasks.get(log.taskId).budget.cpuMilliCores, 0);
  f.report(control); f.ack(); assert.equal(f.manager.tasks.get(control.taskId).budget.cpuMilliCores, 50);
  f.advance(21000); f.ack(); assert.match(f.manager.tasks.get(log.taskId).reason, /采样/);
  f.manager.sample("a", "epoch-a", sample); f.advance(10000); f.ack();
  assert.ok(f.manager.domains.values().next().value.factor < 1);
});

test("lost executors keep reservations until the watchdog grace period ends", (t) => {
  const f = fixture(t), a = f.task(), b = f.task(); f.report(a); f.ack();
  f.manager.detach("a", "epoch-a");
  assert.equal(f.manager.tasks.get(a.taskId).status, "interrupted");
  assert.equal(f.manager.publicTask(f.manager.tasks.get(a.taskId)).resourceState, "reclaiming");
  f.manager.sample("b", "epoch-b", sample); f.report(b, {}, "b"); f.ack();
  f.manager.setMode("b", b.taskId, "manual_max", 1); f.ack();
  assert.equal(f.manager.tasks.get(b.taskId).budget.cpuMilliCores, 550);
  f.advance(61000); f.manager.sample("b", "epoch-b", sample);
  assert.equal(f.manager.publicTask(f.manager.tasks.get(a.taskId)).resourceState, "released");
});

test("registry retains bounded operational metadata and resource policy rejects invalid ceilings", () => {
  const registry = new TaskRegistry({ maxTasks: 2 });
  const first = registry.register({ type: "diagnostic", label: "诊断" }); registry.update(first, { status: "completed", raw: "PRIVATE" });
  registry.register({ type: "log_search" }); registry.register({ type: "log_search" });
  assert.equal(registry.tasks.size, 2);
  assert.doesNotMatch(JSON.stringify(registry.list()), /PRIVATE/);
  assert.throws(() => normalizeResourcePolicy({ cpuMilliCores: 100 }), /capacity/);
  assert.throws(() => normalizeResourcePolicy({ domains: { a: "../../escape" } }), /domain/);
});

test("worker IPC applies grants through executor acknowledgements and rejects old generations", async (t) => {
  const proc = new EventEmitter(), frames = [];
  const client = new WorkerResourceClient({ instanceId: "test", processObject: proc, send: (f) => frames.push(f) }); t.after(() => client.close());
  let finish;
  const id = client.register({ type: "log_search" }, { onBudget: () => new Promise((r) => { finish = r; }) });
  const budget = { cpuMilliCores: 200, readBytesPerSecond: 1048576, processBytesPerSecond: 1048576, rssLimitBytes: 192 * 1048576, mode: "auto" };
  proc.emit("message", { type: "resource_budget", epoch: "old", taskId: id, revision: 1, budget });
  await pause(5); assert.equal(client.budget(id), null);
  proc.emit("message", { type: "resource_budget", epoch: client.epoch, taskId: id, revision: 1, budget });
  await pause(5); assert.equal(client.budget(id), null);
  finish(); await client.settled(id);
  assert.equal(client.budget(id).cpuMilliCores, 200);
  assert.equal(client.registry.tasks.get(id).appliedRevision, 1);
});

test("common remote runtime paces bytes and can suspend/resume without recreating its process", async () => {
  const runtime = createRemoteResourceRuntime({ cpuPercent: 50, readBytesPerSecond: 65536, processBytesPerSecond: 65536, rssLimitBytes: 512 * 1048576 });
  const start = Date.now(); await runtime.consume("read", 16384); assert.ok(Date.now() - start >= 240);
  runtime.update({ cpuMilliCores: 0, readBytesPerSecond: 0, processBytesPerSecond: 0, rssLimitBytes: 512 * 1048576 }, 1);
  let completed = false; const waiting = runtime.consume("process", 1).then(() => { completed = true; });
  await pause(120); assert.equal(completed, false);
  runtime.update({ cpuMilliCores: 500, readBytesPerSecond: 65536, processBytesPerSecond: 65536, rssLimitBytes: 512 * 1048576 }, 2);
  await waiting; assert.equal(completed, true); assert.equal(runtime.snapshot().readBytes, 16384);
});
