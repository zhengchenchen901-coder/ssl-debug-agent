// Explicit disposable Docker replica set only; native approval is a declared
// fixture substitute. No saved instance, business URI or business input is read.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { runMongoMutation } from "../mongodb-mutations.js";
import { importConfig } from "./helpers/import-fixture.js";
import { executionRiskFixture } from "./helpers/execution-risk-fixture.js";
const container = process.env.RDA_IMPORT_TEST_CONTAINER;
if (!/^rda-import-risk-[a-f0-9]+$/.test(container || "")) throw Error("Explicit disposable helper required");
function node(script) {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", ["exec", "-i", container, "node"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; p.stdout.on("data", b => stdout += b); p.stderr.on("data", b => stderr += b);
    p.on("error", reject); p.on("close", exitCode => resolve({ stdout, stderr, exitCode, timedOut: false })); p.stdin.end(script);
  });
}
async function read(body) {
  const r = await node(`const {MongoClient}=require('/home/app/node_modules/mongodb');const fs=require('fs');const uri=JSON.parse(fs.readFileSync('/home/app/config.json')).test.url;(async()=>{const c=await MongoClient.connect(uri);try{${body}}finally{await c.close()}})().catch(e=>{console.log(JSON.stringify({code:e.code}));process.exitCode=1})`);
  assert.equal(r.exitCode, 0); return JSON.parse(r.stdout);
}
test("real authorized Mongo transaction executes only separately confirmed same-import child; original legacy outcome stays unknown", { timeout: 90000 }, async t => {
  let legacyFailures = 0;
  const h = { state: {}, run: async (request, policy = importConfig) => {
    const legacy = request.mode === "commit" && request._businessExecution && request._businessExecution.version === undefined && /^import-/.test(request.mutationId);
    if (legacy) await read("await c.db('test').collection('members').createIndex({'nested.z':1},{unique:true});await c.db('test').collection('members').insertOne({_id:'isolated-blocker',nested:{z:1}});console.log('true');");
    try { return await runMongoMutation(request, { config: policy,
      runSSH: async (_command, { stdin }) => { const r = await node(stdin); if (r.stdout.includes('"databaseCode":11000')) legacyFailures++; return r; } }); }
    finally { if (legacy) await read("await c.db('test').collection('members').deleteOne({_id:'isolated-blocker'});console.log('true');"); }
  } };
  const collection = await h.run({ kind: "collection", collection: "members" });
  await h.run({ mode: "commit", mutationId: collection.mutationId, planHash: collection.planHash, confirmation: "确认执行" });
  const x = await executionRiskFixture(t, { legacy: true, harness: h }), { f } = x;
  assert.equal(legacyFailures, 1, "historical synthetic execute really reached a duplicate-key server rejection");
  const old = f.call("inspect_operation", { id: x.intent.id });
  const p = await x.prepare(); assert.equal(p.historicalOutcome, "unknown"); assert.equal(p.humanApproved, false);
  await assert.rejects(x.continue(p), { code: "BUSINESS_EXECUTION_RISK_HUMAN_REQUIRED" });
  await x.approve(p); f.reopen(); const child = await x.continue(p);
  assert.equal(await read("console.log(JSON.stringify(await c.db('test').collection('members').countDocuments({})));"), 0);
  const request = { mutationId: child.mutationId, planHash: child.planHash, confirmation: "确认执行" };
  await assert.rejects(h.run({ ...request, mode: "commit", confirmation: "wrong" }), { code: "MONGODB_MUTATION_CONFIRMATION_REQUIRED" });
  const intent = f.call("intent", { route: "/mongodb/mutations/execute", request, identity: { instanceId: f.instance.id, mutationId: child.mutationId, planHash: child.planHash } });
  const execution = f.call("claim_execution", { id: intent.id, operationId: "real-isolated-child", attempt: intent.executionAttempt });
  const result = await h.run({ ...request, mode: "commit", _businessExecution: execution });
  assert.equal(result.status, "committed"); assert.equal(result.importExecution.stage, "acknowledged");
  const docs = await read("console.log(JSON.stringify(await c.db('test').collection('members').find({}).sort({_id:1}).toArray()));");
  assert.deepEqual(docs, f.candidate.documents.slice(0, 2)); assert.deepEqual(Object.keys(docs[0].nested), ["z", "a"]);
  assert.equal((await h.run({ ...request, mode: "commit", _businessExecution: execution })).status, "committed");
  const rollback = { ...execution, intentId: "e".repeat(64), operationId: "real-child-rollback" };
  assert.equal((await h.run({ ...request, mode: "rollback", confirmation: "确认回滚", _businessExecution: rollback })).status, "rolled_back");
  assert.equal(await read("console.log(JSON.stringify(await c.db('test').collection('members').countDocuments({})));"), 0);
  assert.deepEqual(f.call("inspect_operation", { id: x.intent.id }), old);
  const info = await read("console.log(JSON.stringify({version:(await c.db('test').command({buildInfo:1})).version,driver:require('/home/app/node_modules/mongodb/package.json').version}));");
  console.log(JSON.stringify({ realMongo: info, acknowledgedChildDocuments: 2, remaining: 0, originalUnknownRetained: true, nativeOwnerVerification: "fixture substitute", SSH: "docker exec substitute" }));
});
