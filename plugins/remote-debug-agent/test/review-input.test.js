import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrivacyStore } from '../../../agent/privacy-store.js';
import { PrivacyService } from '../../../agent/privacy-service.js';
import { createManagerApp } from '../../../agent/server.js';
import { InstanceRegistry } from '../../../agent/instance-registry.js';
import { loadConfig } from '../../../agent/config.js';
import { importConfig } from '../../../agent/test/helpers/import-fixture.js';
import { importWire } from '../../../agent/test/helpers/import-risk-fixture.js';
import { prepareRequestDigest } from '../prepare-protocol.js';
import { mcpPeer } from './helpers/local-mcp.js';
import localAuth from '../local-auth.cjs';

test('public MCP and real Manager HTTP prepare/read five synthetic review shapes without dispatch, credential loss or historical edits', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rda-review-input-'));fs.chmodSync(root,0o700);
 const directory=path.join(root,'storage'),key=randomBytes(32),registry=new InstanceRegistry({cwd:root,env:{},registryPath:path.join(root,'instances.json')});
 registry.create({id:'test-server',host:'fixture.invalid',username:'fixture',privateKeyPath:'/fixture',hostKeyFingerprints:['SHA256:'+'A'.repeat(43)],mongodb:{...importConfig,database:'yennefer',allowedDatabases:['yennefer']}});
 const config=loadConfig({},root),token=localAuth.ensureAuthToken(localAuth.resolveAuthFile(root));config.agent={host:'127.0.0.1',port:0};config.runtime.statePath=path.join(root,'.runtime','state.json');
 const service=new PrivacyService({directory,key});let dispatches=0;
 const app=createManagerApp({config,registry,privacyService:service,authToken:token,workerManager:{publicInstances:()=>registry.list(),callInstance:async()=>{dispatches++;throw Error('REVIEW_MUST_NOT_DISPATCH');}}});
 const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await app.locals.manualWorkbench.close();await service.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.address().port}`,store=new PrivacyStore({directory,key}),auth=store.execute('create');
 const history=()=>store.db.prepare("SELECT * FROM records WHERE kind IN ('operation','import_prepare_evidence') ORDER BY kind,id").all();
 const before=history(),contextFile=path.join(root,'context.json');fs.writeFileSync(contextFile,JSON.stringify({version:1,origin,auth}),{mode:0o600});t.after(()=>store.close());
 const peer=await mcpPeer(t,{root,url:origin,contextFile});
 const workbench=app.locals.manualWorkbench;await workbench.store.register('admin','synthetic-review-input-admin-123');
 const session=await workbench.login({username:'admin',password:'synthetic-review-input-admin-123',instanceId:'test-server'});await workbench.start();
 const nativeRead=async riskPlanId=>{const r=await fetch(workbench.origin+'/api/orphan-risk/review',{method:'POST',headers:{Authorization:'Bearer '+session.token,Origin:workbench.origin,'Content-Type':'application/json'},body:JSON.stringify({riskPlanId})});return {status:r.status,body:await r.json()};};
 const cases=[
  {name:'customer',count:71,edit:d=>({...d,password:'SYNTHETIC_PRIVATE_PASSWORD_71'})},
  {name:'restaurant-log',count:29,edit:d=>({...d,items:Array.from({length:800},(_,i)=>({k:i,v:'synthetic'}))})},
  {name:'history',count:448,legacyLength:69,edit:d=>({...d,token:'SYNTHETIC_PRIVATE_TOKEN_'+d._id})},
  {name:'booking-log',count:176,legacyLength:65},
  {name:'tags',count:491,edit:d=>({...d,items:Array.from({length:14},(_,i)=>({k:i,v:'synthetic'}))})}
 ];
 for(const c of cases){
  const original=importWire({instanceId:'test-server',database:'yennefer',importId:c.legacyLength?'legacy-'+ 'x'.repeat(c.legacyLength-7):'original-'+c.name,collection:'members',documents:Array.from({length:c.count},(_,i)=>{const d={_id:c.name+'-'+i};return c.edit?c.edit(d):d;}),batchSize:2000,purpose:'synthetic review input regression'});
  const originalOperationId=randomUUID(),candidate={...original,importId:'followup-'+c.name},args={instanceId:'test-server',database:'yennefer',mode:'prepare_orphan_risk',originalOperationId,importId:original.importId,requestDigest:prepareRequestDigest(original),originalRequest:original,replacementRequest:candidate};
  const result=await peer.call('remote_debug_mongodb_disposition',args);assert.notEqual(result.isError,true,c.name+': '+JSON.stringify(result));const p=result.payload;
  assert.equal(p.state,'awaiting_human');assert.equal(p.binding.importId,original.importId);assert.equal(p.binding.originalOperationId,originalOperationId);assert.equal(p.binding.requestDigest,args.requestDigest);assert.equal(p.followup.documentCount,c.count);
  assert.equal(p.historicalOutcome,'unknown');assert.equal(p.originalStatus,'unresolved');assert.equal(p.provesNotDispatched,false);
  const read=await peer.call('remote_debug_mongodb_disposition',{instanceId:'test-server',database:'yennefer',mode:'inspect_orphan_risk',riskPlanId:p.riskPlanId});assert.equal(read.payload.riskPlanId,p.riskPlanId);assert.equal(read.payload.reviewHash,p.reviewHash);
  const rerequest=await peer.call('remote_debug_mongodb_disposition',args);assert.equal(rerequest.payload.riskPlanId,p.riskPlanId);assert.equal(rerequest.payload.reviewHash,p.reviewHash);
  const human=await nativeRead(p.riskPlanId);assert.equal(human.status,200,JSON.stringify(human));assert.equal(human.body.state,'awaiting_human');assert.equal(human.body.requestDisplay.projectionIsInputProof,false);
  assert.doesNotMatch(JSON.stringify(human),/SYNTHETIC_PRIVATE_PASSWORD|SYNTHETIC_PRIVATE_TOKEN/);
  const row=store.db.prepare("SELECT * FROM records WHERE kind='orphan_risk' AND id=?").get(p.riskPlanId);assert.ok(row);assert.equal(JSON.stringify(store.open(row).originalRequest),JSON.stringify(original));assert.doesNotMatch(row.envelope,/SYNTHETIC_PRIVATE_PASSWORD|SYNTHETIC_PRIVATE_TOKEN/);
 }
 // Future preparations still use the 64-character namespace; the error is a
 // structured validation fact, never an arbitrary message/path/value echo.
 const original=importWire({instanceId:'test-server',database:'yennefer',importId:'invalid-candidate-original',collection:'members',documents:[{_id:'doc'}]});
 const bad=await peer.call('remote_debug_mongodb_disposition',{instanceId:'test-server',database:'yennefer',mode:'prepare_orphan_risk',originalOperationId:randomUUID(),importId:original.importId,requestDigest:prepareRequestDigest(original),originalRequest:original,replacementRequest:{...original,importId:'x'.repeat(65)}});
 assert.equal(bad.isError,true);assert.equal(bad.payload.error.code,'BUSINESS_DISPOSITION_INPUT_INVALID');assert.deepEqual(bad.payload.error.inputDiagnostic,{requestField:'replacementRequest',code:'INVALID_MONGODB_MUTATION'});
 assert.equal(dispatches,0);assert.deepEqual(history(),before);assert.equal(store.db.prepare("SELECT count(*) n FROM records WHERE kind='orphan_risk'").get().n,5);
 assert.doesNotMatch(peer.wire.join(''),/SYNTHETIC_PRIVATE_PASSWORD|SYNTHETIC_PRIVATE_TOKEN/);
});
