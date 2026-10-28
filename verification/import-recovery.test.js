import { randomUUID } from 'node:crypto';
import { importRiskFixture } from '../agent/test/helpers/import-risk-fixture.js';
import { privacyRequest } from '../agent/privacy-service.js';
import { normalizeMongoImport } from '../agent/mongodb-mutations.js';
import { importBatchIdentity, importPreparePayload, prepareRequestDigest } from '../plugins/remote-debug-agent/prepare-protocol.js';
import { businessTargetScope } from '../plugins/remote-debug-agent/business-privacy.js';
import { createOutputGuard } from '../plugins/remote-debug-agent/output-guard.js';
import { IMPORT_LOOKUP_MAX_RECORDS } from '../agent/mongodb-import-recovery.js';

const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });
const fixture = () => importRiskFixture({ after: fn => cleanups.push(fn) });
function reserve(f) {
  const request = { ...f.original, importId: 'readonly-recovery-fixture' };
  const args = { route: '/mongodb/imports/prepare', request, dispatchDigest: f.digest(request),
    identity: { instanceId: f.instance.id, database: 'test', importId: request.importId, collection: request.collection } };
  const intent = f.call('intent', args), operationId = randomUUID();
  const input = { auth: f.auth, scope: f.scope, id: intent.id, attempt: intent.importPrepare.attempt, request, operationId };
  const claim = () => f.call('claim_import_prepare', { ...input, dispatchDigest: args.dispatchDigest,
    importBatches: importBatchIdentity(normalizeMongoImport(request, f.instance.mongodb)) });
  return { request, args, intent, operationId, input, claim };
}
const snapshot = f => ({ records: f.store.db.prepare('SELECT * FROM records ORDER BY kind,id').all(), links: f.store.db.prepare('SELECT * FROM links ORDER BY task,ref').all() });
const lookup = (f, a, extra = {}, options = f.requestOptions) => privacyRequest(f.service, {
  action: 'resolve_import', auth: f.auth, scope: f.scope, originalOperationId: a.operationId,
  importId: a.request.importId, requestDigest: a.args.dispatchDigest, ...extra,
}, options);
const send = (f, a, options = f.requestOptions) => privacyRequest(f.service, { ...a.input, action: 'dispatch_prepare' }, options);
const reject = (f, a) => f.call('import_prepare_result', { ...a.input, importPrepare: a.intent.importPrepare,
  notDispatched: true, result: { ok: false, error: { code: 'WORKER_CONFIGURATION_STALE' } } });

test('exact original operation/import/digest returns the existing prepared plan after restart without any state writes', async () => {
  const f = fixture(), a = reserve(f);
  const plan = await send(f, a); expect(plan.status).toBe('prepared'); f.reopen();
  const before = snapshot(f), calls = f.requests.length;
  const result = await lookup(f, a);
  expect(result).toMatchObject({ ok: true, readOnly: true, state: 'complete', intentId: a.intent.id, evidenceSource: 'protected_receipt', result: { importId: a.request.importId, status: 'prepared' } });
  expect(result.result.batches.map(b => b.planHash)).toEqual(plan.batches.map(b => b.planHash));
  expect(snapshot(f)).toEqual(before); expect(f.requests.length).toBe(calls); expect(f.h.state.insert).toBe(0);
});

test('lost local reply reads exact remote evidence through existing recovery without reconciling protection or replaying prepare', async () => {
  const f = fixture(), a = reserve(f);
  let lost = false;
  const service = { call: async (action, input) => {
    if (action === 'import_prepare_result') { lost = true; throw Error('lost local persistence'); }
    return f.service.call(action, input);
  } };
  await expect(privacyRequest(service, { ...a.input, action: 'dispatch_prepare' }, f.requestOptions)).rejects.toThrow('lost local persistence');
  expect(lost).toBe(true); f.reopen(); const before = snapshot(f), calls = f.requests.length;
  const result = await lookup(f, a);
  expect(result).toMatchObject({ state: 'complete', protectedState: 'uncertain', evidenceSource: 'exact_remote_receipt', intentId: a.intent.id, result: { status: 'prepared' } });
  expect(f.requests.slice(calls)).toEqual(['/mongodb/imports/recover-prepare']);
  expect(snapshot(f)).toEqual(before); expect(f.call('inspect_operation', { id: a.intent.id }).state).toBe('uncertain'); expect(f.h.state.insert).toBe(0);
});

