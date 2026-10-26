import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createBusinessPrivacy, isBusinessField } from "../business-privacy.js";
import { createOutputGuard } from "../output-guard.js";
import { normalizeMongoBulkChunk } from "../../../agent/mongodb-bulk.js";
import { bulkSandboxFixture } from "../../../agent/test/helpers/bulk-sandbox-fixture.js";

const query = "remote_debug_mongodb_query";
const payload = (result) => JSON.parse(result.content[0].text);
function fixture(options) {
  const privacy = createBusinessPrivacy(options), guard = createOutputGuard({ businessPrivacy: privacy });
  const instance = { id: "local", host: "127.0.0.1", mongodb: { database: "business", configProfile: "fixture" } };
  const scopeForDatabase = (db) => privacy.targetScope("http://127.0.0.1:4343", instance, db);
  const context = { scope: scopeForDatabase("business"), scopeForDatabase, queryOperation: "find" };
  const protect = (data) => payload(guard.toolResult(query, { database: "business", data }, false, context)).data;
  return { privacy, guard, context, protect, instance };
}

test("business field policy distinguishes identifier words from BSON tags, flags and index definitions", () => {
  for (const key of ["_id", "id", "ids", "key", "keys", "userId", "orderID", "orderIDs", "uuid", "uid", "openid", "businessKey", "user_ids", "order-keys", "owner.userId"]) assert.equal(isBusinessField(key), true, key);
  for (const key of ["valid", "paid", "monkey", "keyboard", "identity", "$minKey", "$maxKey", "$key"]) assert.equal(isBusinessField(key), false, key);
});

test("typed aliases round trip strings, numeric widths, ObjectIds, compound IDs and arrays without leaking credentials", () => {
  const f = fixture();
  const raw = ["123", 123, { $oid: "507f1f77bcf86cd799439011" }, { $numberLong: "9007199254740993" },
    { tenant: "TENANT_PRIVATE", sequence: 2 }, { $binary: { base64: "AP9B", subType: "80" } }];
  const safe = f.protect(raw.map((_id) => ({ _id, userId: _id, ids: [_id], valid: true, count: 123, lowest: { $minKey: 1 }, apiKey: "PRIVATE_CREDENTIAL" })));
  for (let i = 0; i < raw.length; i++) {
    assert.match(safe[i]._id, /^rda_ref_v1_[a-f0-9]{48}$/);
    assert.equal(safe[i]._id, safe[i].userId); assert.equal(safe[i].ids[0], safe[i]._id);
    assert.equal(safe[i].count, 123); assert.deepEqual(safe[i].lowest, { $minKey: 1 });
    assert.equal(safe[i].apiKey, "[REDACTED]");
    const restored = f.privacy.resolve(query, { filter: { _id: { $in: [safe[i]._id] } } }, f.context.scope);
    assert.deepEqual(restored.filter._id.$in[0], raw[i]);
    assert.equal(JSON.stringify(restored.filter._id.$in[0]), JSON.stringify(raw[i]));
  }
  assert.notEqual(safe[0]._id, safe[1]._id);
  const reversed = f.protect([{ _id: { sequence: 2, tenant: "TENANT_PRIVATE" } }])[0]._id;
  assert.notEqual(reversed, safe[4]._id, "BSON compound IDs with different field order must remain distinct");
  assert.deepEqual(f.protect([{ _id: null, ids: [], businessKey: null }]), [{ _id: null, ids: [], businessKey: null }]);
  assert.doesNotMatch(JSON.stringify(safe), /507f1f77|9007199254740993|TENANT_PRIVATE|PRIVATE_CREDENTIAL/);
});

