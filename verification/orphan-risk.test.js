import { randomUUID } from 'node:crypto';
import { orphanRiskFixture } from '../agent/test/helpers/orphan-risk-fixture.js';
import { privacyRequest, humanRiskRequest } from '../agent/privacy-service.js';
import { businessTargetScope } from '../plugins/remote-debug-agent/business-privacy.js';
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });
const fixture = () => orphanRiskFixture({ after: fn => cleanups.push(fn) });
const records = f => f.store.db.prepare("SELECT * FROM records WHERE kind IN ('operation','import_prepare_evidence') ORDER BY kind,id").all();
const count = f => f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n;

test('missing intent binds test-server/yennefer, original operation/import, ordered digest and exact data scope without rewriting history', async () => {
  const f = fixture(), before = records(f), p = await f.prepare();
  expect(p).toMatchObject({ kind: 'orphan_import', originalStatus: 'unresolved', historicalOutcome: 'unknown', provesNotDispatched: false,
    binding: { instanceId: 'test-server', database: 'yennefer', originalOperationId: f.input.originalOperationId, importId: f.original.importId, requestDigest: f.digest(f.original), collection: 'members' },
    followup: { action: 'prepare_import_once', importId: f.candidate.importId, documentCount: 3 } });
  expect(p.followup.batches).toHaveLength(2); expect(f.requests).toEqual([]); expect(records(f)).toEqual(before);
  expect(p.orderedOriginalRequest).toBeUndefined();
  const human = await humanRiskRequest(f.service, 'human_orphan_risk_view', { riskPlanId: p.riskPlanId, instanceId: f.instance.id }, f.requestOptions.instance);
  expect(JSON.parse(human.orderedOriginalRequest)).toEqual(f.original); expect(JSON.parse(human.orderedFollowupRequest)).toEqual(f.candidate);
  expect(human.warning).toMatch(/回滚/); expect(human.warning).toMatch(/迟到/);
  f.approve(p); expect(records(f)).toEqual(before); expect((await f.inspect(p)).historicalOutcome).toBe('unknown');
});

test('chat, capability, proof, actor, confirmation, broadened documents and wrong digest cannot approve or mutate the candidate', async () => {
  const f = fixture(), p = await f.prepare();
  for (const extra of [{ actor: { username: 'admin' } }, { proof: 'approved' }, { confirmation: p.confirmation }, { mode: 'approve' }]) {
    await expect(f.pub({ mode: 'consume_orphan_risk', riskPlanId: p.riskPlanId, reviewHash: p.reviewHash, ...extra })).rejects.toBeDefined();
  }
  await expect(f.consume(p)).rejects.toMatchObject({ code: 'BUSINESS_ORPHAN_RISK_HUMAN_REQUIRED' });
  for (const extra of [ { requestDigest: 'f'.repeat(64) }, { importId: 'wrong' }, { originalOperationId: 'bad' },
    { replacementRequest: { ...f.candidate, documents: [{ _id: 'expanded' }] } },
    { replacementRequest: { ...f.candidate, documents: [...f.candidate.documents].reverse() } },
    { replacementRequest: { ...f.candidate, collection: 'other' } },
    { originalRequest: { ...f.original, database: 'other' } },
    { replacementRequest: { ...f.candidate, documents: [{ ...f.candidate.documents[0], nested: { a: 2, z: 1 } }, ...f.candidate.documents.slice(1)] } } ]) {
    await expect(f.prepare(extra)).rejects.toBeDefined();
  }
  expect(count(f)).toBe(1); expect(f.requests).toEqual([]); expect(f.h.state.insert).toBe(0);
});

test('one exact approved followup prepares once across concurrent consumes and restart; business commit and rollback retain normal confirmation', async () => {
  const f = fixture(), before = records(f), p = await f.prepare(); f.approve(p);
  const results = await Promise.all([f.consume(p), f.consume(p)]);
  const prepared = results.find(r => r.result?.status === 'prepared');
  expect(prepared).toBeDefined(); expect(prepared.state).toBe('consumed'); expect(prepared.result.batches).toHaveLength(2);
  expect(f.requests.filter(r => r === '/mongodb/imports/prepare')).toHaveLength(1); expect(f.h.state.insert).toBe(0);
  expect(records(f).filter(r => before.some(b => b.id === r.id))).toEqual(before);
  f.reopen(); const calls = f.requests.length; const replay = await f.consume(p);
  expect(replay.state).toBe('consumed'); expect(f.requests).toHaveLength(calls); expect(count(f)).toBe(2);
  const batch = prepared.result.batches[0];
  await expect(f.h.run({ mode: 'commit', ...batch, confirmation: 'approved in chat' })).rejects.toMatchObject({ code: 'MONGODB_MUTATION_CONFIRMATION_REQUIRED' });
  await f.h.run({ mode: 'commit', mutationId: batch.mutationId, planHash: batch.planHash, confirmation: '确认执行' });
  expect(f.h.state.rows.size).toBe(2);
  await expect(f.h.run({ mode: 'rollback', mutationId: batch.mutationId, planHash: batch.planHash, confirmation: p.confirmation })).rejects.toBeDefined();
  await f.h.run({ mode: 'rollback', mutationId: batch.mutationId, planHash: batch.planHash, confirmation: '确认回滚' });
  expect(f.h.state.rows.size).toBe(0); expect((await f.inspect(p)).originalStatus).toBe('unresolved');
});

