// Serialized for remote Node 12+. All enforcement is cooperative; no OS quotas.
export function createRemoteResourceRuntime(initial, options = {}) {
  const started = Date.now(), initialCpu = process.cpuUsage();
  let budget = { cpuMilliCores: initial.cpuPercent * 10, readBytesPerSecond: initial.readBytesPerSecond,
    processBytesPerSecond: initial.processBytesPerSecond, rssLimitBytes: initial.rssLimitBytes, ...initial.resourceBudget };
  let revision = 0, readBytes = 0, processedBytes = 0, peakRssBytes = 0;
  let readDue = 0, processDue = 0, cpuDue = 0, lastCpu = 0, lastLease = Date.now();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cpuMs = () => { const value = process.cpuUsage(initialCpu); return (value.user + value.system) / 1000; };
  function snapshot() {
    const rssBytes = process.memoryUsage().rss; peakRssBytes = Math.max(peakRssBytes, rssBytes);
    return { rssBytes, peakRssBytes, cpuMs: cpuMs(), readBytes, processedBytes,
      elapsedMs: Date.now() - started, budget, budgetRevision: revision,
      resourceState: budget.cpuMilliCores === 0 ? "suspended" : budget.cpuMilliCores < initial.cpuPercent * 10 ? "throttled" : "normal" };
  }
  function health() {
    options.assertActive?.();
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    if (peakRssBytes > budget.rssLimitBytes) throw Object.assign(new Error("remote task RSS threshold exceeded"), { code: options.memoryErrorCode || "RESOURCE_MEMORY_LIMIT" });
    if (initial.resourceLeaseRequired && Date.now() - lastLease > 60000) throw Object.assign(new Error("resource lease expired"), { code: "RESOURCE_LEASE_EXPIRED" });
  }
  function update(next, nextRevision) {
    if (!Number.isInteger(nextRevision) || nextRevision <= revision) return false;
    for (const key of ["cpuMilliCores", "readBytesPerSecond", "processBytesPerSecond", "rssLimitBytes"]) {
      if (!Number.isFinite(next[key]) || next[key] < 0 || next[key] > (key === "cpuMilliCores" ? 64000 : 64 * 1024 ** 3)) throw Object.assign(new Error("invalid resource budget"), { code: "RESOURCE_PROTOCOL" });
    }
    // Heap/RSS safety ceilings are fixed at launch, even in manual maximum mode.
    budget = { ...next, rssLimitBytes: Math.min(next.rssLimitBytes, initial.rssLimitBytes) };
    revision = nextRevision; lastLease = Date.now();
    readDue = processDue = cpuDue = 0; lastCpu = cpuMs();
    return true;
  }
  async function consume(kind, bytes = 0) {
    health();
    if (kind === "read") readBytes += bytes;
    if (kind === "process") processedBytes += bytes;
    let accountedRevision = -1;
    while (true) {
      health();
      if (accountedRevision !== revision) {
        const now = Date.now(), used = cpuMs(), delta = Math.max(0, used - lastCpu); lastCpu = used;
        if (kind === "read" && budget.readBytesPerSecond) readDue = Math.max(readDue, now) + bytes * 1000 / budget.readBytesPerSecond;
        if (kind === "process" && budget.processBytesPerSecond) processDue = Math.max(processDue, now) + bytes * 1000 / budget.processBytesPerSecond;
        if (budget.cpuMilliCores) cpuDue = Math.max(cpuDue, now - delta) + delta * 1000 / budget.cpuMilliCores;
        accountedRevision = revision;
      }
      const wait = Math.max(readDue, processDue, cpuDue) - Date.now();
      const suspended = !budget.cpuMilliCores || kind === "read" && !budget.readBytesPerSecond || kind === "process" && !budget.processBytesPerSecond;
      if (!suspended && !options.isPaused?.() && wait <= 0) break;
      await delay(suspended || options.isPaused?.() ? 100 : Math.min(100, Math.max(1, wait)));
    }
    await new Promise((resolve) => setImmediate(resolve)); health();
  }
  return { consume, health, snapshot, update, renew: () => { lastLease = Date.now(); } };
}