test("aliases work in queries, transactions, imports and bulk expected values but never in control arguments", () => {
  const f = fixture(), id = { $oid: "507f1f77bcf86cd799439011" };
  const ref = f.protect([{ _id: id }])[0]._id;
  const cases = [
    [query, { pipeline: [{ $match: { _id: ref } }] }, (v) => v.pipeline[0].$match._id],
    ["remote_debug_mongodb_prepare_write", { filter: { _id: ref }, update: { $set: { parentId: ref } } }, (v) => v.update.$set.parentId],
    ["remote_debug_mongodb_prepare_transaction", { operations: [{ collection: "orders", operation: "insertOne", document: { _id: ref } }] }, (v) => v.operations[0].document._id],
    ["remote_debug_mongodb_prepare_import", { documents: [{ _id: ref }] }, (v) => v.documents[0]._id],
    ["remote_debug_mongodb_prepare_bulk", { units: [{ unitId: "unit-1", operations: [{ collection: "orders", id: ref, expected: { parentId: { exists: true, value: ref } } }] }] }, (v) => v.units[0].operations[0].expected.parentId.value],
  ];
  for (const [name, input, read] of cases) assert.deepEqual(read(f.privacy.resolve(name, input, f.context.scope)), id);
  for (const [name, input] of [
    [query, { collection: ref }], [query, { filter: { _id: { $oid: ref } } }],
    [query, { filter: { note: `prefix ${ref}` } }], [query, { filter: { [ref]: 1 } }],
    ["remote_debug_mongodb_prepare_index", { key: { _id: ref } }],
    ["remote_debug_mongodb_prepare_transaction", { operations: [{ collection: ref }] }],
    ["remote_debug_mongodb_prepare_bulk", { units: [{ unitId: ref, operations: [] }] }],
    ["remote_debug_run_command", { cmd: ref }], ["remote_debug_review_command_draft", { draftId: ref }],
  ]) assert.throws(() => f.privacy.resolve(name, input, f.context.scope), { code: "BUSINESS_REFERENCE_INVALID" });
});

test("references cannot cross processes, instances, endpoints, databases or changed target profiles", () => {
  const f = fixture(), ref = f.protect([{ _id: "PRIVATE_ORDER_001" }])[0]._id;
  const input = { filter: { _id: ref } };
  const scopes = [undefined, f.context.scopeForDatabase("other"),
    f.privacy.targetScope("http://127.0.0.1:4344", f.instance, "business"),
    f.privacy.targetScope("http://127.0.0.1:4343", { ...f.instance, id: "other" }, "business"),
    f.privacy.targetScope("http://127.0.0.1:4343", { ...f.instance, host: "changed" }, "business"),
    f.privacy.targetScope("http://127.0.0.1:4343", { ...f.instance, mongodb: { configProfile: "changed" } }, "business")];
  for (const scope of scopes) assert.throws(() => f.privacy.resolve(query, input, scope), { code: "BUSINESS_REFERENCE_INVALID" });
  assert.throws(() => createBusinessPrivacy().resolve(query, input, f.context.scope), { code: "BUSINESS_REFERENCE_INVALID" });
  assert.throws(() => f.privacy.resolve(query, { filter: { _id: "rda_ref_v1_" + "a".repeat(48) } }, f.context.scope), { code: "BUSINESS_REFERENCE_INVALID" });
});

test("known identifier echoes are scrubbed from errors, encoded text, object keys and final transport", () => {
  const f = fixture(), raw = 'PRIVATE_ORDER_"ABC/001';
  const safe = f.protect([{ _id: raw, note: raw, encoded: encodeURIComponent(raw) }]);
  assert.equal(safe[0].note, "[REDACTED]"); assert.equal(safe[0].encoded, "[REDACTED]");
  const result = f.guard.toolResult("remote_debug_run_command", { stdout: `${raw} ${JSON.stringify(raw)}`, stderr: raw });
  const wire = f.guard.serialize({ jsonrpc: "2.0", id: 1, result }).toString();
  assert.doesNotMatch(wire, /PRIVATE_ORDER/); assert.equal(payload(result).stderr, "[REDACTED]");
  const err = f.guard.toolResult(query, { error: { code: "DUPLICATE", message: raw } }, true);
  assert.equal(payload(err).error.message, "[REDACTED]");
  const collision = f.guard.toolResult(query, { data: [{ _id: raw, [raw]: 1, "[REDACTED]": 2 }] }, false, f.context);
  assert.equal(payload(collision).error.code, "OUTPUT_GUARD_BLOCKED");
});