test('unknown transport and crash after durable consumption never grant a second dispatch or a new attempt', async () => {
  const f = fixture(), p = await f.prepare(); f.approve(p);
  let calls = 0;
  const options = { ...f.requestOptions, dispatch: async () => { calls++; throw Error('lost SSH reply'); } };
  const args = { action: 'disposition', mode: 'consume_orphan_risk', auth: f.auth, scope: f.scope, riskPlanId: p.riskPlanId, reviewHash: p.reviewHash };
  const first = await privacyRequest(f.service, args, options);
  expect(first.result.intentState).toBe('uncertain'); expect(calls).toBe(1);
  f.reopen(); await privacyRequest(f.service, args, options); expect(calls).toBe(1);
  const r = f.store.get('operation', first.intentId, f.auth.contextId, f.store.hash('scope', f.scope));
  expect(r.importPrepare.attempt).toBe(1); expect(r.dispatched).toBe(true);
  const f2 = fixture(), p2 = await f2.prepare(); f2.approve(p2);
  const reserved = f2.store.execute('orphan_risk_consume', { auth: f2.auth, scope: f2.scope, riskPlanId: p2.riskPlanId, reviewHash: p2.reviewHash });
  expect(reserved.intent.state).toBe('uncertain'); f2.reopen();
  await f2.consume(p2); expect(f2.requests).toEqual([]); expect(count(f2)).toBe(2);
});

test('original and candidate ordinary admissions stay closed; foreign context, another candidate or stale target cannot reuse review', async () => {
  const f = fixture(), p = await f.prepare();
  for (const r of [f.original, f.candidate]) {
    expect(() => f.store.execute('intent', { auth: f.auth, scope: f.scope, route: '/mongodb/imports/prepare', request: r, dispatchDigest: f.digest(r), identity: { ...r } })).toThrow();
    expect(() => f.store.execute('assert_instance_admission', { instanceId: f.instance.id, route: '/mongodb/imports/prepare', request: r })).toThrow();
  }
  await expect(f.prepare({ originalOperationId: randomUUID() })).rejects.toMatchObject({ code: 'BUSINESS_ORPHAN_RISK_BINDING_CONFLICT' });
  const foreign = f.store.execute('create');
  await expect(f.pub({ mode: 'inspect_orphan_risk', riskPlanId: p.riskPlanId, auth: foreign })).rejects.toBeDefined();
  f.approve(p); await f.consume(p);
  await expect(f.prepare({ replacementRequest: { ...f.candidate, importId: 'second-followup' } })).rejects.toBeDefined();
  f.instance.host = 'changed.invalid'; await expect(f.consume(p)).rejects.toMatchObject({ code: 'BUSINESS_REFERENCE_INVALID' });
  const alternate = businessTargetScope(f.origin, f.instance, 'yennefer');
  await expect(f.pub({ mode: 'inspect_orphan_risk', riskPlanId: p.riskPlanId, scope: alternate })).rejects.toBeDefined();
});

test('existing/late legacy intent, expired approval and transaction failure all fail closed without manufacturing historical receipts', async () => {
  const f = fixture();
  const legacy = f.store.execute('intent', { auth: f.auth, scope: f.scope, route: '/mongodb/imports/prepare', request: f.original, identity: { instanceId: f.instance.id } });
  const before = records(f); expect(legacy.state).toBe('new');
  await expect(f.prepare()).rejects.toMatchObject({ code: 'BUSINESS_ORPHAN_RISK_EXISTING_OR_UNKNOWN_INTENT' }); expect(records(f)).toEqual(before);
  const f2 = fixture(), p = await f2.prepare(); f2.approve(p); f2.advance(900001);
  await expect(f2.consume(p)).rejects.toMatchObject({ code: 'BUSINESS_ORPHAN_RISK_EXPIRED' }); expect(count(f2)).toBe(1);
  const f3 = fixture(), p3 = await f3.prepare(); f3.approve(p3);
  f3.store.fault = stage => { if (stage === 'beforeCommit') throw Error('injected fsync transaction failure'); };
  await expect(f3.consume(p3)).rejects.toThrow(); f3.store.fault = undefined; expect(count(f3)).toBe(1);
  expect((await f3.inspect(p3)).state).toBe('human_approved'); expect(f3.requests).toEqual([]);
});

