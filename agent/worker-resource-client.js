import { randomUUID } from "node:crypto";
import { TaskRegistry } from "./task-registry.js";
import { RESOURCE_TERMINAL } from "./resource-policy.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export class WorkerResourceClient {
  constructor({ instanceId, send, processObject = process, now = Date.now }) {
    this.epoch = randomUUID(); this.send = send; this.now = now;
    this.registry = new TaskRegistry({ instanceId, now }); this.entries = new Map(); this.closed = false;
    this.syncs = new Map();
    this.processObject = processObject;
    this.onMessage = (message) => { if (message?.epoch === this.epoch) this.receive(message); };
    processObject.on("message", this.onMessage);
    this.registry.on("task", (task) => this.send({ type: "resource_task", epoch: this.epoch, task }));
    this.heartbeat = setInterval(() => {
      for (const [id, entry] of this.entries) if (!RESOURCE_TERMINAL.has(this.registry.tasks.get(id)?.status)) {
        if (entry.renew) entry.renew(this.now() - entry.lastBudgetAt < 20000);
      }
      this.send({ type: "resource_hello", epoch: this.epoch });
    }, 10000); this.heartbeat.unref?.();
    this.send({ type: "resource_hello", epoch: this.epoch });
  }
  register(descriptor, { onBudget, control } = {}) {
    const id = this.registry.register(descriptor);
    this.entries.set(id, { onBudget, control, budget: null, lastBudgetAt: this.now(), revision: 0, chain: Promise.resolve() });
    return id;
  }
  receive(message) {
    if (message.type === "resource_config") { this.samplerEnabled = message.sampler; this.policy = message.policy; return; }
    if (message.type === "resource_probe_request") { this.probeNow?.(); return; }
    if (message.type === "resource_sync_ack") {
      const pending = this.syncs.get(message.requestId); if (!pending) return;
      this.syncs.delete(message.requestId);
      Promise.resolve(this.entries.get(pending.taskId)?.chain).then(pending.resolve, pending.reject); return;
    }
    if (message.type !== "resource_budget") return;
    const entry = this.entries.get(message.taskId); if (!entry) return;
    entry.lastBudgetAt = this.now();
    if (message.revision <= entry.revision) return;
    entry.lastBudgetAt = this.now(); entry.revision = message.revision;
    entry.chain = entry.chain.catch(() => {}).then(async () => {
      this.registry.update(message.taskId, { budget: message.budget, resourceMode: message.budget.mode,
        reason: message.budget.reason, resourceState: message.budget.cpuMilliCores ? "normal" : "suspended" });
      try {
        await entry.onBudget?.(message.budget, message.revision);
        if (entry.budget?.transferBytesPerSecond !== message.budget.transferBytesPerSecond) entry.readDue = 0;
        entry.budget = message.budget;
        this.registry.update(message.taskId, { appliedRevision: message.revision });
      } catch {
        if (entry.revision === message.revision) entry.revision--;
        this.registry.update(message.taskId, { reason: "资源预算下发未确认", resourceState: "waiting" });
      }
    });
  }
  bind(id, options) { Object.assign(this.entries.get(id), options); }
  update(id, patch) {
    const task = this.registry.update(id, patch);
    if (task && RESOURCE_TERMINAL.has(task.status)) this.entries.delete(id);
    return task;
  }
  budget(id) { return this.entries.get(id)?.budget; }
  async settled(id) { await this.entries.get(id)?.chain; }
  async synchronize(taskId) {
    const requestId = randomUUID();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.syncs.delete(requestId); reject(Object.assign(new Error("resource coordinator did not acknowledge"), { code: "RESOURCE_CONTROLLER_LOST" })); }, 5000);
      this.syncs.set(requestId, { taskId, resolve: () => { clearTimeout(timer); resolve(); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.send({ type: "resource_sync", epoch: this.epoch, taskId, requestId });
    });
  }
  async receiveBytes(id, bytes, signal) {
    const entry = this.entries.get(id); if (!entry) return;
    while (!entry.budget?.transferBytesPerSecond && !this.closed) { if (signal?.aborted) throw signal.reason; await sleep(50); }
    if (this.closed) throw new Error("resource controller closed");
    entry.readDue = Math.max(entry.readDue || 0, this.now()) + bytes * 1000 / Math.max(1, entry.budget.transferBytesPerSecond);
    while (this.now() < entry.readDue) { if (signal?.aborted) throw signal.reason; await sleep(Math.min(50, entry.readDue - this.now())); }
    entry.readBytes = (entry.readBytes || 0) + bytes;
    this.update(id, { usage: { transferBytes: entry.readBytes } });
  }
  async wait(id, signal) {
    while (!this.closed) {
      if (signal?.aborted) throw signal.reason;
      if (this.entries.get(id)?.budget?.cpuMilliCores > 0 && this.now() - this.entries.get(id).lastBudgetAt < 20000) return this.entries.get(id).budget;
      await sleep(50);
    }
    throw Object.assign(new Error("resource controller closed"), { code: "RESOURCE_CONTROLLER_LOST" });
  }
  async operation(operation, options, work) {
    if (options.resourceIgnore) return work();
    if (options.resourceTaskId) {
      if (options.priority !== "control") await this.wait(options.resourceTaskId, operation.signal);
      return work({ taskId: options.resourceTaskId });
    }
    const type = options.taskType || (options.priority === "control" ? "control" : options.priority === "background" ? "discovery" : "diagnostic");
    const id = this.register({ type, label: { control: "控制请求", diagnostic: "诊断操作", file_read: "文件读取", mongo_read: "数据库查询", mongo_write: "数据库操作", discovery: "后台发现" }[type] || type });
    this.update(id, { status: "starting" });
    try {
      await this.wait(id, operation.signal);
      return await work({ taskId: id, started: () => this.update(id, { status: "running", phase: "executing" }) });
    } catch (error) {
      this.update(id, { status: operation.signal?.aborted ? "cancelled" : "failed", phase: "finished" }); throw error;
    } finally {
      const status = this.registry.tasks.get(id)?.status;
      if (!RESOURCE_TERMINAL.has(status)) this.update(id, { status: "completed", phase: "finished" });
      this.entries.delete(id);
    }
  }
  async control(taskId, action) {
    const entry = this.entries.get(taskId);
    if (!entry?.control) throw Object.assign(new Error("任务不支持此操作或详情已过期"), { code: "TASK_CONTROL_UNAVAILABLE", statusCode: 409 });
    return entry.control(action);
  }
  reportSample(sample) { this.send({ type: "resource_sample", epoch: this.epoch, sample }); }
  close() {
    this.closed = true; clearInterval(this.heartbeat); this.processObject.off("message", this.onMessage);
    for (const pending of this.syncs.values()) pending.reject(new Error("resource controller closed")); this.syncs.clear();
  }
}
