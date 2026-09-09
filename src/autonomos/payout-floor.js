export const OWNER_MINIMUM_PAYOUT_USD=5;
export function minimumJobPayoutUsd(env=process.env,config={}){
  return Math.max(OWNER_MINIMUM_PAYOUT_USD,...[env.AUTONOMOS_MIN_JOB_PAYOUT_USD,env.AUTONOMOS_GLOBAL_MIN_JOB_PAYOUT_USD,config.minJobPayoutUsd].map(v=>Number.isFinite(Number(v))?Number(v):0));
}
