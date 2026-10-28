import { orphanRiskFixture } from '../agent/test/helpers/orphan-risk-fixture.js';
import { normalizeMongoImport } from '../agent/mongodb-mutations.js';
import { normalizeExactImportReview, importReviewDisplay } from '../agent/mongodb-import-review.js';
import { importReviewDiagnostic } from '../plugins/remote-debug-agent/review-diagnostic.js';
import { createOutputGuard } from '../plugins/remote-debug-agent/output-guard.js';
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });
const fixture = () => orphanRiskFixture({ after: fn => cleanups.push(fn) });
function proposal(f, docs, originalId = f.original.importId) {
  const originalRequest = { ...f.original, importId: originalId, documents: docs };
  return { originalRequest, replacementRequest: { ...originalRequest, importId: f.candidate.importId }, importId: originalId, requestDigest: f.digest(originalRequest) };
}
const saved = (f, p) => f.store.get('orphan_risk', p.riskPlanId, f.auth.contextId, f.store.hash('scope', f.scope));
const history = f => f.store.db.prepare("SELECT * FROM records WHERE kind IN ('operation','import_prepare_evidence') ORDER BY kind,id").all();

test('credential-shaped business values retain exact ordered input in encrypted storage while administrator output is redacted', async () => {
  const f = fixture(), docs = [{ _id: 'synthetic-member', password: 'SYNTHETIC_PRIVATE_PASSWORD_8c1', nested: { z: 1, a: 2 }, authorization: 'Bearer SYNTHETIC_PRIVATE_TOKEN_9cd' }];
  const args = proposal(f, docs), before = history(f), p = await f.prepare(args);
  expect(p.binding.requestDigest).toBe(args.requestDigest); expect(p.provesNotDispatched).toBe(false); expect(history(f)).toEqual(before);
  expect(JSON.stringify(saved(f,p).originalRequest)).toBe(JSON.stringify(args.originalRequest));
  const raw = f.store.db.prepare("SELECT envelope FROM records WHERE kind='orphan_risk' AND id=?").get(p.riskPlanId).envelope;
  expect(raw).not.toContain(docs[0].password);
  const view = await f.human('human_orphan_risk_view', { riskPlanId: p.riskPlanId, instanceId: f.instance.id });
  expect(view.requestDisplay).toMatchObject({ redacted: true, projectionIsInputProof: false, originalBytes: 'encrypted_only' });
  expect(JSON.stringify(view)).not.toContain(docs[0].password); expect(JSON.stringify(view)).not.toContain('SYNTHETIC_PRIVATE_TOKEN_9cd');
  expect(JSON.parse(view.orderedOriginalRequest).documents[0].password).toBe('[REDACTED]');
  f.reopen(); expect((await f.inspect(p)).riskPlanId).toBe(p.riskPlanId); expect(f.requests).toEqual([]);
});

