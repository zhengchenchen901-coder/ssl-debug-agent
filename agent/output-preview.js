import { randomUUID } from "node:crypto";

const MAX_WIRE_BYTES = 8 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const INSTANCE = /^[a-zA-Z0-9._-]{1,128}$/;
const KEYS = new Set(["sessionId", "sourceSequence", "operationId", "requestId", "toolName", "instanceId", "durationMs", "wireMessage", "droppedBefore"]);

function invalid() {
  return Object.assign(new Error("Invalid output preview record"), { statusCode: 400, code: "OUTPUT_PREVIEW_INVALID" });
}

function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !KEYS.has(key))) throw invalid();
  if (!UUID.test(input.sessionId) || !UUID.test(input.operationId) || !Number.isSafeInteger(input.sourceSequence) || input.sourceSequence < 1 ||
      !/^(?:remote_debug_[a-z0-9_]{1,100}|unknown)$/.test(input.toolName) ||
      input.instanceId !== null && (typeof input.instanceId !== "string" || !INSTANCE.test(input.instanceId)) ||
      !Number.isSafeInteger(input.durationMs) || input.durationMs < 0 || !Number.isSafeInteger(input.droppedBefore) || input.droppedBefore < 0 ||
      typeof input.wireMessage !== "string" || Buffer.byteLength(input.wireMessage) > MAX_WIRE_BYTES) throw invalid();
  if (input.requestId !== null && typeof input.requestId !== "number" && typeof input.requestId !== "string" ||
      typeof input.requestId === "string" && input.requestId.length > 128 || typeof input.requestId === "number" && !Number.isSafeInteger(input.requestId)) throw invalid();
  let message, payload;
  try {
    message = JSON.parse(input.wireMessage);
    const result = message.result;
    if (message.jsonrpc !== "2.0" || !Object.hasOwn(message, "id") || Object.keys(message).some((key) => !["jsonrpc", "id", "result"].includes(key)) || !result ||
        Object.keys(result).some((key) => !["isError", "content"].includes(key)) ||
        Object.hasOwn(result, "isError") && typeof result.isError !== "boolean" ||
        !Array.isArray(result.content) || result.content.length !== 1 || result.content[0].type !== "text" || typeof result.content[0].text !== "string" ||
        Object.keys(result.content[0]).some((key) => !["type", "text"].includes(key))) throw invalid();
    payload = JSON.parse(result.content[0].text);
    if (payload?.outputGuard?.policyVersion !== 1 && payload?.error?.code !== "OUTPUT_GUARD_BLOCKED") throw invalid();
  } catch { throw invalid(); }
  return { message, payload };
}

