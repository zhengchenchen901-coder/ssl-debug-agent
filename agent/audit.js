import fs from "node:fs/promises";
import path from "node:path";

function safeLength(value) {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

export function buildAuditEntry(event, now = () => new Date()) {
  const entry = {
    time: now().toISOString(),
    tool: event.tool,
    cmd: event.cmd,
    path: event.path,
    ok: Boolean(event.ok),
    durationMs: event.durationMs,
    stdoutLength: event.stdoutLength ?? safeLength(event.stdout),
    stderrLength: event.stderrLength ?? safeLength(event.stderr),
    contentLength: event.contentLength ?? safeLength(event.content),
    errorCode: event.errorCode,
  };

  for (const key of [
    "instanceId",
    "draftId",
    "commandHash",
    "commandIndex",
    "commandCount",
    "commandPreview",
    "operationId",
    "category",
    "prefix",
    "limit",
    "cursor",
    "memberPath",
    "compression",
    "hasMore",
    "truncated",
    "scannedEntries",
    "sourceCount",
    "warningCount",
    "scannedBytes",
    "archiveScannedBytes",
    "scannedTruncated",
    "totalLines",
    "matchedLines",
    "connectionGeneration",
    "queueMs",
    "connectMs",
    "validationMs",
    "executionMs",
    "errorLayer",
    "errorPhase",
    "operation",
    "database",
    "collection",
    "resultCount",
    "decision",
    "reviewReason",
    "staticViolationCodes",
    "violationCodes",
    "modelDecision",
    "modelAttempts",
    "modelDurationMs",
    "execution",
  ]) {
    if (event[key] !== undefined) {
      entry[key] = event[key];
    }
  }

  return entry;
}

export async function writeAuditLog(logPath, event, now) {
  const entry = buildAuditEntry(event, now);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

