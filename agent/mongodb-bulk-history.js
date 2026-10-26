import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_LINES = 200000;

// Historical text logs are corroboration, never an authenticated intent receipt.
// Paths come from Manager configuration, never from an MCP argument. Read a
// bounded snapshot without following links or exporting raw log/user content.
async function scan(filename, select) {
  let file;
  const result = { status: "unavailable", complete: false, matches: [] };
  try {
    for (let parent = path.dirname(filename); parent !== path.dirname(parent); parent = path.dirname(parent)) {
      const stat = await fs.lstat(parent);
      if (stat.isSymbolicLink() && !(process.platform === "darwin" && ["/var", "/tmp"].includes(parent))) {
        result.status = "unsafe"; return result;
      }
    }
    const constants = (await import("node:fs")).constants;
    file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || process.getuid && before.uid !== process.getuid() || before.mode & 0o022) {
      result.status = "unsafe"; return result;
    }
    if (before.size > MAX_BYTES) { result.status = "budget_exceeded"; return result; }
    result.snapshotBytes = before.size;
    let lineNumber = 0, invalid = false;
    if (before.size) {
      const lines = createInterface({ input: file.createReadStream({ start: 0, end: before.size - 1, autoClose: false }), crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (++lineNumber > MAX_LINES || Buffer.byteLength(line) > MAX_LINE_BYTES) { result.status = "budget_exceeded"; return result; }
          let row; try { row = JSON.parse(line); } catch { invalid = true; continue; }
          const value = select(row);
          if (value) {
            if (result.matches.length >= 100) { result.status = "budget_exceeded"; return result; }
            result.matches.push({ ...value, line: lineNumber, sha256: createHash("sha256").update(line).digest("hex") });
          }
        }
      } finally { lines.close(); }
      const last = Buffer.alloc(1); await file.read(last, 0, 1, before.size - 1);
      if (last[0] !== 10) invalid = true;
    }
    const after = await file.stat();
    const current = await fs.lstat(filename);
    if (current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink() ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      result.status = "changed"; return result;
    }
    result.status = invalid ? "incomplete" : "read";
    result.complete = !invalid;
    return result;
  } catch (error) {
    result.status = error.code === "ENOENT" ? "missing" : error.code === "ELOOP" ? "unsafe" : "unavailable";
    return result;
  } finally { await file?.close(); }
}

export function createBulkHistoryReader({ dataDirectory, instance } = {}) {
  return async ({ record, target }) => {
    const current = instance(target.id), identity = record.identity || {};
    const inWindow = (row) => Number.isFinite(record.started) && Date.parse(row.time) >= record.started - 10000 && Date.parse(row.time) <= record.started + 900000;
    const mcp = await scan(path.join(dataDirectory, "logs", "mcp-error.log"), (row) => {
      if (!inWindow(row) || row.toolName !== "remote_debug_mongodb_prepare_bulk" || !/^[A-Za-z0-9._:-]{1,128}$/.test(row.operationId || "")) return;
      if (row.code === "MCP_TOOLS_CALL_STARTED" && row.arguments?.instanceId === target.id && row.arguments.jobId === identity.jobId && row.arguments.chunkIndex === identity.chunkIndex) {
        return { operationId: row.operationId, kind: "mcp_started", code: row.code };
      }
      if (row.code === "MCP_TOOLS_CALL_FAILED") return { operationId: row.operationId, kind: "mcp_failed", code: /^[A-Z][A-Z0-9_]{1,80}$/.test(row.error?.code || "") ? row.error.code : "UNKNOWN" };
    });
    const ids = new Set(mcp.matches.filter((row) => row.kind === "mcp_started").map((row) => row.operationId));
    mcp.matches = mcp.matches.filter((row) => ids.has(row.operationId));
    const worker = await scan(current?.auditLog || path.join(dataDirectory, ".remote-debug", "instances", target.id, "audit.jsonl"), (row) => {
      if (!inWindow(row) || row.tool !== "mongodb-bulk-upload" || !ids.has(row.operationId)) return;
      return { operationId: row.operationId, kind: "worker_audit", code: /^[A-Z][A-Z0-9_]{1,80}$/.test(row.errorCode || "") ? row.errorCode : "UNKNOWN",
        validationRejected: row.ok === false && row.errorLayer === "mongodb-bulk" && row.errorPhase === "validation" };
    });
    return { trust: "diagnostic_only", intentBound: false, requestDigestBound: false,
      candidateCount: ids.size, mcp, worker };
  };
}