test("index definitions, plugin identifiers, plan hashes and counts retain their contracts", () => {
  const f = fixture(), hash = "a".repeat(64);
  const result = payload(f.guard.toolResult("remote_debug_mongodb_prepare_index", { instanceId: "local", mutationId: "mutation-1", planHash: hash,
    kind: "index", affectedIds: [], affectedCount: 0 }, false, f.context));
  assert.equal(result.planHash, hash); assert.equal(result.mutationId, "mutation-1"); assert.equal(result.affectedCount, 0);
  const input = { key: { userId: 1, businessKey: -1 }, name: "user_idx" };
  assert.deepEqual(f.privacy.resolve("remote_debug_mongodb_prepare_index", input, f.context.scope), input);
  assert.equal(result.outputGuard.businessPrivacy.storage, "process_memory");
});

test("privacy capacity fails closed and leaves existing references valid", () => {
  const f = fixture({ maxEntries: 1 }), first = f.protect([{ _id: "PRIVATE_FIRST" }])[0]._id;
  const blocked = payload(f.guard.toolResult(query, { data: [{ _id: "PRIVATE_SECOND" }] }, false, f.context));
  assert.equal(blocked.error.code, "OUTPUT_GUARD_BLOCKED");
  assert.equal(f.privacy.resolve(query, { filter: { _id: first } }, f.context.scope).filter._id, "PRIVATE_FIRST");
  assert.equal(f.protect([{ _id: "PRIVATE_FIRST" }])[0]._id, first);
  assert.equal(payload(f.guard.toolResult(query, { data: [{ _id: "MISSING_SCOPE" }] })).error.code, "OUTPUT_GUARD_BLOCKED");
});

test("business substrings never alter import/job IDs or database metadata", () => {
  const f = fixture(); f.protect([{ _id: "seed-0" }, { _id: "business" }]);
  const result = f.guard.toolResult("remote_debug_mongodb_prepare_import", { database: "business", importId: "seed-01", mutationId: "seed-0-mutation", affectedIds: ["seed-0"], affectedCount: 1 }, false, f.context);
  const wire = JSON.parse(f.guard.serialize({ jsonrpc: "2.0", id: 1, result }).toString());
  const safe = payload(wire.result);
  assert.equal(safe.database, "business"); assert.equal(safe.importId, "seed-01"); assert.equal(safe.mutationId, "seed-0-mutation");
  assert.match(safe.affectedIds[0], /^rda_ref_v1_/);
});

test("aggregation aliases and derived identifier values remain private while counts remain numeric", () => {
  const f = fixture();
  const context = { ...f.context, queryOperation: "aggregate", queryPipeline: [{ $project: { public: "$userId", total: { $sum: 1 }, ordinary: 1 } },
    { $set: { derived: { $concat: ["$public", "suffix"] } } }] };
  const safe = payload(f.guard.toolResult(query, { data: [{ public: "PRIVATE_ALIAS", derived: "PRIVATE_DERIVED", total: 3, ordinary: "keep" }] }, false, context)).data[0];
  assert.match(safe.public, /^rda_ref_v1_/); assert.match(safe.derived, /^rda_ref_v1_/); assert.equal(safe.total, 3); assert.equal(safe.ordinary, "keep");
  assert.equal(f.privacy.resolve(query, { filter: { _id: safe.public } }, f.context.scope).filter._id, "PRIVATE_ALIAS");
});

test("historical bulk acceptance plan masks all 128 sample IDs and preserves the immutable execution identity", async () => {
  const historical = JSON.parse(await fs.readFile(new URL("../../../docs/reports/resource-acceptance-20261018/bulk-plan.json", import.meta.url), "utf8")).plan;
  const f = fixture();
  const protectedPlan = payload(f.guard.toolResult("remote_debug_mongodb_get_bulk_job", historical, false, f.context));
  assert.equal(protectedPlan.jobId, historical.jobId); assert.equal(protectedPlan.planHash, historical.planHash);
  assert.equal(protectedPlan.batchCount, 128); assert.equal(protectedPlan.batches.length, 128);
  assert.equal(protectedPlan.outputGuard.replacements, 128);
  for (let index = 0; index < historical.batches.length; index++) {
    const original = historical.batches[index].sampleIds[0].id, alias = protectedPlan.batches[index].sampleIds[0].id;
    assert.match(alias, /^rda_ref_v1_/); assert.ok(!JSON.stringify(protectedPlan).includes(original));
    assert.equal(f.privacy.resolve(query, { filter: { _id: alias } }, f.context.scopeForDatabase(historical.database)).filter._id, original);
  }
});

