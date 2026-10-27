// Opt-in disposable Docker fixture only. No saved instance, SSH credentials or
// application database can be selected by this test.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { runMongoMutation } from "../mongodb-mutations.js";
import { importRiskFixture } from "./helpers/import-risk-fixture.js";
import { importConfig } from "./helpers/import-fixture.js";
import { privacyRequest } from "../privacy-service.js";
const container = process.env.RDA_IMPORT_TEST_CONTAINER;
if (!/^rda-import-risk-[a-f0-9]+$/.test(container || "")) throw Error("Explicit disposable rda-import-risk helper container required");
function node(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container, "node"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", value => stdout += value); child.stderr.on("data", value => stderr += value);
    child.on("error", reject); child.on("close", exitCode => resolve({ stdout, stderr, exitCode, timedOut: false })); child.stdin.end(script);
  });
}
const query = async () => {
  const result = await node(`const {MongoClient}=require('/home/app/node_modules/mongodb'); (async()=>{const c=await MongoClient.connect('mongodb://mongo:27017/test?replicaSet=fixture',{useNewUrlParser:true,useUnifiedTopology:true});try{console.log(JSON.stringify(await c.db('test').collection('members').find({}).sort({_id:1}).toArray()))}finally{await c.close()}})().catch(()=>process.exitCode=1)`);
  assert.equal(result.exitCode, 0); return JSON.parse(result.stdout);
};
test("real isolated MongoDB import review, native-helper retirement, lost reply reconciliation, transaction idempotency and rollback", { timeout: 90000 }, async t => {
  const h = { run: request => runMongoMutation(request, { config: importConfig, runSSH: async (_command, { stdin }) => node(stdin) }) };
  // Explicit fixture seeding; import itself must never create a collection.
  assert.equal((await node(`const {MongoClient}=require('/home/app/node_modules/mongodb');(async()=>{const c=await MongoClient.connect('mongodb://mongo:27017/test?replicaSet=fixture');try{await c.db('test').createCollection('members')}finally{await c.close()}})().catch(()=>process.exitCode=1)`)).exitCode, 0);
  const f = importRiskFixture(t, { harness: h });
  const historical = await h.run({ ...f.original, kind: "import_plan", mode: "prepare" });
  const before = f.call("inspect_operation", { id: f.old.id }), plan = await f.prepare();
  assert.deepEqual(plan.observations.batches.map(batch => batch.status), ["planned", "planned"]);
  const approved = f.approve(plan); let lost = true;
  const options = { ...f.requestOptions, dispatch: async (...args) => {
    const result = await f.requestOptions.dispatch(...args);
    if (args[1] === "/mongodb/imports/prepare" && lost) { lost = false; throw Error("synthetic lost response after durable prepare"); }
    return result;
  } };
  const create = () => privacyRequest(f.service, { action: "disposition", auth: f.auth, scope: f.scope, mode: "create_replacement", riskPlanId: plan.riskPlanId, reviewHash: approved.reviewHash }, options);
  assert.equal((await create()).result.intentState, "uncertain"); f.reopen();
  const recovered = await create(); assert.equal(recovered.result.state, "complete");
  const prepared = recovered.result.result; assert.equal(prepared.batches.length, 2);
  assert.deepEqual(await query(), []);
  await assert.rejects(h.run({ mode: "commit", mutationId: historical.batches[0].mutationId, planHash: historical.batches[0].planHash, confirmation: "确认执行" }), { code: "MONGODB_IMPORT_RETIRED" });
  for (const batch of prepared.batches) {
    await assert.rejects(h.run({ mode: "commit", mutationId: batch.mutationId, planHash: batch.planHash, confirmation: "wrong" }), { code: "MONGODB_MUTATION_CONFIRMATION_REQUIRED" });
    const request = { mode: "commit", mutationId: batch.mutationId, planHash: batch.planHash, confirmation: "确认执行" };
    assert.equal((await h.run(request)).status, "committed"); assert.equal((await h.run(request)).status, "committed");
  }
  assert.equal((await query()).length, 3);
  for (const batch of [...prepared.batches].reverse()) assert.equal((await h.run({ mode: "rollback", mutationId: batch.mutationId, planHash: batch.planHash, confirmation: "确认回滚" })).status, "rolled_back");
  assert.deepEqual(await query(), []);
  assert.deepEqual(f.call("inspect_operation", { id: f.old.id }), before);
  console.log(JSON.stringify({ realMongo: true, nativeOwnerVerification: "synthetic fixture approval", originalHistoricalOutcome: "unknown", preparedBatches: 2, committedDocuments: 3, remainingDocumentsAfterRollback: 0 }));
});
