import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMongoBulkChunk } from "../mongodb-bulk.js";
import { createOutputGuard } from "../../plugins/remote-debug-agent/output-guard.js";
import { prepareRequestDigest } from "../../plugins/remote-debug-agent/prepare-protocol.js";

const config = { bulkEnabled: true, writeEnabled: true, database: "fixture", allowedCollections: ["members"] };
const chunk = document => ({ jobId: "fixture-job", chunkIndex: 0, units: [{ unitId: "fixture-unit", operations: [{ operation: "insertOne", collection: "members", document }] }] });

test("sanitized insert documents retain exact chunk identity and normalized content", () => {
  const raw = chunk({ _id: { $oid: "a".repeat(24) }, batches: [{ date: { $date: "2025-10-26T00:00:00.000Z" }, value: 3 }] });
  const safe = createOutputGuard().sanitize(raw).value;
  assert.equal(Object.getPrototypeOf(safe.units[0].operations[0].document), null);
  assert.equal(prepareRequestDigest(raw), prepareRequestDigest(safe));
  assert.equal(JSON.stringify(normalizeMongoBulkChunk(safe, config)), JSON.stringify(normalizeMongoBulkChunk(raw, config)));
});

test("null-prototype compatibility retains document shape, dangerous-key and BSON bounds", () => {
  for (const prototype of [Object.prototype, null]) {
    const document = properties => Object.defineProperties(Object.create(prototype), Object.getOwnPropertyDescriptors(properties));
    for (const key of ["__proto__", "prototype", "constructor", "$where", "$function", "$accumulator", "$out", "$merge", "$currentOp"]) {
      for (const nested of [false, true]) {
        const bad = JSON.parse(`{"${key}":"fixture"}`);
        assert.throws(() => normalizeMongoBulkChunk(chunk(document({ _id: "one", ...(nested ? { nested: bad } : bad) })), config));
      }
    }
    assert.throws(() => normalizeMongoBulkChunk(chunk(document({ value: 3 })), config), { code: "MONGODB_BULK_ID_REQUIRED" });
    assert.throws(() => normalizeMongoBulkChunk(chunk(document({ _id: "one", value: { $oid: "invalid" } })), config), { code: "MONGODB_BULK_VALUE_INVALID" });
    for (const key of ["a.b", "nul\0key"]) assert.throws(() => normalizeMongoBulkChunk(chunk(document({ _id: "one", [key]: 3 })), config));
  }
  for (const document of [[], new Date(), new (class Document { constructor() { this._id = "one"; } })(), Object.assign(Object.create({ inherited: true }), { _id: "one" })]) {
    assert.throws(() => normalizeMongoBulkChunk(chunk(document), config), { code: "MONGODB_BULK_DOCUMENT_INVALID" });
  }
  for (const nested of [new Date(), Object.create({ inherited: true })]) assert.throws(() => normalizeMongoBulkChunk(chunk({ _id: "one", nested }), config), { code: "MONGODB_BULK_VALUE_INVALID" });
});