test("local sandbox bulk completes, reuses protected IDs, preserves chunk hashes and rolls back without replay", async (t) => {
  const h = bulkSandboxFixture(t); await h.initialize(); const f = fixture();
  const id = f.protect([{ _id: "order-1", businessKey: "PRIVATE_BUSINESS_KEY" }])[0]._id;
  const aliased = { jobId: "privacy-local-job", database: "business", chunkIndex: 0, units: [{ unitId: "unit-1", operations: [{
    operation: "updateOne", collection: "orders", id, expected: { count: { exists: true, value: 0 } }, update: { $inc: { count: 1 } },
  }] }] };
  const raw = f.privacy.resolve("remote_debug_mongodb_prepare_bulk", aliased, f.context.scope);
  const upload = await h.run({ action: "upload", chunk: raw });
  assert.equal(upload.chunkHash, normalizeMongoBulkChunk(raw, h.config).chunkHash);
  assert.throws(() => normalizeMongoBulkChunk({ ...raw, chunkHash: normalizeMongoBulkChunk(aliased, h.config).chunkHash }, h.config), { code: "MONGODB_BULK_CHUNK_HASH_MISMATCH" });
  const plan = await h.run({ action: "upload", chunk: { jobId: raw.jobId, chunkIndex: 1, units: [], endOfUpload: true } });
  const protectedPlan = payload(f.guard.toolResult("remote_debug_mongodb_prepare_bulk", plan, false, f.context));
  assert.equal(protectedPlan.batches[0].sampleIds[0].id, id); assert.equal(protectedPlan.planHash, plan.planHash);
  const run = (action, extra = {}) => h.run({ action, jobId: raw.jobId, planHash: plan.planHash, leaseId: "a".repeat(64), ...extra });
  await run("executeStart"); h.state.loseReply = true;
  await run("executeBatch", { batchIndex: 0 }); await run("executeBatch", { batchIndex: 0 });
  assert.equal(h.rows("business", "orders").get("order-1").count, 1);
  await run("verifyBatch", { batchIndex: 0 }); const done = await run("finish");
  assert.equal(done.status, "completed");
  const safeDone = payload(f.guard.toolResult("remote_debug_mongodb_get_bulk_job", await run("get"), false, f.context));
  assert.equal(safeDone.planPreview[0].sampleIds[0].id, id);
  assert.doesNotMatch(JSON.stringify(safeDone), /order-1|PRIVATE_BUSINESS_KEY/);
  await run("rollbackStart", { leaseId: "b".repeat(64) });
  await run("rollbackBatch", { batchIndex: 0, leaseId: "b".repeat(64) });
  assert.equal(h.rows("business", "orders").get("order-1").count, 0);
});

test("historical candidate restores typed references only within original bulk business surfaces", () => {
  const f = fixture(), originalId = { $oid: "507f1f77bcf86cd799439011" };
  const ref = f.protect([{ _id: originalId }])[0]._id;
  const args = { instanceId: "local", database: "business", intentId: "a".repeat(64), mode: "historical", originalRequest: {
    jobId: "old-job", chunkIndex: 0, units: [{ unitId: "old-unit", operations: [{ operation: "updateOne", collection: "orders", id: ref,
      expected: { "entries.0.origin_id": { exists: true, value: ref } }, update: { $set: { "entries.0.parent_id": ref } } }] }],
  } };
  const restored = f.privacy.resolve("remote_debug_mongodb_recover_operation", args, f.context.scope);
  assert.deepEqual(restored.originalRequest.units[0].operations[0].id, originalId);
  assert.deepEqual(restored.originalRequest.units[0].operations[0].expected["entries.0.origin_id"].value, originalId);
  assert.throws(() => f.privacy.resolve("remote_debug_mongodb_recover_operation", { ...args, intentId: ref }, f.context.scope), { code: "BUSINESS_REFERENCE_INVALID" });
  assert.throws(() => f.privacy.resolve("remote_debug_mongodb_recover_operation", { ...args, originalRequest: { ...args.originalRequest, jobId: ref } }, f.context.scope), { code: "BUSINESS_REFERENCE_INVALID" });
  assert.throws(() => f.privacy.resolve("remote_debug_mongodb_recover_operation", args, "another-target"), { code: "BUSINESS_REFERENCE_INVALID" });
});
