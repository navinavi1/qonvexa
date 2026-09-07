import 'dotenv/config';
import { LeanInternetHunter } from '../src/autonomos/lean-internet-hunter.js';
import { RevenueGlobalWorkHunter } from '../src/autonomos/revenue-global-work-hunter.js';
import { ReliableGlobalLeadActioner } from '../src/autonomos/reliable-global-lead-actioner.js';
import { RevenueLeadActioner } from '../src/autonomos/revenue-lead-actioner.js';
import { GmailJobMonitor } from '../src/autonomos/gmail-job-monitor.js';
import { migrateGlobalActionerState } from '../src/autonomos/global-actioner-migrations.js';
import { TaskForceVerifier } from '../src/autonomos/taskforce-verifier.js';
import { TaskForceWorker } from '../src/autonomos/taskforce-worker.js';
import { applySourceQuarantine } from '../src/autonomos/source-quarantine.js';
import { GlobalFeedPublisher } from '../src/autonomos/global-feed-publisher.js';
import { probeRuntimeEmailChannel } from '../src/autonomos/email-channel-probe.js';
import { installNetworkGuard } from '../src/autonomos/network-guard.js';

// Build/verify runs must keep their isolated fixture config. Only the actual long-running
// service process enables persisted-runtime throughput overrides.
if (/^(1|true|yes|on)$/i.test(String(process.env.AUTONOMOS_PRODUCTION_SWARM_MODE||''))) {
  process.env.AUTONOMOS_RUNTIME_ENV_OVERRIDES='true';
}

// Must be installed before server.js imports the legacy connector runtime. Disabled/noisy
// sources therefore cannot consume network time even if an older connector still tries to poll.
installNetworkGuard({env:process.env,logger:console});
applySourceQuarantine({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
migrateGlobalActionerState({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});

const internetHunter=enabled(process.env.AUTONOMOS_INTERNET_HUNTER_ENABLED,'true')
  ? new LeanInternetHunter({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console}) : null;
const globalHunter=new RevenueGlobalWorkHunter({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
// Browser automation is optional only. If Browserbase is exhausted/unconfigured it is not
// instantiated at all and therefore cannot block the worldwide earning loop.
const browserActioner=enabled(process.env.AUTONOMOS_GLOBAL_ACTIONER_ENABLED,'false')
  ? new ReliableGlobalLeadActioner({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console}) : null;
const outboundEmailRequested=enabled(process.env.AUTONOMOS_BROWSERLESS_ACTIONER_ENABLED,'true');
let browserlessActioner=null;
let gmailJobMonitor=null;
let emailGateTimer=null;
let emailGateRunning=false;
const taskForceVerifier=new TaskForceVerifier({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const taskForceWorker=new TaskForceWorker({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const globalFeedPublisher=new GlobalFeedPublisher({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});

async function ensureRevenueEmailLane(){
  if(!outboundEmailRequested||browserlessActioner||emailGateRunning)return Boolean(browserlessActioner);
  emailGateRunning=true;
  try{
    const probe=await probeRuntimeEmailChannel({env:process.env,logger:console});
    if(!probe?.ready){
      try{console.info('[RevenueEmailGate] '+JSON.stringify({ready:false,reason:String(probe?.reason||'gmail_not_ready'),reconnectRequired:Boolean(probe?.reconnectRequired),reconnectAvailable:Boolean(probe?.reconnectAvailable)}));}catch{}
      return false;
    }
    browserlessActioner=new RevenueLeadActioner({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
    browserlessActioner.start();
    if(enabled(process.env.AUTONOMOS_GMAIL_JOB_MONITOR_ENABLED,'true')){
      gmailJobMonitor=new GmailJobMonitor({actioner:browserlessActioner,env:process.env,logger:console});
      gmailJobMonitor.start();
    }
    if(emailGateTimer){clearInterval(emailGateTimer);emailGateTimer=null;}
    try{console.info('[RevenueEmailGate] '+JSON.stringify({ready:true,started:true,reason:'gmail_send_authorized'}));}catch{}
    return true;
  }catch(error){
    try{console.error('[RevenueEmailGate] '+JSON.stringify({ready:false,error:String(error?.message||error).slice(0,180)}));}catch{}
    return false;
  }finally{emailGateRunning=false;}
}

internetHunter?.start();
globalHunter.start();
browserActioner?.start();
if(outboundEmailRequested){
  await ensureRevenueEmailLane();
  if(!browserlessActioner){
    const every=Math.max(30_000,Number(process.env.AUTONOMOS_EMAIL_REAUTH_POLL_MS||60_000));
    emailGateTimer=setInterval(()=>ensureRevenueEmailLane().catch(()=>{}),every);emailGateTimer.unref?.();
  }
}
taskForceVerifier.start();
if(enabled(process.env.AUTONOMOS_TASKFORCE_WORKER_ENABLED,'true'))taskForceWorker.start();
globalFeedPublisher.start();

const stop=()=>{
  internetHunter?.stop();globalHunter.stop();browserActioner?.stop();browserlessActioner?.stop();gmailJobMonitor?.stop();taskForceVerifier.stop();taskForceWorker.stop();globalFeedPublisher.stop();
  if(emailGateTimer)clearInterval(emailGateTimer);emailGateTimer=null;
};
process.on('SIGTERM',stop);
process.on('SIGINT',stop);

await import('../server.js');

function enabled(value,fallback='false'){return !/^(0|false|no|off)$/i.test(String(value??fallback));}
