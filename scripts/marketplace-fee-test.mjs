import assert from 'node:assert/strict';
import { marketplaceFeePercent, withMarketplaceFee, estimatedFeeUsd, VERIFIED_MARKET_FEES, DEFAULT_UNKNOWN_FEE_PERCENT } from '../src/autonomos/marketplace-fees.js';
import { canonicalOpportunity, priceOpportunity } from '../src/autonomos/canonical-opportunity.js';
import { classifyOpportunity } from '../src/autonomos/capabilities.js';

let checks=0;
const ok=(c,l)=>{assert.ok(c,l);checks++;};
const eq=(a,b,l)=>{assert.deepEqual(a,b,l+' (got '+JSON.stringify(a)+')');checks++;};

// 1. A published rate is used as published; an unknown market gets a protective assumption.
eq(marketplaceFeePercent('taskmarket.dev',{}).percent,7.5,'taskmarket uses its published 7.5%');
eq(marketplaceFeePercent('taskmarket.dev',{}).verified,true,'and is marked verified');
eq(marketplaceFeePercent('TaskMarket.DEV',{}).percent,7.5,'source matching is case-insensitive');
eq(marketplaceFeePercent('who.knows',{}).verified,false,'an unknown market is not claimed as verified');
ok(marketplaceFeePercent('who.knows',{}).percent>0,'and never assumes a flattering zero fee');
eq(marketplaceFeePercent('who.knows',{}).percent,DEFAULT_UNKNOWN_FEE_PERCENT,'it uses the documented default');
eq(marketplaceFeePercent('x',{AUTONOMOS_DEFAULT_MARKETPLACE_FEE_PERCENT:'5'}).percent,5,'the default is overridable');
eq(marketplaceFeePercent('x',{AUTONOMOS_DEFAULT_MARKETPLACE_FEE_PERCENT:'oops'}).percent,DEFAULT_UNKNOWN_FEE_PERCENT,'a bad override falls back');
eq(marketplaceFeePercent('x',{AUTONOMOS_DEFAULT_MARKETPLACE_FEE_PERCENT:'900'}).percent,DEFAULT_UNKNOWN_FEE_PERCENT,'an out-of-range override is refused');

// 2. A rate the market itself reports always beats our assumption.
eq(withMarketplaceFee({source:'who.knows',feePercent:3},{}).feePercent,3,'a reported fee is preserved');
eq(withMarketplaceFee({source:'taskmarket.dev'},{}).feePercent,7.5,'an absent fee is filled in');
eq(withMarketplaceFee({source:'taskmarket.dev'},{}).feePercentVerified,true,'the fill records whether it is verified');

// 3. Fee amounts.
eq(estimatedFeeUsd({source:'taskmarket.dev',budgetUsd:40},{}),3,'$40 on taskmarket costs $3');
eq(estimatedFeeUsd({source:'taskmarket.dev',budgetUsd:0},{}),0,'no budget means no fee');
eq(estimatedFeeUsd({source:'taskmarket.dev'},{}),0,'a missing budget is not NaN');

// 4. The regression this exists to stop: profit must be net of the platform's cut.
const caps={llmEnabled:true,hasWebSearchTool:true,hasGithubPrTool:true,hasArtifactTool:true,hasShellTool:true,strictCapabilityProof:true,connectedApps:[]};
const job=canonicalOpportunity({externalId:'j',source:'taskmarket.dev',title:'Write a report',description:'Summarize a dataset.',payoutUsd:40,currency:'USDC',workType:'REAL_MARKET_JOB',claimRoute:'API_APPLICATION',fresh:true});
const priced=priceOpportunity(job,classifyOpportunity({...job,budgetUsd:job.payoutUsd},caps),{env:{}});
ok(priced.expectedNetProfit<40,'net profit is below the gross payout, got '+priced.expectedNetProfit);
ok(priced.expectedNetProfit>36,'and not over-deducted, got '+priced.expectedNetProfit);
ok(Math.abs((40-3-priced.estimatedExecutionCost)-priced.expectedNetProfit)<0.01,
  'net equals payout minus the 7.5% fee minus execution cost, got '+priced.expectedNetProfit);

// 5. An explicit fee passed by a caller wins over the table.
const explicit=priceOpportunity(job,classifyOpportunity({...job,budgetUsd:40},caps),{marketplaceFeeUsd:0,env:{}});
ok(explicit.expectedNetProfit>39,'a caller-supplied zero fee is honoured, got '+explicit.expectedNetProfit);

// 6. Every verified entry must be a sane percentage, not a fraction or a typo.
for(const [market,percent] of Object.entries(VERIFIED_MARKET_FEES)){
  ok(percent>0&&percent<50,market+' has a plausible take rate: '+percent);
}

console.log('marketplace-fee-test OK ('+checks+' checks)');
