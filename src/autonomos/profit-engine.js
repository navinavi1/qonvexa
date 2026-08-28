export function evaluateOpportunity(input = {}, config = {}) {
  const revenue = finite(input.expectedRevenueUsd, 0);
  const probability = clamp(finite(input.successProbability, 1), 0, 1);
  const compute = finite(input.computeCostUsd, 0);
  const api = finite(input.apiCostUsd, 0);
  const marketplace = finite(input.marketplaceFeesUsd, 0);
  const network = finite(input.networkFeesUsd, 0);
  const failure = finite(input.failureReserveUsd, 0);
  const totalCost = compute + api + marketplace + network + failure;
  const expectedRevenue = revenue * probability;
  const expectedProfit = expectedRevenue - totalCost;
  const marginPercent = expectedRevenue > 0 ? (expectedProfit / expectedRevenue) * 100 : 0;
  const minMarginPercent = finite(config.minMarginPercent, 35);
  const zeroSpendMode = config.zeroSpendMode !== false;
  const hasSpend = totalCost > 0.000001;
  const allowed = expectedProfit > 0 && marginPercent >= minMarginPercent && (!zeroSpendMode || !hasSpend);

  return {
    expectedRevenueUsd: round(expectedRevenue),
    expectedCostUsd: round(totalCost),
    expectedProfitUsd: round(expectedProfit),
    marginPercent: round(marginPercent),
    allowed,
    reason: allowed
      ? 'positive_unit_economics'
      : zeroSpendMode && hasSpend
        ? 'blocked_by_zero_spend_mode'
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

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function round(value) { return Math.round((value + Number.EPSILON) * 1e6) / 1e6; }