test('missing remote receipt or a forged/mismatched receipt stays unresolved with the original record unchanged', async () => {
  const f = fixture(), a = reserve(f); a.claim(); const before = snapshot(f);
  expect(await lookup(f, a)).toMatchObject({ state: 'unresolved', intentId: a.intent.id, reason: 'remote_evidence_unavailable' });
  expect(await lookup(f, a, {}, { ...f.requestOptions, dispatch: async () => ({ ok: true, kind: 'import_plan', status: 'prepared', importId: a.request.importId, importReceipt: { binding: 'a'.repeat(64) }, batches: [] }) })).toMatchObject({ state: 'unresolved', reason: 'import_prepare_evidence_required' });
  expect(snapshot(f)).toEqual(before); expect(f.h.state.insert).toBe(0);
});

test('every caller binding is required; wrong operation, digest, import, context or database cannot locate an intent', async () => {
  const f = fixture(), a = reserve(f); await send(f, a);
  const otherAuth = f.store.execute('create'), otherScope = businessTargetScope(f.origin, f.instance, 'other');
  const before = snapshot(f);
  for (const extra of [{ originalOperationId: randomUUID() }, { requestDigest: 'f'.repeat(64) }, { importId: 'different-import' }, { auth: otherAuth }, { scope: otherScope }]) {
    const r = await lookup(f, a, extra); expect(r).toMatchObject({ state: 'unresolved', reason: 'trusted_record_not_found' }); expect(r.intentId).toBeUndefined();
  }
  expect(snapshot(f)).toEqual(before);
});

test('explicit test-server / yennefer scope is supported and cannot be redirected to default or another profile', async () => {
  const f = fixture(); f.instance.id = 'test-server'; f.instance.mongodb = { ...f.instance.mongodb, database: 'yennefer', allowedDatabases: ['yennefer'] };
  const scope = businessTargetScope(f.origin, f.instance, 'yennefer'), operationId = randomUUID();
  const request = JSON.parse(JSON.stringify(importPreparePayload({ ...f.original, instanceId: 'test-server', database: 'yennefer' })));
  const intent = f.call('intent', { scope, route: '/mongodb/imports/prepare', request, dispatchDigest: f.digest(request), identity: { instanceId: 'test-server', database: 'yennefer', collection: 'members', importId: request.importId } });
  f.call('claim_import_prepare', { scope, id: intent.id, operationId, attempt: 1, dispatchDigest: f.digest(request), importBatches: importBatchIdentity(normalizeMongoImport(request, f.instance.mongodb)) });
  const a = { operationId, request, args: { dispatchDigest: f.digest(request) } }, before = snapshot(f);
  expect(await lookup(f, a, { scope }, { ...f.requestOptions, dispatch: undefined })).toMatchObject({ state: 'unresolved', intentId: intent.id });
  await expect(lookup(f, a, { scope: businessTargetScope(f.origin, { ...f.instance, id: 'default' }, 'yennefer') })).rejects.toMatchObject({ code: 'BUSINESS_REFERENCE_INVALID' });
  const stale = scope; f.instance.mongodb.configProfile = 'changed';
  await expect(lookup(f, a, { scope: stale })).rejects.toMatchObject({ code: 'BUSINESS_REFERENCE_INVALID' });
  expect(snapshot(f)).toEqual(before);
});

test('no intent plus log-like data and absent plans never manufacture a historical rejection', async () => {
  const f = fixture(), a = { operationId: randomUUID(), request: { importId: 'never-recorded' }, args: { dispatchDigest: '1'.repeat(64) } };
  // Existing diagnostic events are not dispatch receipts, even if their text
  // claims a pre-dispatch stop. No event parser is a source of recovery proof.
  f.store.put('event', randomUUID(), f.auth.contextId, f.store.hash('scope', f.scope), { operationId: a.operationId, code: 'OUTPUT_GUARD_BLOCKED', state: 'rejected_before_dispatch' });
  const before = snapshot(f); expect(await lookup(f, a)).toMatchObject({ state: 'unresolved', reason: 'trusted_record_not_found' });
  expect(snapshot(f)).toEqual(before); expect(f.requests).toHaveLength(0);
});

test('unclaimed existing intent with no operation binding remains unresolved and is not fenced', async () => {
  const f = fixture(), a = reserve(f), before = snapshot(f);
  expect(await lookup(f, a)).toMatchObject({ state: 'unresolved' });
  expect(await privacyRequest(f.service, { action: 'recover_operation', auth: f.auth, scope: f.scope, id: a.intent.id, mode: 'observe' }, f.requestOptions)).toMatchObject({ state: 'unresolved', protectedState: 'uncertain' });
  expect(snapshot(f)).toEqual(before); expect(f.call('inspect_operation', { id: a.intent.id }).dispatched).toBeUndefined(); expect(f.requests).toHaveLength(0);
});

