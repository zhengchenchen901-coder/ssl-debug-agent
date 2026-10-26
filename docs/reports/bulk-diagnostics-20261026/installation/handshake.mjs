import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
const plugin='/Users/zhengchenchen/.codex/plugins/cache/remote-debug-local/remote-debug-agent/2.4.0+codex.20261026.6';
// Explicit supported URL verifies the installed MCP without replacing a shared Manager.
const child=spawn(process.execPath,[path.join(plugin,'launch.cjs')],{cwd:plugin,env:{...process.env,REMOTE_DEBUG_AGENT_URL:'http://127.0.0.1:4343',REMOTE_DEBUG_PRIVACY_CONTEXT_FILE:''},stdio:['pipe','pipe','pipe']});
let buffer='',seq=0;const pending=new Map();let stderrSeen=false;
child.stderr.on('data',()=>{stderrSeen=true;});
child.stdout.on('data',chunk=>{buffer+=chunk;for(;;){const pos=buffer.indexOf('\n');if(pos<0)break;const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);let msg;try{msg=JSON.parse(line)}catch{continue}const slot=pending.get(msg.id);if(slot){clearTimeout(slot.timer);pending.delete(msg.id);msg.error?slot.reject(Error('MCP_PROTOCOL_ERROR')):slot.resolve(msg.result)}}});
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('MCP_TIMEOUT'));},30000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
try{
 const init=await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'installed-bulk-diagnostics-handshake',version:'1'}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const list=await rpc('tools/list',{});
 if(init.serverInfo.version!=='2.4.0+codex.20261026.6'||!list.tools.some(t=>t.name==='remote_debug_mongodb_get_bulk_job'))throw Error('INSTALLED_SCHEMA_MISMATCH');
 const caps=await rpc('tools/call',{name:'remote_debug_get_capabilities',arguments:{}});
 const parsed=JSON.parse(caps.content.find(c=>c.type==='text').text);
 if(caps.isError||parsed.ok!==true)throw Error('CAPABILITIES_FAILED');
 const instances=await rpc('tools/call',{name:'remote_debug_list_instances',arguments:{}});
 const parsedInstances=JSON.parse(instances.content.find(c=>c.type==='text').text);
 if(instances.isError||parsedInstances.ok!==true)throw Error('INSTANCE_LIST_FAILED');
 const {createOutputGuard}=await import(path.join(plugin,'output-guard.js'));
 const synthetic={version:1,code:13,name:'MongoError',message:'MongoDB authorization rejected; database and command details withheld',layer:'mongodb-helper',phase:'receipt_write',batchIndex:0,operationId:'6d16cfd5-033f-4bbf-b82e-92cc8441a1c9',outcome:'not_committed',recovery:'inspect_before_resume',cause:{code:'SSH_CONNECTION_FAILED',message:'transport lost'},frames:[{function:'__bulkRunTransaction',line:100,column:4}],driverVersion:'3.3.4',document:{private:'MUST_NOT_LEAVE'}};
 const guarded=JSON.parse(createOutputGuard().toolResult('remote_debug_mongodb_get_bulk_job',{ok:true,jobId:'synthetic-output-contract-fixture',lastFailure:synthetic}).content[0].text);
 if(guarded.lastFailure?.code!==13||guarded.lastFailure?.cause?.code!=='SSH_CONNECTION_FAILED'||JSON.stringify(guarded).includes('MUST_NOT_LEAVE'))throw Error('DIAGNOSTIC_OUTPUT_CONTRACT_FAILED');
 const result={checkedAt:new Date().toISOString(),installedPath:plugin,serverInfo:init.serverInfo,toolCount:list.tools.length,readOnlyToolsCalled:['remote_debug_get_capabilities','remote_debug_list_instances'],instanceStatuses:parsedInstances.instances.map(i=>({id:i.id,status:i.runtime?.status,pid:i.runtime?.pid,health:i.runtime?.health?.overall})),diagnosticOutputContract:{lastFailure:true,nestedCause:true,frames:true,unknownDocumentOmitted:true,syntheticOnly:true},managerReplacementRequested:false,businessContextAttached:false,businessToolsCalled:[],stderrObserved:stderrSeen};
 await fs.writeFile(new URL('handshake.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
}finally{child.stdin.end();setTimeout(()=>child.kill('SIGTERM'),500).unref();}
