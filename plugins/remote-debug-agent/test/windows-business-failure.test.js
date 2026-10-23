import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { localMcp } from "./helpers/local-mcp.js";
import windowsPrivacy from "../windows-privacy.cjs";

test("Windows missing privacy credential blocks business calls while ordinary diagnostics remain available", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const instance = { id: "isolated", host: "127.0.0.1", mongodb: { database: "business", configProfile: "fixture" } };
  const f = await localMcp(t, { instance, nativeKey: true, initializeStorage: (directory) => {
    windowsPrivacy.prepareStore(directory);
    fs.writeFileSync(path.join(directory, "privacy.sqlite"), "synthetic existing database without a key");
  }, handler: () => assert.fail("A failed privacy store must not dispatch a remote operation") });
  const denied = await f.call("remote_debug_mongodb_query", { operation: "find", collection: "orders" });
  assert.equal(denied.isError, true); assert.equal(denied.payload.error.code, "BUSINESS_KEYSTORE_MISSING");
  const diagnostics = await f.call("remote_debug_list_instances");
  assert.notEqual(diagnostics.isError, true); assert.equal(diagnostics.payload.instances.length, 1);
  assert.equal(f.requests.length, 0);
});
