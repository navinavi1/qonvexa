import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentMemory } from '../src/autonomos/memory.js';
import { JobRegistry } from '../src/autonomos/job-registry.js';
import { discoverMarketOpportunities, claimMarketplaceJob, deliverMarketplaceJob, startDealworkContract } from '../src/autonomos/connectors/index.js';

class JsonStore {
  constructor(dir){this.dir=dir;fs.mkdirSync(dir,{recursive:true});}
  readJson(name,fallback){try{return JSON.parse(fs.readFileSync(path.join(this.dir,name),'utf8'));}catch{return fallback;}}
  writeJson(name,value){fs.writeFileSync(path.join(this.dir,name),JSON.stringify(value,null,2));}
}

// Regression: semantic recall used five SQL parameters but LIMIT accidentally referenced
// the tenant-scope parameter ($3). The catch then silently hid the vector-query failure.
{
  const memory=new AgentMemory({env:{AUTONOMOS_EMBEDDING_DIMENSIONS:'256'},logger:{warn(){}}});
  memory.ready=true;
  let captured=null;
  memory.pool={query:async(sql,params)=>{captured={sql,params};return{rows:[{memory_key:'m1',similarity:0.91,utility:1}]};}};
  memory.embed=async()=>Array.from({length:256},()=>0.01);
  const rows=await memory.recall('needle',{kind:'experience',limit:7,tenantScope:'tenant-a',jobScope:'job-a'});
  assert.equal(rows.length,1);
  assert.match(captured.sql,/LIMIT \$5\b/,'semantic memory LIMIT must reference the fifth SQL parameter');
  assert.equal(captured.params.length,5);
  assert.equal(captured.params[2],'tenant-a');
  assert.equal(captured.params[4],7);
}

// Regression: competitive proposals must age out only from a COMPLETE authoritative live
// snapshot. First miss => stale_check, second complete miss => archived. Both must persist.
{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'autonomos-final-registry-'));
  try{
    const store=new JsonStore(root);
    const registry=new JobRegistry({store,maxRecords:1000});
    const live={source:'agenthansa',externalId:'listing-1',title:'Agent bounty',description:'Produce a report',budgetUsd:600,currency:'USDC',claimMode:'competitive_submission'};
    registry.observe(live);registry.setState(live,'proposal',{reasonCode:'competitive_eligible'});

    const ignored=registry.reconcileCompetitiveSnapshot('agenthansa',[],{authoritative:false});
    assert.equal(ignored.changed,0,'truncated/non-authoritative feed must never age a proposal');
    assert.equal(registry.get(live).status,'proposal');

    const first=registry.reconcileCompetitiveSnapshot('agenthansa',[],{authoritative:true,missingToArchive:2});
    assert.equal(first.staleChecked,1);assert.equal(registry.get(live).status,'stale_check');
    assert.equal(registry.blockReason(live)?.status,'stale_check','stale listing must be excluded from worker claim');

    const restarted=new JobRegistry({store,maxRecords:1000});
    assert.equal(restarted.get(live).status,'stale_check','first miss must persist across restart');
    const second=restarted.reconcileCompetitiveSnapshot('agenthansa',[],{authoritative:true,missingToArchive:2});
    assert.equal(second.archived,1);assert.equal(restarted.get(live).status,'archived');
    assert.equal(restarted.blockReason(live)?.status,'archived');

    const reopened=restarted.reconcileCompetitiveSnapshot('agenthansa',['listing-1'],{authoritative:true,missingToArchive:2});
    assert.equal(reopened.reopened,1,'authoritative live feed must be allowed to restore an archived competitive listing');
    assert.equal(restarted.get(live).status,'new');
    assert.equal(restarted.blockReason(live),null);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}


