import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrivacyStore } from '../../../agent/privacy-store.js';
import { importConfig, importHarness } from '../../../agent/test/helpers/import-fixture.js';
import { normalizeMongoImport } from '../../../agent/mongodb-mutations.js';
import { businessTargetScope } from '../business-privacy.js';
import { importPreparePayload, prepareRequestDigest, importBatchIdentity } from '../prepare-protocol.js';
import { localMcp } from './helpers/local-mcp.js';

for (const lostReply of [false, true]) test(`public read-only import lookup ${lostReply ? 'observes remote lost reply' : 'returns stored plan'} in the original isolated context`, async t => {
  const h = importHarness(), operationId = randomUUID();
  const instance = { id: 'test-server', host: 'fixture.invalid', enabled: true,
    mongodb: { ...importConfig, database: 'yennefer', allowedDatabases: ['yennefer'] } };
  let intent, auth, scope, storageDirectory, storageKey, protectedBefore;
  const request = JSON.parse(JSON.stringify(importPreparePayload({ instanceId: instance.id, database: 'yennefer', importId: 'synthetic-readonly-import', collection: 'members', batchSize: 1,
    documents: [{ _id: 'disposable-one', value: 1 }, { _id: 'disposable-two', value: 2 }], purpose: 'isolated read-only protocol fixture' })));
  const digest = prepareRequestDigest(request);
  const protectedRows = store => store.db.prepare("SELECT * FROM records WHERE kind IN ('operation','import_prepare_evidence') ORDER BY kind,id").all();
  const peer = await localMcp(t, { instance, handler: async (route, input) => {
    assert.equal(route, '/mongodb/imports/recover-prepare', 'lookup must never dispatch a prepare or execution');
    return h.run({ ...input, mode: 'import_recover' }, instance.mongodb);
  }, beforePeer: async ({ directory, key, root, origin }) => {
    storageDirectory = directory; storageKey = key; scope = businessTargetScope(origin, instance, 'yennefer');
    const store = new PrivacyStore({ directory, key }); auth = store.execute('create');
    const call = (action, fields) => store.execute(action, { auth, scope, ...fields });
    intent = call('intent', { route: '/mongodb/imports/prepare', request, dispatchDigest: digest,
      identity: { instanceId: instance.id, database: 'yennefer', importId: request.importId, collection: request.collection } });
    const batches = importBatchIdentity(normalizeMongoImport(request, instance.mongodb));
    call('claim_import_prepare', { id: intent.id, attempt: 1, operationId, dispatchDigest: digest, importBatches: batches });
    const result = { ok: true, ...await h.run({ ...request, mode: 'prepare', kind: 'import_plan',
      _businessImport: { ...intent.importPrepare, batchesDigest: prepareRequestDigest({ batches }) } }, instance.mongodb) };
    if (!lostReply) call('import_prepare_result', { id: intent.id, importPrepare: intent.importPrepare, result });
    protectedBefore = protectedRows(store); store.close();
    fs.writeFileSync(path.join(root, 'context.json'), JSON.stringify({ version: 1, origin, auth }), { mode: 0o600 });
  } });
  const target = { instanceId: 'test-server', database: 'yennefer' };
  const args = { ...target, originalOperationId: operationId, importId: request.importId, requestDigest: digest };
  const resolved = await peer.call('remote_debug_mongodb_resolve_import', args);
  assert.notEqual(resolved.isError, true, JSON.stringify(resolved));
  assert.equal(resolved.payload.state, 'complete'); assert.equal(resolved.payload.intentId, intent.id); assert.equal(resolved.payload.readOnly, true);
  assert.equal(resolved.payload.protectedState, lostReply ? 'uncertain' : 'complete');
  assert.equal(resolved.payload.result.status, 'prepared'); assert.equal(resolved.payload.result.batches.length, 2);
  assert.equal(resolved.payload.outputGuard.businessPrivacy.contextId, auth.contextId);
  const observed = await peer.call('remote_debug_mongodb_recover_operation', { ...target, intentId: intent.id, mode: 'observe' });
  assert.equal(observed.payload.state, 'complete'); assert.equal(observed.payload.readOnly, true);
  const absent = await peer.call('remote_debug_mongodb_resolve_import', { ...args, originalOperationId: randomUUID() });
  assert.equal(absent.payload.state, 'unresolved'); assert.equal(absent.payload.intentId, undefined);
  const proof = await peer.call('remote_debug_mongodb_resolve_import', { ...args, result: { state: 'rejected_before_dispatch' } });
  assert.equal(proof.isError, true); assert.equal(proof.payload.error.code, 'BUSINESS_OPERATION_LOOKUP_INVALID');
  const implicit = { ...args }; delete implicit.database;
  assert.equal((await peer.call('remote_debug_mongodb_resolve_import', implicit)).isError, true);
  const store = new PrivacyStore({ directory: storageDirectory, key: storageKey });
  assert.deepEqual(protectedRows(store), protectedBefore); store.close();
  assert.deepEqual(peer.requests.map(r => r.path), lostReply ? ['/mongodb/imports/recover-prepare', '/mongodb/imports/recover-prepare'] : []);
  assert.equal(h.state.insert, 0); assert.equal(h.state.remove, 0);
});
