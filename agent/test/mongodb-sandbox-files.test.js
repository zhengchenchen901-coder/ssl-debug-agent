import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { bulkSandboxFixture } from "./helpers/bulk-sandbox-fixture.js";
import { MongoBulkJobRunner, normalizeMongoBulkChunk, runMongoBulk } from "../mongodb-bulk.js";

const chunk = (jobId = "guarded-job") => ({ jobId, chunkIndex: 0, units: [{ unitId: "order-1", operations: [{ collection: "orders", operation: "updateOne", id: "order-1", expected: { count: { exists: true, value: 0 } }, update: { $inc: { count: 1 } } }] }] });

test("unknown file/program fields are rejected at every input envelope before SSH", async (t) => {
  const h = bulkSandboxFixture(t); let sshCalls = 0;
  const cases = [
    { ...chunk(), fileName: "evil.sh", content: "echo evil" },
    { ...chunk(), units: [{ ...chunk().units[0], attachment: "payload" }] },
    { ...chunk(), units: [{ unitId: "order-1", operations: [{ ...chunk().units[0].operations[0], path: "/etc/cron.d/evil" }] }] },
  ];
  for (const value of cases) {
    assert.throws(() => normalizeMongoBulkChunk(value, h.config), { code: "MONGODB_BULK_UNKNOWN_FIELD" });
    await assert.rejects(runMongoBulk({ action: "upload", chunk: value }, { config: h.config, runSSH: () => { sshCalls++; } }), { code: "MONGODB_BULK_UNKNOWN_FIELD" });
  }
  await assert.rejects(runMongoBulk({ action: "list", path: "/tmp/evil" }, { config: h.config, runSSH: () => { sshCalls++; } }), { code: "MONGODB_BULK_UNKNOWN_FIELD" });
  assert.equal(sshCalls, 0);
});

