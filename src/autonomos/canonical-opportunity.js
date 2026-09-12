import crypto from 'node:crypto';
import { isRetiredMarket } from './retired-markets.js';
import { minimumJobPayoutUsd } from './payout-floor.js';
import { marketplaceFeePercent } from './marketplace-fees.js';
const USD=new Set(['USD','USDC','USDT','DAI']);
const amount=v=>v===null||v===undefined||v===''||typeof v==='boolean'||!Number.isFinite(Number(v))||Number(v)<0?null:Number(v);
export function canonicalOpportunity(raw={}){
 const currency=String(raw.currency||raw.payoutCurrency||raw.payout?.currency||'UNKNOWN').toUpperCase();
 const payout=amount(raw.payout?.amount??(typeof raw.payout==='number'?raw.payout:undefined)??raw.budgetUsd??raw.amountUsd);
 const explicitUsd=amount(raw.payoutUsd??raw.rewardUsd??raw.payout?.amountUsd??raw.budgetUsd??raw.amountUsd);
 const payoutUsd=explicitUsd!==null?explicitUsd:USD.has(currency)?payout:null;
 const source=String(raw.marketplace||raw.marketId||raw.source||'unknown');
 const externalId=String(raw.externalId||raw.id||raw.url||'');
 const description=String(raw.description||raw.snippet||'');
 const text=raw.title+' '+description;
 const workType=raw.workType||(/annual salary|401k|full.time employee|per annum/i.test(text)?'EMPLOYMENT':/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(raw.url||'')?'GITHUB_BOUNTY':raw.marketId?'REAL_MARKET_JOB':'UNROUTABLE');
 const rate=amount(raw.estimatedWinProbability);
 const probability=raw.estimatedWinProbability==null?(raw.competitive?null:1):rate!==null&&rate<=1?rate:null;
 const cost=amount(raw.estimatedExecutionCost),fee=amount(raw.marketplaceFees??0),failureCost=amount(raw.expectedFailureCost??0);
 return{...raw,id:crypto.createHash('sha256').update(source+':'+externalId).digest('hex').slice(0,24),externalId,source,marketplace:source,title:String(raw.title||''),description,url:String(raw.url||raw.URL||''),workType,payout,payoutUsd,currency,paymentRail:raw.paymentRail||'unknown',cryptoConvertible:raw.cryptoConvertible===true,escrow:raw.escrowed===true||raw.escrow===true,buyerFunded:raw.buyerFunded===true,deadline:raw.deadline||'',requiredSkills:raw.requiredSkills||raw.skills||[],requiredTools:raw.requiredTools||[],requiredCapabilities:raw.requiredCapabilities||[],competitive:raw.competitive===true,estimatedWinProbability:probability,estimatedExecutionCost:cost,expectedNetProfit:payoutUsd!==null&&probability!==null&&cost!==null&&fee!==null&&failureCost!==null?payoutUsd*probability-cost-fee-failureCost:null,claimRoute:raw.claimRoute||null,applicationRoute:raw.applicationRoute||null,deliveryRoute:raw.deliveryRoute||null,payoutRoute:raw.payoutRoute||null,humanGate:raw.humanGate||false,fresh:raw.fresh===true||Date.parse(raw.observedAt||raw.lastSeenAt||'')>Date.now()-48*3600000,createdAt:raw.createdAt||'',expiresAt:raw.expiresAt||raw.deadline||'',rawEvidence:raw.rawEvidence||{url:raw.url||'',observedAt:raw.observedAt||raw.lastSeenAt||''}};
}
// expectedNetProfit stays null unless estimatedExecutionCost is a number, and nothing in
// the system ever set that field: it was read in canonicalOpportunity and written by no
// one. So every opportunity failed the execution-phase profitability check on a missing
// input rather than on its economics, and businessSnapshot reported eligible:0 with
// PROFITABILITY_UNVERIFIED_OR_NEGATIVE as the top blocker on every job it had ever seen.
//
// The number it wanted already existed one module over: classifyOpportunity computes
// estimatedModelCostUsd for exactly this opportunity. Pricing is therefore a join, not a
// new estimate -- pass the capability that was classified for this op and nothing else.
export function priceOpportunity(op,capability,{marketplaceFeeUsd=null,env=process.env}={}){
  const executionCost=amount(capability?.estimatedModelCostUsd);
  if(executionCost===null)return op;
  // The marketplace's cut belongs in expectedNetProfit. feePercent was read in four places
  // and written by none, so every fee evaluated to zero and a $40 job looked like $40 net.
  const payout=amount(op?.payoutUsd);
  const fee=marketplaceFeeUsd!==null?Number(marketplaceFeeUsd)
    :payout===null?0:Math.round(payout*marketplaceFeePercent(op?.source,env).percent)/100;
  return canonicalOpportunity({...op,estimatedExecutionCost:executionCost,marketplaceFees:fee});
}

export function eligibility(op,env=process.env,{phase='execution'}={}){
 const reasons=[];if(isRetiredMarket(op))reasons.push('DO_NOT_RESTORE');
 if(!['REAL_MARKET_JOB','REAL_DIRECT_PAID_PROJECT','GITHUB_BOUNTY'].includes(op.workType))reasons.push(op.workType);
 if(amount(op.payoutUsd)===null)reasons.push('PAYOUT_USD_UNVERIFIED');else if(op.payoutUsd<minimumJobPayoutUsd(env))reasons.push('BELOW_MIN_JOB_VALUE');
 if(op.humanGate)reasons.push('OWNER_ACTION_REQUIRED');
 if(!op.fresh)reasons.push('FRESHNESS_UNVERIFIED');
 if(op.expiresAt&&Date.parse(op.expiresAt)<=Date.now())reasons.push('JOB_EXPIRED');
 if((!Number.isFinite(op.expectedNetProfit)||op.expectedNetProfit===null||op.expectedNetProfit<=0)&&!(phase==='application'&&op.applicationCostUsd===0&&op.expectedNetProfit===null))reasons.push('PROFITABILITY_UNVERIFIED_OR_NEGATIVE');
 if(!op.claimRoute&&!op.applicationRoute)reasons.push('APPLICATION_ROUTE_UNVERIFIED');
 return{eligible:reasons.length===0,reasons};
}