// Dealwork is a real escrow state machine. Transport failure after an irreversible write
// must be resolved from canonical contract state, never by blindly repeating the action.
{
  const originalFetch=global.fetch;
  try{
    let contractReads=0;
    global.fetch=async (url,opts={})=>{
      const u=String(url),method=String(opts.method||'GET').toUpperCase();
      if(u.endsWith('/contracts/c-start')&&method==='GET'){
        contractReads++;
        return new Response(JSON.stringify({data:{id:'c-start',state:contractReads===1?'escrow_locked':'in_progress'}}),{status:200,headers:{'content-type':'application/json'}});
      }
      if(u.endsWith('/contracts/c-start/events')&&method==='POST')throw new TypeError('simulated response lost after commit');
      throw new Error(`unexpected fetch ${method} ${u}`);
    };
    const start=await startDealworkContract('c-start',{env:{DEALWORK_API_KEY:'dw_test'},credentials:{}});
    assert.equal(start.ok,true,'START_WORK timeout must recover from canonical in_progress state');
    assert.equal(start.recoveredAfterUncertainWrite,true);

    global.fetch=async (url,opts={})=>{
      const u=String(url),method=String(opts.method||'GET').toUpperCase();
      if(u.includes('/jobs/dw-claim/claim')&&method==='POST')throw new TypeError('claim response lost');
      if(u.includes('/contracts?role=worker')&&method==='GET')return new Response(JSON.stringify({data:[{id:'c-claim',jobId:'dw-claim',state:'in_progress'}]}),{status:200,headers:{'content-type':'application/json'}});
      if(u.endsWith('/jobs/dw-claim')&&method==='GET')return new Response(JSON.stringify({data:{id:'dw-claim',title:'Recovered work order',description:'Do the requested research'}}),{status:200,headers:{'content-type':'application/json'}});
      throw new Error(`unexpected fetch ${method} ${u}`);
    };
    const recoveredClaim=await claimMarketplaceJob({source:'dealwork',externalId:'dw-claim',title:'Research',description:'Research',budgetUsd:50,currency:'USD',claimMode:'automatic',raw:{}},{env:{DEALWORK_API_KEY:'dw_test'},credentials:{}});
    assert.equal(recoveredClaim.ok,true,'uncertain Dealwork claim must recover our already-created worker contract');
    assert.equal(recoveredClaim.recoveredClaim,true);
    assert.equal(recoveredClaim.jobId,'c-claim');

    let createCalls=0;
    global.fetch=async (url,opts={})=>{
      const u=String(url),method=String(opts.method||'GET').toUpperCase();
      if(u.endsWith('/contracts/c-deliver')&&method==='GET'){
        const state=createCalls===0?'in_progress':'in_review';
        return new Response(JSON.stringify({data:{id:'c-deliver',state}}),{status:200,headers:{'content-type':'application/json'}});
      }
      if(u.endsWith('/contracts/c-deliver/deliverables')&&method==='GET')return new Response(JSON.stringify({data:[]}),{status:200});
      if(u.endsWith('/contracts/c-deliver/deliverables')&&method==='POST'){
        createCalls++;throw new TypeError('deliverable response lost after server commit');
      }
      throw new Error(`unexpected fetch ${method} ${u}`);
    };
    const recoveredDelivery=await deliverMarketplaceJob(
      {source:'dealwork',externalId:'dw-deliver',title:'Deliver report'},
      {ok:true,jobId:'c-deliver'},
      {content:'final answer',format:'text/markdown',hash:'h1',evidence:{}},
      {env:{DEALWORK_API_KEY:'dw_test'},credentials:{}}
    );
    assert.equal(recoveredDelivery.ok,true,'delivery timeout after commit must be recovered from in_review state');
    assert.equal(recoveredDelivery.recoveredAfterUncertainWrite,true);
    assert.equal(createCalls,1,'recovery must not create a second deliverable');
  } finally { global.fetch=originalFetch; }
}

