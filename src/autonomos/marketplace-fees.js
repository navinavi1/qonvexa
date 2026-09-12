// Marketplace take rates. feePercent was read in four places and written by nobody, so
// every marketplace fee evaluated to zero: a $40 job was treated as $40 net when the
// platform keeps a cut of it. That inflates the profitability gate (work gets accepted
// that does not clear its own cost once the fee lands) and inflates the owner/agent split,
// which is computed from the same figure.
//
// Only rates read from a platform's own documentation are marked verified. Everything else
// uses a deliberately protective assumption rather than a flattering zero: assuming no fee
// where one exists accepts unprofitable work, while assuming one where there is none only
// skips a job at the margin. Add a market here once its published rate is confirmed.
export const VERIFIED_MARKET_FEES=Object.freeze({
  // Taskmarket's own rewards reference states a 7.5% platform fee (bonusBps default 750
  // "matching the platform fee").
  'taskmarket.dev':7.5
});

export const DEFAULT_UNKNOWN_FEE_PERCENT=15;

export function marketplaceFeePercent(source,env=process.env){
  const id=String(source||'').trim().toLowerCase();
  if(Object.prototype.hasOwnProperty.call(VERIFIED_MARKET_FEES,id))
    return{percent:VERIFIED_MARKET_FEES[id],verified:true,source:'published_rate'};
  const override=Number(env.AUTONOMOS_DEFAULT_MARKETPLACE_FEE_PERCENT);
  const percent=Number.isFinite(override)&&override>=0&&override<=100?override:DEFAULT_UNKNOWN_FEE_PERCENT;
  return{percent,verified:false,source:'protective_assumption'};
}

// Applied to an opportunity before its economics are judged. Never overwrites a fee the
// market itself reported: a real rate always beats our assumption.
export function withMarketplaceFee(opportunity,env=process.env){
  const existing=Number(opportunity?.feePercent);
  if(Number.isFinite(existing)&&existing>0)return opportunity;
  const fee=marketplaceFeePercent(opportunity?.source,env);
  return{...opportunity,feePercent:fee.percent,feePercentVerified:fee.verified,feePercentBasis:fee.source};
}

// The fee an accepted job will actually lose, for display and for the economics gate.
// The ledger must still record only fees observed on a real settlement.
export function estimatedFeeUsd(opportunity,env=process.env){
  const budget=Number(opportunity?.budgetUsd??opportunity?.payoutUsd??0);
  if(!Number.isFinite(budget)||budget<=0)return 0;
  const percent=Number.isFinite(Number(opportunity?.feePercent))&&Number(opportunity?.feePercent)>0
    ?Number(opportunity.feePercent)
    :marketplaceFeePercent(opportunity?.source,env).percent;
  return Math.round(budget*percent)/100;
}
