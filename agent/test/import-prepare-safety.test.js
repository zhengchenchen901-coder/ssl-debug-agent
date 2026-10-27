import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { importRiskFixture } from './helpers/import-risk-fixture.js';
import { privacyRequest } from '../privacy-service.js';
import { importBatchIdentity } from '../../plugins/remote-debug-agent/prepare-protocol.js';
import { normalizeMongoImport } from '../mongodb-mutations.js';
function attempt(f) {
  const request = { ...f.original, importId: 'new-safe-import' };
  const args = { route: '/mongodb/imports/prepare', request, dispatchDigest: f.digest(request), identity: { instanceId: f.instance.id, importId: request.importId, collection: request.collection } };
  const intent = f.call('intent', args);
  const input = { auth: f.auth, scope: f.scope, id: intent.id, attempt: intent.importPrepare.attempt, request };
  return { args, intent, input, claim: { ...input, dispatchDigest: f.digest(request), importBatches: importBatchIdentity(normalizeMongoImport(request, f.instance.mongodb)) } };
}
const recover = (f, a, service = f.service) => privacyRequest(service, { ...a.input, action: 'recover_operation', mode: 'reconcile' }, f.requestOptions);
const send = (f, a) => privacyRequest(f.service, { ...a.input, action: 'dispatch_prepare' }, f.requestOptions);

test('unclaimed import closes atomically across concurrent recovery, restart and lost closure reply; exact retry keeps every old attempt', async t => {
  const f = importRiskFixture(t), a = attempt(f), history = f.call('inspect_operation', { id: f.old.id });
  f.call('import_prepare_result', { ...a.input, importPrepare: a.intent.importPrepare, result: { ok: false, error: { code: 'MONGODB_IMPORT_EVIDENCE_REQUIRED' } } });
  const service = { call: async (action, input) => { const result = await f.service.call(action, input); if (action === 'import_prepare_result') throw Error('lost closure reply'); return result; } };
  await assert.rejects(recover(f, a, service), /lost closure reply/);
  f.reopen();
  const results = await Promise.all([recover(f, a), recover(f, a)]);
  assert.ok(results.every(r => r.state === 'rejected_before_dispatch'));
  const closed = f.call('inspect_operation', { id: a.intent.id });
  assert.equal(closed.reconciliation, undefined);
  assert.equal(closed.rejection.evidence, 'unclaimed_attempt_fence'); assert.equal(f.requests.length, 0);
  assert.throws(() => f.call('claim_import_prepare', a.claim));
  const next = f.call('intent', a.args); assert.equal(next.id, a.intent.id); assert.equal(next.importPrepare.attempt, 2);
  const reserved = f.call('inspect_operation', { id: next.id });
  await assert.rejects(send(f, a), { code: 'BUSINESS_OPERATION_RECONCILIATION_REQUIRED' });
  assert.deepEqual(f.call('inspect_operation', { id: next.id }), reserved);
  assert.throws(() => f.call('claim_import_prepare', a.claim));
  assert.throws(() => f.call('import_prepare_result', { ...a.input, importPrepare: a.intent.importPrepare, unclaimed: true, result: {} }));
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='import_prepare_evidence'").get().n, 1);
  assert.equal((await send(f, { ...a, input: { ...a.input, attempt: 2 } })).status, 'prepared');
  assert.deepEqual(f.call('inspect_operation', { id: f.old.id }), history); assert.equal(f.h.state.insert, 0);
});

test('claim winning the recovery race preserves uncertain even when no reply or remote files exist', async t => {
  const f = importRiskFixture(t), a = attempt(f); let won = false;
  const service = { call: async (action, input) => {
    if (action === 'import_prepare_result' && !won) { won = true; f.call('claim_import_prepare', a.claim); }
    return f.service.call(action, input);
  } };
  assert.equal((await recover(f, a, service)).state, 'uncertain'); f.reopen();
  assert.equal((await recover(f, a)).state, 'uncertain');
  assert.equal(f.call('intent', a.args).state, 'uncertain'); assert.equal(f.requests.filter(r => r === '/mongodb/imports/prepare').length, 0);
});

test('preflight failure cannot close a concurrent already claimed import', async t => {
  const f = importRiskFixture(t), a = attempt(f); f.call('claim_import_prepare', a.claim);
  f.instance.mongodb = { ...f.instance.mongodb, allowedCollections: ['other'] };
  assert.equal((await send(f, a)).intentState, 'uncertain'); assert.equal(f.requests.length, 0);
});

