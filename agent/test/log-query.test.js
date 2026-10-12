import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { buildLogQueryScript, normalizeLogQuery, queryLogs, LOG_QUERY_MARKER } from "../log-query.js";
import { normalizeLogProjects } from "../log-projects.js";
import { readLog, listLogArchiveMembers } from "../logs.js";
import { InstanceRegistry } from "../instance-registry.js";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "log-query-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { security: { allowedPaths: [dir] }, logs: { projects: { be: { root: dir, directories: [dir] } } } };
  const operation = { operationId: "query-test", deadlineAt: Date.now() + 30000 };
  const run = (args) => {
    const query = normalizeLogQuery(args, config);
    const output = execFileSync(process.execPath, [], { input: buildLogQueryScript(query, operation), encoding: "utf8", maxBuffer: 1024 * 1024 });
    return JSON.parse(output.trim().slice(LOG_QUERY_MARKER.length));
  };
  return { dir, config, operation, run };
}
function tar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.content || "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write("0000644\0", 100, 8);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    header.write(entry.type || "0", 156, 1);
    header.fill(32, 148, 156);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function record(route, timestamp, level = "error") {
  return JSON.stringify({ level, message: `[${timestamp}] ${JSON.stringify({ path: route, method: "POST", timestamp, value: "你好" })}` });
}

test("latest reads only the tail of a large file and returns newest records", async (t) => {
  const { dir, run } = await fixture(t);
  const file = path.join(dir, "2026-10-12-error.log");
  await fs.writeFile(file, "old\n".repeat(3 * 1024 * 1024) + "latest-1\nlatest-2\n");
  const result = run({ path: file, limit: 2 });
  assert.equal(result.mode, "latest");
  assert.deepEqual(result.records.map((record) => record.text), ["latest-2", "latest-1"]);
  assert.equal(result.records[0].lineFromEnd, 1);
  assert.ok(result.scannedBytes <= 32768);
  assert.equal(result.coverage, "tail");
  assert.equal(result.countsAreComplete, false);
});

test("project queries select dated filenames before exact structured route and time filtering", async (t) => {
  const { dir, run } = await fixture(t);
  await fs.writeFile(path.join(dir, "2026-10-12-error.log"), [
    record("/v3/order", "2026-10-12T01:00:00Z"),
    record("/v3/order_other", "2026-10-12T02:00:00Z"),
    record("/v3/order", "2026-10-12T03:00:00Z"),
  ].join("\n") + "\n");
  await fs.writeFile(path.join(dir, "2026-10-11-error.log"), record("/v3/order", "2026-10-11T03:00:00Z"));
  const result = run({ projectId: "be", date: "2026-10-12", fileContains: "-error.log", route: "/v3/order", level: "error", method: "POST", fromTime: "2026-10-12T02:30:00Z" });
  assert.equal(result.files.length, 1);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].lineNumber, 3);
  assert.equal(result.records[0].route, "/v3/order");
  assert.equal(result.complete, true);
  assert.equal(result.matchedLines, 1);
});

test("search counts all matches while bounding returned output", async (t) => {
  const { dir, run } = await fixture(t);
  const file = path.join(dir, "app.log");
  await fs.writeFile(file, "MATCH one\nmatch two\nmatch newest\n");
  const result = run({ path: file, contains: "match", limit: 1 });
  assert.equal(result.matchedLines, 3);
  assert.equal(result.records[0].text, "match newest");
  assert.equal(result.outputTruncated, true);
  assert.equal(result.countsAreComplete, true);
});

test("malformed metadata cannot abort a plain-text search", async (t) => {
  const { dir, run } = await fixture(t);
  const file = path.join(dir, "app.log");
  await fs.writeFile(file, '{"timestamp":{"toString":1},"level":{"nested":"value"},"message":"match"}\n');
  const result = run({ path: file, contains: "match" });
  assert.equal(result.matchedLines, 1);
  assert.equal(result.complete, true);
  assert.equal(result.records[0].timestamp, undefined);
});

