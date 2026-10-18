// Serialized separately for remote Node 12+. No remote files or daemon install.
export function remoteLogJob() {
  const readline = require("readline");
  const { once } = require("events");
  const controls = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let input, paused = false, pausedAt = 0, cancelled = false, lastHeartbeat = Date.now();
  let finished = false, watchdog, lastPublished = 0, readBytes = 0, processedBytes = 0;
  let started, initialCpu, runtime;
  let readDue = 0, processDue = 0, cpuDue = 0, lastCpuMs = 0;
  let peakRssBytes = 0;
  const error = (code, message) => Object.assign(new Error(message), { code });
  const cpuMs = () => { const usage = process.cpuUsage(initialCpu); return (usage.user + usage.system) / 1000; };
  const resources = () => {
    const rssBytes = process.memoryUsage().rss;
    peakRssBytes = Math.max(peakRssBytes, rssBytes);
    return { rssBytes, peakRssBytes, cpuMs: cpuMs(), readBytes,
      processedBytes, elapsedMs: Date.now() - started };
  };
  const publish = (type, value) => {
    // A slow transport may drop redundant progress; final results are drained.
    if (type === "progress" && process.stdout.writableLength > 65536) return;
    return process.stdout.write(JSON.stringify({ type, ...value }) + "\n");
  };
  const snapshot = () => ({ ...(runtime.progress ? runtime.progress() : {}), resources: resources(),
    status: paused ? "paused" : "running", countsAreComplete: false });
  const health = () => {
    if (cancelled) throw error("LOG_JOB_CANCELLED", "log query cancelled");
    if (Date.now() >= input.deadlineAt) throw error("LOG_JOB_TIMEOUT", "log query task deadline exceeded");
    if (Date.now() - lastHeartbeat > 60000) throw error("LOG_JOB_CONTROLLER_LOST", "log query controller heartbeat lost");
    if (paused && Date.now() - pausedAt >= input.pauseTtlMs) throw error("LOG_JOB_PAUSE_EXPIRED", "paused log query expired");
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    if (peakRssBytes > input.rssLimitBytes) throw error("LOG_JOB_MEMORY_LIMIT", "log query RSS threshold exceeded");
  };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function check(kind, bytes, progress) {
    if (progress) runtime.progress = progress;
    health();
    if (kind === "read") readBytes += bytes;
    if (kind === "process") processedBytes += bytes;
    // Virtual clocks allow one chunk of burst without accumulating idle credit.
    // Process CPU includes zlib's worker threads.
    const now = Date.now();
    if (kind === "read") readDue = Math.max(readDue, now) + bytes * 1000 / input.readBytesPerSecond;
    if (kind === "process") processDue = Math.max(processDue, now) + bytes * 1000 / input.processBytesPerSecond;
    const usedCpu = cpuMs(), cpuDelta = Math.max(0, usedCpu - lastCpuMs);
    lastCpuMs = usedCpu;
    cpuDue = Math.max(cpuDue, now - cpuDelta) + cpuDelta * 100 / input.cpuPercent;
    while (true) {
      health();
      const wait = Math.max(readDue, processDue, cpuDue) - Date.now();
      if (!paused && wait <= 0) break;
      await delay(paused ? 100 : Math.min(100, Math.max(1, wait)));
    }
    // Yield between bounded chunks so controls/watchdogs run even for hot files.
    await new Promise((resolve) => setImmediate(resolve));
    health();
  }
  async function finish(type, value, exitCode) {
    if (finished) return;
    finished = true;
    clearInterval(watchdog);
    controls.close();
    process.stdin.destroy();
    if (publish(type, value) === false) await once(process.stdout, "drain");
    process.exitCode = exitCode;
  }
  controls.on("line", (line) => {
    if (finished) return;
    try {
      if (Buffer.byteLength(line) > (input ? 1024 : 512 * 1024)) throw error("LOG_JOB_PROTOCOL", "oversized control frame");
      const message = JSON.parse(line);
      if (!input) {
        if (message.type !== "start") throw error("LOG_JOB_PROTOCOL", "expected start frame");
        input = message.input;
        started = Date.now(); initialCpu = process.cpuUsage(); lastHeartbeat = started;
        runtime = { check, evidence: (record) => publish("evidence", { record, progress: snapshot() }) };
        watchdog = setInterval(() => {
          try {
            health();
            if (Date.now() - lastPublished >= 5000) {
              lastPublished = Date.now(); publish("progress", snapshot());
            }
          } catch (failure) {
            // Watchdog exit also covers a stalled file or a blocked SSH output.
            publish("error", { ...snapshot(), error: { code: failure.code, message: failure.message } });
            process.exit(1);
          }
        }, 250);
        // runRemoteLogQuery is defined in the separately compiled runtime.
        runRemoteLogQuery(input, runtime).then(
          (result) => finish("result", { result, resources: resources() }, 0),
          (failure) => finish("error", { ...snapshot(), error: { code: failure.code || "LOG_JOB_FAILED", message: failure.message } }, 1),
        ).catch(() => process.exit(1));
      } else if (message.type === "heartbeat") lastHeartbeat = Date.now();
      else if (message.type === "pause") { if (!paused) pausedAt = Date.now(); paused = true; publish("progress", snapshot()); }
      else if (message.type === "resume") { paused = false; pausedAt = 0; publish("progress", snapshot()); }
      else if (message.type === "cancel") cancelled = true;
      else throw error("LOG_JOB_PROTOCOL", "invalid control frame");
    } catch (failure) {
      publish("error", { error: { code: failure.code || "LOG_JOB_PROTOCOL", message: "invalid log job control frame" } });
      process.exit(1);
    }
  });
  controls.on("close", () => { if (!finished) cancelled = true; });
  // Do not leave a bootstrap process alive if its controller never starts it.
  const bootstrapTimeout = setTimeout(() => { if (!input) process.exit(1); }, 60000);
  bootstrapTimeout.unref();
}
