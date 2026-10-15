import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

test("installed bundle enforces TTL policy without source checkout or node_modules", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rda-bundled-ttl-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginRoot = path.resolve(import.meta.dirname, "..");
  await fs.copyFile(path.join(pluginRoot, "runtime/agent/server.cjs"), path.join(root, "server.cjs"));
  const script = String.raw`
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { createApp } = require("./server.cjs");
(async () => {
  const token = "a".repeat(64);
  let calls = 0;
  const config = { agent: { host: "127.0.0.1", port: 0 }, ssh: {}, security: { allowedPaths: ["/var/log"] }, audit: { logPath: path.resolve("audit.jsonl") }, mongodb: { enabled:true, writeEnabled:true, bulkEnabled:true, configPath:"/home/app/config.json", driverPath:"/home/app/node_modules/mongodb", configProfile:"test", uriKey:"url", database:"test", allowedDatabases:["test"], allowedCollections:["orders","__remote_debug_bulk_receipts"], bulkReceiptsCollection:"orders" } };
  const app = createApp({ config, authToken: token, runSSH: async () => { calls++; throw new Error("should never reach remote execution"); } });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    async function post(route,body) { const response = await fetch(base+route,{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(body)}); return {status:response.status,body:await response.json()}; }
    const ttl = await post("/mongodb/mutations/prepare",{kind:"index",operation:"createIndex",collection:"orders",name:"business_ttl",key:{createdAt:1},options:{expireAfterSeconds:0}});
    assert.equal(ttl.status,403); assert.equal(ttl.body.error.code,"MONGODB_TTL_INDEX_REJECTED");
    const redirect = await post("/mongodb/bulk/storage/prepare",{kind:"bulk_storage"});
    assert.equal(redirect.status,403); assert.equal(redirect.body.error.code,"MONGODB_BULK_RECEIPTS_RESERVED");
    assert.equal(calls,0);
    const capabilities = await (await fetch(base+"/api/capabilities",{headers:{Authorization:"Bearer "+token}})).json();
    assert.equal(capabilities.capabilities.mongodb.mutations.ttlIndexes.businessAllowed,false);
    console.log("bundled TTL preparation and receipt-redirection rejection verified");
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode=1; });
`;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, env: { ...process.env, NODE_PATH: "" }, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /bundled TTL preparation/);
});
