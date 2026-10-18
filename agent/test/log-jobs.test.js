import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { gzipSync, createGzip } from "node:zlib";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LogJobRunner, normalizeLogJob } from "../log-jobs.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = fn(); if (value) return value; await sleep(20); }
  throw new Error("timed out waiting for log query");
}
function tar(entries) {
  const chunks = [];
  for (const { name, content } of entries) {
    const body = Buffer.from(content), header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write("0000644\0", 100, 8);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    header.write("0", 156, 1); header.fill(32, 148, 156);
    header.write([...header].reduce((sum, b) => sum + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "log-jobs-")));
  const config = { security: { allowedPaths: [dir] }, logs: { projects: { be: { directories: [dir] } } } };
  const children = new Set(), calls = [];
  const runSSH = (command, options) => new Promise((resolve, reject) => {
    calls.push(command);
    const child = spawn("/bin/sh", ["-c", "exec " + command], { env: { ...process.env, PATH: path.dirname(process.execPath) + ":" + process.env.PATH } });
    children.add(child);
    const abort = () => child.kill("SIGTERM");
    options.operation.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => { try { options.onStdoutChunk(chunk); } catch (error) { child.kill(); reject(error); } });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (exitCode) => {
      children.delete(child); options.operation.signal.removeEventListener("abort", abort);
      if (options.operation.signal.aborted) reject(options.operation.signal.reason);
      else resolve({ exitCode });
    });
    child.stdin.write(options.stdin);
    options.onChannel(child.stdin);
  });
  const runner = new LogJobRunner({ config, runSSH });
  t.after(async () => { await runner.close(); for (const child of children) child.kill(); await fs.rm(dir, { recursive: true, force: true }); });
  const finished = (id, timeout) => waitFor(() => {
    const result = runner.get({ jobId: id, limit: 2000 });
    return ["completed", "partial", "stopped", "failed", "cancelled", "expired", "interrupted"].includes(result.status) && result;
  }, timeout);
  return { dir, config, runner, calls, children, finished };
}

test("background search automatically covers more than one file page and scan batch", async (t) => {
  const { dir, runner, calls, finished } = await fixture(t);
  for (let i = 0; i < 55; i++) await fs.writeFile(path.join(dir, `app.log.${i}`), "match 你好\n".repeat(200));
  const start = runner.start({ projectId: "be", contains: "match", batchScanBytes: 65536, limit: 3 });
  assert.equal(start.status, "queued");
  const result = await finished(start.jobId);
  assert.equal(result.status, "completed", JSON.stringify(result.error));
  assert.equal(result.matchedLines, 11000);
  assert.equal(result.completedFiles, 55);
  assert.ok(result.batchesCompleted > 1);
  assert.equal(result.countsAreComplete, true);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.records.length, 3);
  assert.equal(result.fileResultCount, 55);
  assert.equal(result.fileResults[0].scanComplete, true);
  assert.equal(result.fileResults[0].countsAreComplete, true);
  assert.equal(result.scanComplete, true);
  assert.equal(result.evidenceComplete, false);
  assert.equal(result.paginationScope, "retained_evidence");
  assert.equal(calls.length, 1);
  const page = runner.get({ jobId: start.jobId, limit: 1 });
  assert.equal(page.hasMoreRecords, true);
  assert.notEqual(runner.get({ jobId: start.jobId, offset: page.nextOffset, limit: 1 }).records[0].lineNumber, page.records[0].lineNumber);
});

test("archive members share one decompressor, preserve long UTF-8 lines and exact counts", async (t) => {
  const { dir, runner, calls, finished } = await fixture(t);
  const archive = path.join(dir, "archive.tar.gz");
  const line = "你好".repeat(20000) + " match\n";
  await fs.writeFile(archive, tar([
    { name: "info.log", content: "ignored\n".repeat(40000) },
    { name: "first-error.log", content: line + "match\n" },
    { name: "second-error.log", content: line },
  ]));
  const before = await fs.readdir(dir);
  const start = runner.start({ path: archive, memberContains: "-error.log", contains: "match", batchScanBytes: 65536, limit: 10 });
  const result = await finished(start.jobId);
  assert.equal(result.status, "completed", JSON.stringify(result.error));
  assert.equal(result.matchedLines, 3);
  assert.equal(result.completedMembers, 2);
  assert.equal(result.records.filter((r) => r.text === line.trimEnd()).length, 2);
  assert.ok(result.expandedBytes > result.scannedBytes);
  assert.equal(calls.length, 1);
  assert.deepEqual(await fs.readdir(dir), before);
});

