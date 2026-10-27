import { importHarness } from '../agent/test/helpers/import-fixture.js';
import { importRiskFixture } from '../agent/test/helpers/import-risk-fixture.js';
import { privacyRequest } from '../agent/privacy-service.js';
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });
const fixture = () => importRiskFixture({ after: fn => cleanups.push(fn) });
const input = { kind: 'import_plan', importId: 'execution-fixture', collection: 'members', documents: [{ _id: 'synthetic-1', value: 1 }] };
const prepare = async h => (await h.run(JSON.parse(JSON.stringify(input)))).batches[0];
const ticket = (b, attempt = 1) => ({ version: 2, attempt, intentId: 'e'.repeat(64), operationId: `attempt-${attempt}`, mutationId: b.mutationId, planHash: b.planHash });
const commit = (b, t = ticket(b)) => ({ mode: 'commit', mutationId: b.mutationId, planHash: b.planHash, confirmation: '确认执行', _businessExecution: t });
const recover = (b, t = ticket(b)) => ({ mode: 'recover_execution', database: 'test', mutationId: b.mutationId, planHash: b.planHash, _businessExecution: t });

test('missing namespace and unsupported transaction topology are rejected in prepare without business writes', async () => {
  for (const patch of [{ collectionExists: false }, { replicaSet: false }, { wireVersion: 6 }, { sessions: undefined }, { collectionType: 'view' }, { collectionOptions: { capped: true } }]) {
    const h = importHarness(); Object.assign(h.state, patch);
    await expect(prepare(h)).rejects.toMatchObject({ code: patch.collectionExists === false ? 'MONGODB_COLLECTION_REQUIRED' : patch.collectionType || patch.collectionOptions ? 'MONGODB_COLLECTION_UNSUPPORTED' : 'MONGODB_TRANSACTIONS_UNSUPPORTED' });
    expect(h.state.insert).toBe(0); expect(h.state.created).toBe(0);
  }
});

test('namespace is rechecked at execute; exact safe terminal allows only next attempt of same plan', async () => {
  const h = importHarness(), b = await prepare(h); h.state.collectionExists = false;
  await expect(h.run(commit(b))).rejects.toMatchObject({ code: 'MONGODB_COLLECTION_REQUIRED', diagnostic: { phase: 'collection_preflight' } });
  expect(await h.run(recover(b))).toMatchObject({ status: 'commit_retryable', retryable: true, importExecution: { stage: 'safe_terminal' }, indexRecovery: { reason: 'exact_safe_terminal_receipt' } });
  await expect(h.run(commit(b))).rejects.toMatchObject({ code: 'MONGODB_EXECUTION_ATTEMPT_CLOSED' });
  h.state.collectionExists = true;
  await expect(h.run(commit(b, { ...ticket(b, 2), intentId: 'f'.repeat(64) }))).rejects.toMatchObject({ code: 'MONGODB_EXECUTION_EVIDENCE_REQUIRED' });
  expect((await h.run(commit(b, ticket(b, 2)))).status).toBe('committed'); expect(h.state.insert).toBe(1);
});

test('recreated same-name collection cannot inherit a prepared import', async () => {
  const h = importHarness(), b = await prepare(h); h.state.collectionUuid = 'different-namespace';
  await expect(h.run(commit(b))).rejects.toMatchObject({ code: 'MONGODB_COLLECTION_IDENTITY_CHANGED' });
  expect(h.state.insert).toBe(0);
});

