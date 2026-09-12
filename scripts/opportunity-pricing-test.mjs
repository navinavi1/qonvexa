import assert from 'node:assert/strict';
import { canonicalOpportunity, eligibility, priceOpportunity } from '../src/autonomos/canonical-opportunity.js';
import { classifyOpportunity } from '../src/autonomos/capabilities.js';
import { isRetiredMarket } from '../src/autonomos/retired-markets.js';

let checks=0;
const ok=(c,l)=>{assert.ok(c,l);checks++;};
const eq=(a,b,l)=>{assert.deepEqual(a,b,l+' (got '+JSON.stringify(a)+')');checks++;};

const caps={llmEnabled:true,hasWebSearchTool:true,hasGithubPrTool:true,hasArtifactTool:true,hasShellTool:true,strictCapabilityProof:true,connectedApps:[]};
const env={AUTONOMOS_MIN_JOB_PAYOUT_USD:'5'};
const job=extra=>canonicalOpportunity({externalId:'j',source:'m',title:'Fix a Node.js bug and open a PR',description:'A test fails.',payoutUsd:40,currency:'USD',workType:'REAL_MARKET_JOB',claimRoute:'API_APPLICATION',category:'coding',fresh:true,...extra});
const priced=op=>priceOpportunity(op,classifyOpportunity({...op,budgetUsd:op.payoutUsd},caps));

// 1. The bug: an unpriced job is refused for a missing field, not for its economics.
const raw=job();
eq(raw.expectedNetProfit,null,'unpriced job has no profit figure');
eq(eligibility(raw,env).reasons,['PROFITABILITY_UNVERIFIED_OR_NEGATIVE'],'and is refused at execution');

// 2. Pricing it from its own capability classification clears the gate.
const p=priced(raw);
ok(p.estimatedExecutionCost>0,'execution cost is now a real number');
ok(p.expectedNetProfit>39,'a $40 job nets over $39 once priced, got '+p.expectedNetProfit);
eq(eligibility(p,env).eligible,true,'priced job passes the execution gate');

// 3. Pricing must not whitewash a job that genuinely loses money.
const tiny=priced(job({payoutUsd:6,description:'x'.repeat(40000)}));
ok(tiny.estimatedExecutionCost>0,'a long job costs more to execute');
if(tiny.expectedNetProfit<=0)eq(eligibility(tiny,env).eligible,false,'an unprofitable job is still refused');
else ok(tiny.expectedNetProfit>0,'a profitable job stays eligible on its economics');

// 4. Below the payout floor stays refused no matter how cheap execution is.
ok(eligibility(priced(job({payoutUsd:1})),env).reasons.includes('BELOW_MIN_JOB_VALUE'),'payout floor still applies');

// 5. A competitive job has no win probability, so it stays unpriced rather than guessed.
const competitive=priced(job({competitive:true}));
eq(competitive.expectedNetProfit,null,'a competitive job without a win probability is not invented');

// 6. Pricing is a no-op when there is no capability to price from.
eq(priceOpportunity(raw,null),raw,'no capability means the opportunity is returned untouched');
eq(priceOpportunity(raw,{}).expectedNetProfit,null,'a capability without a cost estimate changes nothing');

// 7. Algora is retired: verified dead from the live site, so hunters must stop polling it.
for(const source of ['algora.io','algora','api.docs.algora.io'])
  ok(isRetiredMarket({source}),source+' is retired');
ok(!isRetiredMarket({source:'github.com'}),'live markets stay live');

console.log('opportunity-pricing-test OK ('+checks+' checks)');