test("pause/resume retain the stream, cancel releases the process and allows the next job", async (t) => {
  const { dir, runner, calls, children, finished } = await fixture(t);
  const file = path.join(dir, "app.log");
  await fs.writeFile(file, "match\n".repeat(60000));
  const first = runner.start({ path: file, contains: "match", processBytesPerSecond: 65536 });
  await waitFor(() => runner.find(first.jobId).channel);
  runner.control({ jobId: first.jobId, action: "pause" });
  await waitFor(() => runner.get({ jobId: first.jobId }).status === "paused");
  const paused = runner.get({ jobId: first.jobId }).progress.scannedBytes;
  await sleep(200);
  assert.equal(runner.get({ jobId: first.jobId }).progress.scannedBytes, paused);
  runner.control({ jobId: first.jobId, action: "resume" });
  await waitFor(() => runner.get({ jobId: first.jobId }).status === "running");
  const second = runner.start({ path: file, contains: "match" });
  assert.equal(second.status, "queued");
  runner.control({ jobId: first.jobId, action: "cancel" });
  assert.equal(runner.get({ jobId: first.jobId }).status, "cancelling");
  assert.equal(runner.get({ jobId: first.jobId }).progress.status, "cancelling");
  const cancelled = await finished(first.jobId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.progress.status, "cancelled");
  if (cancelled.progress.currentFileProgress) assert.notEqual(cancelled.progress.currentFileProgress.status, "running");
  const result = await finished(second.jobId);
  assert.equal(result.matchedLines, 60000);
  assert.equal(result.countsAreComplete, true);
  assert.equal(calls.length, 2);
  assert.equal(children.size, 0);
});

test("deadline, changed sources and oversized lines never produce complete counts", async (t) => {
  const { dir, runner, finished } = await fixture(t);
  const file = path.join(dir, "slow.log");
  await fs.writeFile(file, "match\n".repeat(100000));
  const start = runner.start({ path: file, contains: "match", processBytesPerSecond: 65536, jobTimeoutMs: 1000 });
  const expired = await finished(start.jobId);
  assert.equal(expired.status, "expired");
  assert.equal(expired.countsAreComplete, false);
  const next = runner.start({ path: file, contains: "match", processBytesPerSecond: 65536 });
  await waitFor(() => runner.find(next.jobId).channel);
  await sleep(100); await fs.appendFile(file, "changed\n");
  const changed = await finished(next.jobId);
  assert.equal(changed.countsAreComplete, false);
  assert.equal(changed.error?.code, "LOG_FILE_CHANGED");
  await fs.writeFile(file, "x".repeat(1100000) + "match\nmatch\n");
  const oversized = await finished(runner.start({ path: file, contains: "match" }).jobId);
  assert.equal(oversized.status, "partial");
  assert.equal(oversized.matchedLines, 1);
  assert.equal(oversized.countsAreComplete, false);
  assert.equal(oversized.scanComplete, true);
  assert.equal(oversized.fileResults[0].scanComplete, true);
  assert.equal(oversized.fileResults[0].countsAreComplete, false);
});

async function datedArchives(dir, count = 3, content = "match\n") {
  const paths = [];
  for (let i = 0; i < count; i++) {
    const file = path.join(dir, `2026-10-${17 - i}-logs.tar.gz`);
    await fs.writeFile(file, tar([{ name: "error.log", content }]));
    await fs.utimes(file, 100 - i, 100 - i); paths.push(file);
  }
  return paths;
}

test("an advance file boundary stops before the next archive and preserves paged completion receipts", async (t) => {
  const { dir, runner, finished } = await fixture(t);
  const paths = await datedArchives(dir);
  const job = runner.start({ projectId: "be", contains: "match", stopAfterFile: paths[1] });
  const result = await finished(job.jobId);
  assert.equal(result.status, "stopped", JSON.stringify(result.error));
  assert.equal(result.progress.status, "stopped");
  assert.equal(result.completedFiles, 2);
  assert.equal(result.countsAreComplete, false);
  assert.equal(result.scanComplete, false);
  assert.equal(result.stopReason, "file_boundary");
  assert.deepEqual(result.fileResults.map((r) => r.path), paths.slice(0, 2));
  for (const receipt of result.fileResults) {
    assert.equal(receipt.status, "completed"); assert.equal(receipt.countsAreComplete, true);
    assert.equal(receipt.matchedLines, 1); assert.ok(receipt.scannedBytes > 0);
    assert.equal(receipt.evidenceComplete, true); assert.ok(receipt.source.inode);
    assert.equal(receipt.queryId, job.jobId);
  }
  const first = runner.get({ jobId: job.jobId, fileLimit: 1 });
  assert.equal(first.hasMoreFileResults, true);
  assert.equal(runner.get({ jobId: job.jobId, fileOffset: first.nextFileOffset, fileLimit: 1 }).fileResults[0].path, paths[1]);
});