for (const [name, error, category] of [
  ['permission', { code: 13, name: 'MongoServerError' }, 'permission'],
  ['duplicate', { code: 11000, name: 'MongoServerError' }, 'duplicate_key'],
  ['transaction', { code: 263, name: 'MongoServerError' }, 'transaction_support'],
  ['network', { name: 'MongoNetworkError' }, 'network'],
  ['writeConcern', { code: 64, name: 'MongoWriteConcernError' }, 'write_concern'],
]) test(`aborted ${name} errors retain bounded diagnostics without private errmsg`, async () => {
  const h = importHarness(), b = await prepare(h);
  h.state.failInsert = true; h.state.insertError = Object.assign(Error('PRIVATE_DOCUMENT and mongodb://credential'), error);
  let caught; try { await h.run(commit(b)); } catch (e) { caught = e; }
  expect(caught).toMatchObject({ code: 'MONGODB_OPERATION_FAILED', diagnostic: { phase: 'transaction_write', category } });
  expect(JSON.stringify(caught)).not.toMatch(/PRIVATE_DOCUMENT|credential/);
  expect(await h.run(recover(b))).toMatchObject({ status: 'commit_retryable', importExecution: { stage: 'safe_terminal' } });
  expect(h.state.rows.size).toBe(0);
});

test('abort failure and lost commit response remain unknown and never replay', async () => {
  for (const failure of ['abort', 'commit']) {
    const h = importHarness(), b = await prepare(h);
    if (failure === 'abort') { h.state.failInsert = true; h.state.failAbort = true; } else h.state.loseCommitReply = true;
    await expect(h.run(commit(b))).rejects.toMatchObject({ code: 'MONGODB_OPERATION_FAILED' });
    expect(await h.run(recover(b))).toMatchObject({ status: 'commit_unknown', retryable: false, importExecution: { stage: 'unknown' } });
    await expect(h.run(commit(b, ticket(b, 2)))).rejects.toMatchObject({ code: 'MONGODB_MUTATION_STATE_INVALID' });
    expect(h.state.insert).toBe(1);
  }
});

test('legacy retryable journal has no recovery evidence and cannot acquire it by retrying', async () => {
  const h = importHarness(), b = await prepare(h); h.state.failInsert = true;
  await expect(h.run({ ...commit(b), _businessExecution: { intentId: ticket(b).intentId, operationId: 'legacy' } })).rejects.toMatchObject({ code: 'MONGODB_OPERATION_FAILED' });
  expect(await h.run(recover(b))).toMatchObject({ indexRecovery: { reason: 'legacy_execution_evidence_required' } });
  await expect(h.run(commit(b))).rejects.toMatchObject({ code: 'MONGODB_EXECUTION_EVIDENCE_REQUIRED' });
});