// Dedicated, memory-only cache. No activity/audit payloads enter this store.
export function createOutputPreviewStore({ maxInstanceBytes = 10 * 1024 * 1024, maxBytes = 50 * 1024 * 1024, maxInstanceEvents = 100, maxEvents = 500 } = {}) {
  const epoch = randomUUID(), records = new Map(), listeners = new Set();
  let sequence = 0, bytes = 0, lastEvicted = 0;

  function evict(id) {
    const entry = records.get(id);
    if (!entry) return;
    records.delete(id);
    bytes -= entry.bytes;
    // Track when eviction happened, not the old record's sequence. A browser
    // can have a newer cursor while still displaying that older record.
    lastEvicted = sequence;
  }

  function snapshot(cursor) {
    const split = typeof cursor === "string" ? cursor.split(":") : [];
    const after = Number(split[1]);
    const valid = split.length === 2 && split[0] === epoch && Number.isSafeInteger(after) && after >= 0 && after <= sequence;
    const gap = Boolean(cursor) && (!valid || after < lastEvicted);
    return { cursor: `${epoch}:${sequence}`, reset: !valid || gap, gap,
      records: [...records.values()].filter((entry) => !valid || gap || entry.summary.sequence > after).map((entry) => entry.summary) };
  }

  function publish(input) {
    const { message, payload } = validate(input);
    const id = `${input.sessionId}:${input.sourceSequence}`;
    if (records.has(id)) return records.get(id).summary;
    const previousIds = [...records.keys()];
    const summary = {
      id, sequence: ++sequence, time: new Date().toISOString(), instanceId: input.instanceId,
      sessionId: input.sessionId, operationId: input.operationId,
      requestId: typeof message.id === "string" ? message.id.slice(0, 128) : Number.isSafeInteger(message.id) ? message.id : null,
      toolName: input.toolName, durationMs: input.durationMs, bytes: Buffer.byteLength(input.wireMessage),
      isError: Boolean(message.result.isError || payload?.ok === false), blocked: payload?.error?.code === "OUTPUT_GUARD_BLOCKED",
      outputGuard: payload?.outputGuard ? {
        policyVersion: 1,
        replacements: Number.isSafeInteger(payload.outputGuard.replacements) ? payload.outputGuard.replacements : 0,
        omittedFields: Number.isSafeInteger(payload.outputGuard.omittedFields) ? payload.outputGuard.omittedFields : 0,
      } : null,
      droppedBefore: input.droppedBefore,
    };
    // Count both the wire string and the bounded metadata against cache limits.
    const size = summary.bytes + Buffer.byteLength(JSON.stringify(summary));
    records.set(id, { summary, wireMessage: input.wireMessage, bytes: size });
    bytes += size;
    const instanceEntries = [...records.values()].filter((entry) => entry.summary.instanceId === input.instanceId);
    let instanceBytes = instanceEntries.reduce((total, entry) => total + entry.bytes, 0);
    while (instanceEntries.length > maxInstanceEvents || instanceBytes > maxInstanceBytes) {
      const entry = instanceEntries.shift();
      instanceBytes -= entry.bytes;
      evict(entry.summary.id);
    }
    while (records.size > maxEvents || bytes > maxBytes) evict(records.keys().next().value);
    // Small notices carry no tool content. Full messages use a separate GET.
    const event = { cursor: `${epoch}:${sequence}`, reset: false, gap: false,
      records: records.has(id) ? [summary] : [], evictedIds: previousIds.filter((key) => !records.has(key)) };
    for (const listener of listeners) listener(event);
    return summary;
  }

  function get(id) {
    const entry = records.get(id);
    return entry ? { ...entry.summary, wireMessage: entry.wireMessage } : null;
  }

  function removeInstance(instanceId) {
    sequence++;
    for (const [id, entry] of records) if (entry.summary.instanceId === instanceId) evict(id);
    for (const listener of listeners) listener(snapshot());
  }

  function stream(request, response) {
    if (listeners.size >= 16) return response.status(429).json({ ok: false, error: { code: "OUTPUT_PREVIEW_STREAM_LIMIT", message: "Too many preview connections" } });
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    response.flushHeaders?.();
    const write = (event) => {
      if (response.destroyed || response.writableEnded) return;
      response.write(`event: preview\ndata: ${JSON.stringify(event)}\n\n`);
      // Bound buffering for an abandoned/slow browser.
      if (response.writableLength > 1024 * 1024) response.destroy();
    };
    listeners.add(write);
    write(snapshot(request.query.cursor));
    const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    heartbeat.unref?.();
    response.on("close", () => { clearInterval(heartbeat); listeners.delete(write); });
  }

  return { publish, snapshot, get, stream, removeInstance };
}

export function installOutputPreviewRoutes(app, store, registry) {
  app.post("/api/output-preview/records", (request, response) => {
    try {
      const input = request.body;
      // Only inspect bounded instance IDs; unknown/deleted instances are global.
      if (typeof input?.instanceId === "string" && INSTANCE.test(input.instanceId) && !registry.getInternal(input.instanceId)) input.instanceId = null;
      const record = store.publish(input);
      response.status(202).json({ ok: true, id: record.id });
    } catch { response.status(400).json({ ok: false, error: { code: "OUTPUT_PREVIEW_INVALID", message: "Invalid output preview record" } }); }
  });
  app.get("/api/output-preview/records", (request, response) => response.json({ ok: true, ...store.snapshot(request.query.cursor) }));
  app.get("/api/output-preview/events", (request, response) => store.stream(request, response));
  app.get("/api/output-preview/records/:id", (request, response) => {
    const record = store.get(request.params.id);
    if (!record) return response.status(410).json({ ok: false, error: { code: "OUTPUT_PREVIEW_EXPIRED", message: "Preview record has expired from memory" } });
    response.json({ ok: true, record });
  });
}
