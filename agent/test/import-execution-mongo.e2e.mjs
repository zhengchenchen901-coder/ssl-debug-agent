// Explicit disposable internal Docker fixture only. No registry, host Mongo URI
// or saved business configuration can be selected by this integration test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { runMongoMutation } from '../mongodb-mutations.js';
import { importConfig } from './helpers/import-fixture.js';
const container = process.env.RDA_IMPORT_TEST_CONTAINER;
if (!/^rda-import-risk-[a-f0-9]+$/.test(container || '')) throw Error('Explicit disposable helper required');
function node(script) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['exec', '-i', container, 'node'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; p.stdout.on('data', b => stdout += b); p.stderr.on('data', b => stderr += b);
    p.on('error', reject); p.on('close', exitCode => resolve({ stdout, stderr, exitCode, timedOut: false })); p.stdin.end(script);
  });
}
async function fixtureCode(body) {
  const r = await node(`const { MongoClient } = require('/home/app/node_modules/mongodb'); const fs=require('fs'); const uri=JSON.parse(fs.readFileSync('/home/app/config.json')).test.url; (async()=>{const c=await MongoClient.connect(uri);try{${body}}finally{await c.close()}})().catch(e=>{console.log(JSON.stringify({error: typeof e.code==='number'?e.code:'fixture_error'}));process.exitCode=1})`);
  assert.equal(r.exitCode, 0, 'isolated fixture command failed'); return JSON.parse(r.stdout);
}
const h = { run: (request, config = importConfig) => runMongoMutation(request, { config, runSSH: (_command, { stdin }) => node(stdin) }) };
const input = { mode: 'prepare', kind: 'import_plan', importId: 'real-execution-fixture', collection: 'members', documents: [{ _id: 's1', unique: 1 }, { _id: 's2', unique: 2 }] };
const execution = (b, attempt = 1) => ({ version: 2, attempt, intentId: 'c'.repeat(64), operationId: `real-attempt-${attempt}`, mutationId: b.mutationId, planHash: b.planHash });
const commit = (b, attempt = 1) => ({ mode: 'commit', mutationId: b.mutationId, planHash: b.planHash, confirmation: '确认执行', _businessExecution: execution(b, attempt) });
const recover = b => ({ mode: 'recover_execution', database: 'test', mutationId: b.mutationId, planHash: b.planHash, _businessExecution: execution(b) });

test('real server boundary, explicit collection creation, exact failed-attempt recovery and rollback', { timeout: 90000 }, async () => {
  const info = await fixtureCode(`const s=await c.db('test').command({isMaster:1});console.log(JSON.stringify({wire:s.maxWireVersion,replica:!!s.setName,version:(await c.db('test').command({buildInfo:1})).version,driver:require('/home/app/node_modules/mongodb/package.json').version}));`);
  await assert.rejects(h.run(input), { code: 'MONGODB_COLLECTION_REQUIRED' });
  // Demonstrate the old path independently of the fix on the actual server.
  const implicit = await fixtureCode(`const s=c.startSession();let outcome='unknown',code;try{s.startTransaction();await c.db('test').collection('old_path_missing').insertOne({_id:'fixture'}, {session:s});await s.commitTransaction();outcome='committed'}catch(e){code=typeof e.code==='number'?e.code:undefined;try{await s.abortTransaction()}catch(_){}}finally{await s.endSession()}console.log(JSON.stringify({outcome,code}));`);
  await assert.rejects(h.run({ mode: 'prepare', kind: 'collection', collection: 'members' }, { ...importConfig, uriKey: 'readOnlyUrl' }), { code: 'MONGODB_COLLECTION_PERMISSION_REQUIRED' });
  const plan = await h.run({ mode: 'prepare', kind: 'collection', collection: 'members', purpose: 'disposable fixture' });
  assert.equal(plan.rollbackMode, 'retained_non_rollbackable');
  await assert.rejects(h.run({ ...commit(plan), confirmation: 'wrong' }), { code: 'MONGODB_MUTATION_CONFIRMATION_REQUIRED' });
  assert.equal((await h.run({ ...commit(plan), _businessExecution: { intentId: 'd'.repeat(64), operationId: 'create-collection' } })).status, 'committed');
  assert.equal(await fixtureCode(`console.log(JSON.stringify(await c.db('test').collection('members').countDocuments({})));`), 0);
  const readOnlyConfig = { ...importConfig, uriKey: 'readOnlyUrl' };
  const denied = (await h.run({ ...input, importId: 'real-permission-fixture' }, readOnlyConfig)).batches[0];
  await assert.rejects(h.run(commit(denied), readOnlyConfig), e => e.code === 'MONGODB_OPERATION_FAILED' && e.diagnostic.databaseCode === 13 && e.diagnostic.category === 'permission');
  assert.equal((await h.run(recover(denied), readOnlyConfig)).retryable, true);
  const b = (await h.run(input)).batches[0];
  // A second unique index causes a true driver duplicate key, not an _id guard.
  await fixtureCode(`await c.db('test').collection('members').createIndex({unique:1},{unique:true});await c.db('test').collection('members').insertOne({_id:'other',unique:1});console.log('true');`);
  await assert.rejects(h.run(commit(b)), e => {
    assert.equal(e.code, 'MONGODB_OPERATION_FAILED'); assert.equal(e.diagnostic.databaseCode, 11000);
    assert.equal(e.diagnostic.category, 'duplicate_key'); assert.equal(e.diagnostic.driverVersion, info.driver);
    assert.doesNotMatch(JSON.stringify(e), /dup key|keyValue|errmsg|unique_1/); return true;
  });
  const failure = await h.run(recover(b));
  assert.equal(failure.importExecution.stage, 'safe_terminal'); assert.equal(failure.retryable, true);
  assert.equal(await fixtureCode(`console.log(JSON.stringify(await c.db('test').collection('members').countDocuments({_id:{$in:['s1','s2']}})));`), 0);
  await fixtureCode(`await c.db('test').collection('members').deleteOne({_id:'other'});console.log('true');`);
  assert.equal((await h.run(commit(b, 2))).status, 'committed');
  assert.equal((await h.run(commit(b, 2))).status, 'committed');
  const rollback = { ...commit(b), mode: 'rollback', confirmation: '确认回滚', _businessExecution: { ...execution(b), intentId: 'e'.repeat(64), operationId: 'rollback' } };
  assert.equal((await h.run(rollback)).status, 'rolled_back');
  assert.equal(await fixtureCode(`console.log(JSON.stringify(await c.db('test').collection('members').countDocuments({})));`), 0);
  await assert.rejects(h.run({ ...rollback, mutationId: plan.mutationId, planHash: plan.planHash }), { code: 'MONGODB_COLLECTION_NOT_ROLLBACKABLE' });
  console.log(JSON.stringify({ realMongo: info, oldImplicitCreation: implicit, exactFailureReceipt: failure.importExecution.stage, committedDocuments: 2, remainingDocuments: 0, nativeOwnerVerification: 'not involved' }));
});