test('Manager reconciles exact failure after restart, preserves evidence and fences late claims/reconciles', async () => {
  const f = fixture(), b = await prepare(f.h);
  const request = { mutationId: b.mutationId, planHash: b.planHash, confirmation: '确认执行' };
  const args = { route: '/mongodb/mutations/execute', request, identity: { instanceId: f.instance.id, mutationId: b.mutationId, planHash: b.planHash } };
  const a = f.call('intent', args);
  const execution = f.call('claim_execution', { id: a.id, operationId: 'attempt-1', attempt: a.executionAttempt });
  f.h.state.failInsert = true; await expect(f.h.run(commit(b, execution))).rejects.toMatchObject({ code: 'MONGODB_OPERATION_FAILED' });
  f.reopen();
  const options = { ...f.requestOptions, dispatch: async (_id, route, body) => {
    expect(route).toBe('/mongodb/mutations/recover-execution'); return { ok: true, ...await f.h.run({ ...body, mode: 'recover_execution' }) };
  } };
  const reconcile = () => privacyRequest(f.service, { action: 'recover_operation', mode: 'reconcile', id: a.id, auth: f.auth, scope: f.scope }, options);
  expect((await Promise.all([reconcile(), reconcile()])).map(r => r.state)).toEqual(['retryable', 'retryable']);
  const next = f.call('intent', args); expect(next.id).toBe(a.id); expect(next.executionAttempt).toBe(2);
  expect(() => f.call('claim_execution', { id: a.id, operationId: 'late', attempt: 1 })).toThrow();
  const preserved = f.call('inspect_operation', { id: a.id });
  const oldReceipt = { ok: true, ...await f.h.run(recover(b, execution)) };
  f.call('reconcile', { id: a.id, result: { ok: true, entries: [oldReceipt] } });
  expect(f.call('inspect_operation', { id: a.id })).toEqual(preserved);
  const second = f.call('claim_execution', { id: next.id, operationId: 'attempt-2', attempt: 2 });
  expect((await f.h.run(commit(b, second))).status).toBe('committed');
  expect(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='execution_evidence'").get().n).toBe(1);
  expect(f.h.state.rows.size).toBe(1);
});

test('collection create is separate, permission bounded, rejects concurrent owners and never drops later data', async () => {
  const h = importHarness(); h.state.collectionExists = false;
  const request = { kind: 'collection', collection: 'members' };
  h.state.privileges = false;
  await expect(h.run(request)).rejects.toMatchObject({ code: 'MONGODB_COLLECTION_PERMISSION_REQUIRED' });
  h.state.privileges = true;
  const p = await h.run(request); expect(h.state.created).toBe(0);
  expect(p.rollbackMode).toBe('retained_non_rollbackable');
  h.state.concurrentCollection = true;
  await expect(h.run({ ...commit(p), _businessExecution: undefined })).rejects.toMatchObject({ diagnostic: { databaseCode: 48 } });
  expect(h.state.created).toBe(0);
  const other = importHarness(); other.state.collectionExists = false;
  const b = await other.run(request);
  expect((await other.run({ ...commit(b), _businessExecution: undefined })).status).toBe('committed');
  other.state.rows.set('later', { _id: 'later-business-data' });
  await expect(other.run({ ...commit(b), mode: 'rollback', confirmation: '确认回滚', _businessExecution: undefined })).rejects.toMatchObject({ code: 'MONGODB_COLLECTION_NOT_ROLLBACKABLE' });
  expect(other.state.rows.size).toBe(1); expect(other.state.collectionExists).toBe(true);
});

// Actual filesystem and process death. A dead helper's exclusive lock remains
// a safety stop; these tests never delete it to manufacture recovery evidence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
for (const stage of ['started', 'commit_sent', 'acknowledged', 'safe_terminal']) test(`SIGKILL at durable ${stage} keeps the exact attempt protected`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rda-execution-crash-')); cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = importHarness({ realFiles: root }), b = await prepare(h);
  const file = path.join(root, 'synthetic-request.json'); fs.writeFileSync(file, JSON.stringify(commit(b)), { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(process.cwd(), 'agent/test/helpers/import-execution-crash.mjs'), root, file, stage], { stdio: 'ignore' });
  const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
  expect(result.signal).toBe('SIGKILL');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, b.mutationId, 'manifest.json')));
  expect(manifest.importExecution.stage).toBe(stage); expect(manifest.execution).toEqual(ticket(b));
  await expect(h.run(recover(b))).rejects.toMatchObject({ code: 'MONGODB_MUTATION_BUSY' });
  await expect(h.run(commit(b, ticket(b, 2)))).rejects.toMatchObject({ code: 'MONGODB_MUTATION_BUSY' });
});

test('filesystem failure before commit sends no commit; failed terminal persistence keeps recovery unknown', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rda-execution-io-')); cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  let armed = false;
  const h = importHarness({ realFiles: root, beforeRename: (temporary, file) => {
    if (!armed || !file.endsWith('/manifest.json')) return;
    const m = JSON.parse(fs.readFileSync(temporary));
    if (['commit_sent', 'safe_terminal'].includes(m.importExecution?.stage)) throw Object.assign(Error('synthetic disk fault'), { code: 'EIO' });
  } });
  const b = await prepare(h); armed = true;
  await expect(h.run(commit(b))).rejects.toMatchObject({ code: 'MONGODB_OPERATION_FAILED' });
  expect(h.state.rows.size).toBe(0);
  expect(await h.run(recover(b))).toMatchObject({ status: 'commit_started', importExecution: { stage: 'started' }, indexRecovery: { reason: 'execution_acknowledgement_required' } });
  await expect(h.run(commit(b, ticket(b, 2)))).rejects.toMatchObject({ code: 'MONGODB_MUTATION_STATE_INVALID' });
});

