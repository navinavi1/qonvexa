export const DEFAULT_AUTONOMOS_CONFIG = Object.freeze({
  enabled: false,
  killSwitch: false,
  genesisObjective: 'Maximize sustainable net revenue by providing legitimate digital services to humans and autonomous agents.',
  // Live earning mode: permit bounded work spend from earned/seed budget. Emergency Stop and
  // explicit policy gates can still force zero spend at runtime.
  zeroSpendMode: false,
  earnedFundsOnly: true,
  seedSpendBudgetUsd: 3,
  allowExternalSpending: false,
  minMarginPercent: 35,
  reservePercent: 85,
  growthPercent: 10,
  experimentPercent: 5,
  heartbeatSeconds: 60,
  fastClaimPollSeconds: 15,
  maxChildren: 12,
  childSpawnConcurrencyThreshold: 3,
  childTtlMinutes: 180,
  maxPaidProcurementUsd: 3,
  maxApiCostPercentOfPayout: 25,
  maxJobsPerCycle: 6,
  maxConcurrentJobs: 4,
  platformGeneration: 5,
  autoClaimJobs: true,
  autoCompetitiveSubmissions: false,
  requireEscrowForAutoClaim: true,
  rejectDemoAndTestJobs: true,
  minJobPayoutUsd: 25,
  clawlancerMinJobPayoutUsd: 25,
  dealworkMinJobPayoutUsd: 25,
  superteamMinJobPayoutUsd: 25,
  t2000MinOpenJobPayoutUsd: 35,
  t2000PriorityOpenJobPayoutUsd: 65,
  t2000PremiumOpenJobPayoutUsd: 100,
  autoReplication: true,
  treasuryAsset: 'USDC',
  updatedAt: ''
});

