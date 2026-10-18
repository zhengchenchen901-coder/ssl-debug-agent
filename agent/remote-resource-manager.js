import { EventEmitter } from "node:events";
import { normalizeResourcePolicy, RESOURCE_PROFILES, RESOURCE_TERMINAL } from "./resource-policy.js";

const fault = (message, code, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const numeric = (value) => Number.isFinite(value) && value >= 0;

export class RemoteResourceManager extends EventEmitter {
  constructor({ policy, instance = () => null, now = Date.now } = {}) {
    super(); this.policy = normalizeResourcePolicy(policy); this.instance = instance; this.now = now;
    this.workers = new Map(); this.tasks = new Map(); this.domains = new Map(); this.revision = 0;
    this.timer = setInterval(() => this.rebalance(), 1000); this.timer.unref?.();
  }
  domainFor(instanceId) {
    const instance = this.instance(instanceId);
    return this.policy.domains[instanceId] || (instance?.host ? `${instance.host}:${instance.port || 22}` : instanceId);
  }
  domain(instanceId) {
    const id = this.domainFor(instanceId);
    if (!this.domains.has(id)) this.domains.set(id, { id, sample: null, factor: 1, recoveryAt: this.now() });
    return this.domains.get(id);
  }
  attach(instanceId, epoch, send) {
    const previous = this.workers.get(instanceId);
    if (previous?.epoch === epoch) {
      for (const task of this.tasks.values()) if (task.instanceId === instanceId && task.epoch === epoch && task.budget && !RESOURCE_TERMINAL.has(task.status)) send({ type: "resource_budget", epoch, taskId: task.taskId, revision: task.budgetRevision, budget: task.budget });
      return;
    }
    if (previous && previous.epoch !== epoch) this.detach(instanceId, previous.epoch);
    this.workers.set(instanceId, { epoch, send, domain: this.domainFor(instanceId) });
    this.domain(instanceId); this.electSamplers(); this.rebalance();
  }
  electSamplers() {
    const selected = new Set();
    for (const worker of this.workers.values()) {
      const sampler = !selected.has(worker.domain); selected.add(worker.domain);
      worker.send({ type: "resource_config", epoch: worker.epoch, policy: this.policy, sampler });
    }
  }
  detach(instanceId, epoch) {
    if (this.workers.get(instanceId)?.epoch !== epoch) return;
    this.workers.delete(instanceId);
    for (const entry of this.tasks.values()) if (entry.instanceId === instanceId && entry.epoch === epoch && !RESOURCE_TERMINAL.has(entry.status)) {
      entry.status = "interrupted"; entry.finishedAt = this.now(); entry.resourceMode = "auto";
      entry.reason = "连接已失效，等待远端执行器回收"; entry.orphanUntil = this.now() + 60000;
    }
    this.electSamplers(); this.rebalance();
  }
  report(instanceId, epoch, task) {
    if (this.workers.get(instanceId)?.epoch !== epoch || !/^[a-f0-9-]{36}$/.test(task?.taskId || "") || !Object.hasOwn(RESOURCE_PROFILES, task.type)) return;
    const previous = this.tasks.get(task.taskId);
    if (previous && (previous.epoch !== epoch || previous.instanceId !== instanceId)) return;
    const profile = RESOURCE_PROFILES[task.type];
    const resumed = !previous && task.type === "mongo_bulk" && task.referenceId
      ? [...this.tasks.values()].find((t) => t.instanceId === instanceId && t.type === task.type && t.referenceId === task.referenceId && t.handoverManual) : null;
    const inheritedMaximum = resumed && ![...this.tasks.values()].some((t) => t.domain === resumed.domain && t.resourceMode === "manual_max");
    if (resumed) resumed.handoverManual = false;
    const usage = Object.fromEntries(Object.entries(task.usage || {}).filter(([key, v]) => ["rssBytes", "peakRssBytes", "cpuMs", "elapsedMs", "readBytes", "processedBytes", "transferBytes"].includes(key) && numeric(v)));
    const progress = Object.fromEntries(Object.entries(task.progress || {}).filter(([key, v]) => ["scannedBytes", "expandedBytes", "matchedLines", "completedFiles", "totalFiles", "batchCount", "nextBatch", "nextVerifyBatch", "committedBatchCount", "verifiedBatchCount", "operationCount"].includes(key) && numeric(v)));
    const request = {};
    for (const key of ["cpuMilliCores", "readBytesPerSecond", "processBytesPerSecond", "rssLimitBytes", "parallelism", "maxCpuMilliCores", "maxReadBytesPerSecond", "maxProcessBytesPerSecond"]) if (numeric(task.requested?.[key])) request[key] = task.requested[key];
    const statuses = ["queued", "starting", "running", "paused", "cancelling", "stopping", ...RESOURCE_TERMINAL];
    if (!statuses.includes(task.status)) return;
    const entry = { ...previous, taskId: task.taskId, instanceId, epoch, domain: this.domainFor(instanceId),
      type: task.type, bulk: profile.bulk, referenceId: String(task.referenceId || "").slice(0, 64),
      label: String(task.label || task.type).slice(0, 160), source: String(task.source || "api").slice(0, 80), status: task.status,
      phase: String(task.phase || task.status).slice(0, 48), createdAt: previous?.createdAt || this.now(), updatedAt: this.now(),
      usage, progress, requested: request, inFlight: task.inFlight === true,
      appliedRevision: Number.isInteger(task.appliedRevision) ? task.appliedRevision : previous?.appliedRevision || 0,
      capabilities: (Array.isArray(task.capabilities) ? task.capabilities : []).filter((v) => ["pause", "resume", "cancel", "stop_after_file", "detail"].includes(v)),
      resourceMode: previous?.resourceMode || (inheritedMaximum ? "manual_max" : "auto"), modeRevision: previous?.modeRevision || 1 };
    if (previous?.usage?.elapsedMs < usage.elapsedMs && previous.usage.cpuMs <= usage.cpuMs) {
      entry.cpuMilliCoresUsed = Math.min(64000, (usage.cpuMs - previous.usage.cpuMs) / (usage.elapsedMs - previous.usage.elapsedMs) * 1000);
    }
    if (RESOURCE_TERMINAL.has(entry.status)) {
      entry.handoverManual = previous?.resourceMode === "manual_max" && task.phase === "resumed_as_new_execution";
      entry.finishedAt ||= this.now(); entry.resourceMode = "auto";
    }
    this.tasks.set(entry.taskId, entry); this.rebalance();
  }
  sample(instanceId, epoch, sample) {
    if (this.workers.get(instanceId)?.epoch !== epoch) return;
    const domain = this.domain(instanceId);
    const keys = ["cpuCores", "cpuBusyRatio", "memoryAvailableBytes", "totalMemoryBytes", "load1", "ioWaitRatio"];
    if (!sample || keys.some((key) => !numeric(sample[key])) || sample.cpuCores < 0.01 || sample.cpuCores > 4096 || sample.cpuBusyRatio > 1 || sample.ioWaitRatio > 1) return;
    if (!domain.sample) domain.factor = 1;
    domain.sample = Object.fromEntries(keys.map((key) => [key, sample[key]]));
    domain.sample.scope = sample.scope === "cgroup" ? "cgroup" : "host";
    domain.sample.sampledAt = this.now(); this.rebalance();
  }
  setMode(instanceId, taskId, mode, expectedRevision) {
    const task = this.tasks.get(taskId);
    if (!task || task.instanceId !== instanceId) throw fault("任务不存在或已过期", "TASK_NOT_FOUND", 404);
    if (!task.bulk || RESOURCE_TERMINAL.has(task.status)) throw fault("只有未结束的批量任务可提档", "TASK_MODE_INVALID", 409);
    if (task.status === "cancelling") throw fault("任务正在取消，无法调整资源模式", "TASK_MODE_INVALID", 409);
    if (!["auto", "manual_max"].includes(mode)) throw fault("无效资源模式", "TASK_MODE_INVALID");
    if (!Number.isInteger(expectedRevision) || expectedRevision !== task.modeRevision) throw fault("任务模式已变化，请刷新后重试", "TASK_REVISION_CONFLICT", 409);
    if (mode === "manual_max") for (const other of this.tasks.values()) {
      if (other.domain === task.domain && other.taskId !== taskId && other.resourceMode === "manual_max") { other.resourceMode = "auto"; other.modeRevision++; }
    }
    task.resourceMode = mode; task.modeRevision++; this.rebalance(); return this.publicTask(task);
  }
  budget(entry, cpu, factor = 1, reason = "") {
    const p = this.policy, profile = RESOURCE_PROFILES[entry.type], manual = entry.resourceMode === "manual_max";
    const normalCpu = entry.requested.cpuMilliCores || profile.cpuMilliCores;
    const bulkReadCap = (p.readBytesPerSecond - p.protectedReadBytesPerSecond) * cpu / (p.cpuMilliCores - p.protectedCpuMilliCores - p.controlCpuMilliCores);
    const bulkProcessCap = (p.processBytesPerSecond - p.protectedProcessBytesPerSecond) * cpu / (p.cpuMilliCores - p.protectedCpuMilliCores - p.controlCpuMilliCores);
    const activeBulk = [...this.tasks.values()].filter((t) => t.domain === entry.domain && t.bulk && !RESOURCE_TERMINAL.has(t.status) && t.status !== "queued").length;
    const transferFloor = entry.status === "queued" ? 0 : 16384;
    const bulkTransferCap = transferFloor + Math.max(0, p.transferBytesPerSecond - p.protectedTransferBytesPerSecond - activeBulk * 16384) * cpu / (p.cpuMilliCores - p.protectedCpuMilliCores - p.controlCpuMilliCores);
    return { cpuMilliCores: Math.max(0, Math.floor(cpu)),
      readBytesPerSecond: cpu ? Math.max(1, Math.floor(profile.bulk ? Math.min(bulkReadCap, entry.requested.maxReadBytesPerSecond || Infinity, manual ? Infinity : entry.requested.readBytesPerSecond || 2 * 1048576) : p.protectedReadBytesPerSecond)) : 0,
      processBytesPerSecond: cpu ? Math.max(1, Math.floor(profile.bulk ? Math.min(bulkProcessCap, entry.requested.maxProcessBytesPerSecond || Infinity, manual ? Infinity : entry.requested.processBytesPerSecond || 4 * 1048576) : p.protectedProcessBytesPerSecond)) : 0,
      transferBytesPerSecond: Math.floor(profile.bulk ? bulkTransferCap : entry.type === "control" ? (cpu ? p.controlTransferBytesPerSecond : 0)
        : (p.protectedTransferBytesPerSecond - p.controlTransferBytesPerSecond) * cpu / p.protectedCpuMilliCores),
      rssLimitBytes: Math.min(entry.requested.rssLimitBytes || profile.memoryBytes, profile.memoryBytes),
      parallelism: cpu ? Math.max(1, Math.min(entry.requested.parallelism || 1, Math.ceil(cpu / 200))) : 0,
      dispatchDelayMs: cpu ? Math.max(0, Math.ceil(200 / cpu * 50) - 50) : 100,
      mode: entry.resourceMode, reason };
  }
  rebalance() {
    const now = this.now(), p = this.policy;
    for (const [id, task] of this.tasks) if (task.finishedAt && now - task.finishedAt > 1800000 || this.tasks.size > 1000 && task.finishedAt && !task.orphanUntil) this.tasks.delete(id);
    for (const domain of this.domains.values()) {
      const all = [...this.tasks.values()].filter((t) => t.domain === domain.id);
      const live = all.filter((t) => !RESOURCE_TERMINAL.has(t.status));
      if (live.some((task) => task.bulk) && now - (domain.lastProbeRequested || 0) >= p.sampleIntervalMs
        && (!domain.sample || now - domain.sample.sampledAt >= p.sampleIntervalMs)) {
        const leader = [...this.workers.values()].find((worker) => worker.domain === domain.id);
        if (leader) { domain.lastProbeRequested = now; leader.send({ type: "resource_probe_request", epoch: leader.epoch }); }
      }
      const fresh = domain.sample && now - domain.sample.sampledAt <= p.sampleTtlMs;
      const desired = new Map();
      const managed = live.reduce((sum, t) => sum + (now - t.updatedAt < p.sampleTtlMs ? t.cpuMilliCoresUsed || 0 : 0), 0);
      const raw = fresh ? Math.min(p.cpuMilliCores, Math.max(0, domain.sample.cpuCores * 1000 * (0.8 - domain.sample.cpuBusyRatio) + managed)) : 0;
      const targetFactor = Math.min(1, raw / p.cpuMilliCores, fresh && domain.sample.ioWaitRatio > 0.2 ? 0.5 : 1);
      if (targetFactor < domain.factor) { domain.factor = targetFactor; domain.recoveryAt = now; }
      else if (now - domain.recoveryAt >= 10000) { domain.factor = Math.min(targetFactor, domain.factor + 0.1); domain.recoveryAt = now; }
      const orphan = all.filter((t) => t.orphanUntil > now);
      let cpu = Math.max(0, p.cpuMilliCores * domain.factor - p.protectedCpuMilliCores - p.controlCpuMilliCores - orphan.reduce((n, t) => n + (t.budget?.cpuMilliCores || 0), 0));
      const availableMemory = fresh ? Math.max(0, domain.sample.memoryAvailableBytes - Math.max(128 * 1048576, domain.sample.totalMemoryBytes * p.memoryHeadroomRatio)
        + live.reduce((n, t) => n + (t.usage.rssBytes || 0), 0)) : 0;
      let memory = Math.min(p.memoryBytes - p.protectedMemoryBytes, availableMemory) - orphan.reduce((n, t) => n + (t.budget?.rssLimitBytes || 0), 0)
        - live.filter((t) => t.bulk && t.status === "paused").reduce((n, t) => n + (t.usage.rssBytes || 0), 0);
      const bulk = live.filter((t) => t.bulk && !["paused", "queued"].includes(t.status)).sort((a, b) => Number(b.resourceMode === "manual_max") - Number(a.resourceMode === "manual_max") || a.createdAt - b.createdAt);
      const pinned = bulk.filter((t) => t.type === "mongo_bulk" && t.inFlight);
      for (const task of pinned) { const grant = { ...(task.budget || this.budget(task, 0)), mode: task.resourceMode, reason: "等待当前数据库批次结束后调整资源" }; desired.set(task.taskId, grant); cpu -= grant.cpuMilliCores; memory -= grant.rssLimitBytes; }
      const eligible = bulk.filter((t) => !pinned.includes(t));
      for (const task of eligible) {
        const rss = Math.min(task.requested.rssLimitBytes || RESOURCE_PROFILES[task.type].memoryBytes, RESOURCE_PROFILES[task.type].memoryBytes);
        let grant = 0, reason = "";
        if (!fresh) reason = "远端资源采样失效";
        else if (memory < rss) reason = "可用内存不足";
        else if (cpu < 10) reason = "为其他任务保留资源";
        else {
          const manual = task.resourceMode === "manual_max";
          const share = cpu / Math.max(1, eligible.filter((t) => !desired.has(t.taskId)).length);
          grant = Math.min(cpu, task.requested.maxCpuMilliCores || Infinity, manual ? cpu : Math.min(task.requested.cpuMilliCores || RESOURCE_PROFILES[task.type].cpuMilliCores, share));
          if (manual && pinned.length) reason = "等待其他数据库批次完成，逐步接管资源";
          else if (domain.factor < 1) reason = "主机资源压力，降低执行预算";
          else if (manual && task.requested.maxCpuMilliCores && grant >= task.requested.maxCpuMilliCores) reason = "已达到管理员配置的任务上限";
          else if (grant < (task.requested.cpuMilliCores || RESOURCE_PROFILES[task.type].cpuMilliCores)) reason = "按共享资源池分配";
          cpu -= grant;
        }
        // Pausing a process does not reclaim its resident memory.
        memory -= Math.max(task.usage.rssBytes || 0, grant ? rss : 0);
        desired.set(task.taskId, this.budget(task, grant, domain.factor, reason));
      }
      let protectedCpu = p.protectedCpuMilliCores, protectedMemory = p.protectedMemoryBytes - 32 * 1048576, controlAvailable = true;
      for (const task of live.filter((t) => !desired.has(t.taskId)).sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || a.createdAt - b.createdAt)) {
        let cpu = 0;
        if (!task.bulk && task.type === "control" && controlAvailable) { cpu = p.controlCpuMilliCores; controlAvailable = false; }
        else if (!task.bulk && task.type !== "control" && protectedMemory >= RESOURCE_PROFILES[task.type].memoryBytes) {
          cpu = Math.min(RESOURCE_PROFILES[task.type].cpuMilliCores, protectedCpu); protectedCpu -= cpu;
          if (cpu) protectedMemory -= RESOURCE_PROFILES[task.type].memoryBytes;
        }
        desired.set(task.taskId, this.budget(task, cpu, 1, task.bulk ? task.status === "paused" ? "任务已暂停" : "等待执行通道" : "非批量任务保底"));
      }
      // Reductions must be applied before another executor receives the released CPU.
      const reductions = live.filter((t) => desired.get(t.taskId).cpuMilliCores < (t.budget?.cpuMilliCores || 0));
      const pendingReduction = live.some((t) => t.budget && t.appliedRevision < t.budgetRevision && t.reducing);
      for (const task of live) {
        const grant = desired.get(task.taskId);
        if (equal(task.budget, grant)) continue;
        const increase = grant.cpuMilliCores > (task.budget?.cpuMilliCores || 0);
        if (increase && task.bulk && (reductions.length || pendingReduction)) continue;
        task.reducing = grant.cpuMilliCores < (task.budget?.cpuMilliCores || 0);
        task.budget = grant; task.budgetRevision = ++this.revision;
        task.resourceState = grant.cpuMilliCores ? grant.cpuMilliCores < (task.requested.cpuMilliCores || RESOURCE_PROFILES[task.type].cpuMilliCores) ? "throttled" : "normal"
          : task.status === "queued" ? "waiting" : "suspended";
        task.reason = grant.reason;
        const worker = this.workers.get(task.instanceId);
        if (worker?.epoch === task.epoch) worker.send({ type: "resource_budget", epoch: task.epoch, taskId: task.taskId, revision: task.budgetRevision, budget: grant });
      }
      domain.available = { cpuMilliCores: Math.max(0, raw), factor: domain.factor, sampleFresh: Boolean(fresh) };
    }
    this.emit("change", { revision: ++this.revision });
  }
  publicTask(task) {
    const { epoch, domain, requested, orphanUntil, reducing, handoverManual, ...value } = task;
    const released = RESOURCE_TERMINAL.has(task.status) && !(task.orphanUntil > this.now());
    return { ...value, resourceState: released ? "released" : task.orphanUntil > this.now() ? "reclaiming" : task.resourceState,
      budget: released && task.budget ? { ...task.budget, cpuMilliCores: 0, readBytesPerSecond: 0, processBytesPerSecond: 0, transferBytesPerSecond: 0, parallelism: 0 } : task.budget,
      enforcement: task.type === "log_search" ? "cooperative" : task.type === "mongo_bulk" ? "batch_dispatch" : "admission",
      elapsedMs: Math.max(0, (task.finishedAt || this.now()) - task.createdAt) };
  }
  list(instanceId, { offset = 0, limit = 50 } = {}) {
    const tasks = [...this.tasks.values()].filter((t) => t.instanceId === instanceId).sort((a, b) => Number(RESOURCE_TERMINAL.has(a.status)) - Number(RESOURCE_TERMINAL.has(b.status)) || Number(b.resourceMode === "manual_max") - Number(a.resourceMode === "manual_max") || b.createdAt - a.createdAt);
    const domain = this.domain(instanceId);
    return { tasks: tasks.slice(offset, offset + limit).map((t) => this.publicTask(t)), total: tasks.length,
      nextOffset: offset + limit < tasks.length ? offset + limit : null,
      pool: { domain: domain.id, policy: this.policy, sample: domain.sample, available: domain.available }, revision: this.revision };
  }
  close() { clearInterval(this.timer); this.workers.clear(); }
}
