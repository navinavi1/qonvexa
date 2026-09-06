import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AutonomOSStore} from '../src/autonomos/store.js';
import {MarketplaceManager} from '../src/autonomos/marketplace-manager.js';
import {executionDiagnostics,logExecutionEvent} from '../src/autonomos/execution-diagnostics.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-queue-'));
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
function fixture(name){
  const env={TASKBOUNTY_API_KEY:'test',TASKBOUNTY_AGENT_ID:'agent',TASKBOUNTY_PAYOUT_ADDRESS:'11111111111111111111111111111111'};
  const job={source:'taskbounty',externalId:name,title:'Fix addition',description:'Fix arithmetic and run unit tests',kind:'competitive',status:'open',netPayoutUsd:40,budgetUsd:40,category:'coding',currency:'USDC'};
  const state={busy:0,enabled:true,claims:0,executions:0,submissions:0,failClaim:false,failExecution:false};
  const connector={profile:async()=>({ok:true}),discover:async()=>({ok:true,rows:[job],complete:true}),inspect:async()=>({ok:true,authenticated:true,job}),
    claim:async()=>{state.claims++;return state.failClaim?{ok:false,reason:'network timeout'}:{ok:true};},
    submit:async()=>{state.submissions++;return {ok:true,id:'receipt'};},status:async()=>({ok:false})};
  const options={store:new AutonomOSStore(path.join(root,name)),env,connectors:{taskbounty:connector,agenthansa:connector},
    classify:()=>({executable:true}),getConfig:()=>({earningProfileVersion:15,enabled:state.enabled,allowExternalSpending:true,activeLegacyJobs:state.busy}),
    execute:async()=>{state.executions++;if(state.failExecution)throw new Error('network timeout');return {content:'Fixed and tested.',evidence:{qa:{ok:true}}};}};
  const manager=new MarketplaceManager(options);manager.update('taskbounty',{walletConfirmed:true});
  return {manager,state,options};
}
async function drain(manager){for(let n=0;n<50;n++){await new Promise(resolve=>setImmediate(resolve));if(!manager.running.size)return;}throw new Error('worker did not finish');}
try{
  await test('A commissioning job deferred by occupied capacity resumes after restart',async()=>{
    const {manager,state,options}=fixture('capacity');state.busy=1;
    await manager.tick();await drain(manager);assert.equal(state.claims,0);
    state.busy=0;const restarted=new MarketplaceManager(options);
    await restarted.tick();await drain(restarted);
    assert.equal(state.claims,1);assert.equal(state.executions,1);assert.equal(state.submissions,1);
    await restarted.tick();await drain(restarted);assert.equal(state.claims,1,'submitted canary must not repeat');
  });
  await test('A canary retries a failed claim only after the persisted backoff',async()=>{
    const {manager,state,options}=fixture('claim-retry');state.failClaim=true;
    await manager.tick();await drain(manager);assert.equal(state.claims,1);
    const row=Object.values(manager.data.jobs)[0];assert.equal(row.status,'retry');
    await manager.tick();await drain(manager);assert.equal(state.claims,1);
    row.retryAfter=new Date(0).toISOString();manager.save();state.failClaim=false;
    const restarted=new MarketplaceManager(options);await restarted.tick();await drain(restarted);
    assert.equal(state.claims,2);assert.equal(state.executions,1);assert.equal(state.submissions,1);
  });
  await test('An owned job resumes without another claim, and Pause prevents new work',async()=>{
    const {manager,state}=fixture('owned');state.failExecution=true;
    await manager.tick();await drain(manager);assert.equal(state.claims,1);
    const row=Object.values(manager.data.jobs)[0];assert.equal(row.status,'retry');
    row.retryAfter=new Date(0).toISOString();manager.save();state.failExecution=false;state.enabled=false;
    await manager.tick();await drain(manager);assert.equal(state.executions,1);
    state.enabled=true;await manager.tick();await drain(manager);
    assert.equal(state.claims,1);assert.equal(state.executions,2);assert.equal(state.submissions,1);
  });
  await test('Provider logs report blockers without job content, credentials or wallet addresses',()=>{
    const secret='private-fixture-value';
    const diagnostic=executionDiagnostics({config:{enabled:true,password:secret},capabilities:{llmEnabled:true,apiKey:secret},
      newMarkets:[{source:'taskbounty',settings:{mode:'canary',walletAddress:secret,walletConfirmed:false},health:{profile:{apiKey:secret}},
        jobs:[{status:'filtered',job:{title:secret,description:secret},qualification:{reasons:['owner_payout_route_confirmation_required','skill_mismatch:shell,artifact']}}]}]});
    assert.equal(diagnostic.markets[0].blockers.owner_payout_route_confirmation_required,1);
    assert.equal(diagnostic.markets[0].missingTools.shell,1);
    assert(!JSON.stringify(diagnostic).includes(secret));
    const lines=[];logExecutionEvent({info:line=>lines.push(line)},'market_job_failed',{source:'taskbounty',error:'http_401:'+secret,payload:secret});
    assert.equal(JSON.parse(lines[0].slice('[AutonomOS] '.length)).httpStatus,401);
    assert(!lines.join('').includes(secret));
  });
  console.log(`EXECUTION QUEUE: ${passed}/${passed} passed`);
}finally{fs.rmSync(root,{recursive:true,force:true});}