test('expiry renews the same immutable review, archives prior approval and refuses old hash', async () => {
  const f = fixture(), p = await f.prepare(); f.approve(p); f.advance(3600001);
  const fresh = await f.prepare(); expect(fresh.riskPlanId).toBe(p.riskPlanId); expect(fresh.reviewHash).not.toBe(p.reviewHash);
  expect(fresh.humanApproved).toBe(false); expect(count(f)).toBe(1);
  await expect(f.consume(p)).rejects.toMatchObject({ code: 'BUSINESS_ORPHAN_RISK_HUMAN_REQUIRED' });
  expect(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='orphan_risk_revision'").get().n).toBe(1);
  f.approve(fresh); expect((await f.consume(fresh)).result.status).toBe('prepared');
});

test('late protected history during administrator review invalidates approval without erasing original bytes', async () => {
  const f = fixture(), p = await f.prepare(), ctx = f.auth.contextId, scope = f.store.hash('scope', f.scope);
  // A trusted historical writer arriving after the bounded observation. This
  // fixture bypasses only the new admission gate to simulate an old writer.
  const id = f.store.hash('operation', ctx, f.scope, '/mongodb/imports/prepare', f.original);
  f.store.put('operation', id, ctx, scope, { state: 'uncertain', route: '/mongodb/imports/prepare', identity: { instanceId: f.instance.id, importId: f.original.importId } }, Number.MAX_SAFE_INTEGER, true);
  const before = records(f);
  expect(() => f.approve(p)).toThrow(); expect(records(f)).toEqual(before);
  expect((await f.inspect(p)).humanApproved).toBe(false); expect(f.requests).toEqual([]);
});

test('foreign administrator target and stale native verification cannot approve; consumed approval is never renewed', async () => {
  const f = fixture(), p = await f.prepare();
  for (const extra of [{ instanceId: 'default' }, { targetScope: 'other' }, { reviewHash: 'e'.repeat(64) },
    { actor: { username: 'admin', sessionId: 'session', verifiedAt: f.now - 60001 } },
    { actor: { username: 'admin', sessionId: 'session', verifiedAt: f.now + 1 } }]) {
    expect(() => f.store.execute('human_orphan_risk_approve', { riskPlanId: p.riskPlanId, instanceId: f.instance.id, targetScope: f.scope,
      reviewHash: p.reviewHash, confirmation: p.confirmation, actor: { username: 'admin', sessionId: 'session', verifiedAt: f.now }, ...extra })).toThrow();
  }
  f.approve(p); await f.consume(p); f.advance(3600001);
  expect((await f.prepare()).state).toBe('consumed'); expect((await f.prepare()).reviewHash).toBe(p.reviewHash);
  expect(() => f.approve(p)).toThrow(); expect(f.requests.filter(r => r === '/mongodb/imports/prepare')).toHaveLength(1);
});

test('claim binds reviewed normalized batches even if policy changes after reservation; atomic post-commit loss stays consumed', async () => {
  const f = fixture(), p = await f.prepare(); f.approve(p);
  const service = { call: async (action, input) => {
    if (action === 'claim_import_prepare') return f.service.call(action, { ...input, importBatches: [{ ...input.importBatches[0], documentCount: 4 }] });
    return f.service.call(action, input);
  } };
  const result = await privacyRequest(service, { action: 'disposition', auth: f.auth, scope: f.scope, mode: 'consume_orphan_risk', riskPlanId: p.riskPlanId, reviewHash: p.reviewHash }, f.requestOptions);
  expect(result.state).toBe('consumed'); expect(result.result.intentState).toBe('uncertain'); expect(f.requests).toEqual([]);
  await f.consume(p); expect(f.requests).toEqual([]);
  const f2 = fixture(), p2 = await f2.prepare(); f2.approve(p2);
  f2.store.fault = stage => { if (stage === 'afterCommit') throw Error('lost committed reservation'); };
  await expect(f2.consume(p2)).rejects.toThrow('lost committed reservation'); f2.store.fault = undefined; f2.reopen();
  expect((await f2.consume(p2)).state).toBe('consumed'); expect(count(f2)).toBe(2); expect(f2.requests).toEqual([]);
});