test("bounded searches keep the newest file and newest tail rather than older rotations", async (t) => {
  const { dir, run } = await fixture(t);
  const old = path.join(dir, "old.log");
  const latest = path.join(dir, "latest.log");
  await fs.writeFile(old, "match OLD\n".repeat(20000));
  await fs.utimes(old, 1, 1);
  await fs.writeFile(latest, "prefix\n".repeat(20000) + "match NEWEST\n");
  const result = run({ projectId: "be", contains: "match", limit: 1, maxScanBytes: 32768 });
  assert.equal(result.records[0].text, "match NEWEST");
  assert.equal(result.records[0].lineFromEnd, 1);
  assert.equal(result.countsAreComplete, false);
  assert.equal(result.scannedFiles[0].path, await fs.realpath(latest));
});

test("gzip and tar.gz searches stream without creating extraction artifacts", async (t) => {
  const { dir, run } = await fixture(t);
  const gz = path.join(dir, "app.log.gz");
  const archive = path.join(dir, "2026-10-11-logs.tar.gz");
  await fs.writeFile(gz, gzipSync("old\nmatch newest\n"));
  await fs.writeFile(archive, tar([
    { name: "info.log", content: "not selected\n" },
    { name: "error.log", content: "MATCH archived\n" },
    { name: "../escaped.log", content: "MATCH unsafe\n" },
    { name: "link.log", type: "2", content: "MATCH symlink\n" },
  ]));
  const before = await fs.readdir(dir);
  assert.equal(run({ path: gz, contains: "match" }).records[0].text, "match newest");
  const result = run({ path: archive, contains: "match", memberContains: "error.log" });
  assert.equal(result.records[0].text, "MATCH archived");
  assert.equal(result.records[0].memberPath, "error.log");
  assert.equal(result.records[0].lineNumber, 1);
  assert.deepEqual(await fs.readdir(dir), before);
});

test("an exact archive member stops before expanding later members", async (t) => {
  const { dir, run } = await fixture(t);
  const file = path.join(dir, "archive.tar.gz");
  await fs.writeFile(file, tar([{ name: "selected.log", content: "wanted\n" }, { name: "later.log", content: "unused\n".repeat(200000) }]));
  const result = run({ path: file, memberPath: "selected.log", maxExpandedBytes: 65536 });
  assert.equal(result.records[0].text, "wanted");
  assert.equal(result.complete, true);
  assert.ok(result.expandedBytes <= 65536);
});

test("archive member pages stream on the target without reading member contents into records", async (t) => {
  const { dir, run, config, operation } = await fixture(t);
  const file = path.join(dir, "archive.tar.gz");
  await fs.writeFile(file, tar([{ name: "one.log", content: "one\n".repeat(20000) }, { name: "two.log", content: "two\n" }, { name: "../unsafe.log", content: "unsafe" }]));
  const first = run({ path: file, mode: "members", limit: 1 });
  assert.equal(first.members[0].name, "one.log");
  assert.equal(first.hasMoreMembers, true);
  assert.equal(first.records.length, 0);
  assert.ok(first.expandedBytes < 80000);
  const second = run({ path: file, mode: "members", limit: 3, memberOffset: first.nextMemberOffset });
  assert.deepEqual(second.members.map((member) => member.name), ["two.log", "../unsafe.log"]);
  assert.equal(second.members[1].readable, false);
  const result = await listLogArchiveMembers({ path: file, limit: 1, config, operation,
    runSSH: async (_command, options) => ({ exitCode: 0, stdout: execFileSync(process.execPath, [], { input: options.stdin, encoding: "utf8" }) }),
  });
  assert.equal(result.members[0].name, "one.log");
  assert.ok(result.nextCursor);
});

test("expansion and scan budgets explicitly mark incomplete counts", async (t) => {
  const { dir, run } = await fixture(t);
  const file = path.join(dir, "big.log.gz");
  await fs.writeFile(file, gzipSync("match\n".repeat(300000)));
  const result = run({ path: file, contains: "match", maxExpandedBytes: 4096 });
  assert.equal(result.complete, false);
  assert.equal(result.scanTruncated, true);
  assert.equal(result.countsAreComplete, false);
});

