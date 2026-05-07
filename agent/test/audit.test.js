import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAuditEntry, writeAuditLog } from "../audit.js";

test("builds audit entries without secret material", () => {
  const entry = buildAuditEntry(
    {
      tool: "run",
      cmd: "ps aux",
      ok: true,
      durationMs: 12,
      stdout: "hello",
      stderr: "",
    },
    () => new Date("2026-05-07T10:00:00.000Z"),
  );

  assert.deepEqual(entry, {
    time: "2026-05-07T10:00:00.000Z",
    tool: "run",
    cmd: "ps aux",
    path: undefined,
    ok: true,
    durationMs: 12,
    stdoutLength: 5,
    stderrLength: 0,
    contentLength: 0,
    errorCode: undefined,
  });
});

test("writes JSONL audit records", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-debug-audit-"));
  const logPath = path.join(dir, "audit.jsonl");

  await writeAuditLog(
    logPath,
    {
      tool: "list-dir",
      path: "/var/log",
      ok: true,
      durationMs: 3,
      contentLength: 22,
    },
    () => new Date("2026-05-07T10:00:00.000Z"),
  );

  const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).path, "/var/log");
});

