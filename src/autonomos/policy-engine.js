export const DEFAULT_AUTONOMOS_CONFIG = Object.freeze({
  enabled: false, killSwitch: false,
  genesisObjective:'Maximize sustainable net revenue by completing legitimate digital work, preserving owner capital, and reinvesting a bounded agent treasury.',
  survivalMode:true, ownerRevenuePercent:50, agentTreasuryPercent:50,
  completionReservePercentOfPayout:15, completionReserveMultiplier:0.5,
  noAbandonAcceptedJobs:true, emergencyFinishMode:true, skillAcquisitionMode:true,
  zeroSpendMode:false, earnedFundsOnly:true, seedSpendBudgetUsd:3, allowExternalSpending:false,
  minMarginPercent:20, reservePercent:50, growthPercent:35, experimentPercent:15,
  heartbeatSeconds:60, fastClaimPollSeconds:15,
  maxChildren:50, childSpawnConcurrencyThreshold:3, childTtlMinutes:180,
  maxPaidProcurementUsd:3, maxApiCostPercentOfPayout:60,
  maxJobsPerCycle:10, maxConcurrentJobs:6,
  platformGeneration:8, earningProfileVersion:16,
  autoClaimJobs:true, autoCompetitiveSubmissions:false,
  commissioningMode:true, commissioningMinPayoutUsd:0.5, cryptoOnlyEarnings:true,
  requireEscrowForAutoClaim:true, rejectDemoAndTestJobs:true,
  minJobPayoutUsd:0.5, clawlancerMinJobPayoutUsd:0.5, dealworkMinJobPayoutUsd:0.5, superteamMinJobPayoutUsd:0.5,
  t2000MinOpenJobPayoutUsd:0.5, t2000PriorityOpenJobPayoutUsd:25, t2000PremiumOpenJobPayoutUsd:50,
  autoReplication:true, treasuryAsset:'USDC', updatedAt:''
});

