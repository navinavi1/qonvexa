export const DEFAULT_AUTONOMOS_CONFIG = Object.freeze({
  enabled: false,
  killSwitch: false,
  genesisObjective: 'Maximize sustainable net revenue by providing legitimate digital services to humans and autonomous agents.',
  zeroSpendMode: true,
  earnedFundsOnly: true,
  allowExternalSpending: false,
  minMarginPercent: 35,
  reservePercent: 85,
  growthPercent: 10,
  experimentPercent: 5,
  heartbeatSeconds: 60,
  maxChildren: 12,
  childSpawnConcurrencyThreshold: 3,
  childTtlMinutes: 180,
  maxPaidProcurementUsd: 0,
  maxApiCostPercentOfPayout: 25,
  maxJobsPerCycle: 2,
  autoClaimJobs: true,
  requireEscrowForAutoClaim: true,
  minJobPayoutUsd: 0.01,
  autoReplication: true,
  treasuryAsset: 'USDC',
  updatedAt: ''
});

export function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULT_AUTONOMOS_CONFIG, ...raw };
  cfg.enabled = Boolean(cfg.enabled);
  cfg.killSwitch = Boolean(cfg.killSwitch);
  cfg.zeroSpendMode = cfg.zeroSpendMode !== false;
  cfg.earnedFundsOnly = cfg.earnedFundsOnly !== false;
  cfg.allowExternalSpending = Boolean(cfg.allowExternalSpending) && !cfg.zeroSpendMode;
  cfg.minMarginPercent = clampNumber(cfg.minMarginPercent, 0, 95, 35);
  cfg.reservePercent = clampNumber(cfg.reservePercent, 0, 100, 85);
  cfg.growthPercent = clampNumber(cfg.growthPercent, 0, 100, 10);
  cfg.experimentPercent = clampNumber(cfg.experimentPercent, 0, 100, 5);
  const split = cfg.reservePercent + cfg.growthPercent + cfg.experimentPercent;
  if (split <= 0) {
    cfg.reservePercent = 85; cfg.growthPercent = 10; cfg.experimentPercent = 5;
  }
  cfg.heartbeatSeconds = Math.round(clampNumber(cfg.heartbeatSeconds, 30, 3600, 60));
  cfg.maxChildren = Math.round(clampNumber(cfg.maxChildren, 0, 100, 12));
  cfg.childSpawnConcurrencyThreshold = Math.round(clampNumber(cfg.childSpawnConcurrencyThreshold, 2, 50, 3));
  cfg.childTtlMinutes = Math.round(clampNumber(cfg.childTtlMinutes, 5, 1440, 180));
  cfg.maxPaidProcurementUsd = clampNumber(cfg.maxPaidProcurementUsd, 0, 100000, 0);
  cfg.maxApiCostPercentOfPayout = clampNumber(cfg.maxApiCostPercentOfPayout, 0, 80, 25);
  cfg.maxJobsPerCycle = Math.round(clampNumber(cfg.maxJobsPerCycle, 0, 20, 2));
  cfg.autoClaimJobs = cfg.autoClaimJobs !== false;
  cfg.requireEscrowForAutoClaim = cfg.requireEscrowForAutoClaim !== false;
  cfg.minJobPayoutUsd = clampNumber(cfg.minJobPayoutUsd, 0, 100000, 0.01);
  cfg.autoReplication = cfg.autoReplication !== false;
  cfg.genesisObjective = String(cfg.genesisObjective || DEFAULT_AUTONOMOS_CONFIG.genesisObjective).trim().slice(0, 1000);
  cfg.treasuryAsset = ['USDC','USDT','ETH','BTC','SOL'].includes(String(cfg.treasuryAsset).toUpperCase())
    ? String(cfg.treasuryAsset).toUpperCase() : 'USDC';
  cfg.updatedAt = new Date().toISOString();
  return cfg;
}

export function validateAction(action = {}, config = {}) {
  if (config.killSwitch) return { allowed:false, reason:'emergency_stop' };
  if (!config.enabled) return { allowed:false, reason:'runtime_stopped' };
  if (action.kind === 'spend') {
    const amount = Number(action.amountUsd || 0);
    if (config.zeroSpendMode || !config.allowExternalSpending) return { allowed:false, reason:'external_spending_disabled' };
    if (!Number.isFinite(amount) || amount <= 0) return { allowed:false, reason:'invalid_amount' };
    if (amount > Number(config.maxPaidProcurementUsd || 0)) return { allowed:false, reason:'above_spend_limit' };
  }
  if (action.kind === 'wallet_export' || action.kind === 'private_key_access') {
    return { allowed:false, reason:'secret_access_forbidden' };
  }
  return { allowed:true, reason:'policy_pass' };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
