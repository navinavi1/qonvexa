import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {Pool} from 'pg';
import {AutonomOSStore} from '../src/autonomos/store.js';
import {MarketplaceManager} from '../src/autonomos/marketplace-manager.js';
import {executionDiagnostics,logExecutionEvent} from '../src/autonomos/execution-diagnostics.js';
import {planJob} from '../src/autonomos/planner.js';
import {createJobBudget} from '../src/autonomos/job-budget.js';
import {postgresPoolConfig} from '../src/autonomos/memory.js';
import {checkpointExecution} from '../src/autonomos/execution-checkpoint.js';
import {createAutonomOS} from '../src/autonomos/runtime.js';

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
  await test('Slow planning times out to a usable plan; emergency cancellation is preserved',async()=>{
    let signalSeen;
    const llm={enabled:true,complete:({signal})=>new Promise((_,reject)=>{signalSeen=signal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})};
    const keepAlive=setTimeout(()=>{},2000);
    try{
      const plan=await planJob({title:'Translate text',category:'translation'},{llm,env:{AUTONOMOS_PLANNER_TIMEOUT_MS:20}});
      assert.equal(signalSeen.aborted,true);assert.equal(plan.source,'deterministic');assert(plan.steps.length>0);
      const controller=new AbortController();controller.abort();
      await assert.rejects(()=>planJob({title:'Translate text'},{llm,abortSignal:controller.signal}),/job_cancelled/);
    }finally{clearTimeout(keepAlive);}
  });
  await test('A budgeted planner uses the accounted model client even with a direct API key',async()=>{
    let calls=0,cost=0;
    const scoped=createJobBudget(1,{onCost:amount=>cost+=amount}).llm({enabled:true,complete:async()=>{calls++;return {ok:true,text:JSON.stringify({goal:'Translate',steps:[{id:'execute',role:'content-worker'}]})};}});
    const plan=await planJob({title:'Translate text'},{llm:scoped,env:{OPENAI_API_KEY:'unused-test-key'}});
    assert.equal(calls,1);assert(cost>0);assert.equal(plan.source,'llm_gateway');
  });
  await test('A nonresponsive database cannot hold a checkpoint connection forever',async()=>{
    const sockets=new Set();const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const pool=new Pool(postgresPoolConfig({DATABASE_URL:`postgres://local:unused@127.0.0.1:${server.address().port}/local`,AUTONOMOS_DB_CONNECT_TIMEOUT_MS:30}));
    try{await assert.rejects(()=>pool.query('SELECT 1'),/timeout/i);}
    finally{await pool.end();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
  });
  await test('Interrupted planning resumes but an uncertain external effect remains held',async()=>{
    const store=new AutonomOSStore(path.join(root,'checkpoints'));const checkpoint=checkpointExecution(store,'job');
    await assert.rejects(()=>checkpoint('plan',async()=>{throw new Error('simulated crash');}),/crash/);
    assert.equal(await checkpoint('plan',async()=>'recovered',{retrySafe:true}),'recovered');
    await assert.rejects(()=>checkpoint('delivery',async()=>{throw new Error('network failure');}),/network/);
    let replayed=false;await assert.rejects(()=>checkpoint('delivery',async()=>{replayed=true;}),/checkpoint_uncertain/);assert.equal(replayed,false);
  });
  await test('Only one cycle can wait for startup recovery at a time',async()=>{
    const realFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({}),{status:200});
    const runtime=createAutonomOS({storageDir:path.join(root,'cycle-lock'),siteUrl:'https://example.com',env:{AUTONOMOS_X402_ENABLED:'false'},logger:{}});
    try{
      const first=runtime.runCycle();const second=await runtime.runCycle();
      assert.equal(second.ok,false);assert.equal(second.reason,'cycle_already_running');
      assert.equal((await first).ok,true);
    }finally{runtime.stop();globalThis.fetch=realFetch;}
  });
  console.log(`EXECUTION QUEUE: ${passed}/${passed} passed`);
}finally{fs.rmSync(root,{recursive:true,force:true});}