test("completed archive receipts survive cancellation without relying on previous polling", async (t) => {
  const { dir, runner, finished } = await fixture(t);
  const paths = await datedArchives(dir, 3, "match\n".repeat(12000));
  const job = runner.start({ projectId: "be", contains: "match", processBytesPerSecond: 65536, limit: 1 });
  await waitFor(() => runner.get({ jobId: job.jobId }).fileResults.some((r) => r.path === paths[1] && r.countsAreComplete), 15000);
  runner.control({ jobId: job.jobId, action: "cancel" });
  const result = await finished(job.jobId);
  assert.equal(result.status, "cancelled"); assert.equal(result.progress.status, "cancelled");
  assert.equal(result.countsAreComplete, false);
  const completed = result.fileResults.filter((r) => r.countsAreComplete);
  assert.deepEqual(completed.map((r) => r.path), paths.slice(0, 2));
  assert.ok(completed.every((r) => r.matchedLines === 12000));
  assert.equal(completed[1].evidenceComplete, false);
});

test("live boundary and range controls acknowledge changes and reject expansion and unknown targets", async (t) => {
  const { dir, runner, finished } = await fixture(t);
  const paths = await datedArchives(dir, 3, "match\n".repeat(12000));
  const job = runner.start({ projectId: "be", contains: "match", processBytesPerSecond: 65536 });
  await waitFor(() => runner.get({ jobId: job.jobId }).fileResultCount > 0);
  await assert.rejects(runner.control({ jobId: job.jobId, action: "stop_after_file", stopAfterFile: path.join(dir, "missing.log") }), /outside/);
  const accepted = await runner.control({ jobId: job.jobId, action: "stop_after_file", stopAfterFile: paths[1] });
  assert.equal(accepted.status, "stopping");
  assert.equal((await finished(job.jobId)).fileResultCount, 2);
  const next = runner.start({ projectId: "be", contains: "match", processBytesPerSecond: 65536 });
  await waitFor(() => runner.get({ jobId: next.jobId }).fileResultCount > 0);
  const narrowed = await runner.control({ jobId: next.jobId, action: "narrow", dateFrom: "2026-10-16" });
  assert.equal(narrowed.scopeControls.dateFrom, "2026-10-16");
  await assert.rejects(runner.control({ jobId: next.jobId, action: "narrow", dateFrom: "2026-10-15" }), /narrow/);
  const result = await finished(next.jobId);
  assert.equal(result.status, "stopped"); assert.equal(result.skippedFiles, 1);
  assert.equal(result.fileResults[2].status, "skipped");
  assert.equal(result.fileResults[2].scannedBytes, 0);
  assert.equal(result.countsAreComplete, false);
});

test("invalid and ignored-looking parameters fail before any remote scan", async (t) => {
  const { runner, dir, calls } = await fixture(t);
  for (const parameters of [{ fileContains: "" }, { memberPrefix: "error" }, { maxFiles: 1 }, { fileOffset: 0 },
    { contains: null }, { caseSensitive: "false" }, { limit: 2001 }, { maxBytes: 262145 },
    { typoDate: "2026-10-16" }, { memberContains: "error", path: path.join(dir, "plain.log") }]) {
    assert.throws(() => runner.start({ projectId: "be", ...parameters }), (error) => error.statusCode === 400);
  }
  assert.equal(calls.length, 0);
  const job = runner.start({ projectId: "be" });
  assert.throws(() => runner.get({ jobId: job.jobId, fileOffest: 1 }), /unknown/);
  assert.throws(() => runner.control({ jobId: job.jobId, action: "narrow" }), /requires/);
  assert.throws(() => runner.control({ jobId: job.jobId, action: "narrow", dateFrom: "2026-02-30" }), /invalid/);
  assert.throws(() => runner.control({ jobId: job.jobId, action: "pause", dateFrom: "2026-10-16" }), /do not apply/);
});

test("job policy bounds resources, queue size and retained task state", async (t) => {
  const { dir, config, runner } = await fixture(t);
  assert.equal(normalizeLogJob({ projectId: "be" }, config).maxExpandedBytes, Number.MAX_SAFE_INTEGER);
  for (const input of [{ cpuPercent: 100 }, { jobTimeoutMs: 7200001 }, { batchScanBytes: 1 }, { readBytesPerSecond: 0 }]) {
    assert.throws(() => runner.start({ projectId: "be", ...input }), /invalid/);
  }
  const file = path.join(dir, "app.log"); await fs.writeFile(file, "line\n");
  const queued = Array.from({ length: 4 }, () => runner.start({ path: file }));
  assert.throws(() => runner.start({ path: file }), /queue is full/);
  runner.control({ jobId: queued[2].jobId, action: "cancel" });
  assert.equal(runner.get({ jobId: queued[2].jobId }).status, "cancelled");
  assert.throws(() => runner.get({ jobId: "missing" }), /not found/);
});

