import fs from 'node:fs';
import path from 'node:path';
import { resourceRoot, resourceSnapshot } from './resource-control.js';
import { refreshCapabilities } from './capability-registry.js';
import { startResourceRecovery } from './free-tool-recovery.js';
import { minimumJobPayoutUsd } from './payout-floor.js';

export async function startUnifiedCapabilities(env=process.env,logger=console){
  const stopRecovery=startResourceRecovery(env,logger);
  const refresh=async()=>{try{const context=await refreshCapabilities(env);logger.info?.('[UnifiedCapabilities] '+JSON.stringify({context,resources:resourceSnapshot(env),minimumJobPayoutUsd:minimumJobPayoutUsd(env)}));}catch(error){logger.warn?.('[UnifiedCapabilities] '+String(error.message));}};
  await refresh();const timer=setInterval(refresh,5*60_000);timer.unref?.();
  return()=>{clearInterval(timer);stopRecovery();};
}

// One explicit owner-authorized launch migration. Subsequent stops/kill switches
// remain persistent and are never cleared by later restarts of this release.
export function migrateUnifiedRelease(env=process.env){
  if(!/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_ENABLED||'')))return;
  const root=resourceRoot(env);fs.mkdirSync(root,{recursive:true});const marker=path.join(root,'unified-resource-release-v1.json');if(fs.existsSync(marker))return;
  const file=path.join(root,'config.json');let config={};try{config=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  const floor=minimumJobPayoutUsd(env,config);
  const next={...config,enabled:true,killSwitch:false,zeroSpendMode:false,survivalMode:true,ownerRevenuePercent:50,agentTreasuryPercent:50,noAbandonAcceptedJobs:true,emergencyFinishMode:true,skillAcquisitionMode:true,minJobPayoutUsd:floor,clawlancerMinJobPayoutUsd:Math.max(floor,Number(config.clawlancerMinJobPayoutUsd||0)),dealworkMinJobPayoutUsd:Math.max(floor,Number(config.dealworkMinJobPayoutUsd||0)),commissioningMinPayoutUsd:floor,updatedAt:new Date().toISOString()};
  const tmp=file+'.unified.tmp';fs.writeFileSync(tmp,JSON.stringify(next,null,2),{mode:0o600});fs.renameSync(tmp,file);fs.writeFileSync(marker,JSON.stringify({at:new Date().toISOString(),minimumJobPayoutUsd:floor,ownerAuthorizedStart:true}),{mode:0o600});
}