test("file listing pages stay inside mapped directories and flag limited coverage", async (t) => {
  const { dir, run } = await fixture(t);
  for (let i = 0; i < 3; i++) await fs.writeFile(path.join(dir, `2026-10-12-info.log.${i}`), "ok\n");
  await fs.mkdir(path.join(dir, "nested"));
  await fs.writeFile(path.join(dir, "nested", "not-listed.log"), "ok\n");
  const first = run({ projectId: "be", mode: "files", maxFiles: 2 });
  assert.equal(first.files.length, 2);
  assert.equal(first.hasMoreFiles, true);
  const second = run({ projectId: "be", mode: "files", maxFiles: 2, fileOffset: first.nextFileOffset });
  assert.equal(second.files.length, 1);
  assert.equal(second.hasMoreFiles, false);
});

test("canonical symlink escapes are rejected before reading", async (t) => {
  const { dir, run } = await fixture(t);
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "log-query-outside-"));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  await fs.writeFile(path.join(other, "secret.log"), "outside\n");
  const link = path.join(dir, "escape.log");
  await fs.symlink(path.join(other, "secret.log"), link);
  assert.throws(() => run({ path: link }), /Command failed/);
});

test("configuration persists mappings without expanding allowed path roots", async (t) => {
  const { dir } = await fixture(t);
  assert.throws(() => normalizeLogProjects({ be: { directories: ["/etc/ssh"] } }, ["/home/github"]), /outside approved/);
  assert.deepEqual(normalizeLogProjects(undefined, ["/home/github"], { be: "/home/github/app" }).be.directories, ["/home/github/app/logs"]);
  const registry = new InstanceRegistry({ cwd: dir, env: {}, registryPath: path.join(dir, "instances.json") });
  registry.create({ id: "default", host: "example.test", username: "app", privateKeyPath: "key",
    logProjects: { be: { root: "/home/github/app", directories: ["/home/github/app/logs"] } } });
  const reloaded = new InstanceRegistry({ cwd: dir, env: {}, registryPath: path.join(dir, "instances.json") });
  assert.deepEqual(reloaded.getInternal("default").logProjects.be.directories, ["/home/github/app/logs"]);
});

test("invalid dates, ambiguous selectors and shell-looking values cannot become code", async (t) => {
  const { config, dir, run } = await fixture(t);
  for (const args of [ { projectId: "constructor" }, { projectId: "be", date: "2026-02-30" },
    { projectId: "be", fromTime: "2026-10-12T00:00:00" }, { projectId: "be", path: "/home/github/a.log" },
    { projectId: "be", mode: "latest", contains: "match" } ]) assert.throws(() => normalizeLogQuery(args, config));
  await fs.writeFile(path.join(dir, "app.log"), 'literal $(touch injected) and "quoted"\n');
  assert.equal(run({ projectId: "be", contains: "$(touch injected)" }).records.length, 1);
  assert.equal((await fs.readdir(dir)).includes("injected"), false);
});

test("legacy read_log delegates to the remote helper and keeps chronological output", async (t) => {
  const { dir, config, operation } = await fixture(t);
  const file = path.join(dir, "app.log");
  await fs.writeFile(file, "first\nsecond\nthird\n");
  const runner = async (command, options) => {
    assert.equal(command, "node");
    return { exitCode: 0, stdout: execFileSync(process.execPath, [], { input: options.stdin, encoding: "utf8" }), timing: { queueMs: 0 } };
  };
  const result = await readLog({ path: file, tailLines: 2, config, operation, runSSH: runner });
  assert.equal(result.content, "second\nthird\n");
  assert.equal(result.compression, "none");
  const query = await queryLogs({ path: file, limit: 1 }, { config, operation, runSSH: runner });
  assert.equal(query.records[0].text, "third");
});
