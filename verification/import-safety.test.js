import { importRiskFixture } from '../agent/test/helpers/import-risk-fixture.js';
import { privacyRequest } from '../agent/privacy-service.js';
import { WorkerManager, workerConfigFingerprint } from '../agent/worker-manager.js';
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });
const fixture = () => importRiskFixture({ after: fn => cleanups.push(fn) });
function reserve(f) {
  const request = { ...f.original, importId: 'formal-safe-import' };
  const args = { route: '/mongodb/imports/prepare', request, dispatchDigest: f.digest(request), identity: { instanceId: f.instance.id, importId: request.importId, collection: request.collection } };
  return { args, intent: f.call('intent', args) };
}
function call(f, a, action, extra = {}, options = f.requestOptions) {
  return privacyRequest(f.service, { auth: f.auth, scope: f.scope, id: a.intent.id, attempt: a.intent.importPrepare.attempt, request: a.args.request, action, ...extra }, options);
}

test('unclaimed import fences once and retries the exact same intent after restart', async () => {
  const f = fixture(), a = reserve(f), original = f.call('inspect_operation', { id: f.old.id });
  f.reopen();
  const recovered = await Promise.all([call(f, a, 'recover_operation', { mode: 'reconcile' }), call(f, a, 'recover_operation', { mode: 'reconcile' })]);
  expect(recovered.map(r => r.state)).toEqual(['rejected_before_dispatch', 'rejected_before_dispatch']);
  expect(f.requests).toHaveLength(0);
  const next = f.call('intent', a.args);
  expect(next.id).toBe(a.intent.id); expect(next.importPrepare.attempt).toBe(2);
  const reserved = f.call('inspect_operation', { id: next.id });
  await expect(call(f, a, 'dispatch_prepare')).rejects.toMatchObject({ code: 'BUSINESS_OPERATION_RECONCILIATION_REQUIRED' });
  expect(f.call('inspect_operation', { id: next.id })).toEqual(reserved);
  expect(f.requests).toHaveLength(0);
  expect(await call(f, { ...a, intent: next }, 'dispatch_prepare')).toMatchObject({ status: 'prepared', intentState: 'complete' });
  expect(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='import_prepare_evidence'").get().n).toBe(1);
  expect(f.call('inspect_operation', { id: f.old.id })).toEqual(original);
  expect(f.h.state.insert).toBe(0);
});

test('dispatched import with no positive remote receipt remains uncertain and cannot retry', async () => {
  const f = fixture(), a = reserve(f);
  const options = { ...f.requestOptions, dispatch: async () => { throw Error('synthetic lost response'); } };
  expect(await call(f, a, 'dispatch_prepare', {}, options)).toMatchObject({ intentState: 'uncertain' });
  f.reopen();
  expect(await call(f, a, 'recover_operation', { mode: 'reconcile' })).toMatchObject({ state: 'uncertain', reason: 'import_prepare_evidence_required' });
  expect(f.call('intent', a.args).state).toBe('uncertain');
  expect(f.h.state.insert).toBe(0);
});

test('Manager new allowlist / worker old configuration is rejected before transport and exact intent can retry', async () => {
  const f = fixture(), a = reserve(f), managerPolicy = { host: '127.0.0.1', sshNetwork: {} };
  const runtime = { status: 'running', workerPort: 49999, authToken: 'a'.repeat(64), configFingerprint: workerConfigFingerprint(f.instance, managerPolicy, f.root) };
  let transports = 0;
  const manager = { cwd: f.root, registry: { getInternal: () => f.instance }, resolveInstanceId: id => id, runtime: new Map([[f.instance.id, runtime]]), managerConfig: () => managerPolicy,
    fetchImpl: async () => { transports++; throw Error('must never enter stale worker'); } };
  f.instance.mongodb = { ...f.instance.mongodb, allowedCollections: ['members', 'new-collection'] };
  const options = { ...f.requestOptions, preflight: id => WorkerManager.prototype.assertMongoConfigurationCurrent.call(manager, id), dispatch: (...args) => WorkerManager.prototype.callInstance.call(manager, ...args) };
  expect(await call(f, a, 'dispatch_prepare', {}, options)).toMatchObject({ intentState: 'rejected_before_dispatch', error: { code: 'WORKER_CONFIGURATION_STALE' } });
  expect(transports).toBe(0);
  expect(f.call('inspect_operation', { id: a.intent.id }).dispatched).toBeUndefined();
  const next = f.call('intent', a.args); expect(next.id).toBe(a.intent.id); expect(next.importPrepare.attempt).toBe(2);
  expect(await call(f, { ...a, intent: next }, 'dispatch_prepare')).toMatchObject({ status: 'prepared' });
  expect(f.h.state.insert).toBe(0);
});

test('human acceptance preserves original unknown, unique lineage, per-batch confirmation, idempotency and rollback', async () => {
  const f = fixture(), original = f.call('inspect_operation', { id: f.old.id }), p = f.approve(await f.prepare(JSON.parse(JSON.stringify(f.candidate))));
  expect(f.h.state.rows.size).toBe(0);
  const result = await f.create(p);
  expect(result.result.status).toBe('prepared'); expect(result.result.batches).toHaveLength(2);
  expect(f.h.state.rows.size).toBe(0);
  expect((await f.create(p)).result.importId).toBe(f.candidate.importId);
  for (const b of result.result.batches) {
    await expect(f.h.run({ mode: 'commit', mutationId: b.mutationId, planHash: b.planHash, confirmation: 'wrong' })).rejects.toMatchObject({ code: 'MONGODB_MUTATION_CONFIRMATION_REQUIRED' });
    expect((await f.h.run({ mode: 'commit', mutationId: b.mutationId, planHash: b.planHash, confirmation: '确认执行' })).status).toBe('committed');
    expect((await f.h.run({ mode: 'commit', mutationId: b.mutationId, planHash: b.planHash, confirmation: '确认执行' })).status).toBe('committed');
  }
  expect(f.h.state.rows.size).toBe(3);
  for (const b of [...result.result.batches].reverse()) expect((await f.h.run({ mode: 'rollback', mutationId: b.mutationId, planHash: b.planHash, confirmation: '确认回滚' })).status).toBe('rolled_back');
  expect(f.h.state.rows.size).toBe(0); expect(f.call('inspect_operation', { id: f.old.id })).toEqual(original);
});
