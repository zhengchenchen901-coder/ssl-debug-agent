import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { assertIndexedMutationDocument, buildMongoMutationScript, normalizeMongoMutation, normalizeMongoTransaction } from "../mongodb-mutations.js";

const config = {
  enabled: true, writeEnabled: true, database: "test", allowedDatabases: ["test"],
  allowedCollections: ["customers"], configPath: "/home/app/config.json", driverPath: "/home/app/node_modules/mongodb",
  configProfile: "test", uriKey: "url", rollbackRoot: "/tmp/remote-debug-agent/mutations",
};
const input = {
  operation: "updateOne", collection: "customers", expectedCount: 1,
  filter: { _id: "c1", "bookings.1.id": "o2" },
  update: { $set: { "bookings.1.status": "2" } },
};

test("indexed patches support guarded EJSON ids and remain small for large arrays", () => {
  const request = normalizeMongoMutation({ ...input, filter: { _id: "c1", "bookings.1.id": { $oid: "0123456789abcdef01234567" } } }, config);
  const document = { _id: "c1", bookings: [{ id: "o1", note: "x".repeat(300000) }, { id: "o2", status: "1" }] };
  assert.ok(JSON.stringify(document).length > 256 * 1024);
  assert.ok(JSON.stringify(request).length < 2000);
  assert.doesNotThrow(() => assertIndexedMutationDocument(request, document));
  assert.equal(normalizeMongoTransaction({ operations: [input] }, config).operations.length, 1);
  for (const operator of ["$set", "$unset", "$inc"]) {
    assert.doesNotThrow(() => normalizeMongoMutation({ ...input, update: { [operator]: { "bookings.1.count": 1 } } }, config));
  }
});

test("indexed patches reject unguarded, positional, unsafe and unbounded paths", () => {
  assert.throws(() => normalizeMongoMutation({ ...input, filter: { _id: "c1" } }, config), { code: "MONGODB_ARRAY_GUARD_REQUIRED" });
  assert.throws(() => normalizeMongoMutation({ ...input, filter: { "bookings.1.id": "o2" } }, config), { code: "MONGODB_FILTER_SCOPE_REQUIRED" });
  for (const field of ["bookings.$.status", "bookings.$[].status", "bookings.$[item].status", "bookings.-1.status", "bookings.01.status", "bookings.100000.status", "bookings.1e2.status", "bookings..status", "bookings.1.__proto__.x", "bookings.constructor.x", "_id.0", "0.status"]) {
    assert.throws(() => normalizeMongoMutation({ ...input, update: { $set: { [field]: "2" } } }, config), { code: "MONGODB_FIELD_REJECTED" }, field);
  }
  assert.throws(() => normalizeMongoMutation({ ...input, filter: { _id: "c1", "bookings.01.id": "o2" } }, config), { code: "MONGODB_FILTER_REJECTED" });
  assert.throws(() => normalizeMongoMutation(input, { ...config, writeEnabled: false }), { code: "MONGODB_MUTATIONS_DISABLED" });
  assert.throws(() => normalizeMongoMutation({ ...input, filter: { ...input.filter, _id: { $nin: ["c2"] } } }, config), { code: "MONGODB_FILTER_SCOPE_REQUIRED" });
});

