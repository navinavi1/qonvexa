import assert from 'node:assert/strict';
import { canonicalOpportunity, eligibility, priceOpportunity } from '../src/autonomos/canonical-opportunity.js';
import { classifyOpportunity } from '../src/autonomos/capabilities.js';
import { isRetiredMarket } from '../src/autonomos/retired-markets.js';
import { marketplaceFeePercent } from '../src/autonomos/marketplace-fees.js';
import { evaluateOpportunity } from '../src/autonomos/profit-engine.js';

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
// Net is the payout less the marketplace's cut and our execution cost. This used to assert
// >39, which only held while every marketplace fee evaluated to zero.
const feePercent=marketplaceFeePercent('m',{}).percent;
const expectedNet=40-(40*feePercent/100)-p.estimatedExecutionCost;
ok(Math.abs(p.expectedNetProfit-expectedNet)<0.01,
  'net is payout minus the '+feePercent+'% fee minus execution cost, expected '+expectedNet.toFixed(4)+' got '+p.expectedNetProfit);
ok(p.expectedNetProfit<40,'net is always below gross once a fee applies');
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


// 8. A marketplace's cut comes out of the payout, so it is only paid when we are paid.
// Charged at face value against probability-weighted revenue, the payout cancelled out of
// the comparison entirely and the whole profitability test degenerated into
// "win probability > fee percentage" -- refusing a $10,000 contract on a 15% market for
// "non_positive_profit" while allowing a $10 one on a 7.5% market. Profit must scale with
// the size of the job.
const econCfg={minMarginPercent:20,zeroSpendMode:false,earnedFundsOnly:true,availableSpendUsd:50};
const priceAt=(payoutUsd,feePercent)=>evaluateOpportunity({expectedRevenueUsd:payoutUsd,
  successProbability:0.13,modelCostUsd:0.0045,marketplaceFeeUsd:payoutUsd*feePercent/100},econCfg);

const big=priceAt(10000,15),small=priceAt(10,15);
ok(big.allowed,'a $10,000 job on a 15% market is profitable work, not a loss');
ok(big.expectedProfitUsd>small.expectedProfitUsd*100,'expected profit scales with the size of the job');
ok(priceAt(100,7.5).expectedProfitUsd>priceAt(100,15).expectedProfitUsd,'a cheaper market is worth more, all else equal');

// The same arithmetic, in the other place it is written.
const feeJob={title:'Paid task',description:'Deliver a document.',source:'taskmarket.dev',externalId:'fee-1',
  payoutUsd:1000,currency:'USDC',competitive:true,estimatedWinProbability:0.13,
  estimatedExecutionCost:0.0045,marketplaceFees:75,expectedFailureCost:0};
eq(Math.round(canonicalOpportunity(feeJob).expectedNetProfit*100)/100,
   Math.round((1000*0.13-0.0045-75*0.13)*100)/100,
   'canonicalOpportunity weights the marketplace cut by the chance of being paid');
ok(canonicalOpportunity(feeJob).expectedNetProfit>0,'a $1,000 task with a 7.5% cut is not a loss');

console.log('opportunity-pricing-test OK ('+checks+' checks)');
