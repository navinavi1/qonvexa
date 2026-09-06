import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AutonomOSStore} from '../src/autonomos/store.js';
import {JobRegistry,classifyFailure} from '../src/autonomos/job-registry.js';
import {classifyOpportunity} from '../src/autonomos/capabilities.js';
import {evaluateDeliverable} from '../src/autonomos/qa-engine.js';
import {buildAcceptanceContract,validateAcceptanceContract} from '../src/autonomos/acceptance-engine.js';
import {SandboxSession} from '../src/autonomos/sandbox-session.js';
import {e2bRunShell,e2bRunPython,parseCodeRabbitReview} from '../src/autonomos/tools.js';
import {reviewWithRepair} from '../src/autonomos/orchestration.js';
import {AgentHansaConnector} from '../src/autonomos/agenthansa-connector.js';
import {MarketplaceManager,marketplaceSettings} from '../src/autonomos/marketplace-manager.js';
let passed=0;
async function test(name,fn){await fn();console.log('PASS '+name);passed++;}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'earning-lifecycle-'));
const store=new AutonomOSStore(root);
const job={source:'dealwork',externalId:'one',title:'Fix bug',description:'Fix addition and run tests',budgetUsd:10,currency:'USDC'};
try{
await test('Tool, auth, stop and connection errors never bury a marketplace job',()=>{
  for(const error of ['tool_not_found','tool_not_available','sandbox expired','connection closed','token expired','job_cancelled_by_emergency_stop','delivery_failed:http_404'])assert.equal(classifyFailure(error).permanent,false,error);
  assert.equal(classifyFailure('job closed',{phase:'claim'}).permanent,true);
});
await test('Retry backoff survives changed metadata and process restart',()=>{
 const r=new JobRegistry({store});r.observe(job);r.markRetry(job,{retryAfter:'2099-01-01T00:00:00Z'});
 r.observe({...job,title:'New title',budgetUsd:100});
 const again=new JobRegistry({store});assert.equal(again.get(job).status,'retry');assert.equal(again.blockReason(job).status,'retry_wait');
});
await test('Permanent exclusion survives all discovery hold writes',()=>{
 const r=new JobRegistry({store});r.markPermanent(job,{reason:'job closed'});r.markPolicyHold(job);r.markSystemBlocked(job);r.markRetry(job);r.setState(job,'ready');
 assert.equal(new JobRegistry({store}).get(job).status,'graveyard');
});
await test('Read a website, fix passwords and build local Solana code are not physical or malicious work',()=>{
 const ctx={llmEnabled:true,hasShellTool:true,hasArtifactTool:true,hasWebSearchTool:true};
 for(const title of ['Visit https://example.com and compare its pricing with competitors','Fix the password reset bug and run tests','Implement a Solana smart contract with local tests and deliver a patch']){
  const c=classifyOpportunity({...job,title,description:'',category:title.startsWith('Visit')?'research':'coding'},ctx);
  assert.equal(c.safe,true,title);assert.equal(c.permanentlyUnsupported,false,title);assert.equal(c.executable,true,`${title}: ${c.missingTools}`);
 }
 assert.equal(classifyOpportunity({...job,title:'Visit the store and pick up a package'},ctx).permanentlyUnsupported,true);
});
await test('Research containing URLs cannot be replaced by a site snapshot',()=>{
 const c=classifyOpportunity({...job,category:'research',title:'Research competitors',description:'Compare https://example.com and cite current pricing'}, {llmEnabled:true,hasWebSearchTool:true});
 assert.notEqual(c.mode,'deterministic');
});
await test('A dictionary translation passes QA without a paid model call',async()=>{
 const r=await evaluateDeliverable(job,{content:'hola mundo',evidence:{mode:'deterministic_dictionary'}},{llm:null});assert.equal(r.ok,true);
 const fake=await evaluateDeliverable(job,{content:'A complete result with evidence and sufficient length.',evidence:{}},{llm:{enabled:true,complete:async()=>({ok:true,text:'{"pass":"false","score":1}'})}});assert.equal(fake.ok,false);
});
await test('Code verification cannot be substituted by successful web search',()=>{
 const c=buildAcceptanceContract(job);
 assert.equal(validateAcceptanceContract(c,{content:'Done',evidence:{toolCalls:[{tool:'web_search',ok:true}]}}).ok,false);
 assert.equal(validateAcceptanceContract(c,{content:'Fixed addition. Tests passed.',evidence:{toolCalls:[{tool:'run_shell',ok:true,exitCode:0}]}}).ok,true);
});
await test('Shell and Python share files until execution cleanup; jobs stay isolated',async()=>{
 let creates=0,kills=0;const files=new Map();
 const session=new SandboxSession({env:{E2B_API_KEY:'test'},create:async()=>{creates++;return {files:{write:async(p,c)=>files.set(p,c)},commands:{run:async cmd=>({exitCode:0,stdout:cmd==='read'?files.get('/home/user/code.py'):'written'})},runCode:async()=>({logs:{stdout:[files.get('/home/user/code.py')]}}),kill:async()=>kills++};}});
 const env={E2B_API_KEY:'test'};
 await e2bRunShell({command:'write',files:[{path:'code.py',content:'persisted'}]},env,null,session);
 assert.equal((await e2bRunShell({command:'read'},env,null,session)).stdout,'persisted');
 assert.equal((await e2bRunPython('read',env,null,session)).stdout,'persisted');
 assert.equal(creates,1);assert.equal(kills,0);await session.close();assert.equal(kills,1);await assert.rejects(()=>session.get(),/closed/);
});
await test('AgentHansa reads the second page and independent community tasks',async()=>{
 const seen=[];
 const c=new AgentHansaConnector({env:{AGENTHANSA_API_KEY:'test'},fetchImpl:async url=>{
   const u=new URL(url);seen.push(u.pathname+u.search);let data;
   if(u.pathname.endsWith('/agents/work'))data={items:[{id:'offer'+u.searchParams.get('page'),type:'offer',title:'Offer'}],pagination:{has_more:u.searchParams.get('page')==='1'}};
   else if(u.pathname.endsWith('/collective/bounties'))data={bounties:[{id:'task',title:'Community task',status:'in_progress',reward_pool:100}],pagination:{has_more:false}};
   else if(u.pathname.endsWith('/alliance-war/quests'))data={quests:[],pagination:{has_more:false}};
   else data={engagement:{items:[]},alliance_war_quests:{items:[]},reddit_karma_quest:{locked_reason:'unverified'},personal:{items:[]},side_quests:{items:[]}};
   return new Response(JSON.stringify(data),{status:200});
 }});
 const r=await c.discover();assert.equal(r.ok,true);assert.equal(r.complete,true);assert.equal(r.rows.length,3);assert(seen.some(u=>u.includes('page=2')));assert(r.rows.some(j=>j.kind==='task'));
});
await test('A claimed job is not claimed again after execution failure and rescan',async()=>{
 const env={TASKBOUNTY_API_KEY:'test',TASKBOUNTY_AGENT_ID:'agent',TASKBOUNTY_PAYOUT_ADDRESS:'11111111111111111111111111111111'};
 const j={...job,source:'taskbounty',externalId:'tb',kind:'competitive',status:'open',netPayoutUsd:40,category:'coding'};
 let claims=0,executes=0;
 const connector={profile:async()=>({ok:true}),discover:async()=>({ok:true,rows:[j],complete:true}),inspect:async()=>({ok:true,authenticated:true,job:j}),claim:async()=>{claims++;return {ok:true};},status:async()=>({ok:false}),submit:async()=>({ok:true,id:'receipt'})};
 const m=new MarketplaceManager({store:new AutonomOSStore(path.join(root,'manager')),env,connectors:{taskbounty:connector,agenthansa:connector},classify:()=>({executable:true}),getConfig:()=>({enabled:true,allowExternalSpending:true}),execute:async()=>{executes++;throw new Error('qa_failed');}});
 m.update('taskbounty',{mode:'canary',walletConfirmed:true,competitiveAllowed:true});await m.probe('taskbounty');const row=m.pick('taskbounty');assert(row);
 await m.run(row,true);assert.equal(row.status,'system_blocked');await m.probe('taskbounty');await m.run(row,true);
 assert.equal(claims,1);assert.equal(executes,1);assert.equal(m.pick('taskbounty'),undefined);
 m.fail(row,'network timeout',{phase:'submit'});assert.equal(row.status,'retry');assert.equal(row.resumeStatus,'delivery_ready');assert(Date.parse(row.retryAfter)>Date.now());
});
await test('Default floor is $0.50 and explicit higher owner floor is preserved',()=>{
 assert.equal(marketplaceSettings('taskbounty',{},{}).minPayoutUsd,.5);assert.equal(marketplaceSettings('taskbounty',{}, {minPayoutUsd:12}).minPayoutUsd,12);
});
await test('CodeRabbit must finish a real review, including structured findings',()=>{
 assert.equal(parseCodeRabbitReview('').completed,false);
 assert.equal(parseCodeRabbitReview('{"type":"action_required","status":"awaiting_confirmation"}').completed,false);
 assert.equal(parseCodeRabbitReview('{"type":"complete","status":"review_skipped"}').completed,false);
 const r=parseCodeRabbitReview(JSON.stringify({type:'complete',status:'completed',findings:[{severity:'high',message:'bug'}]},null,2));assert.equal(r.completed,true);assert.equal(r.findings.length,1);
});
await test('QA repairs once; an externally published result is never repeated',async()=>{
 let calls=0,repairs=0;const result={content:'Implemented a concrete corrected result with verified details.',evidence:{toolCalls:[]}};
 const llm={enabled:true,complete:async()=>({ok:true,text:JSON.stringify({pass:++calls>1,score:calls>1?1:.1,reasons:['Fix missing detail']})})};
 const r=await reviewWithRepair(job,result,{llm,execute:async(_,opts)=>{repairs++;assert.equal(opts.phaseRole,'qa-repair-1');return result;}});
 assert.equal(r.qa.ok,true);assert.equal(repairs,1);assert.equal(r.deliverable.evidence.qaRepairAttempts,1);
 calls=0;await assert.rejects(()=>reviewWithRepair(job,{...result,evidence:{toolCalls:[{tool:'open_pull_request',ok:true}]}},{llm,execute:async()=>{throw new Error('must not run');}}),/qa_failed/);
});
await test('The earning profile migrates old defaults once and preserves owner changes',()=>{
 const s=new AutonomOSStore(path.join(root,'profile'));s.writeJson('marketplace-manager.json',{settings:{agenthansa:{minPayoutUsd:5,mode:'read_only'},taskbounty:{minPayoutUsd:12}},jobs:{},health:{},circuits:{},metrics:{},canaries:{}});
 const opts={store:s,env:{AGENTHANSA_API_KEY:'test'},getConfig:()=>({earningProfileVersion:15}),connectors:{}};
 const m=new MarketplaceManager(opts);assert.equal(m.settings('agenthansa').minPayoutUsd,.5);assert.equal(m.settings('agenthansa').mode,'canary');assert.equal(m.settings('agenthansa').walletConfirmed,false);assert.equal(m.settings('taskbounty').minPayoutUsd,12);
 m.update('agenthansa',{minPayoutUsd:8,mode:'read_only'});const again=new MarketplaceManager(opts);assert.equal(again.settings('agenthansa').minPayoutUsd,8);assert.equal(again.settings('agenthansa').mode,'read_only');assert.equal(again.data.settingsBeforeV15.agenthansa.minPayoutUsd,5);
});
await test('Automatic commissioning runs one job, waits for acceptance and respects Pause',async()=>{
 const env={TASKBOUNTY_API_KEY:'test',TASKBOUNTY_AGENT_ID:'agent',TASKBOUNTY_PAYOUT_ADDRESS:'11111111111111111111111111111111'};
 const j={...job,source:'taskbounty',externalId:'commission',kind:'competitive',status:'open',netPayoutUsd:40};
 const c={discover:async()=>({ok:true,rows:[j],complete:true}),inspect:async()=>({ok:true,job:j}),profile:async()=>({ok:true}),status:async()=>({ok:false})};
 let enabled=false,launches=0;
 const m=new MarketplaceManager({store:new AutonomOSStore(path.join(root,'commission')),env,connectors:{taskbounty:c,agenthansa:c},classify:()=>({executable:true}),getConfig:()=>({earningProfileVersion:15,enabled,allowExternalSpending:true})});
 m.update('taskbounty',{walletConfirmed:true});m.launch=row=>{launches++;m.set(row,'submitted');};
 await m.tick();assert.equal(launches,0);enabled=true;await m.tick();assert.equal(launches,1);assert.equal(m.data.canaries.taskbounty.status,'queued');
 await m.tick();assert.equal(launches,1);m.data.canaries.taskbounty.accepted=true;await m.tick();assert.equal(m.settings('taskbounty').mode,'live');
});
console.log(`EARNING LIFECYCLE: ${passed}/${passed} passed`);
}finally{fs.rmSync(root,{recursive:true,force:true});}