test("terminal results expire without polling and partial transport output is never complete", async (t) => {
  const config = { security: { allowedPaths: ["/var/log"] } };
  const runner = new LogJobRunner({ config, runSSH: async (_command, options) => {
    options.onStdoutChunk(Buffer.from('{"type":"evidence","record":{"file":"/var/log/app.log","text":"match"},"progress":{"matchedLines":1}}\n'));
    assert.equal(runner.get({ jobId: options.operation.operationId }).records[0].text, "match");
    options.onStdoutChunk(Buffer.from('{"type":"progress","matchedLines":7,"scannedBytes":100}\n'));
    throw Object.assign(new Error("transport lost"), { code: "SSH_TRANSPORT_LOST" });
  } });
  t.after(() => runner.close());
  runner.retentionMs = 80;
  const start = runner.start({ path: "/var/log/app.log" });
  await waitFor(() => runner.find(start.jobId).status === "interrupted");
  const result = runner.get({ jobId: start.jobId });
  assert.equal(result.progress.matchedLines, 7);
  assert.equal(result.records[0].text, "match");
  assert.equal(result.countsAreComplete, false);
  assert.equal(runner.find(start.jobId).query.path, undefined);
  await sleep(120);
  assert.equal(runner.jobs.size, 0);
});

test("background sample budget accounts for JSON escaping and metadata", async (t) => {
  const { dir, runner, finished } = await fixture(t);
  const file = path.join(dir, "app.log");
  await fs.writeFile(file, 'match "\\'.repeat(40000) + '\n');
  const result = await finished(runner.start({ path: file, contains: "match", maxBytes: 1024 }).jobId);
  assert.equal(result.countsAreComplete, true);
  assert.equal(result.matchedLines, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result.records[0])) <= 1024);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.fileResults[0].evidenceComplete, false);
});

test("a selected gzip log continues beyond the synchronous 256 MiB scan ceiling", { skip: process.env.REMOTE_DEBUG_LARGE_LOG_TEST !== "1" }, async (t) => {
  const { dir, runner, calls, finished } = await fixture(t);
  const file = path.join(dir, "large.log.gz"), block = Buffer.from("x".repeat(65535) + "\n");
  await pipeline(Readable.from((async function* () {
    for (let i = 0; i < 4097; i++) yield block;
    yield Buffer.from("match after scan ceiling\n");
  })()), createGzip({ level: 1 }), createWriteStream(file));
  const job = runner.start({ path: file, contains: "match", cpuPercent: 50, processBytesPerSecond: 32 * 1024 * 1024 });
  const result = await finished(job.jobId, 90000);
  assert.equal(result.status, "completed", JSON.stringify(result.error));
  assert.equal(result.matchedLines, 1);
  assert.ok(result.scannedBytes > 256 * 1024 * 1024);
  assert.ok(result.batchesCompleted >= 1);
  assert.equal(calls.length, 1);
  t.diagnostic(JSON.stringify(result.resources));
});

test("an archive beyond 2 GiB reaches a late member in one bounded-memory traversal", { skip: process.env.REMOTE_DEBUG_LARGE_LOG_TEST !== "1" }, async (t) => {
  const { dir, runner, calls, finished } = await fixture(t);
  function header(name, size) {
    const block = Buffer.alloc(512);
    block.write(name); block.write("0000644\0", 100, 8);
    block.write(size.toString(8).padStart(11, "0") + "\0", 124, 12);
    block.write("0", 156, 1); block.fill(32, 148, 156);
    block.write([...block].reduce((sum, b) => sum + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
    return block;
  }
  const file = path.join(dir, "large.tar.gz"), size = 2 * 1024 * 1024 * 1024 + 65536;
  const evidence = Buffer.from("match late member\n"), zeroes = Buffer.alloc(65536);
  await pipeline(Readable.from((async function* () {
    yield header("padding.bin", size);
    for (let offset = 0; offset < size; offset += zeroes.length) yield zeroes;
    yield header("error.log", evidence.length); yield evidence;
    yield Buffer.alloc((512 - evidence.length % 512) % 512 + 1024);
  })()), createGzip({ level: 1 }), createWriteStream(file));
  const job = runner.start({ path: file, memberPath: "error.log", contains: "match",
    cpuPercent: 50, processBytesPerSecond: 32 * 1024 * 1024, jobTimeoutMs: 180000 });
  const result = await finished(job.jobId, 190000);
  assert.equal(result.status, "completed", JSON.stringify(result.error));
  assert.equal(result.countsAreComplete, true);
  assert.equal(result.matchedLines, 1);
  assert.ok(result.expandedBytes > 2 * 1024 * 1024 * 1024);
  assert.ok(result.resources.peakRssBytes < 128 * 1024 * 1024);
  assert.ok(result.resources.elapsedMs >= size / (32 * 1024 * 1024) * 1000);
  assert.equal(calls.length, 1);
  t.diagnostic(JSON.stringify(result.resources));
});