test('large lawful input no longer consumes output traversal budget or registers a second review on retry', async () => {
  const f = fixture(), docs = Array.from({length:491},(_,i)=>({_id:'synthetic-'+i, content:Array.from({length:14},(_,j)=>({name:'label-'+j,value:j}))}));
  const args = proposal(f,docs), before=history(f);
  args.originalRequest.batchSize = 2000; args.replacementRequest.batchSize = 2000; args.requestDigest = f.digest(args.originalRequest);
  expect(() => createOutputGuard().sanitize(args.originalRequest)).toThrow('OUTPUT_GUARD_BLOCKED');
  const p=await f.prepare(args), retry=await f.prepare(args); expect(retry.riskPlanId).toBe(p.riskPlanId); expect(retry.reviewHash).toBe(p.reviewHash);
  expect(saved(f,p).originalRequest.documents).toEqual(docs); expect(p.followup.documentCount).toBe(491); expect(history(f)).toEqual(before);
  const v=await f.human('human_orphan_risk_view',{riskPlanId:p.riskPlanId,instanceId:f.instance.id}); expect(v.state).toBe('awaiting_human'); expect(v.requestDisplay.redacted).toBe(false);
  expect(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='orphan_risk'").get().n).toBe(1); expect(f.requests).toEqual([]);
});

for(const length of [65,69,128]) test(`historical ${length}-character import identity can be reviewed unchanged without admitting it for new business prepare`,async()=>{
 const f=fixture(), oldId='legacy-'+ 'x'.repeat(length-7), args=proposal(f,f.original.documents,oldId), before=history(f);
 expect(()=>normalizeMongoImport(args.originalRequest,f.instance.mongodb)).toThrow();
 const p=await f.prepare(args); expect(p.binding.importId).toBe(oldId); expect(saved(f,p).originalRequest.importId).toBe(oldId); expect(p.followup.importId).toBe(f.candidate.importId); expect(history(f)).toEqual(before);
 await expect(f.prepare({...args,replacementRequest:{...args.replacementRequest,importId:'new-'+ 'x'.repeat(65)}})).rejects.toMatchObject({code:'BUSINESS_DISPOSITION_INPUT_INVALID',inputDiagnostic:{requestField:'replacementRequest',code:'INVALID_MONGODB_MUTATION'}});
 expect(()=>normalizeMongoImport(args.replacementRequest,f.instance.mongodb)).not.toThrow(); expect(f.requests).toEqual([]);
});

test('normal document, import, identity and original-byte limits remain enforced and diagnostics contain no business values', async()=>{
 const f=fixture(), before=history(f);
 for(const args of [proposal(f,[{_id:'doc',value:'x'.repeat(256*1024)}]),proposal(f,[{_id:'same'},{_id:'same'}]),proposal(f,f.original.documents,'x'.repeat(129)),proposal(f,[{_id:'doc',nested:{$where:'PRIVATE_FORBIDDEN_VALUE'}}])]){
  await expect(f.prepare(args)).rejects.toMatchObject({code:expect.stringMatching(/^BUSINESS_/)});
 }
 await expect(f.prepare(proposal(f,[{_id:'doc',password:'[REDACTED]'}]))).rejects.toMatchObject({code:'BUSINESS_DISPOSITION_ORIGINAL_BYTES_REQUIRED'});
 expect(history(f)).toEqual(before); expect(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='orphan_risk'").get().n).toBe(0);
 expect(importReviewDiagnostic({requestField:'originalRequest',code:'INVALID_MONGODB_MUTATION',raw:'PRIVATE_RAW'})).toEqual({requestField:'originalRequest',code:'INVALID_MONGODB_MUTATION'});
 expect(importReviewDiagnostic({requestField:'PRIVATE_FIELD',code:'PRIVATE_ERROR'})).toBeUndefined();
});

test('administrator projection withholds over-budget documents by digest without changing their stored bytes or output guard budgets',async()=>{
 const f=fixture(), doc={_id:'synthetic-large-document',values:Array.from({length:6000},(_,i)=>({a:i,b:i,c:i}))};const args=proposal(f,[doc]);
 expect(()=>createOutputGuard().sanitize(doc)).toThrow('OUTPUT_GUARD_BLOCKED');
 const p=await f.prepare(args), v=await f.human('human_orphan_risk_view',{riskPlanId:p.riskPlanId,instanceId:f.instance.id});
 expect(v.requestDisplay).toMatchObject({redacted:true,withheldDocuments:2,projectionIsInputProof:false});
 expect(JSON.parse(v.orderedOriginalRequest).documents[0]).toEqual({displayUnavailable:true,documentDigest:f.digest({document:doc})});
 expect(saved(f,p).originalRequest.documents[0]).toEqual(doc); expect(f.requests).toEqual([]);
});

test('exact review boundary rejects accessors, cycles, non-finite values and unknown metadata before storage',()=>{
 const f=fixture(), target={id:f.instance.id,database:'yennefer'};
 const getter=Object.defineProperty({...f.original},'documents',{enumerable:true,get(){throw Error('PRIVATE_GETTER');}});
 const cycle={...f.original};cycle.documents=[cycle];
 for(const raw of [undefined,null,getter,cycle,{...f.original,documents:[{_id:'doc',value:Infinity}]},{...f.original,proof:'fake'}, {...f.original,database:'other'}])expect(()=>normalizeExactImportReview(raw,target,f.instance.mongodb,'originalRequest')).toThrow();
 expect(importReviewDisplay(f.original).redacted).toBe(false);
});


test('administrator redaction learns later credentials before displaying earlier echoes', async()=>{
 const f=fixture(), secret='SYNTHETIC_CROSS_DOCUMENT_PASSWORD_8a29', docs=[{_id:'early',note:secret},{_id:'late',password:secret}];
 const p=await f.prepare(proposal(f,docs)),v=await f.human('human_orphan_risk_view',{riskPlanId:p.riskPlanId,instanceId:f.instance.id});
 expect(v.orderedOriginalRequest).not.toContain(secret);expect(v.orderedFollowupRequest).not.toContain(secret);
 expect(saved(f,p).originalRequest.documents).toEqual(docs);
});
