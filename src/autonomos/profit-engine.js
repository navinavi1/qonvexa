export function evaluateOpportunity(input = {}, config = {}) {
  const revenue = finite(input.expectedRevenueUsd, 0);
  const probability = clamp(finite(input.successProbability, 1), 0, 1);
  const compute = finite(input.computeCostUsd, 0);
  const api = finite(input.apiCostUsd, 0);
  const model = finite(input.modelCostUsd, 0);
  const externalAgent = finite(input.externalAgentCostUsd, 0);
  const marketplace = finite(input.marketplaceFeesUsd ?? input.marketplaceFeeUsd, 0);
  const network = finite(input.networkFeesUsd, 0);
  const failure = finite(input.failureReserveUsd, 0);
  const baseOutOfPocket = compute + api + model + externalAgent + network;

  const survival=Boolean(config.survivalMode);
  const reserveByPayout=revenue*finite(config.completionReservePercentOfPayout,15)/100;
  const reserveByWork=baseOutOfPocket*finite(config.completionReserveMultiplier,0.5);
  const completionReserve=survival&&baseOutOfPocket>0 ? Math.min(reserveByPayout,Math.max(0.002,reserveByWork)) : 0;
  const reservedOutOfPocket=baseOutOfPocket+completionReserve;

  const totalCost = compute + api + model + externalAgent + marketplace + network + failure;
  const expectedRevenue = revenue * probability;
  const expectedProfit = expectedRevenue - totalCost;
  const marginPercent = expectedRevenue > 0 ? (expectedProfit / expectedRevenue) * 100 : 0;
  const minMarginPercent = finite(config.minMarginPercent, 20);
  const zeroSpendMode = config.zeroSpendMode !== false;
  const earnedFundsOnly = config.earnedFundsOnly !== false;
  const allowExternalSpending = Boolean(config.allowExternalSpending) && !zeroSpendMode;
  const availableSpendUsd = Math.max(0, finite(config.availableSpendUsd, 0));
  const hasExternalSpend = reservedOutOfPocket > 0.000001;
  const withinEarnedBudget = reservedOutOfPocket <= availableSpendUsd + 0.000001;
  const spendBlocked = zeroSpendMode
    ? hasExternalSpend
    : earnedFundsOnly
      ? (hasExternalSpend && !withinEarnedBudget)
      : (hasExternalSpend && !allowExternalSpending);
  const allowed = expectedProfit > 0 && marginPercent >= minMarginPercent && !spendBlocked;

  return {
    expectedRevenueUsd: round(expectedRevenue), expectedCostUsd: round(totalCost), estimatedExecutionSpendUsd: round(baseOutOfPocket),
    completionReserveUsd: round(completionReserve), outOfPocketCostUsd: round(reservedOutOfPocket), marketplaceFeesUsd: round(marketplace),
    expectedProfitUsd: round(expectedProfit), marginPercent: round(marginPercent), allowed,
    reason: allowed
      ? survival && completionReserve>0 ? 'positive_unit_economics_with_finish_reserve' : 'positive_unit_economics'
      : zeroSpendMode && hasExternalSpend ? 'blocked_by_zero_spend_mode'
      : earnedFundsOnly && hasExternalSpend && !withinEarnedBudget ? 'blocked_by_earned_funds_cap'
      : !earnedFundsOnly && hasExternalSpend && !allowExternalSpending ? 'blocked_by_external_spending_disabled'
      : expectedProfit <= 0 ? 'non_positive_profit' : 'margin_below_floor'
  };
}

export function allocateRevenue(amountUsd, config = {}) {
  const amount = Math.max(0, finite(amountUsd, 0));
  if(config.survivalMode!==false){
    let ownerPct=clamp(finite(config.ownerRevenuePercent,50),0,100);
    let treasuryPct=clamp(finite(config.agentTreasuryPercent,50),0,100);
    const split=ownerPct+treasuryPct;
    if(split<=0){ownerPct=50;treasuryPct=50;}else{ownerPct=100*ownerPct/split;treasuryPct=100-ownerPct;}
    const ownerUsd=round(amount*ownerPct/100);
    const treasuryUsd=round(Math.max(0,amount-ownerUsd));
    const growthUsd=round(treasuryUsd*0.70);
    const experimentUsd=round(Math.max(0,treasuryUsd-growthUsd));
    return {ownerUsd,treasuryUsd,reserveUsd:ownerUsd,growthUsd,experimentUsd,ownerPercent:round(ownerPct),treasuryPercent:round(treasuryPct),mode:'survival_50_50'};
  }
  const reservePct = finite(config.reservePercent, 85);
  const growthPct = finite(config.growthPercent, 10);
  const experimentPct = finite(config.experimentPercent, 5);
  const total = reservePct + growthPct + experimentPct || 100;
  const reserveUsd=round(amount*reservePct/total),growthUsd=round(amount*growthPct/total),experimentUsd=round(Math.max(0,amount-reserveUsd-growthUsd));
  return {ownerUsd:reserveUsd,treasuryUsd:round(growthUsd+experimentUsd),reserveUsd,growthUsd,experimentUsd,mode:'legacy_allocation'};
}

// The agents' working float. Without this being fundable the system deadlocks on a cold
// start: the pool is the one-time seedSpendBudgetUsd, every attempt (successful or not)
// appends a cost row, and once the pool reaches zero no job can execute — but a job has to
// execute to earn the revenue that would refill it. Revenue still only ever contributes the
// agent half; the owner's half is never spendable here.
//
// 'owner_funding' rows are the way out that invents no money: the owner records working
// capital they actually provided (the API subscriptions the agents draw on), it counts in
// full rather than being split 50/50, and it stays auditable in ledger.ndjson like every
// other movement.
export function computeEarnedSpendBudgetUsd(ledger = [], config = {}) {
  let earnedPool = Math.max(0, finite(config.seedSpendBudgetUsd, 0));
  let spent = 0;
  for (const row of ledger) {
    if (row.type === 'revenue' && !row.testnet) {
      const allocation = row.allocation || allocateRevenue(Number(row.amountUsd || 0), config);
      earnedPool += Number(allocation.treasuryUsd ?? (Number(allocation.growthUsd||0)+Number(allocation.experimentUsd||0)));
    } else if (row.type === 'owner_funding' && !row.testnet) {
      // finite() rather than Number(): a malformed amount would otherwise turn the whole
      // pool into NaN, and every downstream `treasury > 0` gate silently reads false.
      earnedPool += Math.max(0, finite(row.amountUsd, 0));
    } else if (row.type === 'cost') spent += Math.max(0, finite(row.amountUsd, 0));
  }
  return round(Math.max(0, earnedPool - spent));
}

function finite(value, fallback) { const number=Number(value); return Number.isFinite(number)?number:fallback; }
function clamp(value,min,max){return Math.min(max,Math.max(min,value));}
function round(value){return Math.round((value+Number.EPSILON)*1e6)/1e6;}
