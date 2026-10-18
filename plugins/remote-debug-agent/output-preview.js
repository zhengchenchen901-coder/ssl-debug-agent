import { randomUUID } from "node:crypto";

// Inputs contain generated correlation values plus untrusted instance/request IDs.
// If the guard itself is unavailable, preserve visibility of its fixed block
// response using only generated values and fixed metadata, with no input echo.
export function outputPreviewMetadata(guard, input) {
  try {
    const safe = guard.sanitize(input).value;
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if (!uuid.test(safe.sessionId) || !uuid.test(safe.operationId) || !Number.isSafeInteger(safe.sourceSequence) ||
        !Number.isSafeInteger(safe.durationMs)) throw new Error("metadata blocked");
    if (typeof safe.instanceId !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(safe.instanceId)) safe.instanceId = null;
    if (typeof safe.requestId === "string" && safe.requestId.length > 128) safe.requestId = null;
    return safe;
  } catch {
    return { sessionId: input.sessionId, sourceSequence: input.sourceSequence,
      operationId: randomUUID(), requestId: null, toolName: "unknown", instanceId: null, durationMs: 0 };
  }
}

// Best-effort telemetry: no manager startup, retries, disk writes or stdout.
export function createOutputPreviewPublisher({ send, maxBytes = 20 * 1024 * 1024, maxEvents = 64 } = {}) {
  const queue = [];
  let bytes = 0, running = false, dropped = 0;

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const item = queue[0];
        const skipped = dropped;
        try {
          await send(item.settings, { ...item.event, droppedBefore: skipped });
          dropped -= skipped;
        } catch { dropped++; }
        queue.shift();
        bytes -= item.bytes;
      }
    } finally { running = false; }
  }

  function publish(settings, event) {
    if (!settings) return;
    const size = Buffer.byteLength(JSON.stringify(event));
    if (queue.length >= maxEvents || bytes + size > maxBytes) { dropped++; return; }
    queue.push({ settings, event, bytes: size });
    bytes += size;
    // Never await telemetry in the tool response path.
    void drain();
  }

  return { publish };
}
