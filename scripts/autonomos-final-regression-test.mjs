import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AgentMemory} from '../src/autonomos/memory.js';
import {ArtifactStore} from '../src/autonomos/artifact-store.js';
import {JobRegistry} from '../src/autonomos/job-registry.js';
import {AutonomOSStore} from '../src/autonomos/store.js';
import {checkpointExecution} from '../src/autonomos/execution-checkpoint.js';
import {readDurableResponse} from '../src/autonomos/durable-response.js';
import {classifyOpportunity} from '../src/autonomos/capabilities.js';
import {buildAcceptanceContract} from '../src/autonomos/acceptance-engine.js';
import {executeExternalOpportunity} from '../src/autonomos/job-executor.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autonomos-final-'));
let passed=0;
async function test(name,fn){await fn();passed++;console.log(`PASS ${name}`);}
try{
await test('semantic recall binds numeric limit separately from tenant',async()=>{
 const memory=new AgentMemory();memory.ready=true;memory.embed=async()=>[0.2,0.3];
 memory.pool={query:async(sql,args)=>{assert.match(sql,/LIMIT \$5/);assert.deepEqual(args,['[0.2,0.3]','experience','tenant-a','job-a',3]);return {rows:[{content:'semantic hit',similarity:0.9}]};}};
 assert.equal((await memory.recall('query',{tenantScope:'tenant-a',jobScope:'job-a',limit:3}))[0].content,'semantic hit');
});
await test('failed semantic recall reports fallback and preserves scope',async()=>{
 let warned=false;const memory=new AgentMemory({logger:{warn(){warned=true;}}});memory.ready=true;memory.embed=async()=>[1];
 memory.pool={query:async(sql,args)=>{if(sql.includes('<=>'))throw new Error('vector unavailable');assert.deepEqual(args,['experience','tenant','job',2]);return {rows:[]};}};
 await memory.recall('query',{tenantScope:'tenant',jobScope:'job',limit:2});assert.equal(warned,true);
});
const env={R2_ENDPOINT:'https://r2.example',R2_BUCKET:'artifacts',R2_ACCESS_KEY_ID:'test',R2_SECRET_ACCESS_KEY:'test'};
await test('R2 aliases use the same storage configuration',async()=>{assert.equal(new ArtifactStore({env}).configured(),true);assert.equal(new ArtifactStore({env:{...env,R2_SECRET_ACCESS_KEY:''}}).configured(),false);});
await test('upload is not successful delivery when signing fails',async()=>{const a=new ArtifactStore({env});a.client={send:async()=>({})};a.getDownloadUrl=async()=>({ok:false,reason:'signing failed'});const r=await a.putText('test.md','text');assert.equal(r.ok,false);assert.equal(r.uploaded,true);});
await test('text research report needs sources, not invented file',async()=>{const op={category:'report',title:'Research report',description:'Research current sources and write a report in plain text.'};const cap=classifyOpportunity(op,{llmEnabled:true,hasWebSearchTool:true});assert.equal(cap.skill,'web-research');assert.equal(cap.requiresArtifact,false);assert.equal(buildAcceptanceContract({...op,capability:cap}).artifacts.length,0);});
await test('explicit PDF still requires artifact',async()=>{assert.ok(buildAcceptanceContract({title:'Create a PDF report'}).artifacts.length);});
for(const title of ['Swap 1 USDC','Send USDT','Join our community','Invite your friends','Buy a service'])await test(`unsupported earning action: ${title}`,async()=>{assert.equal(classifyOpportunity({source:'t2000',title},{llmEnabled:true,hasAppTool:true}).executable,false);});
const store=new AutonomOSStore(dir);let registry=new JobRegistry({store});const op={source:'superteam',externalId:'ghost',title:'Old competition',claimMode:'competitive_submission',budgetUsd:5000};
await test('first Superteam miss persists across restart',async()=>{registry.observe(op);registry.setState(op,'proposal');registry.reconcileCompetitiveFeed('superteam',{ok:true,authoritativeLive:true,liveIds:[],complete:true});registry=new JobRegistry({store});assert.equal(registry.get(op).status,'stale_check');registry.observe({...op,title:'Changed cached title'});assert.equal(registry.get(op).status,'stale_check');assert.equal(registry.summary().proposal,0);});
await test('partial/failed feeds cannot archive a listing',async()=>{registry.reconcileCompetitiveFeed('superteam',{ok:false,authoritativeLive:true,liveIds:[],complete:true});registry.reconcileCompetitiveFeed('superteam',{ok:true,authoritativeLive:true,liveIds:[],complete:false});assert.equal(registry.get(op).status,'stale_check');});
await test('confirmed absence archives; ordinary observe cannot resurrect',async()=>{registry.reconcileCompetitiveFeed('superteam',{ok:true,authoritativeLive:true,liveIds:[],complete:true});registry.observe({...op,title:'changed'});assert.equal(registry.get(op).status,'archived');});
await test('authoritative live presence reopens an archived listing',async()=>{registry.reconcileCompetitiveFeed('superteam',{ok:true,authoritativeLive:true,liveIds:['ghost']});assert.equal(registry.get(op).status,'new');assert.equal(registry.get(op).terminal,false);});
await test('owned and permanently rejected jobs survive feed reconciliation',async()=>{registry.setState(op,'claimed');registry.reconcileCompetitiveFeed('superteam',{ok:true,authoritativeLive:true,liveIds:[],complete:true});assert.equal(registry.get(op).status,'claimed');registry.markPermanent(op,{reason:'closed'});registry.reconcileCompetitiveFeed('superteam',{ok:true,authoritativeLive:true,liveIds:['ghost']});assert.equal(registry.get(op).status,'graveyard');});
await test('completed phase replay makes no second external call',async()=>{let n=0;await checkpointExecution(store,'job-1')('research',async()=>({content:String(++n)}));const r=await checkpointExecution(new AutonomOSStore(dir),'job-1')('research',async()=>{n++;});assert.equal(n,1);assert.equal(r.content,'1');});
await test('uncertain side effect cannot run again on retry',async()=>{let n=0;await assert.rejects(checkpointExecution(store,'job-2')('execute',async()=>{n++;throw new Error('lost response');}));await assert.rejects(checkpointExecution(store,'job-2')('execute',async()=>{n++;}),/execution_checkpoint_uncertain/);assert.equal(n,1);});
await test('runtime business failure is returned, not thrown for durable retry',async()=>{const b={ok:false,handledByRuntime:true,retryScheduled:true};assert.deepEqual(await readDurableResponse(new Response(JSON.stringify(b))),b);});
await test('HTTP 401 is terminal, HTTP 429 and 503 retry transport',async()=>{assert.equal((await readDurableResponse(new Response('{}',{status:401}))).terminal,true);for(const status of [429,503])await assert.rejects(readDurableResponse(new Response('{}',{status})));});
await test('malformed success cannot be treated as completed',async()=>{await assert.rejects(readDurableResponse(new Response('bad json')));});
await test('R2 tools build without missing ArtifactStore import',async()=>{let tools;const llm={enabled:true,complete:async x=>{tools=x.tools;return {ok:true,text:'Finished prose.'};}};await executeExternalOpportunity({title:'Write prose',description:'A short paragraph.'},{mode:'llm',skill:'copywriting'},{llm,env,config:{enabled:true,allowExternalSpending:true,zeroSpendMode:false,killSwitch:false,maxPaidProcurementUsd:1,availableSpendUsd:1}});assert.ok(tools.some(t=>t.function.name==='store_artifact')); });
await test('phase allowlist blocks a model-requested deployment',async()=>{
 let calls=0,round=0;const original=global.fetch;global.fetch=async()=>{calls++;return new Response('{}');};
 try{
 const llm={enabled:true,complete:async()=>++round===1?{ok:true,message:{role:'assistant',content:null,tool_calls:[{id:'x',type:'function',function:{name:'deploy_webhook',arguments:'{}'}}]},toolCalls:[{id:'x',function:{name:'deploy_webhook',arguments:'{}'}}]}:{ok:true,text:'Completed prose.'}};
 const r=await executeExternalOpportunity({title:'Write prose'},{mode:'llm',skill:'copywriting'},{llm,env:{AUTONOMOS_DEPLOY_WEBHOOK_URL:'https://example.test/deploy'},toolFilter:[],config:{enabled:true}});
 assert.equal(calls,0);assert.equal(r.evidence.toolCalls[0].ok,false);assert.equal(r.evidence.toolCalls[0].error,'tool_not_allowed_for_phase');
 }finally{global.fetch=original;}
});
await test('corrupt checkpoint fails closed',async()=>{
 await checkpointExecution(store,'corrupt-job')('step',async()=>({done:true}));
 const files=fs.readdirSync(dir).filter(x=>x.startsWith('execution-'));
 const target=files.find(x=>fs.readFileSync(path.join(dir,x),'utf8').includes('"done": true'));
 fs.writeFileSync(path.join(dir,target),'{invalid');let invoked=false;
 await assert.rejects(checkpointExecution(store,'corrupt-job')('step',async()=>{invoked=true;}));assert.equal(invoked,false);
});
await test('failure before any side effect can retry execution',async()=>{
 let attempts=0;const run=()=>executeExternalOpportunity({title:'Write prose'},{mode:'llm',skill:'copywriting'},{llm:{enabled:true,complete:async()=>++attempts===1?{ok:false,reason:'llm_transport_failed'}:{ok:true,text:'Finished prose.'}},env:{}});
 await assert.rejects(checkpointExecution(store,'safe-retry')('execute',run));
 assert.equal((await checkpointExecution(store,'safe-retry')('execute',run)).content,'Finished prose.');assert.equal(attempts,2);
});
console.log(`Final regression: ${passed}/${passed} PASS`);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
