import { executionRiskFixture } from '../agent/test/helpers/execution-risk-fixture.js';
import { privacyRequest } from '../agent/privacy-service.js';
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });
const fixture = options => executionRiskFixture({ after: fn => cleanups.push(fn) }, options);

for (const legacy of [true, false]) test(`independent ${legacy ? 'legacy' : 'v2'} unknown acceptance preserves original and creates one immutable child`, async () => {
  const x = await fixture({ legacy }), { f } = x;
  const original = f.call('inspect_operation', { id: x.intent.id }), p = await x.prepare();
  expect(p).toMatchObject({ kind: 'import_execution', humanApproved: false, historicalOutcome: 'unknown', binding: { intentId: x.intent.id, importId: f.candidate.importId, attempt: legacy ? null : 1 } });
  await expect(x.continue(p)).rejects.toMatchObject({ code: 'BUSINESS_EXECUTION_RISK_HUMAN_REQUIRED' });
  const approved = await x.approve(p); f.reopen(); const child = await x.continue(approved);
  expect(child.state).toBe('prepared'); expect(child.mutationId).not.toBe(x.batch.mutationId); expect(child.planHash).not.toBe(x.batch.planHash);
  expect(child.result).toMatchObject({ status: 'planned', requiresConfirmation: true, importId: f.candidate.importId });
  expect(f.call('inspect_operation', { id: x.intent.id })).toEqual(original); expect(f.h.state.rows.size).toBe(0);
  expect(await x.continue(approved)).toEqual(child);
});

test('legacy plan with no UUID gets an explicitly reviewed current prerequisite while retaining old immutable hash', async () => {
  const x = await fixture({ legacy: true, legacyNoUuid: true }), p = await x.prepare();
  expect(p.originalCollectionIdentity).toBeNull(); expect(p.collectionIdentity).toBe('synthetic-uuid-1');
  await x.approve(p); const child = await x.continue(p);
  expect(child.binding.planHash).toBe(x.batch.planHash); expect(child.planHash).not.toBe(x.batch.planHash);
  expect(x.f.call('inspect_operation', { id: x.intent.id }).state).toBe('uncertain');
});

test('caller proof, old approval and different protected context cannot authorize this execution', async () => {
  const x = await fixture(), { f } = x, p = await x.prepare();
  await expect(x.continue({ ...p, reviewHash: x.lineage.reviewHash })).rejects.toMatchObject({ code: 'BUSINESS_EXECUTION_RISK_HUMAN_REQUIRED' });
  await expect(x.pub({ mode: 'prepare_execution_risk', id: x.intent.id, riskPlanId: x.lineage.riskPlanId, proof: { safe: true } })).rejects.toMatchObject({ code: 'BUSINESS_DISPOSITION_DENIED' });
  const auth = f.store.execute('create');
  await expect(privacyRequest(f.service, { action: 'disposition', auth, scope: f.scope, mode: 'inspect_execution_risk', riskPlanId: p.riskPlanId }, x.requestOptions)).rejects.toThrow();
  await expect(f.human('human_execution_risk_approve', { riskPlanId: p.riskPlanId, instanceId: f.instance.id,
    reviewHash: p.reviewHash, confirmation: x.lineage.confirmation, actor: { username: 'a', sessionId: 'b', verifiedAt: f.now } })).rejects.toThrow();
});

test('UUID drift after approval rejects continuation without changing the approved hash or replaying writes', async () => {
  const x = await fixture(), p = await x.prepare(); await x.approve(p); x.f.h.state.collectionUuid = 'new-namespace';
  await expect(x.continue(p)).rejects.toMatchObject({ code: 'MONGODB_EXECUTION_REVIEW_CONFLICT' });
  expect(await x.pub({ mode: 'inspect_execution_risk', riskPlanId: p.riskPlanId })).toMatchObject({ state: 'reserved', planHash: p.planHash });
  expect(x.f.h.state.rows.size).toBe(0);
});

test('lost reservation reply recovers the same child after Manager storage restart', async () => {
  const x = await fixture(), { f } = x, p = await x.prepare(); await x.approve(p); let lose = true;
  const options = { ...x.requestOptions, dispatch: async (...args) => { const r = await x.requestOptions.dispatch(...args);
    if (lose && args[1].endsWith('execution-continue')) { lose = false; throw Error('synthetic reply lost'); } return r; } };
  await expect(privacyRequest(f.service, { action: 'disposition', auth: f.auth, scope: f.scope, mode: 'continue_execution', riskPlanId: p.riskPlanId, reviewHash: p.reviewHash }, options)).rejects.toThrow('synthetic reply lost');
  f.reopen(); expect(await x.continue(p)).toMatchObject({ mutationId: p.mutationId, planHash: p.planHash, state: 'prepared' }); expect(f.h.state.rows.size).toBe(0);
});

test('expired independent review cannot approve; explicit refresh archives the previous revision', async () => {
  const x = await fixture(), p = await x.prepare(); x.f.advance(900001);
  await expect(x.approve(p)).rejects.toThrow(); const fresh = await x.prepare();
  expect(fresh.riskPlanId).toBe(p.riskPlanId); expect(fresh.reviewHash).not.toBe(p.reviewHash);
  expect(x.f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='execution_risk_revision'").get().n).toBe(1);
});

test('child requires exact separate business confirmation and its new unknown never automatically dispatches again', async () => {
  const x = await fixture(), { f } = x, p = await x.prepare(); await x.approve(p); const child = await x.continue(p);
  const r = { mutationId: child.mutationId, planHash: child.planHash, confirmation: '确认执行' };
  await expect(f.h.run({ ...r, mode: 'commit', confirmation: 'wrong' })).rejects.toMatchObject({ code: 'MONGODB_MUTATION_CONFIRMATION_REQUIRED' });
  await expect(f.h.run({ ...r, mode: 'commit' })).rejects.toMatchObject({ code: 'MONGODB_EXECUTION_IDENTITY_INVALID' });
  const identity = { instanceId: f.instance.id, mutationId: r.mutationId, planHash: r.planHash };
  const intent = f.call('intent', { route: '/mongodb/mutations/execute', request: r, identity });
  const ticket = f.call('claim_execution', { id: intent.id, operationId: 'child-unknown', attempt: intent.executionAttempt });
  f.h.state.failInsert = true; f.h.state.failAbort = true;
  await expect(f.h.run({ ...r, mode: 'commit', _businessExecution: ticket })).rejects.toMatchObject({ code: 'MONGODB_OPERATION_FAILED' });
  const count = f.h.state.insert;
  expect(f.call('intent', { route: '/mongodb/mutations/execute', request: r, identity }).state).toBe('uncertain');
  await expect(f.h.run({ ...r, mode: 'commit', _businessExecution: ticket })).rejects.toMatchObject({ code: 'MONGODB_MUTATION_STATE_INVALID' });
  await expect(x.pub({ mode: 'prepare_execution_risk', id: intent.id, riskPlanId: x.lineage.riskPlanId })).rejects.toMatchObject({ code: 'BUSINESS_EXECUTION_RISK_DENIED' });
  expect(f.h.state.insert).toBe(count);
});
