import crypto from 'node:crypto';
import { isRetiredMarket } from './retired-markets.js';
import { minimumJobPayoutUsd } from './payout-floor.js';
const USD=new Set(['USD','USDC','USDT','DAI']);
export function canonicalOpportunity(raw={}){
 const currency=String(raw.currency||raw.payoutCurrency||'UNKNOWN').toUpperCase();
 const payout=Number(raw.payout?.amount??raw.payout??raw.budgetUsd??raw.amountUsd??0);
 const explicitUsd=Number(raw.payoutUsd??raw.rewardUsd);
 const payoutUsd=Number.isFinite(explicitUsd)?explicitUsd:USD.has(currency)&&Number.isFinite(payout)?payout:null;
 const source=String(raw.marketplace||raw.marketId||raw.source||'unknown');
 const externalId=String(raw.externalId||raw.id||raw.url||'');
 const description=String(raw.description||raw.snippet||'');
 const text=raw.title+' '+description;
 const workType=raw.workType||(/annual salary|401k|full.time employee|per annum/i.test(text)?'EMPLOYMENT':/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(raw.url||'')?'GITHUB_BOUNTY':raw.marketId?'REAL_MARKET_JOB':'UNROUTABLE');
 const probability=raw.estimatedWinProbability==null?(raw.competitive?null:1):Math.max(0,Math.min(1,Number(raw.estimatedWinProbability)));
 const cost=Number(raw.estimatedExecutionCost??0);const fee=Number(raw.marketplaceFees??0);
 return{...raw,id:crypto.createHash('sha256').update(source+':'+externalId).digest('hex').slice(0,24),externalId,source,marketplace:source,title:String(raw.title||''),description,url:String(raw.url||raw.URL||''),workType,payout,payoutUsd,currency,paymentRail:raw.paymentRail||'unknown',cryptoConvertible:raw.cryptoConvertible===true,escrow:raw.escrowed===true,buyerFunded:raw.buyerFunded===true,deadline:raw.deadline||'',requiredSkills:raw.requiredSkills||raw.skills||[],requiredTools:raw.requiredTools||[],requiredCapabilities:raw.requiredCapabilities||[],competitive:raw.competitive===true,estimatedWinProbability:probability,estimatedExecutionCost:cost,expectedNetProfit:payoutUsd!==null&&probability!==null?payoutUsd*probability-cost-fee:null,claimRoute:raw.claimRoute||null,applicationRoute:raw.applicationRoute||null,deliveryRoute:raw.deliveryRoute||null,payoutRoute:raw.payoutRoute||null,humanGate:raw.humanGate||false,fresh:raw.fresh===true,createdAt:raw.createdAt||'',expiresAt:raw.expiresAt||raw.deadline||'',rawEvidence:raw.rawEvidence||{url:raw.url||'',observedAt:raw.observedAt||raw.lastSeenAt||''}};
}
export function eligibility(op,env=process.env){
 const reasons=[];if(isRetiredMarket(op))reasons.push('DO_NOT_RESTORE');
 if(!['REAL_MARKET_JOB','REAL_DIRECT_PAID_PROJECT','GITHUB_BOUNTY'].includes(op.workType))reasons.push(op.workType);
 if(op.payoutUsd===null)reasons.push('PAYOUT_USD_UNVERIFIED');else if(op.payoutUsd<minimumJobPayoutUsd(env))reasons.push('BELOW_MIN_JOB_VALUE');
 if(op.humanGate)reasons.push('OWNER_ACTION_REQUIRED');
 if(op.expiresAt&&Date.parse(op.expiresAt)<=Date.now())reasons.push('JOB_EXPIRED');
 if(op.expectedNetProfit===null||op.expectedNetProfit<=0)reasons.push('PROFITABILITY_UNVERIFIED_OR_NEGATIVE');
 if(!op.claimRoute&&!op.applicationRoute)reasons.push('APPLICATION_ROUTE_UNVERIFIED');
 return{eligible:reasons.length===0,reasons};
}