export function normalizeConfig(raw={}){
  const env=process.env,envOverrides={};
  if(env.AUTONOMOS_ZERO_SPEND_MODE!==undefined)envOverrides.zeroSpendMode=/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_ZERO_SPEND_MODE));
  if(env.AUTONOMOS_EARNED_FUNDS_ONLY!==undefined)envOverrides.earnedFundsOnly=/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_EARNED_FUNDS_ONLY));
  if(env.AUTONOMOS_MAX_PAID_PROCUREMENT_USD!==undefined)envOverrides.maxPaidProcurementUsd=Number(env.AUTONOMOS_MAX_PAID_PROCUREMENT_USD);
  if(env.AUTONOMOS_SURVIVAL_MODE!==undefined)envOverrides.survivalMode=/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_SURVIVAL_MODE));
  if(env.AUTONOMOS_OWNER_REVENUE_PERCENT!==undefined)envOverrides.ownerRevenuePercent=Number(env.AUTONOMOS_OWNER_REVENUE_PERCENT);
  if(env.AUTONOMOS_AGENT_TREASURY_PERCENT!==undefined)envOverrides.agentTreasuryPercent=Number(env.AUTONOMOS_AGENT_TREASURY_PERCENT);
  if(env.AUTONOMOS_COMPLETION_RESERVE_PERCENT!==undefined)envOverrides.completionReservePercentOfPayout=Number(env.AUTONOMOS_COMPLETION_RESERVE_PERCENT);
  if(env.AUTONOMOS_NO_ABANDON_ACCEPTED_JOBS!==undefined)envOverrides.noAbandonAcceptedJobs=/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_NO_ABANDON_ACCEPTED_JOBS));
  if(env.AUTONOMOS_EMERGENCY_FINISH_MODE!==undefined)envOverrides.emergencyFinishMode=/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_EMERGENCY_FINISH_MODE));
  if(env.AUTONOMOS_SKILL_ACQUISITION_MODE!==undefined)envOverrides.skillAcquisitionMode=/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_SKILL_ACQUISITION_MODE));
  const mergedRaw={...envOverrides,...raw};
  const legacy=!Object.prototype.hasOwnProperty.call(mergedRaw,'platformGeneration');
  const previousGeneration=Number(mergedRaw.platformGeneration||(legacy?0:3));
  const previousProfile=Number(mergedRaw.earningProfileVersion||15);
  const cfg={...DEFAULT_AUTONOMOS_CONFIG,...mergedRaw};

  if(env.AUTONOMOS_MAX_PAID_PROCUREMENT_USD!==undefined&&Number(raw.maxPaidProcurementUsd)===0.3){
    const deployed=Number(env.AUTONOMOS_MAX_PAID_PROCUREMENT_USD);
    if(Number.isFinite(deployed)&&deployed>=0)cfg.maxPaidProcurementUsd=deployed;
  }

  if(legacy&&Number(raw.maxJobsPerCycle)===2)cfg.maxJobsPerCycle=6;
  if(previousGeneration<6){
    if(raw.minJobPayoutUsd===undefined||Number(raw.minJobPayoutUsd)===25)cfg.minJobPayoutUsd=10;
    if(raw.clawlancerMinJobPayoutUsd===undefined||Number(raw.clawlancerMinJobPayoutUsd)===25)cfg.clawlancerMinJobPayoutUsd=10;
    if(raw.dealworkMinJobPayoutUsd===undefined||Number(raw.dealworkMinJobPayoutUsd)===25)cfg.dealworkMinJobPayoutUsd=10;
    if(raw.superteamMinJobPayoutUsd===undefined||Number(raw.superteamMinJobPayoutUsd)===25)cfg.superteamMinJobPayoutUsd=10;
    if(raw.t2000MinOpenJobPayoutUsd===undefined||Number(raw.t2000MinOpenJobPayoutUsd)===35)cfg.t2000MinOpenJobPayoutUsd=10;
    if(raw.t2000PriorityOpenJobPayoutUsd===undefined||Number(raw.t2000PriorityOpenJobPayoutUsd)===65)cfg.t2000PriorityOpenJobPayoutUsd=25;
    if(raw.t2000PremiumOpenJobPayoutUsd===undefined||Number(raw.t2000PremiumOpenJobPayoutUsd)===100)cfg.t2000PremiumOpenJobPayoutUsd=50;
    if(raw.minMarginPercent===undefined||Number(raw.minMarginPercent)===35)cfg.minMarginPercent=20;
    if(Number(raw.maxApiCostPercentOfPayout)===25)cfg.maxApiCostPercentOfPayout=35;
    if(raw.maxChildren===undefined)cfg.maxChildren=20;
  }
  if(previousGeneration<7){if(raw.commissioningMode===undefined)cfg.commissioningMode=true;if(raw.commissioningMinPayoutUsd===undefined)cfg.commissioningMinPayoutUsd=0.5;if(raw.cryptoOnlyEarnings===undefined)cfg.cryptoOnlyEarnings=true;}
  if(previousGeneration<8){
    if(raw.minJobPayoutUsd===undefined||Number(cfg.minJobPayoutUsd)===10)cfg.minJobPayoutUsd=0.5;
    if(raw.clawlancerMinJobPayoutUsd===undefined||Number(cfg.clawlancerMinJobPayoutUsd)===10)cfg.clawlancerMinJobPayoutUsd=0.5;
    if(raw.dealworkMinJobPayoutUsd===undefined||Number(cfg.dealworkMinJobPayoutUsd)===10)cfg.dealworkMinJobPayoutUsd=0.5;
    if(raw.superteamMinJobPayoutUsd===undefined||Number(cfg.superteamMinJobPayoutUsd)===10)cfg.superteamMinJobPayoutUsd=0.5;
    if(raw.t2000MinOpenJobPayoutUsd===undefined||Number(cfg.t2000MinOpenJobPayoutUsd)===10)cfg.t2000MinOpenJobPayoutUsd=0.5;
  }

  if(previousProfile<16&&previousGeneration>=8){
    if(raw.maxChildren===undefined||Number(raw.maxChildren)===20)cfg.maxChildren=50;
    if(raw.maxConcurrentJobs===undefined||Number(raw.maxConcurrentJobs)===4)cfg.maxConcurrentJobs=6;
    if(raw.maxJobsPerCycle===undefined||Number(raw.maxJobsPerCycle)===6)cfg.maxJobsPerCycle=10;
    if(raw.maxApiCostPercentOfPayout===undefined||Number(raw.maxApiCostPercentOfPayout)===35)cfg.maxApiCostPercentOfPayout=60;
    if(raw.maxPaidProcurementUsd===undefined||Number(raw.maxPaidProcurementUsd)===3)cfg.maxPaidProcurementUsd=10;
  }

  // Production swarm can scale elastically without leaking those limits into unit tests.
  // These are high technical ceilings, not targets: runtime still scales only to real queue,
  // available treasury and actual process capacity.
  const runtimeEnvOverridesEnabled=/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_RUNTIME_ENV_OVERRIDES||''))&&Boolean(String(raw.updatedAt||'').trim());
  if(runtimeEnvOverridesEnabled){
    if(env.AUTONOMOS_COMMISSIONING_MODE!==undefined)cfg.commissioningMode=/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_COMMISSIONING_MODE));
    if(env.AUTONOMOS_AUTO_COMPETITIVE_SUBMISSIONS!==undefined)cfg.autoCompetitiveSubmissions=/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_AUTO_COMPETITIVE_SUBMISSIONS));
    if(env.AUTONOMOS_MAX_CHILDREN!==undefined)cfg.maxChildren=Number(env.AUTONOMOS_MAX_CHILDREN);
    if(env.AUTONOMOS_MAX_CONCURRENT_JOBS!==undefined)cfg.maxConcurrentJobs=Number(env.AUTONOMOS_MAX_CONCURRENT_JOBS);
    if(env.AUTONOMOS_MAX_JOBS_PER_CYCLE!==undefined)cfg.maxJobsPerCycle=Number(env.AUTONOMOS_MAX_JOBS_PER_CYCLE);
    if(env.AUTONOMOS_HEARTBEAT_SECONDS!==undefined)cfg.heartbeatSeconds=Number(env.AUTONOMOS_HEARTBEAT_SECONDS);
    if(env.AUTONOMOS_FAST_CLAIM_POLL_SECONDS!==undefined)cfg.fastClaimPollSeconds=Number(env.AUTONOMOS_FAST_CLAIM_POLL_SECONDS);
  }

  cfg.platformGeneration=8;cfg.earningProfileVersion=16;
  cfg.enabled=Boolean(cfg.enabled);cfg.killSwitch=Boolean(cfg.killSwitch);
  cfg.survivalMode=cfg.survivalMode!==false;cfg.noAbandonAcceptedJobs=cfg.noAbandonAcceptedJobs!==false;cfg.emergencyFinishMode=cfg.emergencyFinishMode!==false;cfg.skillAcquisitionMode=cfg.skillAcquisitionMode!==false;
  cfg.zeroSpendMode=cfg.zeroSpendMode!==false;cfg.earnedFundsOnly=cfg.earnedFundsOnly!==false;cfg.seedSpendBudgetUsd=clampNumber(cfg.seedSpendBudgetUsd,0,50,3);cfg.allowExternalSpending=Boolean(cfg.allowExternalSpending)&&!cfg.zeroSpendMode;cfg.minMarginPercent=clampNumber(cfg.minMarginPercent,0,95,20);
  cfg.ownerRevenuePercent=clampNumber(cfg.ownerRevenuePercent,0,100,50);cfg.agentTreasuryPercent=clampNumber(cfg.agentTreasuryPercent,0,100,50);let split=cfg.ownerRevenuePercent+cfg.agentTreasuryPercent;if(split<=0){cfg.ownerRevenuePercent=50;cfg.agentTreasuryPercent=50;}else if(Math.abs(split-100)>0.0001){cfg.ownerRevenuePercent=100*cfg.ownerRevenuePercent/split;cfg.agentTreasuryPercent=100-cfg.ownerRevenuePercent;}
  cfg.completionReservePercentOfPayout=clampNumber(cfg.completionReservePercentOfPayout,0,50,15);cfg.completionReserveMultiplier=clampNumber(cfg.completionReserveMultiplier,0,3,0.5);
  if(cfg.survivalMode){cfg.reservePercent=cfg.ownerRevenuePercent;cfg.growthPercent=cfg.agentTreasuryPercent*0.70;cfg.experimentPercent=cfg.agentTreasuryPercent*0.30;}else{cfg.reservePercent=clampNumber(cfg.reservePercent,0,100,85);cfg.growthPercent=clampNumber(cfg.growthPercent,0,100,10);cfg.experimentPercent=clampNumber(cfg.experimentPercent,0,100,5);}
  const maxChildrenCap=runtimeEnvOverridesEnabled?10000:100;
  const maxJobsPerCycleCap=runtimeEnvOverridesEnabled?1000:50;
  const maxConcurrentJobsCap=runtimeEnvOverridesEnabled?500:20;
  cfg.heartbeatSeconds=Math.round(clampNumber(cfg.heartbeatSeconds,20,3600,60));cfg.fastClaimPollSeconds=Math.round(clampNumber(cfg.fastClaimPollSeconds,5,cfg.heartbeatSeconds,15));cfg.maxChildren=Math.round(clampNumber(cfg.maxChildren,1,maxChildrenCap,50));cfg.childSpawnConcurrencyThreshold=Math.round(clampNumber(cfg.childSpawnConcurrencyThreshold,2,500,3));cfg.childTtlMinutes=Math.round(clampNumber(cfg.childTtlMinutes,5,1440,180));cfg.maxPaidProcurementUsd=clampNumber(cfg.maxPaidProcurementUsd,0,100000,3);cfg.maxApiCostPercentOfPayout=clampNumber(cfg.maxApiCostPercentOfPayout,0,80,60);cfg.maxJobsPerCycle=Math.round(clampNumber(cfg.maxJobsPerCycle,1,maxJobsPerCycleCap,10));cfg.maxConcurrentJobs=Math.round(clampNumber(cfg.maxConcurrentJobs,1,maxConcurrentJobsCap,6));
  cfg.autoClaimJobs=cfg.autoClaimJobs!==false;cfg.autoCompetitiveSubmissions=Boolean(cfg.autoCompetitiveSubmissions);cfg.commissioningMode=cfg.commissioningMode!==false;cfg.commissioningMinPayoutUsd=clampNumber(cfg.commissioningMinPayoutUsd,0.01,10,0.5);cfg.cryptoOnlyEarnings=cfg.cryptoOnlyEarnings!==false;cfg.rejectDemoAndTestJobs=cfg.rejectDemoAndTestJobs!==false;cfg.requireEscrowForAutoClaim=cfg.requireEscrowForAutoClaim!==false;
  cfg.minJobPayoutUsd=clampNumber(cfg.minJobPayoutUsd,0,100000,0.5);cfg.clawlancerMinJobPayoutUsd=clampNumber(cfg.clawlancerMinJobPayoutUsd,cfg.minJobPayoutUsd,100000,Math.max(.5,cfg.minJobPayoutUsd));cfg.dealworkMinJobPayoutUsd=clampNumber(cfg.dealworkMinJobPayoutUsd,cfg.minJobPayoutUsd,100000,Math.max(.5,cfg.minJobPayoutUsd));cfg.superteamMinJobPayoutUsd=clampNumber(cfg.superteamMinJobPayoutUsd,cfg.minJobPayoutUsd,100000,Math.max(.5,cfg.minJobPayoutUsd));cfg.t2000MinOpenJobPayoutUsd=clampNumber(cfg.t2000MinOpenJobPayoutUsd,0,100000,.5);cfg.t2000PriorityOpenJobPayoutUsd=clampNumber(cfg.t2000PriorityOpenJobPayoutUsd,cfg.t2000MinOpenJobPayoutUsd,100000,Math.max(25,cfg.t2000MinOpenJobPayoutUsd));cfg.t2000PremiumOpenJobPayoutUsd=clampNumber(cfg.t2000PremiumOpenJobPayoutUsd,cfg.t2000PriorityOpenJobPayoutUsd,100000,Math.max(50,cfg.t2000PriorityOpenJobPayoutUsd));
  cfg.autoReplication=cfg.autoReplication!==false;cfg.genesisObjective=String(cfg.genesisObjective||DEFAULT_AUTONOMOS_CONFIG.genesisObjective).trim().slice(0,1000);cfg.treasuryAsset=['USDC','USDT','ETH','BTC','SOL'].includes(String(cfg.treasuryAsset).toUpperCase())?String(cfg.treasuryAsset).toUpperCase():'USDC';cfg.updatedAt=new Date().toISOString();return cfg;
}

