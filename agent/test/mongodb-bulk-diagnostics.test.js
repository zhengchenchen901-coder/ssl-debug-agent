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

test("legacy bulk results expose bounded error codes and indexes without copying documents", () => {
  const secret = '13800000000 mongodb://u:p@private.invalid';
  const writeErrors = Array.from({ length: 9 }, (_, index) => ({ code: 11000, index, errmsg: secret, op: { phone: secret } }));
  const failure = publicBulkFailure({ message: secret, result: { result: { writeErrors, writeConcernErrors: [{ code: 64, errmsg: secret }] } } });
  assert.equal(failure.code, "MONGODB_BULK_FAILED");
  assert.equal(failure.driverCode, 11000);
  assert.equal(failure.category, "duplicate_key");
  assert.equal(failure.writeErrorCount, 9);
  assert.equal(failure.writeErrorsTruncated, true);
  assert.deepEqual(failure.writeErrors, writeErrors.slice(0, 5).map(({ code, index }) => ({ code, index, category: "duplicate_key" })));
  assert.deepEqual(failure.writeConcernErrors, [{ code: 64, category: "unknown" }]);
  assert.doesNotMatch(JSON.stringify(failure), /13800000000|private|errmsg|phone|mongodb:\/\//);
  assert.equal(writeErrors.length, 9);
  const forwarded = publicBulkFailure(publicBulkFailure(failure));
  for (const key of ["driverCode", "category", "writeErrors", "writeConcernErrors", "writeErrorCount", "writeErrorsTruncated"]) assert.deepEqual(forwarded[key], failure[key]);
});

test("modern error responses and legacy write-error getters retain only validated metadata", () => {
  class LegacyWriteError {
    constructor() { this.err = { code: 121, index: 4, errmsg: "private document" }; }
    get code() { return this.err.code; }
    get index() { return this.err.index; }
  }
  const failure = publicBulkFailure({ message: "private", errorResponse: { writeErrors: [new LegacyWriteError(), { code: "secret", index: -1 }] }, errorLabels: ["TransientTransactionError", "secret", "TransientTransactionError"] });
  assert.equal(failure.driverCode, 121);
  assert.equal(failure.category, "document_validation");
  assert.deepEqual(failure.writeErrors, [{ code: 121, index: 4, category: "document_validation" }]);
  assert.deepEqual(failure.errorLabels, ["TransientTransactionError"]);
  assert.equal(failure.outcome, "unknown");
  assert.equal(failure.retriable, false);
  const throwing = { get result() { throw Error("private"); }, writeErrors: [{ get code() { throw Error("private"); }, index: 2 }] };
  assert.doesNotThrow(() => publicBulkFailure(throwing));
  assert.equal(publicBulkFailure({ code: "constructor" }).category, "unknown");
});

test("driver stack locations and callable categories omit absolute paths and arbitrary frames", () => {
  const failure = publicBulkFailure({ message: 'operation.update.hasOwnProperty is not a function', stack: 'Error: secret\n at execute (/home/private/node_modules/mongodb/lib/bulk/common.js:908:21)\n at private (/home/private/application.js:1:1)' });
  assert.equal(failure.category, "javascript_callable");
  assert.deepEqual(failure.driverFrames, [{ module: "mongodb/lib/bulk/common.js", line: 908, column: 21 }]);
  assert.deepEqual(publicBulkFailure(failure).driverFrames, failure.driverFrames);
  assert.doesNotMatch(JSON.stringify(failure), /home|application|hasOwnProperty|secret/);
  const bsonFailure = publicBulkFailure({ message: 'object [{"phone":"13800000000"}] is not a valid ObjectId' });
  assert.equal(bsonFailure.category, "bson_object_id");
  assert.equal(bsonFailure.message, "BSON ObjectId serialization rejected; value details withheld");
  assert.doesNotMatch(JSON.stringify(bsonFailure), /13800000000|phone/);
});

test("nested business-write errors persist through pause, events and same-plan recovery without partial writes", async t => {
  const h = bulkSandboxFixture(t), jobId = "nested-business-failure", plan = await prepare(h, jobId), audits = [];
  h.state.businessFailure = Object.assign(new Error("private driver failure"), { result: { result: { writeErrors: [{ code: 121, index: 0, errmsg: "13800000000", op: { private: true } }] } } });
  let runner = new MongoBulkJobRunner({ config: h.config, runMongoBulk: input => h.run(input), onFailure: event => audits.push(event) });
  await runner.start({ jobId, planHash: plan.planHash }, "execute", { operationId: parentOperationId });
  await runner.tasks.get(jobId);
  const paused = await h.run({ action: "get", jobId });
  assert.equal(paused.status, "paused");
  assert.equal(paused.lastFailure.phase, "business_write");
  assert.equal(paused.lastFailure.driverCode, 121);
  assert.equal(paused.lastFailure.outcome, "not_committed");
  assert.equal(paused.committedBatchCount, 0);
  assert.equal(h.rows("business", "orders").get("order-1").count, 0);
  const events = await h.run({ action: "sandboxExport", jobId, limit: 100 });
  assert.equal(events.records.find(event => event.event === "batch_failed").failure.driverCode, 121);
  assert.equal(audits[0].failure.category, "document_validation");
  assert.doesNotMatch(JSON.stringify({ paused, events, audits }), /13800000000|private driver|errmsg/);
  h.state.businessFailure = null;
  runner = new MongoBulkJobRunner({ config: h.config, runMongoBulk: input => h.run(input) });
  await runner.control({ jobId, planHash: plan.planHash, command: "resume" });
  await runner.tasks.get(jobId);
  assert.equal((await h.run({ action: "get", jobId })).status, "completed");
  assert.equal(h.rows("business", "orders").get("order-1").count, 1);
});
