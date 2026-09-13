import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateOpportunity } from '../src/autonomos/profit-engine.js';
import { normalizeConfig } from '../src/autonomos/policy-engine.js';

let checks=0;
const ok=(c,l)=>{assert.ok(c,l);checks++;};
const eq=(a,b,l)=>{assert.deepEqual(a,b,l+' (got '+JSON.stringify(a)+')');checks++;};

// The job the dashboard reported as "Economics Failed": $25, a fraction of a cent to run.
const job={expectedRevenueUsd:25,successProbability:1,modelCostUsd:0.0025,marketplaceFeeUsd:3.75};
const base=normalizeConfig({enabled:true,zeroSpendMode:true,earnedFundsOnly:true,survivalMode:true});

// 1. It is refused, and not because its economics are bad.
const refused=evaluateOpportunity(job,{...base,availableSpendUsd:9.31});
eq(refused.allowed,false,'zero-spend mode refuses the job');
ok(refused.expectedProfitUsd>20,'while the job is plainly profitable, $'+refused.expectedProfitUsd);
ok(refused.marginPercent>80,'at a margin of '+refused.marginPercent+'%');
ok(/zero_spend_mode/.test(refused.reason),'and the reason names the switch, got '+refused.reason);
ok(refused.outOfPocketCostUsd<0.01,'the spend it forbids is under a cent: $'+refused.outOfPocketCostUsd);

// 2. With spending allowed but still capped to earned funds, the same job runs.
const allowed=evaluateOpportunity(job,{...base,zeroSpendMode:false,availableSpendUsd:9.31});
eq(allowed.allowed,true,'the job clears once spending is permitted, reason: '+allowed.reason);

// 3. The earned cap still bites when the agents genuinely cannot afford the work.
const broke=evaluateOpportunity({...job,modelCostUsd:50},{...base,zeroSpendMode:false,availableSpendUsd:0});
eq(broke.allowed,false,'an unaffordable job is still refused');
ok(/earned_funds_cap/.test(broke.reason),'and says so, got '+broke.reason);

// 4. Each refusal reaches the owner as its own blocker with its own text, rather than all
//    three collapsing into "fails the profit/cost gate".
const here=path.dirname(fileURLToPath(import.meta.url));
const runtime=fs.readFileSync(path.join(here,'..','src','autonomos','runtime.js'),'utf8');
const rules=runtime.slice(runtime.indexOf('function blockerBucket('),runtime.indexOf('function buildMarketFunnel('));
const bucket=reason=>{for(const [,re,name] of rules.matchAll(/if\(\/(.+?)\/\.test\(r\)\)return '([a-z_]+)'/g))if(new RegExp(re).test(reason))return name;return 'other';};
const zero=bucket('economics_blocked:blocked_by_zero_spend_mode');
const cap=bucket('economics_blocked:blocked_by_earned_funds_cap');
const real=bucket('economics_blocked:negative_unit_economics');
eq(zero,'spending_switched_off','a spend-mode refusal is its own blocker');
eq(cap,'earned_budget_exhausted','an exhausted budget is its own blocker');
eq(real,'economics_failed','a genuine economics failure keeps its name');
eq(new Set([zero,cap,real]).size,3,'the three never collapse into one message');
for(const name of [zero,cap,real])ok(runtime.includes(name+":'"),name+' carries owner-facing text');
ok(/AUTONOMOS_ZERO_SPEND_MODE/.test(runtime),'the text names the variable the owner has to change');

// 5. availableSpendUsd is a per-cycle figure, not persisted config: normalizeConfig drops it
//    by design. Anyone folding it into normalizeConfig instead of spreading it afterwards
//    silently sets the budget to zero and blocks every paid job, so pin the call order.
eq('availableSpendUsd' in normalizeConfig({availableSpendUsd:9.31}),false,
  'normalizeConfig drops the per-cycle budget, as designed');
ok(/const cycleConfig=\{\.\.\.config,availableSpendUsd\}/.test(runtime),
  'runtime spreads the budget onto the normalized config, never through it');
eq(evaluateOpportunity(job,normalizeConfig({enabled:true,zeroSpendMode:false,earnedFundsOnly:true,availableSpendUsd:9.31})).allowed,false,
  'and folding it into normalizeConfig would indeed block the job -- which is why the order is pinned');

console.log('spend-gate-test OK ('+checks+' checks)');
