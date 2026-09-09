import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentMemory } from '../src/autonomos/memory.js';
import { JobRegistry } from '../src/autonomos/job-registry.js';
import { discoverMarketOpportunities, claimMarketplaceJob, deliverMarketplaceJob } from '../src/autonomos/connectors/index.js';

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


// Static invariants for the crash-safe runtime paths added in the final pass.
{
  const runtime=fs.readFileSync(path.join(process.cwd(),'src/autonomos/runtime.js'),'utf8');
  assert.match(runtime,/writeInFlightJob\(jobId,\{jobId,op,claim,workerId:worker\.id,[^}]*status:'claim_accepted'\}\);\s*handled\.add/s,'claim checkpoint must precede handled bookkeeping');
  assert.match(runtime,/artifact-persistence-pending\.json/,'failed R2\/S3 evidence writes need a persisted retry queue');
  assert.doesNotMatch(runtime,/artifactStore\.put(?:Json|Text)\([^\n]+\.catch\(\(\)=>\{\}\)/,'artifact persistence must not be fire-and-forget');
}

console.log('AUTONOMOS FINAL MEGA REGRESSION: PASS');
