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
  const totalCost = compute + api + model + externalAgent + marketplace + network + failure;
  const outOfPocketCost = compute + api + model + externalAgent + network;
  const expectedRevenue = revenue * probability;
  const expectedProfit = expectedRevenue - totalCost;
  const marginPercent = expectedRevenue > 0 ? (expectedProfit / expectedRevenue) * 100 : 0;
  const minMarginPercent = finite(config.minMarginPercent, 35);
  const zeroSpendMode = config.zeroSpendMode !== false;
  const earnedFundsOnly = config.earnedFundsOnly !== false;
  const availableSpendUsd = Math.max(0, finite(config.availableSpendUsd, 0));
  const hasExternalSpend = outOfPocketCost > 0.000001;
  const withinEarnedBudget = outOfPocketCost <= availableSpendUsd + 0.000001;
  const spendBlocked = zeroSpendMode
    ? hasExternalSpend
    : (earnedFundsOnly && hasExternalSpend && !withinEarnedBudget);
  const allowed = expectedProfit > 0 && marginPercent >= minMarginPercent && !spendBlocked;

  return {
    expectedRevenueUsd: round(expectedRevenue),
    expectedCostUsd: round(totalCost),
    outOfPocketCostUsd: round(outOfPocketCost),
    marketplaceFeesUsd: round(marketplace),
    expectedProfitUsd: round(expectedProfit),
    marginPercent: round(marginPercent),
    allowed,
    reason: allowed
      ? 'positive_unit_economics'
      : zeroSpendMode && hasExternalSpend
        ? 'blocked_by_zero_spend_mode'
        : earnedFundsOnly && hasExternalSpend && !withinEarnedBudget
          ? 'blocked_by_earned_funds_cap'
          : expectedProfit <= 0
            ? 'non_positive_profit'
            : 'margin_below_floor'
  };
}

export function allocateRevenue(amountUsd, config = {}) {
  const amount = Math.max(0, finite(amountUsd, 0));
  const reservePct = finite(config.reservePercent, 85);
  const growthPct = finite(config.growthPercent, 10);
  const experimentPct = finite(config.experimentPercent, 5);
  const total = reservePct + growthPct + experimentPct || 100;
  return {
    reserveUsd: round(amount * reservePct / total),
    growthUsd: round(amount * growthPct / total),
    experimentUsd: round(amount * experimentPct / total)
  };
}
function finite(value, fallback) { const number=Number(value); return Number.isFinite(number)?number:fallback; }
function clamp(value,min,max){return Math.min(max,Math.max(min,value));}
function round(value){return Math.round((value+Number.EPSILON)*1e6)/1e6;}

// The growth+experiment share of settled revenue is the pool earned-funds-only spending
// draws from (the reserve share is never touched by API/model spend). Cost ledger entries
// are subtracted so the same earned dollar can't fund two jobs.
export function computeEarnedSpendBudgetUsd(ledger = [], config = {}) {
  let earnedPool = 0;
  let spent = 0;
  for (const row of ledger) {
    if (row.type === 'revenue' && !row.testnet) {
      const allocation = row.allocation || allocateRevenue(Number(row.amountUsd || 0), config);
      earnedPool += Number(allocation.growthUsd || 0) + Number(allocation.experimentUsd || 0);
    } else if (row.type === 'cost') {
      spent += Number(row.amountUsd || 0);
    }
  }
  return round(Math.max(0, earnedPool - spent));
}
