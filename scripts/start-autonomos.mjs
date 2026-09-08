import 'dotenv/config';
import '../src/autonomos/taskforce-live-recovery-patch.js';
import '../src/autonomos/revenue-lifecycle-hardening-patch.js';
import { cleanLegacyAutonomOSState } from '../src/autonomos/legacy-state-cleaner.js';
import { LeanInternetHunter } from '../src/autonomos/lean-internet-hunter.js';
import { ProfitFirstGlobalWorkHunter } from '../src/autonomos/profit-first-global-work-hunter.js';
import { FreeAgrentingLiveWorker } from '../src/autonomos/free-agrenting-live-worker.js';
import { FreeMarketScout } from '../src/autonomos/free-market-scout.js';
import { MarketExpansionEngine } from '../src/autonomos/market-expansion-engine.js';
import { SkillLibraryWorker } from '../src/autonomos/skill-library-worker.js';
import { AdaptiveSkillAcquirer } from '../src/autonomos/adaptive-skill-acquirer.js';
import { DailyMoneyReporter } from '../src/autonomos/daily-money-reporter.js';
import { FiatCryptoRoutePlanner } from '../src/autonomos/fiat-crypto-route-planner.js';
import { ReliableGlobalLeadActioner } from '../src/autonomos/reliable-global-lead-actioner.js';
import { FreeRevenueLeadActioner } from '../src/autonomos/free-revenue-lead-actioner.js';
import { GmailJobMonitor } from '../src/autonomos/gmail-job-monitor.js';
import { migrateGlobalActionerState } from '../src/autonomos/global-actioner-migrations.js';
import { TaskForceVerifier } from '../src/autonomos/taskforce-verifier.js';
import { TaskForceWorker } from '../src/autonomos/taskforce-worker.js';
import { GlobalFeedPublisher } from '../src/autonomos/global-feed-publisher.js';
import { probeRuntimeEmailChannel } from '../src/autonomos/email-channel-probe.js';

if (/^(1|true|yes|on)$/i.test(String(process.env.AUTONOMOS_PRODUCTION_SWARM_MODE||''))) process.env.AUTONOMOS_RUNTIME_ENV_OVERRIDES='true';

cleanLegacyAutonomOSState({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
migrateGlobalActionerState({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});

const internetHunter=enabled(process.env.AUTONOMOS_INTERNET_HUNTER_ENABLED,'true')?new LeanInternetHunter({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console}):null;
const globalHunter=new ProfitFirstGlobalWorkHunter({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const agrentingWorker=enabled(process.env.AUTONOMOS_AGRENTING_ENABLED,'true')?new FreeAgrentingLiveWorker({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console}):null;
const marketScout=enabled(process.env.AUTONOMOS_FREE_MARKET_SCOUT_ENABLED,'true')?new FreeMarketScout({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console}):null;
const marketExpansion=enabled(process.env.AUTONOMOS_MARKET_EXPANSION_ENABLED,'true')?new MarketExpansionEngine({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console}):null;
const skillLibrary=new SkillLibraryWorker({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const skillAcquirer=enabled(process.env.AUTONOMOS_SKILL_ACQUISITION_MODE,'true')?new AdaptiveSkillAcquirer({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console}):null;
const moneyReporter=new DailyMoneyReporter({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const fiatRoutePlanner=new FiatCryptoRoutePlanner({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const browserActioner=enabled(process.env.AUTONOMOS_GLOBAL_ACTIONER_ENABLED,'false')?new ReliableGlobalLeadActioner({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console}):null;
const outboundEmailRequested=enabled(process.env.AUTONOMOS_BROWSERLESS_ACTIONER_ENABLED,'true');
let browserlessActioner=null,gmailJobMonitor=null,emailGateTimer=null,emailGateRunning=false;
const taskForceVerifier=new TaskForceVerifier({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const taskForceWorker=new TaskForceWorker({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const globalFeedPublisher=new GlobalFeedPublisher({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});

async function ensureRevenueEmailLane(){
  if(!outboundEmailRequested||browserlessActioner||emailGateRunning)return Boolean(browserlessActioner);emailGateRunning=true;
  try{const probe=await probeRuntimeEmailChannel({env:process.env,logger:console});if(!probe?.ready){console.info('[RevenueEmailGate] '+JSON.stringify({ready:false,reason:String(probe?.reason||'gmail_not_ready')}));return false;}
    browserlessActioner=new FreeRevenueLeadActioner({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});browserlessActioner.start();
    if(enabled(process.env.AUTONOMOS_GMAIL_JOB_MONITOR_ENABLED,'true')){gmailJobMonitor=new GmailJobMonitor({actioner:browserlessActioner,env:process.env,logger:console});gmailJobMonitor.start();}
    if(emailGateTimer){clearInterval(emailGateTimer);emailGateTimer=null;}console.info('[RevenueEmailGate] '+JSON.stringify({ready:true,started:true,reason:'gmail_send_authorized',capabilityMode:'free-first'}));return true;
  }catch(error){console.error('[RevenueEmailGate] '+JSON.stringify({ready:false,error:String(error?.message||error).slice(0,180)}));return false;}finally{emailGateRunning=false;}
}

internetHunter?.start();globalHunter.start();agrentingWorker?.start();marketScout?.start();marketExpansion?.start();skillLibrary.start();skillAcquirer?.start();moneyReporter.start();fiatRoutePlanner.start();browserActioner?.start();
if(outboundEmailRequested){await ensureRevenueEmailLane();if(!browserlessActioner){const every=Math.max(30_000,Number(process.env.AUTONOMOS_EMAIL_REAUTH_POLL_MS||60_000));emailGateTimer=setInterval(()=>ensureRevenueEmailLane().catch(()=>{}),every);emailGateTimer.unref?.();}}
taskForceVerifier.start();if(enabled(process.env.AUTONOMOS_TASKFORCE_WORKER_ENABLED,'true'))taskForceWorker.start();globalFeedPublisher.start();

const stop=()=>{internetHunter?.stop();globalHunter.stop();agrentingWorker?.stop();marketScout?.stop();marketExpansion?.stop();skillLibrary.stop();skillAcquirer?.stop();moneyReporter.stop();fiatRoutePlanner.stop();browserActioner?.stop();browserlessActioner?.stop();gmailJobMonitor?.stop();taskForceVerifier.stop();taskForceWorker.stop();globalFeedPublisher.stop();if(emailGateTimer)clearInterval(emailGateTimer);emailGateTimer=null;};
process.on('SIGTERM',stop);process.on('SIGINT',stop);await import('../server.js');
function enabled(value,fallback='false'){return !/^(0|false|no|off)$/i.test(String(value??fallback));}