test('public import preflight rejection has an exact terminal receipt and same-input prepare continuation', async () => {
  const f = fixture(), request = JSON.parse(JSON.stringify({ ...f.original, importId: 'preflight-rejected' }));
  const args = { route: '/mongodb/imports/prepare', request, dispatchDigest: f.digest(request), identity: { instanceId: f.instance.id, importId: request.importId, collection: request.collection } };
  const a = f.call('intent', args); f.h.state.collectionExists = false;
  const dispatch = intent => privacyRequest(f.service, { action: 'dispatch_prepare', auth: f.auth, scope: f.scope, id: intent.id, attempt: intent.importPrepare.attempt, request }, f.requestOptions);
  const rejected = await dispatch(a);
  expect(rejected).toMatchObject({ status: 'prepare_rejected', intentState: 'complete', prepareRejection: { stage: 'preflight_rejected', code: 'MONGODB_COLLECTION_REQUIRED' }, batches: [] });
  expect(f.h.state.insert).toBe(0); expect(f.h.state.created).toBe(0);
  f.reopen(); f.h.state.collectionExists = true;
  const next = f.call('intent', args); expect(next.id).toBe(a.id); expect(next.importPrepare.attempt).toBe(2);
  expect(await dispatch(next)).toMatchObject({ status: 'prepared', intentState: 'complete' });
  expect(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='import_prepare_evidence'").get().n).toBe(1);
});

test('rollback keeps its own acknowledgement, exact safe abort and new attempt without losing commit history', async () => {
  const h = importHarness(), b = await prepare(h); await h.run(commit(b));
  const rollbackTicket = { ...ticket(b), intentId: 'f'.repeat(64), operationId: 'rollback-1' };
  const rollback = { ...commit(b, rollbackTicket), mode: 'rollback', confirmation: '确认回滚' };
  h.state.failConnect = true;
  await expect(h.run(rollback)).rejects.toMatchObject({ code: 'MONGODB_OPERATION_FAILED' });
  h.state.failConnect = false;
  expect(await h.run({ ...recover(b, rollbackTicket) })).toMatchObject({ status: 'rollback_retryable', importExecution: { mode: 'rollback', stage: 'safe_terminal' } });
  expect((await h.run({ ...rollback, _businessExecution: { ...rollbackTicket, attempt: 2, operationId: 'rollback-2' } })).status).toBe('rolled_back');
  expect(h.state.rows.size).toBe(0);
  expect([...h.files.keys()].filter(p => p.includes('/execution-'))).toHaveLength(2);
});

test('driver swallowing abort failure is not a safe terminal acknowledgement', async () => {
  const h = importHarness(), b = await prepare(h); h.state.failInsert = true; h.state.swallowedAbort = true;
  await expect(h.run(commit(b))).rejects.toMatchObject({ code: 'MONGODB_OPERATION_FAILED', diagnostic: { phase: 'transaction_abort' } });
  expect(await h.run(recover(b))).toMatchObject({ status: 'commit_unknown', retryable: false, importExecution: { stage: 'unknown' } });
  await expect(h.run(commit(b, ticket(b, 2)))).rejects.toMatchObject({ code: 'MONGODB_MUTATION_STATE_INVALID' });
});

test('another session abort acknowledgement cannot certify this transaction', async () => {
  const h = importHarness(), b = await prepare(h); h.state.failInsert = true; h.state.mismatchedAck = true;
  await expect(h.run(commit(b))).rejects.toMatchObject({ code: 'MONGODB_OPERATION_FAILED' });
  expect(await h.run(recover(b))).toMatchObject({ status: 'commit_unknown', retryable: false });
});

test('resolved commit without exact command acknowledgement remains unknown', async () => {
  const h = importHarness(), b = await prepare(h); h.state.suppressCommitAck = true;
  await expect(h.run(commit(b))).rejects.toMatchObject({ code: 'MONGODB_IMPORT_COMMIT_UNKNOWN' });
  expect(h.state.rows.size).toBe(1);
  expect(await h.run(recover(b))).toMatchObject({ status: 'commit_unknown', retryable: false });
  await expect(h.run(commit(b, ticket(b, 2)))).rejects.toMatchObject({ code: 'MONGODB_MUTATION_STATE_INVALID' });
});

test('caller-supplied success cannot discharge a protected execution without exact remote evidence', async () => {
  const f = fixture(), b = await prepare(f.h);
  const args = { route: '/mongodb/mutations/execute', request: { mutationId: b.mutationId, planHash: b.planHash, confirmation: '确认执行' }, identity: { instanceId: f.instance.id, mutationId: b.mutationId, planHash: b.planHash } };
  const a = f.call('intent', args), execution = f.call('claim_execution', { id: a.id, operationId: 'caller-proof', attempt: 1 });
  const forged = { ok: true, status: 'committed', mutationId: b.mutationId, planHash: b.planHash, execution, importExecution: { stage: 'acknowledged' } };
  const result = await privacyRequest(f.service, { action: 'outcome', auth: f.auth, scope: f.scope, id: a.id, result: forged }, { ...f.requestOptions,
    dispatch: async (_id, route, body) => { expect(route).toBe('/mongodb/mutations/recover-execution'); return { ok: true, ...await f.h.run({ ...body, mode: 'recover_execution' }) }; } });
  expect(result.state).toBe('uncertain'); expect(f.call('inspect_operation', { id: a.id }).state).toBe('uncertain'); expect(f.h.state.insert).toBe(0);
});

import { fork } from 'node:child_process';
for (const action of ['claim_execution', 'intent']) for (const boundary of ['beforeCommit', 'afterCommit']) test(`SQLite SIGKILL ${action} ${boundary} keeps one exact execution reservation`, async () => {
  const f = fixture(), b = await prepare(f.h);
  const args = { route: '/mongodb/mutations/execute', request: { mutationId: b.mutationId, planHash: b.planHash, confirmation: '确认执行' }, identity: { instanceId: f.instance.id, mutationId: b.mutationId, planHash: b.planHash } };
  const a = f.call('intent', args);
  if (action === 'intent') {
    const execution = f.call('claim_execution', { id: a.id, operationId: 'prior-attempt', attempt: 1 });
    f.h.state.failInsert = true; await expect(f.h.run(commit(b, execution))).rejects.toMatchObject({ code: 'MONGODB_OPERATION_FAILED' });
    const entry = { ok: true, ...await f.h.run(recover(b, execution)) };
    expect(f.call('reconcile', { id: a.id, result: { ok: true, entries: [entry] } }).state).toBe('retryable');
  }
  f.store.close();
  const child = fork(path.join(process.cwd(), 'agent/test/helpers/human-risk-crash.mjs'), { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
  child.send({ directory: f.directory, key: f.key.toString('hex'), action, boundary,
    args: { auth: f.auth, scope: f.scope, ...(action === 'intent' ? args : { id: a.id, operationId: 'claimed-attempt', attempt: 1 }) } });
  expect((await exited).signal).toBe('SIGKILL'); f.reopen();
  const record = f.call('inspect_operation', { id: a.id });
  if (action === 'claim_execution') {
    expect(!!record.execution).toBe(boundary === 'afterCommit'); expect(record.state).toBe('uncertain'); expect(record.executionAttempt).toBe(1);
  } else {
    expect(record.state).toBe(boundary === 'afterCommit' ? 'uncertain' : 'retryable');
    expect(record.executionAttempt).toBe(boundary === 'afterCommit' ? 2 : 1);
    expect(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='execution_evidence'").get().n).toBe(boundary === 'afterCommit' ? 1 : 0);
  }
  expect(f.h.state.rows.size).toBe(0);
});