export function validateAction(action={},config={}){if(config.killSwitch)return{allowed:false,reason:'emergency_stop'};if(!config.enabled)return{allowed:false,reason:'runtime_stopped'};if(action.kind==='spend'){const amount=Number(action.amountUsd||0);if(config.zeroSpendMode)return{allowed:false,reason:'zero_spend_mode'};if(!config.earnedFundsOnly&&!config.allowExternalSpending)return{allowed:false,reason:'external_spending_disabled'};if(!Number.isFinite(amount)||amount<=0)return{allowed:false,reason:'invalid_amount'};if(amount>Number(config.maxPaidProcurementUsd||0))return{allowed:false,reason:'above_spend_limit'};}if(action.kind==='wallet_export'||action.kind==='private_key_access')return{allowed:false,reason:'secret_access_forbidden'};return{allowed:true,reason:'policy_pass'};}
export function isDemoOrTestOpportunity(op={}){const raw=op?.raw&&typeof op.raw==='object'?op.raw:{};if([raw.is_demo,raw.isDemo,raw.demo,raw.is_test,raw.isTest,raw.sandbox].some(v=>v===true||String(v).toLowerCase()==='true'))return true;const envMarker=String(op?.environment||op?.env||op?.networkType||op?.mode||raw.environment||raw.env||raw.network_type||raw.mode||'').toLowerCase();if(['demo','test','testing','sandbox','testnet','devnet'].includes(envMarker))return true;const status=String(op?.status||raw.status||'').toLowerCase();if(['demo','test','testing','sandbox','sample'].includes(status))return true;const tags=[...(Array.isArray(op?.tags)?op.tags:[]),...(Array.isArray(raw.tags)?raw.tags:[])].map(v=>String(v).toLowerCase().trim());if(tags.some(v=>['demo','test-job','test_listing','test-listing','sandbox','sample','example','testnet','devnet'].includes(v)))return true;const title=String(op?.title||raw.title||'').trim();return /^(?:\[(?:demo|test|sample|sandbox)\]|(?:demo|sample|sandbox)\s+(?:job|task|listing)\b|test\s+(?:job|listing)\b)/i.test(title);}
function clampNumber(value,min,max,fallback){const number=Number(value);return Number.isFinite(number)?Math.min(max,Math.max(min,number)):fallback;}