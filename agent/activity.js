import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_PREVIEW_CHARS = 4000;

function serializeSse(eventName, data) {
  const payload = JSON.stringify(data);
  return `event: ${eventName}\ndata: ${payload}\n\n`;
}

export function previewText(value, maxChars = DEFAULT_PREVIEW_CHARS) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }

  if (value.length <= maxChars) {
    return value;
  }

  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...[truncated ${omitted} chars]`;
}

export function byteLength(value) {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

export function createActivityLog(options = {}) {
  const maxEvents = options.maxEvents || DEFAULT_MAX_EVENTS;
  const emitter = new EventEmitter();
  const events = [];

  function publish(event) {
    const entry = {
      id: randomUUID(),
      time: new Date().toISOString(),
      ...event,
    };

    events.push(entry);
    if (events.length > maxEvents) {
      events.splice(0, events.length - maxEvents);
    }

    emitter.emit("activity", entry);
    return entry;
  }

  function list() {
    return events.slice();
  }

  function stream(request, response) {
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();

    const onActivity = (event) => {
      response.write(serializeSse("activity", event));
    };

    emitter.on("activity", onActivity);
    response.write(": connected\n\n");
    response.write(serializeSse("snapshot", { events: list() }));

    const keepAlive = setInterval(() => {
      response.write(": keepalive\n\n");
    }, 15000);

    request.on("close", () => {
      clearInterval(keepAlive);
      emitter.off("activity", onActivity);
    });
  }

  return {
    list,
    publish,
    stream,
  };
}
