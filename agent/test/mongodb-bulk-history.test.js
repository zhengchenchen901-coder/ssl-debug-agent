import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createBulkHistoryReader } from "../mongodb-bulk-history.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rda-history-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mcp = path.join(root, "logs", "mcp-error.log"), worker = path.join(root, ".remote-debug", "instances", "isolated", "audit.jsonl");
  await fs.mkdir(path.dirname(mcp), { recursive: true, mode: 0o700 }); await fs.mkdir(path.dirname(worker), { recursive: true, mode: 0o700 });
  const time = "2026-10-26T02:21:28.158Z";
  const start = { time, code: "MCP_TOOLS_CALL_STARTED", operationId: "original-operation", toolName: "remote_debug_mongodb_prepare_bulk", arguments: { instanceId: "isolated", jobId: "original-job", chunkIndex: 0 } };
  const failed = { time, code: "MCP_TOOLS_CALL_FAILED", operationId: start.operationId, toolName: start.toolName, error: { code: "MONGODB_BULK_FIELD_REJECTED", message: "PRIVATE_VALUE" } };
  const audit = { time, tool: "mongodb-bulk-upload", operationId: start.operationId, ok: false, errorCode: "MONGODB_BULK_FIELD_REJECTED", errorLayer: "mongodb-bulk", errorPhase: "validation" };
  const write = async (p, rows) => fs.writeFile(p, rows.map(x => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
  await write(mcp, [start, failed]); await write(worker, [audit]);
  const reader = createBulkHistoryReader({ dataDirectory: root, instance: () => ({ id: "isolated" }) });
  const input = { record: { started: Date.parse(time), identity: { jobId: "original-job", chunkIndex: 0 } }, target: { id: "isolated" } };
  return { root, mcp, worker, start, failed, audit, write, read: () => reader(input), input };
}

test("old MCP/worker records remain diagnostic and never fabricate intent or digest proof", async (t) => {
  const f = await fixture(t), result = await f.read();
  assert.equal(result.trust, "diagnostic_only"); assert.equal(result.intentBound, false); assert.equal(result.requestDigestBound, false);
  assert.equal(result.candidateCount, 1); assert.equal(result.mcp.complete, true); assert.equal(result.worker.complete, true);
  assert.equal(result.worker.matches[0].validationRejected, true);
  assert.match(result.worker.matches[0].sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_VALUE/);
  await f.write(f.worker, [{ ...f.audit, intentId: "forged", requestDigest: "a".repeat(64), dispatchState: "not_dispatched" }]);
  const forged = await f.read(); assert.equal(forged.intentBound, false); assert.equal(forged.requestDigestBound, false);
});

for (const field of ["jobId", "chunkIndex", "instanceId"]) test(`historical logs for another ${field} are not attached to this intent`, async (t) => {
  const f = await fixture(t);
  await f.write(f.mcp, [{ ...f.start, arguments: { ...f.start.arguments, [field]: field === "chunkIndex" ? 1 : "different" } }, f.failed]);
  const result = await f.read(); assert.equal(result.candidateCount, 0); assert.equal(result.worker.matches.length, 0);
});

for (const scenario of ["missing", "malformed", "partial-tail", "long-line", "oversized", "symlink", "hardlink", "writable"]) test(`bounded historical log reader reports ${scenario} without releasing protection`, async (t) => {
  const f = await fixture(t);
  if (scenario === "missing") await fs.unlink(f.mcp);
  if (scenario === "malformed") await fs.appendFile(f.mcp, "not-json\n");
  if (scenario === "partial-tail") await fs.appendFile(f.mcp, JSON.stringify(f.failed));
  if (scenario === "long-line") await fs.appendFile(f.mcp, "x".repeat(64 * 1024 + 1) + "\n");
  if (scenario === "oversized") await fs.truncate(f.mcp, 64 * 1024 * 1024 + 1);
  if (scenario === "symlink") { await fs.unlink(f.mcp); await fs.symlink(f.worker, f.mcp); }
  if (scenario === "hardlink") await fs.link(f.mcp, path.join(f.root, "linked.log"));
  if (scenario === "writable") await fs.chmod(f.mcp, 0o666);
  const result = await f.read(); assert.equal(result.mcp.complete, false);
  const status = { missing: "missing", malformed: "incomplete", "partial-tail": "incomplete", "long-line": "budget_exceeded", oversized: "budget_exceeded", symlink: "unsafe", hardlink: "unsafe", writable: "unsafe" }[scenario];
  assert.equal(result.mcp.status, status); assert.equal(result.intentBound, false);
});
