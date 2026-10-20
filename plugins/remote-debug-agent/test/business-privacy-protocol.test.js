import assert from "node:assert/strict";
import test from "node:test";
import { localMcp } from "./helpers/local-mcp.js";

for (const framing of ["json-line", "content-length"]) test(`real MCP ${framing} restores typed arguments before HTTP and rejects invalid references before execution`, { timeout: 20000 }, async (t) => {
  const original = { _id: { $oid: "507f1f77bcf86cd799439011" }, businessKey: "PRIVATE_BUSINESS_KEY", userId: 123, apiKey: "PRIVATE_API_CREDENTIAL" };
  const instance = { id: "isolated", host: "127.0.0.1", mongodb: { database: "business", configProfile: "fixture" } };
  const f = await localMcp(t, { instance, framing, handler: async (route, input) => {
    if (route === "/mongodb/query") return { database: input.database, operation: input.operation, data: [original], resultCount: 1 };
    return { database: input.database, mutationId: "mutation-1", planHash: "a".repeat(64), affectedIds: [original._id], affectedCount: 1 };
  } });
  const find = await f.call("remote_debug_mongodb_query", { operation: "find", collection: "orders" });
  const row = find.payload.data[0]; assert.match(row._id, /^rda_ref_v1_/); assert.equal(row.apiKey, "[REDACTED]");
  const prepared = await f.call("remote_debug_mongodb_prepare_write", { operation: "updateOne", collection: "orders",
    filter: { _id: row._id }, update: { $set: { parentId: row.userId, businessKey: row.businessKey } } });
  assert.equal(prepared.payload.affectedIds[0], row._id);
  assert.deepEqual(f.requests.at(-1).input.filter._id, original._id);
  assert.equal(f.requests.at(-1).input.update.$set.parentId, 123);
  assert.equal(f.requests.at(-1).input.update.$set.businessKey, original.businessKey);
  assert.equal(f.requests.at(-1).input.instanceId, "isolated"); assert.equal(f.requests.at(-1).input.database, "business");
  const callCount = f.requests.length;
  for (const args of [{ database: "another", filter: { _id: row._id } }, { filter: { _id: "rda_ref_v1_" + "f".repeat(48) } },
    { filter: { _id: { $oid: row._id } } }, { collection: row._id }, { filter: { note: `prefix ${row._id}` } }]) {
    const rejected = await f.call("remote_debug_mongodb_query", { operation: "find", collection: "orders", ...args });
    assert.equal(rejected.payload.error.code, "BUSINESS_REFERENCE_INVALID");
  }
  assert.equal(f.requests.length, callCount);
  const shell = await f.call("remote_debug_run_command", { cmd: `echo ${row._id}` });
  assert.equal(shell.payload.error.code, "BUSINESS_REFERENCE_INVALID");
  instance.host = "changed-target";
  const changed = await f.call("remote_debug_mongodb_query", { operation: "find", collection: "orders", filter: { _id: row._id } });
  assert.equal(changed.payload.error.code, "BUSINESS_REFERENCE_INVALID"); assert.equal(f.requests.length, callCount);
  assert.doesNotMatch(f.wire.join("") + f.diagnostics.join("") + JSON.stringify(f.previews), /507f1f77bcf86cd799439011|PRIVATE_BUSINESS_KEY|PRIVATE_API_CREDENTIAL/);
});