for (const action of ['intent', 'claim_import_prepare', 'import_prepare_result']) for (const boundary of ['beforeCommit', 'afterCommit']) {
  test(`SIGKILL import ${action} ${boundary} never reuses a dispatched or fenced attempt`, async t => {
    const f = importRiskFixture(t, { liveClock: true }), a = attempt(f);
    let args = { auth: f.auth, scope: f.scope, ...a.args, request: { ...a.args.request, importId: 'crash-import' } };
    if (action === 'intent') { args.identity = { ...args.identity, importId: args.request.importId }; args.dispatchDigest = f.digest(args.request); }
    if (action === 'claim_import_prepare') args = a.claim;
    if (action === 'import_prepare_result') args = { ...a.input, importPrepare: a.intent.importPrepare, unclaimed: true, result: { ok: false, error: { code: 'MONGODB_PREPARE_FENCED' } } };
    f.store.close();
    const child = fork(new URL('./helpers/human-risk-crash.mjs', import.meta.url), { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit'); child.send({ directory: f.directory, key: f.key.toString('hex'), action, args, boundary });
    const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, 'SIGKILL'); f.reopen();
    const target = action === 'intent' ? { ...a, args, intent: f.call('intent', args) } : a;
    if (action === 'intent') target.input = { ...a.input, id: target.intent.id, request: args.request };
    const result = await recover(f, target);
    assert.equal(result.state, action === 'claim_import_prepare' && boundary === 'afterCommit' ? 'uncertain' : 'rejected_before_dispatch');
    if (result.state === 'uncertain') assert.equal(f.call('intent', a.args).state, 'uncertain');
    else { const next = f.call('intent', target.args); assert.equal(next.importPrepare.attempt, 2); assert.equal(next.id, target.intent.id); }
    assert.equal(f.h.state.insert, 0);
  });
}

test('independent SQLite processes serialize delayed claim against atomic unclaimed closure', async t => {
  const f = importRiskFixture(t), a = attempt(f), helper = new URL('./helpers/import-attempt-race.mjs', import.meta.url);
  const launch = (action, args) => {
    const child = fork(helper, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const ready = new Promise(resolve => child.once('message', resolve));
    child.send({ directory: f.directory, key: f.key.toString('hex'), action, args });
    return { child, ready };
  };
  const claimant = launch('claim_import_prepare', a.claim);
  const closer = launch('import_prepare_result', { ...a.input, importPrepare: a.intent.importPrepare, unclaimed: true, result: { ok: false, error: { code: 'MONGODB_PREPARE_FENCED' } } });
  await Promise.all([claimant.ready, closer.ready]);
  const result = child => new Promise(resolve => child.once('message', resolve));
  const claimed = result(claimant.child), closed = result(closer.child), exits = [once(claimant.child, 'exit'), once(closer.child, 'exit')];
  claimant.child.send('run'); closer.child.send('run');
  const [c, r] = await Promise.all([claimed, closed]); await Promise.all(exits);
  f.reopen(); const saved = f.call('inspect_operation', { id: a.intent.id });
  if (c.ok) { assert.equal(saved.state, 'uncertain'); assert.equal(saved.dispatched, true); assert.equal(r.state, 'uncertain'); }
  else { assert.equal(c.code, 'BUSINESS_OPERATION_RECONCILIATION_REQUIRED'); assert.equal(saved.state, 'rejected_before_dispatch'); assert.equal(r.state, 'rejected_before_dispatch'); }
  assert.equal(f.requests.length, 0);
});

test('configuration changing after preclaim check is rechecked before transport, without relying on worker error text', async t => {
  const { WorkerManager, workerConfigFingerprint } = await import('../worker-manager.js');
  const f = importRiskFixture(t), a = attempt(f), policy = { host: '127.0.0.1', sshNetwork: {} }; let transports = 0;
  const runtime = { status: 'running', workerPort: 49999, authToken: 'a'.repeat(64), configFingerprint: workerConfigFingerprint(f.instance, policy, f.root) };
  const manager = { cwd: f.root, registry: { getInternal: () => f.instance }, resolveInstanceId: id => id, runtime: new Map([[f.instance.id, runtime]]), managerConfig: () => policy,
    fetchImpl: async () => { transports++; throw Error('unexpected transport'); } };
  const service = { call: async (action, input) => {
    const result = await f.service.call(action, input);
    if (action === 'claim_import_prepare') f.instance.mongodb = { ...f.instance.mongodb, allowedCollections: ['members', 'concurrently-added'] };
    return result;
  } };
  const options = { ...f.requestOptions, preflight: id => WorkerManager.prototype.assertMongoConfigurationCurrent.call(manager, id), dispatch: (...args) => WorkerManager.prototype.callInstance.call(manager, ...args) };
  const result = await privacyRequest(service, { ...a.input, action: 'dispatch_prepare' }, options);
  assert.equal(result.intentState, 'rejected_before_dispatch'); assert.equal(result.error.code, 'WORKER_CONFIGURATION_STALE');
  const saved = f.call('inspect_operation', { id: a.intent.id }); assert.equal(saved.dispatched, true); assert.equal(saved.rejection.evidence, 'preflight_before_ssh'); assert.equal(transports, 0);
  const next = f.call('intent', a.args);
  assert.equal((await privacyRequest(f.service, { ...a.input, attempt: next.importPrepare.attempt, action: 'dispatch_prepare' }, options)).intentState, 'rejected_before_dispatch');
  assert.equal(f.call('inspect_operation', { id: a.intent.id }).dispatched, undefined); assert.equal(transports, 0);
});