test("append uses a guarded immediate tail and optional bounded absence check", () => {
  const request = normalizeMongoMutation({ ...input, filter: { _id: "c1", "bookings.2": null, "bookings.id": { $nin: ["o3"] } }, update: { $set: { "bookings.2": { id: "o3", status: "2" } } } }, config);
  assert.doesNotThrow(() => assertIndexedMutationDocument(request, { bookings: [{ id: "o1" }, { id: "o2" }] }));
  assert.doesNotThrow(() => assertIndexedMutationDocument({ update: { $set: { "bookings.0": { id: "o1" } } } }, { bookings: [] }));
  for (const document of [{ bookings: [] }, { bookings: {} }, {}, { bookings: null }]) {
    assert.throws(() => assertIndexedMutationDocument(request, document), { code: "MONGODB_ARRAY_INDEX_INVALID" });
  }
  for (const update of [{ $set: { "bookings.2.status": "2" } }, { $unset: { "bookings.2": 1 } }, { $inc: { "bookings.2": 1 } }, { $set: { "bookings.2": {}, "bookings.3": {} } }]) {
    assert.throws(() => assertIndexedMutationDocument({ update }, { bookings: [{}, {}] }), { code: "MONGODB_ARRAY_INDEX_INVALID" });
  }
  for (const values of [[], Array(1001).fill("x"), "x"]) {
    assert.throws(() => normalizeMongoMutation({ ...input, filter: { ...input.filter, "bookings.id": { $nin: values } } }, config), { code: "MONGODB_FILTER_REJECTED" });
  }
  assert.throws(() => normalizeMongoMutation({ ...input, update: { $set: { value: { $nin: ["x"] } } } }, config), { code: "MONGODB_OPERATOR_REJECTED" });
});

test("nested arrays require guards at each level and validate actual array shape", () => {
  const request = { ...input, filter: { _id: "c1", "groups.0.items.1.id": "o2" }, update: { $set: { "groups.0.items.1.status": "2" } } };
  const normalized = normalizeMongoMutation(request, config);
  assert.doesNotThrow(() => assertIndexedMutationDocument(normalized, { groups: [{ items: [{}, { id: "o2" }] }] }));
  assert.throws(() => assertIndexedMutationDocument(normalized, { groups: [{ items: { 1: { id: "o2" } } }] }), { code: "MONGODB_ARRAY_INDEX_INVALID" });
});

test("remote commit preserves neighbouring data, blocks reordering, and rolls back guarded patches", async () => {
  const script = buildMongoMutationScript({ mode: "prepare", kind: "document", mutation: normalizeMongoMutation(input, config) }, config);
  // Exercise the emitted remote functions, with only driver/codec boundaries substituted.
  const extract = (name, next) => script.slice(script.indexOf(`async function ${name}(`), script.indexOf(`async function ${next}(`));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const original = { _id: "c1", other: "preserved", bookings: [{ id: "o1", note: "x".repeat(300000) }, { id: "o2", status: "1", custom: "keep" }] };
  let current = clone(original), writes = 0;
  const context = vm.createContext({
    __decode: clone, __encode: clone, __hash: JSON.stringify, __documentHash: JSON.stringify,
    __findByIds: async () => [clone(current)],
    __fail: (code, message) => { throw Object.assign(new Error(message), { code }); },
  });
  vm.runInContext(extract("__commitDocumentRequest", "__commitDocument") + extract("__rollbackDocumentRequest", "__rollbackTransaction"), context);
  const collection = {
    updateOne: async (_filter, update) => { writes++; for (const [field, value] of Object.entries(update.$set)) { const parts = field.split("."); const last = parts.pop(); let target = current; for (const key of parts) target = target[key]; target[last] = clone(value); } return { matchedCount: 1 }; },
    replaceOne: async (_filter, document) => { writes++; current = clone(document); return { matchedCount: 1 }; },
  };
  const before = [clone(original)];
  current.bookings.reverse();
  await assert.rejects(context.__commitDocumentRequest(input, before, collection, {}), { code: "MONGODB_MUTATION_CONFLICT" });
  assert.equal(writes, 0);
  current = clone(original);
  const after = await context.__commitDocumentRequest(input, before, collection, {});
  assert.equal(current.bookings[1].status, "2");
  assert.equal(current.bookings[1].custom, "keep");
  assert.deepEqual(current.bookings[0], original.bookings[0]);
  const hashes = [{ id: "c1", hash: JSON.stringify(after[0]) }];
  const committed = clone(current); current.other = "concurrent edit";
  await assert.rejects(context.__rollbackDocumentRequest(input, before, hashes, collection, {}), { code: "MONGODB_ROLLBACK_CONFLICT" });
  current = committed;
  await context.__rollbackDocumentRequest(input, before, hashes, collection, {});
  assert.deepEqual(current, original);
});