test('only an already durable exact rejection can be returned and prior rejected attempts survive a same-intent reservation', async () => {
  const f = fixture(), a = reserve(f); a.claim(); reject(f, a);
  const before = snapshot(f); expect(await lookup(f, a)).toMatchObject({ state: 'rejected_before_dispatch', evidenceSource: 'protected_rejection', attempt: 1 }); expect(snapshot(f)).toEqual(before);
  const next = f.call('intent', a.args); expect(next.id).toBe(a.intent.id); expect(next.importPrepare.attempt).toBe(2);
  const reserved = snapshot(f);
  expect(await lookup(f, a)).toMatchObject({ state: 'rejected_before_dispatch', archived: true, attempt: 1, intentId: a.intent.id });
  expect(snapshot(f)).toEqual(reserved); expect(f.call('inspect_operation', { id: a.intent.id }).state).toBe('uncertain'); expect(f.requests).toHaveLength(0);
});

test('legacy rejection labels without authoritative bound evidence and legacy missing digests stay unresolved', async () => {
  const f = fixture(), a = reserve(f); a.claim();
  const key = f.store.hash('scope', f.scope), record = f.call('inspect_operation', { id: a.intent.id });
  f.store.put('operation', a.intent.id, f.auth.contextId, key, { ...record, state: 'rejected_before_dispatch', rejection: { attempt: 1 } });
  const before = snapshot(f); expect(await lookup(f, a)).toMatchObject({ state: 'unresolved', reason: 'pre_dispatch_evidence_required' }); expect(snapshot(f)).toEqual(before);
  f.store.put('operation', a.intent.id, f.auth.contextId, key, { ...record, importPrepare: undefined });
  const legacy = snapshot(f); expect(await lookup(f, a)).toMatchObject({ state: 'unresolved', reason: 'trusted_record_not_found' }); expect(snapshot(f)).toEqual(legacy);
});

test('invalid or caller-supplied proof fields are denied before any recovery dispatch', async () => {
  const f = fixture(), a = reserve(f), before = snapshot(f);
  for (const extra of [{ requestDigest: 'not-a-digest' }, { originalOperationId: 'not-an-operation' }, { importId: '../import' }, { result: { state: 'rejected_before_dispatch' } }, { id: a.intent.id }, { unclaimed: true }]) {
    await expect(lookup(f, a, extra)).rejects.toMatchObject({ code: 'BUSINESS_OPERATION_LOOKUP_INVALID' });
  }
  await expect(lookup(f, a, { auth: { ...f.auth, capability: '0'.repeat(64) } })).rejects.toMatchObject({ code: 'BUSINESS_CONTEXT_DENIED' });
  expect(snapshot(f)).toEqual(before); expect(f.requests).toHaveLength(0);
});

test('ambiguous trusted records and exhausted scan budget cannot return a prefix match', async () => {
  const f = fixture(), a = reserve(f); a.claim();
  const key = f.store.hash('scope', f.scope), record = f.call('inspect_operation', { id: a.intent.id }), otherId = '9'.repeat(64);
  f.store.put('operation', otherId, f.auth.contextId, key, { ...record, importPrepare: { ...record.importPrepare, binding: otherId } });
  expect(await lookup(f, a)).toMatchObject({ state: 'unresolved', reason: 'trusted_records_ambiguous' });
  f.store.transaction(() => { for (let n = 0; n < IMPORT_LOOKUP_MAX_RECORDS; n++) f.store.put('operation', 'budget-'+n, f.auth.contextId, key, { state: 'uncertain', route: '/other' }); });
  const before = snapshot(f); expect(await lookup(f, a)).toMatchObject({ state: 'unresolved', reason: 'trusted_lookup_budget_exceeded' }); expect(snapshot(f)).toEqual(before);
});

test('wire digest preserves original BSON and document order; file hashes and reordered inputs cannot substitute', async () => {
  const f = fixture(), a = reserve(f); await send(f, a);
  const changed = { ...a.request, documents: [...a.request.documents].reverse() };
  expect(prepareRequestDigest(importPreparePayload(changed))).not.toBe(a.args.dispatchDigest);
  const before = snapshot(f); expect(await lookup(f, a, { requestDigest: prepareRequestDigest(importPreparePayload(changed)) })).toMatchObject({ state: 'unresolved' }); expect(snapshot(f)).toEqual(before);
});

test('new output contract retains the verified plan and control evidence, omitting unknown private fields', async () => {
  const f = fixture(), a = reserve(f); await send(f, a);
  const result = await lookup(f, a); result.privateStorage = { capability: 'never-export-this' };
  const guarded = JSON.parse(createOutputGuard().toolResult('remote_debug_mongodb_resolve_import', result).content[0].text);
  expect(guarded).toMatchObject({ readOnly: true, state: 'complete', intentId: a.intent.id, evidenceSource: 'protected_receipt', result: { status: 'prepared' } });
  expect(guarded.result.batches).toHaveLength(2); expect(guarded.privateStorage).toBeUndefined(); expect(JSON.stringify(guarded)).not.toContain('never-export-this');
});
