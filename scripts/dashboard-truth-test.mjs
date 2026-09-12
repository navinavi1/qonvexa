import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutonomOS } from '../src/autonomos/runtime.js';
import { discoverMarketOpportunities, claimMarketplaceJob } from '../src/autonomos/connectors/index.js';
import { isRetiredMarket } from '../src/autonomos/retired-markets.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'dash-truth-'));
const dir=path.join(root,'autonomos');
fs.mkdirSync(dir,{recursive:true});
let checks=0;
const ok=(c,l)=>{assert.ok(c,l);checks++;};
const eq=(a,b,l)=>{assert.deepEqual(a,b,l+' (got '+JSON.stringify(a)+')');checks++;};

// The decommissioned connector path: this is what Mission Control used to read.
eq((await discoverMarketOpportunities()).signals,[],'connector discovery is an empty stub');
eq((await claimMarketplaceJob({source:'x'})).ok,false,'connector claim is a stub');

// The feed the worker fleet actually fills.
const now=new Date().toISOString();
fs.writeFileSync(path.join(dir,'global-work-hunter.json'),JSON.stringify({leads:{
  a:{id:'a',externalId:'a',source:'freelancer.com',title:'Fix a Node bug',budgetUsd:40,currency:'USD',lastSeenAt:now},
  b:{id:'b',externalId:'b',source:'github.com',title:'Bounty issue',budgetUsd:1000,currency:'USD',lastSeenAt:now},
  dead:{id:'dead',externalId:'dead',source:'dealwork',title:'Retired market job',budgetUsd:10,currency:'USD',lastSeenAt:now}
}}));
// Retired-market rows must never reach the panel, whatever wrote them.
fs.writeFileSync(path.join(dir,'jobs.ndjson'),
  JSON.stringify({id:'j1',source:'dealwork',title:'Vesper',status:'claim_failed'})+'\n'+
  JSON.stringify({id:'j2',source:'github.com',title:'Live job',status:'claiming'})+'\n');

const runtime=createAutonomOS({storageDir:root,env:{STORAGE_DIR:root,AUTONOMOS_ENABLED:'true'}});
const snap=await runtime.snapshot();

// 1. The outcomes panel no longer shows markets the owner retired.
const sources=(snap.jobs||[]).map(j=>j.source);
ok(!sources.includes('dealwork'),'retired market left the outcomes panel');
ok(sources.includes('github.com'),'live jobs still shown');
ok(isRetiredMarket({source:'dealwork'}),'dealwork is in fact retired');

// 2. History is filtered in the view only, never on disk.
const onDisk=fs.readFileSync(path.join(dir,'jobs.ndjson'),'utf8');
ok(onDisk.includes('dealwork'),'retired rows are still on disk, only the view filters them');

// 3. Mission Control reads the fleet feed, so its funnel is no longer structurally zero.
await runtime.runCycle();
const after=await runtime.snapshot();
const funnel=after.marketFunnel||after.runtime?.marketFunnel||{};
ok(Number(funnel.rawSignals||0)>0,'funnel now counts real leads, got '+JSON.stringify(funnel));
ok(Number(funnel.rawSignals||0)<=2,'retired lead excluded from the funnel too, got '+funnel.rawSignals);

// 4. Fiat jobs are refused because the owner has no fiat rail, and the panel must say so
//    rather than describing it as a market condition the owner should wait out.
const fiat=createAutonomOS({storageDir:root,env:{STORAGE_DIR:root,AUTONOMOS_ENABLED:'true',AUTONOMOS_CRYPTO_ONLY_EARNINGS:'true'}});
await fiat.runCycle();
const fiatSnap=await fiat.snapshot();
const text=JSON.stringify(fiatSnap);
ok(text.includes('crypto_only_payout_required')||text.includes('CRYPTO_ONLY_EARNINGS'),
  'the crypto-only refusal is surfaced, not swallowed');


fs.rmSync(root,{recursive:true,force:true});
console.log('dashboard-truth-test OK ('+checks+' checks)');
