// Serialized separately for remote Node 12+. No remote files or daemon install.
export function remoteLogJob() {
  const readline = require("readline");
  const { once } = require("events");
  const controls = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let input, paused = false, pausedAt = 0, cancelled = false, lastHeartbeat = Date.now();
  let finished = false, watchdog, lastPublished = 0, readBytes = 0, processedBytes = 0;
  let started, runtime, resourceRuntime;
  let selectedFiles, activeIndex = null, nextIndex = 0, stopIndex = null;
  let remainingFrom = "", remainingTo = "";
  const receipts = new Map();
  const error = (code, message) => Object.assign(new Error(message), { code });
  const resources = () => resourceRuntime.snapshot();
  const publish = (type, value) => {
    // A slow transport may drop redundant progress; final results are drained.
    if (type === "progress" && process.stdout.writableLength > 65536) return;
    return process.stdout.write(JSON.stringify({ type, ...value }) + "\n");
  };
  const snapshot = () => ({ ...(runtime.progress ? runtime.progress() : {}), resources: resources(),
    status: cancelled ? "cancelling" : paused ? "paused" : stopIndex !== null ? "stopping" : "running",
    remainingDateFrom: remainingFrom, remainingDateTo: remainingTo, stopAfterFile: stopIndex === null ? null : selectedFiles?.[stopIndex]?.path,
    countsAreComplete: false });
  const health = () => {
    if (cancelled) throw error("LOG_JOB_CANCELLED", "log query cancelled");
    if (Date.now() >= input.deadlineAt) throw error("LOG_JOB_TIMEOUT", "log query task deadline exceeded");
    if (Date.now() - lastHeartbeat > 60000) throw error("LOG_JOB_CONTROLLER_LOST", "log query controller heartbeat lost");
    if (paused && Date.now() - pausedAt >= input.pauseTtlMs) throw error("LOG_JOB_PAUSE_EXPIRED", "paused log query expired");

  };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function check(kind, bytes, progress) {
    if (progress) runtime.progress = progress;
    await resourceRuntime.consume(kind, bytes);
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
  async function fileResult(receipt) {
    const receiptId = String(receipt.fileIndex);
    let acknowledged = false;
    receipts.set(receiptId, () => { acknowledged = true; });
    try {
      if (publish("file_result", { receiptId, receipt, progress: snapshot() }) === false) await once(process.stdout, "drain");
      const until = Date.now() + 15000;
      while (!acknowledged) {
        health();
        if (Date.now() > until) throw error("LOG_JOB_RECEIPT_TIMEOUT", "file receipt was not acknowledged");
        await delay(10);
      }
    } finally { receipts.delete(receiptId); activeIndex = null; }
  }
  controls.on("line", async (line) => {
    if (finished) return;
    try {
      if (Buffer.byteLength(line) > (input ? 32768 : 512 * 1024)) throw error("LOG_JOB_PROTOCOL", "oversized control frame");
      const message = JSON.parse(line);
      if (!input) {
        if (message.type !== "start") throw error("LOG_JOB_PROTOCOL", "expected start frame");
        input = message.input;
        started = Date.now(); lastHeartbeat = started;
        resourceRuntime = createRemoteResourceRuntime(input, { assertActive: health,
          isPaused: () => paused, memoryErrorCode: "LOG_JOB_MEMORY_LIMIT" });
        remainingFrom = input.dateFrom; remainingTo = input.dateTo;
        runtime = { check, evidence: (record) => publish("evidence", { record, progress: snapshot() }),
          configureFiles: (files) => {
            selectedFiles = files;
            if (input.stopAfterFile) {
              stopIndex = files.findIndex((file) => file.path === input.stopAfterFile);
              if (stopIndex < 0) throw error("INVALID_LOG_JOB_BOUNDARY", "stopAfterFile is outside the selected files");
            }
          },
          beforeFile: async (file, index) => {
            nextIndex = index;
            await check("boundary", 0);
            if (stopIndex !== null && index > stopIndex) return "stop";
            const date = /\d{4}-\d{2}-\d{2}/.exec(file.name)?.[0];
            if ((remainingFrom || remainingTo) && (!date || remainingFrom && date < remainingFrom || remainingTo && date > remainingTo)) return "skip";
            activeIndex = index; nextIndex = index + 1;
            return "read";
          },
          fileStarted: (receipt) => publish("file_started", { receipt }), fileResult,
        };
        watchdog = setInterval(() => {
          try {
            resourceRuntime.health();
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
      else if (message.type === "resource_renew") resourceRuntime.renew();
      else if (message.type === "resource_update") {
        resourceRuntime.update(message.budget, message.revision);
        publish("resource_ack", { revision: message.revision, resources: resources() });
      }
      else if (message.type === "receipt_ack") receipts.get(message.receiptId)?.();
      else if (["stop_after_file", "narrow"].includes(message.type)) {
        try {
          if (!selectedFiles) throw error("LOG_JOB_NOT_READY", "file selection is not ready yet");
          if (message.type === "stop_after_file") {
            let target = message.stopAfterFile;
            if (target && !selectedFiles.some((file) => file.path === target)) {
              try { target = await require("fs").promises.realpath(target); }
              catch { throw error("INVALID_LOG_JOB_BOUNDARY", "stopAfterFile is outside the selected files"); }
            }
            if (finished) return;
            const index = target ? selectedFiles.findIndex((file) => file.path === target) : activeIndex ?? nextIndex;
            if (index < 0 || index >= selectedFiles.length) throw error("INVALID_LOG_JOB_BOUNDARY", "stopAfterFile is outside the selected files");
            if (index < (activeIndex ?? nextIndex)) throw error("LOG_JOB_BOUNDARY_PASSED", "the requested file boundary has already passed");
            if (stopIndex !== null && index > stopIndex) throw error("INVALID_LOG_JOB_BOUNDARY", "cannot extend an existing stop boundary");
            stopIndex = index;
          } else {
            const from = message.dateFrom ?? remainingFrom, to = message.dateTo ?? remainingTo;
            if (remainingFrom && from < remainingFrom || remainingTo && to > remainingTo || from && to && from > to) throw error("INVALID_LOG_JOB_SCOPE", "remaining dates must narrow the existing range");
            remainingFrom = from; remainingTo = to;
          }
          publish("control_ack", { requestId: message.requestId, progress: snapshot(), ok: true });
        } catch (failure) {
          publish("control_ack", { requestId: message.requestId, ok: false, error: { code: failure.code, message: failure.message } });
        }
      }
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
