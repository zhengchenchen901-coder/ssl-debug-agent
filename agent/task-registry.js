import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { RESOURCE_PROFILES, RESOURCE_TERMINAL } from "./resource-policy.js";

// Only operational metadata is retained. No filters, documents, commands or logs.
export class TaskRegistry extends EventEmitter {
  constructor({ instanceId = "local", now = Date.now, maxTasks = 200 } = {}) {
    super(); this.instanceId = instanceId; this.now = now; this.maxTasks = maxTasks; this.tasks = new Map();
  }
  register({ type = "diagnostic", referenceId, label, source = "api", requested = {}, capabilities = [] } = {}) {
    if (!Object.hasOwn(RESOURCE_PROFILES, type)) throw new Error("unknown task type");
    this.prune();
    if (this.tasks.size >= this.maxTasks) throw Object.assign(new Error("task registry is full"), { code: "TASK_CAPACITY", statusCode: 429 });
    const task = { taskId: randomUUID(), instanceId: this.instanceId, referenceId,
      type, bulk: RESOURCE_PROFILES[type].bulk, label: String(label || type).slice(0, 160), source: String(source).slice(0, 80),
      status: "queued", phase: "queued", createdAt: this.now(), updatedAt: this.now(), revision: 1,
      requested, capabilities, resourceMode: "auto", resourceState: "waiting", progress: {}, usage: {} };
    this.tasks.set(task.taskId, task); this.emit("task", task); return task.taskId;
  }
  update(taskId, patch) {
    const task = this.tasks.get(taskId); if (!task) return;
    for (const key of ["status", "phase", "progress", "usage", "resourceState", "budget", "resourceMode", "reason", "inFlight", "appliedRevision"]) if (patch[key] !== undefined) task[key] = ["progress", "usage"].includes(key) ? { ...task[key], ...patch[key] } : patch[key];
    task.revision++; task.updatedAt = this.now();
    if (RESOURCE_TERMINAL.has(task.status)) { task.finishedAt ||= this.now(); task.resourceMode = "auto"; task.resourceState = "released"; }
    this.emit("task", task); return task;
  }
  prune() {
    for (const [id, task] of this.tasks) if (task.finishedAt && (this.now() - task.finishedAt > 1800000 || this.tasks.size >= this.maxTasks)) this.tasks.delete(id);
  }
  list({ offset = 0, limit = 50 } = {}) {
    this.prune(); const all = [...this.tasks.values()].sort((a, b) => Number(Boolean(a.finishedAt)) - Number(Boolean(b.finishedAt)) || b.createdAt - a.createdAt);
    return { tasks: all.slice(offset, offset + limit), total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null };
  }
}