export function normalizeConfig(raw = {}) {
  // Environment values are an explicit deployment override, but persisted config still wins
  // when the caller has intentionally set a value in the admin plane.
  const env=process.env;
  const envOverrides={};
  if(env.AUTONOMOS_ZERO_SPEND_MODE!==undefined) envOverrides.zeroSpendMode=/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_ZERO_SPEND_MODE));
  if(env.AUTONOMOS_EARNED_FUNDS_ONLY!==undefined) envOverrides.earnedFundsOnly=/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_EARNED_FUNDS_ONLY));
  if(env.AUTONOMOS_MAX_PAID_PROCUREMENT_USD!==undefined) envOverrides.maxPaidProcurementUsd=Number(env.AUTONOMOS_MAX_PAID_PROCUREMENT_USD);
  const mergedRaw={...envOverrides,...raw};
  const legacy = !Object.prototype.hasOwnProperty.call(mergedRaw, 'platformGeneration');
  const previousGeneration = Number(mergedRaw.platformGeneration || (legacy ? 0 : 3));
  const cfg = { ...DEFAULT_AUTONOMOS_CONFIG, ...mergedRaw };
  if (legacy && Number(raw.maxJobsPerCycle) === 2) cfg.maxJobsPerCycle = 6;
  // Generation 4 raises the legacy penny-job defaults while preserving any owner-customized floors.
  if (previousGeneration < 5) {
    if (raw.minJobPayoutUsd === undefined || [5,10].includes(Number(raw.minJobPayoutUsd))) cfg.minJobPayoutUsd = 25;
    if (raw.clawlancerMinJobPayoutUsd === undefined || Number(raw.clawlancerMinJobPayoutUsd) === 5) cfg.clawlancerMinJobPayoutUsd = 25;
    if (raw.dealworkMinJobPayoutUsd === undefined || Number(raw.dealworkMinJobPayoutUsd) === 10) cfg.dealworkMinJobPayoutUsd = 25;
  }
  cfg.platformGeneration = 5;
  cfg.enabled = Boolean(cfg.enabled);
  cfg.killSwitch = Boolean(cfg.killSwitch);
  cfg.zeroSpendMode = cfg.zeroSpendMode !== false;
  cfg.earnedFundsOnly = cfg.earnedFundsOnly !== false;
  cfg.seedSpendBudgetUsd = clampNumber(cfg.seedSpendBudgetUsd, 0, 50, 3);
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
  cfg.fastClaimPollSeconds = Math.round(clampNumber(cfg.fastClaimPollSeconds, 10, cfg.heartbeatSeconds, 15));
  cfg.maxChildren = Math.round(clampNumber(cfg.maxChildren, 0, 100, 12));
  cfg.childSpawnConcurrencyThreshold = Math.round(clampNumber(cfg.childSpawnConcurrencyThreshold, 2, 50, 3));
  cfg.childTtlMinutes = Math.round(clampNumber(cfg.childTtlMinutes, 5, 1440, 180));
  cfg.maxPaidProcurementUsd = clampNumber(cfg.maxPaidProcurementUsd, 0, 100000, 0);
  cfg.maxApiCostPercentOfPayout = clampNumber(cfg.maxApiCostPercentOfPayout, 0, 80, 25);
  cfg.maxJobsPerCycle = Math.round(clampNumber(cfg.maxJobsPerCycle, 1, 50, 6));
  cfg.maxConcurrentJobs = Math.round(clampNumber(cfg.maxConcurrentJobs, 1, 20, 4));
  cfg.autoClaimJobs = cfg.autoClaimJobs !== false;
  cfg.autoCompetitiveSubmissions = Boolean(cfg.autoCompetitiveSubmissions);
  cfg.rejectDemoAndTestJobs = cfg.rejectDemoAndTestJobs !== false;
  cfg.requireEscrowForAutoClaim = cfg.requireEscrowForAutoClaim !== false;
  cfg.minJobPayoutUsd = clampNumber(cfg.minJobPayoutUsd, 0, 100000, 25);
  cfg.clawlancerMinJobPayoutUsd = clampNumber(cfg.clawlancerMinJobPayoutUsd, cfg.minJobPayoutUsd, 100000, Math.max(25,cfg.minJobPayoutUsd));
  cfg.dealworkMinJobPayoutUsd = clampNumber(cfg.dealworkMinJobPayoutUsd, cfg.minJobPayoutUsd, 100000, Math.max(25,cfg.minJobPayoutUsd));
  cfg.superteamMinJobPayoutUsd = clampNumber(cfg.superteamMinJobPayoutUsd, cfg.minJobPayoutUsd, 100000, Math.max(25,cfg.minJobPayoutUsd));
  cfg.t2000MinOpenJobPayoutUsd = clampNumber(cfg.t2000MinOpenJobPayoutUsd, 0, 100000, 35);
  cfg.t2000PriorityOpenJobPayoutUsd = clampNumber(cfg.t2000PriorityOpenJobPayoutUsd, cfg.t2000MinOpenJobPayoutUsd, 100000, Math.max(65, cfg.t2000MinOpenJobPayoutUsd));
  cfg.t2000PremiumOpenJobPayoutUsd = clampNumber(cfg.t2000PremiumOpenJobPayoutUsd, cfg.t2000PriorityOpenJobPayoutUsd, 100000, Math.max(100, cfg.t2000PriorityOpenJobPayoutUsd));
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
    if (config.zeroSpendMode) return { allowed:false, reason:'zero_spend_mode' };
    // P0 fix: this used to require allowExternalSpending===true for ANY spend at all,
    // which contradicted the admin UI's own documented precedence text ("Earned-funds-only
    // (default) caps spend to money AutonomOS has actually already earned... Unrestricted
    // only applies once both of the above are off") — meaning earnedFundsOnly was always
    // supposed to be usable on its own, without also flipping the scarier "unrestricted
    // spending" toggle. That mismatch was the real reason a correctly-configured
    // Earned-funds-only setup still couldn't spend a cent on Firecrawl/E2B.
    if (!config.earnedFundsOnly && !config.allowExternalSpending) return { allowed:false, reason:'external_spending_disabled' };
    if (!Number.isFinite(amount) || amount <= 0) return { allowed:false, reason:'invalid_amount' };
    if (amount > Number(config.maxPaidProcurementUsd || 0)) return { allowed:false, reason:'above_spend_limit' };
  }
  if (action.kind === 'wallet_export' || action.kind === 'private_key_access') {
    return { allowed:false, reason:'secret_access_forbidden' };
  }
  return { allowed:true, reason:'policy_pass' };
}


export function isDemoOrTestOpportunity(op = {}) {
  const raw = op?.raw && typeof op.raw === 'object' ? op.raw : {};
  if ([raw.is_demo, raw.isDemo, raw.demo, raw.is_test, raw.isTest, raw.sandbox].some(v => v === true || String(v).toLowerCase() === 'true')) return true;
  const envMarker = String(op?.environment || op?.env || op?.networkType || op?.mode || raw.environment || raw.env || raw.network_type || raw.mode || '').toLowerCase();
  if (['demo','test','testing','sandbox','testnet','devnet'].includes(envMarker)) return true;
  const status = String(op?.status || raw.status || '').toLowerCase();
  if (['demo','test','testing','sandbox','sample'].includes(status)) return true;
  const tags = [...(Array.isArray(op?.tags) ? op.tags : []), ...(Array.isArray(raw.tags) ? raw.tags : [])].map(v=>String(v).toLowerCase().trim());
  if (tags.some(v=>['demo','test-job','test_listing','test-listing','sandbox','sample','example','testnet','devnet'].includes(v))) return true;
  const title = String(op?.title || raw.title || '').trim();
  return /^(?:\[(?:demo|test|sample|sandbox)\]|(?:demo|sample|sandbox)\s+(?:job|task|listing)\b|test\s+(?:job|listing)\b)/i.test(title);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