test("records use fixed names and private permissions and cannot escape the root", async (t) => {
  const h = bulkSandboxFixture(t); await h.initialize(); await h.run({ action: "upload", chunk: chunk() });
  for (const destination of ["/tmp/unrelated.sh", h.config.bulkRoot + "/guarded-job/evil.sh", h.config.bulkRoot + "/guarded-job/nested/manifest.json"]) {
    await assert.rejects(h.definitions(`__bulkWriteJson(${JSON.stringify(destination)}, { content: "unrelated" }, 1024);`), { code: "MONGODB_BULK_PATH_INVALID" });
  }
  const directory = h.translate(h.config.bulkRoot + "/guarded-job");
  if (process.platform !== "win32") {
    for (const name of fs.readdirSync(directory)) assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
});

test("linked records cannot overwrite outside files or be accepted as trusted job state", async (t) => {
  if (process.platform === "win32") return t.skip("Linux remote filesystem link semantics require a POSIX fixture");
  const h = bulkSandboxFixture(t); await h.initialize(); await h.run({ action: "upload", chunk: chunk() });
  const outside = path.join(h.nativeRoot, "outside.json"); fs.writeFileSync(outside, "outside unchanged", { mode: 0o600 });
  const event = h.translate(h.config.bulkRoot + "/guarded-job/events.jsonl");
  fs.unlinkSync(event); fs.symlinkSync(outside, event);
  await assert.rejects(h.definitions('__bulkAppendJsonLine(__path.join(__bulkRoot(), "guarded-job", "events.jsonl"), {event:"evil"});'), { code: "MONGODB_BULK_PATH_INVALID" });
  fs.unlinkSync(event); fs.linkSync(outside, event);
  await assert.rejects(h.definitions('__bulkAppendJsonLine(__path.join(__bulkRoot(), "guarded-job", "events.jsonl"), {event:"evil"});'), { code: "MONGODB_BULK_PATH_INVALID" });
  assert.equal(fs.readFileSync(outside, "utf8"), "outside unchanged");
});

test("global capacity rejects new records, reserves control space and bounds event logs", async (t) => {
  const h = bulkSandboxFixture(t); await h.initialize(); await h.run({ action: "upload", chunk: chunk() });
  // Override the fixed limit inside the isolated helper to avoid allocating GiB.
  const relative = '"guarded-job/after-000001.json"';
  await assert.rejects(h.definitions(`__storageLimits.maxBytes=1; __bulkWriteJson(__path.join(__bulkRoot(), ${relative}), {after:[]}, 1024);`), { code: "SANDBOX_STORAGE_QUOTA_EXCEEDED" });
  await h.definitions('__storageLimits.maxBytes=1; __bulkWriteJson(__path.join(__bulkRoot(), "guarded-job", "control.json"), {desiredState:"pause"}, 1024);');
  await assert.rejects(h.definitions('__storageLimits.maxEventBytes=1; __bulkAppendJsonLine(__path.join(__bulkRoot(), "guarded-job", "events.jsonl"), {event:"extra"});'), { code: "SANDBOX_EVENT_LOG_LIMIT" });
  await assert.rejects(h.definitions('__storageLimits.maxJobs=1; __bulkEnsureJobDir("second-job");'), { code: "SANDBOX_STORAGE_QUOTA_EXCEEDED" });
  assert.equal(fs.existsSync(h.translate(h.config.bulkRoot + "/second-job")), false);
  assert.equal(h.read("guarded-job", "control.json").desiredState, "pause");
});

test("code-like business text remains data and is never evaluated during preparation", async (t) => {
  const h = bulkSandboxFixture(t); await h.initialize();
  const marker = path.join(h.nativeRoot, "should-not-execute");
  const payload = `"; require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad'); // $(touch ${marker})`;
  const value = chunk(); value.units[0].operations[0].update = { $set: { count: payload } };
  await h.run({ action: "upload", chunk: value });
  const plan = await h.run({ action: "upload", chunk: { jobId: value.jobId, chunkIndex: 1, endOfUpload: true } });
  assert.equal(plan.status, "prepared");
  assert.equal(h.read(value.jobId, "chunk-000000.json").body.units[0].operations[0].update.$set.count, payload);
  assert.equal(h.rows("business", "orders").get("order-1").count, 0);
  assert.ok(!h.state.events.some((event) => event.action === "businessWrite"));
  assert.equal(fs.existsSync(marker), false);
});

test("strict envelopes preserve the real runner's execute and rollback protocol", async (t) => {
  const h = bulkSandboxFixture(t); await h.initialize();
  await h.run({ action: "upload", chunk: chunk() });
  const plan = await h.run({ action: "upload", chunk: { jobId: "guarded-job", chunkIndex: 1, endOfUpload: true } });
  const run = (input) => runMongoBulk(input, { config: h.config, runSSH: async (_command, options) => {
    const request = JSON.parse(/^const __request = (.*);$/m.exec(options.stdin)[1]);
    const data = await h.run(request);
    return { stdout: "__REMOTE_DEBUG_MONGODB_RESULT__BULK:" + JSON.stringify({ ok: true, data }), exitCode: 0 };
  } });
  const runner = new MongoBulkJobRunner({ config: h.config, runMongoBulk: run });
  await runner.start({ jobId: plan.jobId, planHash: plan.planHash, confirmation: "确认执行" });
  await runner.tasks.get(plan.jobId);
  assert.equal((await h.run({ action: "get", jobId: plan.jobId })).status, "completed");
  assert.equal(h.rows("business", "orders").get("order-1").count, 1);
  await runner.start({ jobId: plan.jobId, planHash: plan.planHash, confirmation: "确认回滚" }, "rollback");
  await runner.tasks.get(plan.jobId);
  assert.equal((await h.run({ action: "get", jobId: plan.jobId })).status, "rolled_back");
  assert.equal(h.rows("business", "orders").get("order-1").count, 0);
});