// Dealwork active-contract recovery must survive the nastiest claim window: the server
// committed escrow, our claim response was lost, and the job immediately vanished from the
// public feed. Discovery must rehydrate the canonical worker contract as already_assigned.
{
  const originalFetch=global.fetch;
  try{
    let claimPosts=0;
    global.fetch=async (url,opts={})=>{
      const u=String(url),method=String(opts.method||'GET').toUpperCase();
      if(u.includes('/jobs?per_page=')&&method==='GET')return new Response(JSON.stringify({data:[]}),{status:200,headers:{'content-type':'application/json'}});
      if(u.includes('/jobs/matching?')&&method==='GET')return new Response(JSON.stringify({data:[]}),{status:200,headers:{'content-type':'application/json'}});
      if(u.includes('/contracts?role=worker')&&method==='GET')return new Response(JSON.stringify({data:[
        {id:'c-orphan',jobId:'dw-orphan',state:'in_progress',amount:75},
        {id:'c-review',jobId:'dw-review',state:'in_review',amount:90}
      ]}),{status:200,headers:{'content-type':'application/json'}});
      if(u.endsWith('/jobs/dw-orphan')&&method==='GET')return new Response(JSON.stringify({data:{id:'dw-orphan',title:'Recovered assigned job',description:'Create a sourced research brief',fixedPrice:75,acceptanceCriteria:[{id:'a1'}]}}),{status:200,headers:{'content-type':'application/json'}});
      if(u.endsWith('/contracts/c-orphan')&&method==='GET')return new Response(JSON.stringify({data:{id:'c-orphan',jobId:'dw-orphan',state:'in_progress'}}),{status:200,headers:{'content-type':'application/json'}});
      if(u.includes('/jobs/dw-orphan/claim')&&method==='POST'){claimPosts++;throw new Error('assigned job must never be claimed twice');}
      throw new Error(`unexpected fetch ${method} ${u}`);
    };
    const discovery=await discoverMarketOpportunities({env:{DEALWORK_API_KEY:'dw_test'},credentials:{},limit:10,sources:['dealwork']});
    assert.equal(discovery.health.dealwork.assignedMode,1,'only pre-delivery active Dealwork contracts should enter recovery lane');
    assert.equal(discovery.signals.length,1);
    const orphan=discovery.signals[0];
    assert.equal(orphan.externalId,'dw-orphan');
    assert.equal(orphan.claimMode,'already_assigned');
    assert.equal(orphan.escrowed,true);
    assert.equal(orphan.raw.contractId,'c-orphan');
    assert.equal(orphan.budgetUsd,75);

    const claim=await claimMarketplaceJob(orphan,{env:{DEALWORK_API_KEY:'dw_test'},credentials:{}});
    assert.equal(claim.ok,true);
    assert.equal(claim.jobId,'c-orphan');
    assert.equal(claim.recoveredAssigned,true);
    assert.equal(claimPosts,0,'rehydrated contract must not call the irreversible claim endpoint');
  } finally { global.fetch=originalFetch; }
}

// Static invariants for the crash-safe runtime paths added in the final pass.
{
  const runtime=fs.readFileSync(path.join(process.cwd(),'src/autonomos/runtime.js'),'utf8');
  assert.match(runtime,/writeInFlightJob\(jobId,\{jobId,op,claim,workerId:worker\.id,[^}]*status:'claim_accepted'\}\);\s*handled\.add/s,'claim checkpoint must precede handled bookkeeping');
  assert.match(runtime,/fromBid:true,status:'claim_accepted'/,'accepted Dealwork bids need an in-flight claim checkpoint');
  assert.match(runtime,/fromBid:true\}\);\s*appendJobStatus\([^;]+status:'delivered'/s,'accepted Dealwork bid path must checkpoint delivery before local delivered status');
  assert.match(runtime,/artifact-persistence-pending\.json/,'failed R2\/S3 evidence writes need a persisted retry queue');
  assert.doesNotMatch(runtime,/artifactStore\.put(?:Json|Text)\([^\n]+\.catch\(\(\)=>\{\}\)/,'artifact persistence must not be fire-and-forget');
}

console.log('AUTONOMOS FINAL MEGA REGRESSION: PASS');
