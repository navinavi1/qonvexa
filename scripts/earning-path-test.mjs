import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalOpportunity, eligibility, priceOpportunity } from '../src/autonomos/canonical-opportunity.js';
import { classifyOpportunity, capabilityCatalog } from '../src/autonomos/capabilities.js';
import { evaluateOpportunity } from '../src/autonomos/profit-engine.js';
import { normalizeConfig } from '../src/autonomos/policy-engine.js';
import { marketplaceFeePercent } from '../src/autonomos/marketplace-fees.js';
import { createAutonomOS } from '../src/autonomos/runtime.js';

// Walks one real job through every gate between "seen" and "claimable", so a gate that
// refuses everything is named here rather than discovered months later on a dashboard that
// says nothing but zero.
let checks=0;
const ok=(c,l)=>{assert.ok(c,l);checks++;};
const eq=(a,b,l)=>{assert.equal(a,b,l+' (got '+JSON.stringify(a)+')');checks++;};

const caps={llmEnabled:true,hasWebSearchTool:true,hasGithubPrTool:true,hasArtifactTool:true,
  hasShellTool:true,hasBrowserTool:true,hasDesignMediaTool:true,hasAppTool:true,
  connectedApps:['gmail','github','google_drive'],strictCapabilityProof:true};
const env={AUTONOMOS_MIN_JOB_PAYOUT_USD:'5'};

const raw={externalId:'j1',source:'taskmarket.dev',title:'Write API documentation for a REST service',
  description:'Produce developer docs from an OpenAPI file.',payoutUsd:75,currency:'USDC',
  workType:'REAL_MARKET_JOB',claimRoute:'API_APPLICATION',category:'documentation',fresh:true,
  escrowed:true,observedAt:new Date().toISOString()};

// 1. Seen -> shaped.
const op=canonicalOpportunity(raw);
eq(op.payoutUsd,75,'the payout survives canonicalisation');
eq(op.workType,'REAL_MARKET_JOB','the work type survives');
ok(op.fresh,'the job is fresh');

// 2. Shaped -> can we do it.
const cap=classifyOpportunity({...op,budgetUsd:op.payoutUsd},caps);
eq(cap.executable,true,'a documentation job is executable with the full toolset: '+cap.mode);
eq((cap.missingTools||[]).length,0,'nothing is missing for it');

// 3. Can we do it -> is it worth it. Unpriced, this gate refuses everything on a missing
//    field rather than on economics, which is how it hid for so long.
eq(op.expectedNetProfit,null,'an unpriced job has no profit figure');
ok(eligibility(op,env).reasons.includes('PROFITABILITY_UNVERIFIED_OR_NEGATIVE'),'and is refused for that, not for its economics');
const priced=priceOpportunity(op,cap,{env});
ok(priced.expectedNetProfit>60,'priced, a $75 job nets over $60: '+priced.expectedNetProfit);
eq(eligibility(priced,env).eligible,true,'and clears the gate');

// 4. Worth it -> are we allowed to spend what it costs.
const spendable=normalizeConfig({enabled:true,zeroSpendMode:false,earnedFundsOnly:true,survivalMode:true});
const econ=evaluateOpportunity({expectedRevenueUsd:75,successProbability:1,
  modelCostUsd:cap.estimatedModelCostUsd,marketplaceFeeUsd:75*marketplaceFeePercent('taskmarket.dev',{}).percent/100},
  {...spendable,availableSpendUsd:9.31});
eq(econ.allowed,true,'with spending permitted and capped to earned funds, it is allowed: '+econ.reason);
ok(econ.expectedProfitUsd>60,'at a profit of $'+econ.expectedProfitUsd);

// The switch that refused all of them, stated as a fact rather than a belief.
const locked=evaluateOpportunity({expectedRevenueUsd:75,successProbability:1,modelCostUsd:cap.estimatedModelCostUsd},
  {...normalizeConfig({enabled:true,zeroSpendMode:true,earnedFundsOnly:true,survivalMode:true}),availableSpendUsd:9.31});
eq(locked.allowed,false,'zero-spend mode refuses the same job');
ok(/zero_spend_mode/.test(locked.reason),'and names itself: '+locked.reason);
ok(locked.expectedProfitUsd>60,'while the job is worth $'+locked.expectedProfitUsd);

// 5. What the agents can and cannot take on, by tool.
const withTools=capabilityCatalog(caps).filter(r=>r.available).length;
const llmOnly=capabilityCatalog({llmEnabled:true,hasWebSearchTool:true,strictCapabilityProof:true,connectedApps:[]}).filter(r=>r.available).length;
const noShell=capabilityCatalog({...caps,hasShellTool:false,hasBrowserTool:false,hasDesignMediaTool:false}).filter(r=>r.available).length;
eq(withTools,13,'with every tool configured the agents can take all 13 kinds of work');
ok(llmOnly<=3,'with only a model and search they can take at most 3: '+llmOnly);
ok(withTools-noShell>=5,'the sandbox alone is worth at least 5 kinds of work: '+(withTools-noShell));

// 6. Currency policy, which decides whether a found job is reachable at all.
const usd=canonicalOpportunity({...raw,externalId:'j2',currency:'USD',payoutUsd:40});
const usdc=canonicalOpportunity({...raw,externalId:'j3',currency:'USDC',payoutUsd:40});
eq(usd.currency,'USD','a fiat job keeps its currency');
eq(usdc.currency,'USDC','a crypto job keeps its currency');


// The auto-claim lane needs a market at FULL_AUTO_READY. Only NativeMarketWorker records
// all eight evidence kinds that state requires, and its one built-in connector is
// freelancer.com, switched on by a single variable that appeared in three lines of source
// and in no place an owner reads. A switch nobody can find is the same as no switch.
{
  const storage=fs.mkdtempSync(path.join(os.tmpdir(),'missing-'));
  const root=path.join(storage,'autonomos'); fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,'global-work-hunter.json'),JSON.stringify({leads:{
    a:{id:'a',marketId:'freelancer.com'},b:{id:'b',marketId:'freelancer.com'},c:{id:'c',marketId:'remotive'}}}));
  const build=extra=>createAutonomOS({storageDir:storage,siteUrl:'http://127.0.0.1:1',
    ownerWallet:'0x'+'1'.repeat(40),logger:{info(){},warn(){},error(){},debug(){}},
    env:{STORAGE_DIR:storage,AUTONOMOS_ENABLED:'false',npm_lifecycle_event:'',...extra}});

  const off=(await build({}).snapshot()).missing||[];
  const row=off.find(x=>/freelancer/i.test(String(x.item)));
  ok(row,'the dashboard names the switch that opens the only end-to-end market');
  ok(/FREELANCER_OAUTH_TOKEN/.test(row.detail),'and names the variable exactly');
  ok(/\b2\b/.test(row.detail),'and says how many leads are waiting on it');

  const on=(await build({FREELANCER_OAUTH_TOKEN:"token"}).snapshot()).missing||[];
  ok(!on.some(x=>/freelancer/i.test(String(x.item))),'and stops asking once it is set');
  fs.rmSync(storage,{recursive:true,force:true});
}

console.log('earning-path-test OK ('+checks+' checks, seen -> executable -> priced -> affordable)');
