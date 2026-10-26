import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { MongoBulkJobRunner, runMongoBulk } from "../mongodb-bulk.js";
import { publicBulkFailure } from "../mongodb-bulk-error.js";
import { bulkSandboxFixture } from "./helpers/bulk-sandbox-fixture.js";

const parentOperationId = crypto.randomUUID();
async function prepare(h, jobId) {
  await h.initialize();
  await h.run({ action: "upload", chunk: { jobId, chunkIndex: 0, units: [{ unitId: "one", operations: [{ operation: "updateOne", collection: "orders", id: "order-1", expected: { count: { exists: true, value: 0 } }, update: { $inc: { count: 1 } } }] }] } });
  return h.run({ action: "upload", chunk: { jobId, chunkIndex: 1, units: [], endOfUpload: true } });
}

test("helper failure survives paused get, event export, audit callback and a new runner with the exact plan", async t => {
  const h = bulkSandboxFixture(t), jobId = "diagnostic-recovery", plan = await prepare(h, jobId), audits = [], calls = [];
  h.state.rejectReceipt = true;
  const run = async (input, settings) => { calls.push({ input, settings }); return h.run(input); };
  let runner = new MongoBulkJobRunner({ config: h.config, runMongoBulk: run, onFailure: event => audits.push(event) });
  await runner.start({ jobId, planHash: plan.planHash }, "execute", { operationId: parentOperationId });
  await runner.tasks.get(jobId);
  const paused = await h.run({ action: "get", jobId });
  assert.equal(paused.status, "paused");
  assert.equal(paused.lastFailure.code, 13);
  assert.equal(paused.lastFailure.phase, "receipt_write");
  assert.equal(paused.lastFailure.layer, "mongodb-helper");
  assert.equal(paused.lastFailure.batchIndex, 0);
  assert.equal(paused.lastFailure.outcome, "not_committed");
  assert.equal(paused.lastFailure.parentOperationId, parentOperationId);
  const failedCall = calls.find(({ input }) => input.action === "executeBatch");
  assert.equal(paused.lastFailure.operationId, failedCall.settings.operation.operationId);
  assert.match(paused.lastFailure.messageFingerprint, /^[a-f0-9]{64}$/);
  const events = await h.run({ action: "sandboxExport", jobId, limit: 100 });
  assert.ok(events.records.some(event => event.event === "batch_failed" && event.failure.phase === "receipt_write"));
  assert.ok(events.records.some(event => event.event === "paused" && event.failure.parentOperationId === parentOperationId));
  assert.equal(audits[0].failure.code, 13);
  assert.doesNotMatch(JSON.stringify({ paused, events, audits }), /13800000000|secret|private\.invalid|mongodb:\/\//);
  assert.equal(h.rows("business", "orders").get("order-1").count, 0);
  h.state.rejectReceipt = false;
  runner = new MongoBulkJobRunner({ config: h.config, runMongoBulk: run });
  await runner.control({ jobId, planHash: plan.planHash, command: "resume" }, { operationId: crypto.randomUUID() });
  await runner.tasks.get(jobId);
  const completed = await h.run({ action: "get", jobId });
  assert.equal(completed.status, "completed");
  assert.equal(completed.planHash, plan.planHash);
  assert.equal(completed.lastFailure.operationId, paused.lastFailure.operationId);
  assert.equal(h.rows("business", "orders").get("order-1").count, 1);
});

test("lost commit reply with inaccessible receipt remains unknown and same-plan resume never reapplies increment", async t => {
  const h = bulkSandboxFixture(t), jobId = "unknown-receipt", plan = await prepare(h, jobId);
  h.state.hideReceiptAfterCommit = true;
  const runner = new MongoBulkJobRunner({ config: h.config, runMongoBulk: input => h.run(input) });
  await runner.start({ jobId, planHash: plan.planHash }); await runner.tasks.get(jobId);
  const paused = await h.run({ action: "get", jobId });
  assert.equal(paused.lastFailure.code, "MONGODB_BULK_COMMIT_UNKNOWN");
  assert.equal(paused.lastFailure.phase, "commit");
  assert.equal(paused.lastFailure.outcome, "unknown");
  assert.equal(paused.lastFailure.recovery, "reconcile_exact_receipt");
  assert.ok(paused.lastFailure.cause);
  assert.ok(paused.lastFailure.receiptCheckFailure);
  assert.equal(paused.committedBatchCount, 0); // no fabricated local receipt
  assert.equal(h.rows("business", "orders").get("order-1").count, 1); // server really committed
  h.state.hideReceiptAfterCommit = h.state.rejectReceiptRead = false;
  const next = new MongoBulkJobRunner({ config: h.config, runMongoBulk: input => h.run(input) });
  await next.control({ jobId, planHash: plan.planHash, command: "resume" }); await next.tasks.get(jobId);
  assert.equal((await h.run({ action: "get", jobId })).status, "completed");
  assert.equal(h.rows("business", "orders").get("order-1").count, 1);
});

test("dispatch error releases wave bookkeeping and emits the original sanitized error", async t => {
  const h = bulkSandboxFixture(t), jobId = "dispatch-failure", plan = await prepare(h, jobId), audits = [];
  const runner = new MongoBulkJobRunner({ config: h.config, onFailure: event => audits.push(event), runMongoBulk: input => {
    if (input.action === "dispatch" && input.batchIndexes.length) throw Object.assign(new TypeError("Cannot read properties of undefined (reading 'private phone 13800000000')"), { code: "ERR_INVALID_ARG_TYPE" });
    return h.run(input);
  } });
  await runner.start({ jobId, planHash: plan.planHash }); const active = runner.active;
  await runner.tasks.get(jobId);
  assert.equal(active.waveInFlight, false);
  assert.equal(audits[0].failure.phase, "dispatch");
  assert.equal(audits[0].failure.name, "TypeError");
  assert.doesNotMatch(JSON.stringify(audits), /13800000000/);
  assert.equal(h.rows("business", "orders").get("order-1").count, 0);
});

test("public diagnostic schema never copies arbitrary messages, details, stack or metadata", () => {
  const secret = '13800000000 mongodb://u:p@private.invalid rda_ref_v1_private contextCapability=secret {before:"private"}';
  const failure = publicBulkFailure({ name: secret, code: 11000, message: 'E11000 duplicate key error ' + secret, details: secret, stack: secret, cause: { message: secret } }, { phase: secret, layer: secret, operationId: secret, outcome: "safe_failure" });
  assert.equal(failure.code, 11000); assert.equal(failure.outcome, "unknown");
  assert.equal(failure.phase, "unknown"); assert.equal(failure.layer, "mongodb-bulk");
  assert.doesNotMatch(JSON.stringify(failure), /13800000000|private|contextCapability|rda_ref/);
});

test("transport errors have independent operation identities and cannot publish raw SSH cause", async t => {
  const h = bulkSandboxFixture(t);
  await assert.rejects(runMongoBulk({ action: "get", jobId: "transport-fixture" }, { config: h.config, runSSH: async (_command, options) => {
    assert.match(options.operation.operationId, /^[a-f0-9-]{36}$/);
    throw Object.assign(new Error("mongodb://u:p@private.invalid 13800000000"), { code: "SSH_CONNECTION_FAILED", cause: { message: "contextCapability=secret" } });
  } }), error => {
    assert.equal(error.failure.code, "SSH_CONNECTION_FAILED");
    assert.equal(error.failure.outcome, "unknown");
    assert.doesNotMatch(JSON.stringify(error) + error.message, /private|13800000000|contextCapability/);
    return true;
  });
});

test("resource scheduler failure is observable even when no helper was dispatched", async t => {
  const h = bulkSandboxFixture(t), jobId = "resource-diagnostic", plan = await prepare(h, jobId), audits = [];
  const resourceClient = { registry: { tasks: new Map() }, register: () => "task", update() {}, synchronize: async () => { throw Object.assign(new Error("private scheduler metadata"), { code: "RESOURCE_WAIT_FAILED" }); } };
  const runner = new MongoBulkJobRunner({ config: h.config, resourceClient, runMongoBulk: input => h.run(input), onFailure: event => audits.push(event) });
  await runner.start({ jobId, planHash: plan.planHash }, "execute", { operationId: parentOperationId });
  await runner.tasks.get(jobId);
  const state = await h.run({ action: "get", jobId });
  assert.equal(state.lastFailure.phase, "resource_wait");
  assert.equal(state.lastFailure.layer, "resource");
  assert.equal(state.lastFailure.parentOperationId, parentOperationId);
  assert.equal(audits[0].failure.code, "RESOURCE_WAIT_FAILED");
  assert.equal(h.rows("business", "orders").get("order-1").count, 0);
  assert.doesNotMatch(JSON.stringify(state.lastFailure), /private scheduler metadata/);
});
