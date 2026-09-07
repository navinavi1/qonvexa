import 'dotenv/config';
import { InternetHunter } from '../src/autonomos/internet-hunter.js';
import { GlobalWorkHunter } from '../src/autonomos/global-work-hunter.js';
import { ReliableGlobalLeadActioner } from '../src/autonomos/reliable-global-lead-actioner.js';
import { SearchFirstLeadActioner } from '../src/autonomos/search-first-lead-actioner.js';
import { migrateGlobalActionerState } from '../src/autonomos/global-actioner-migrations.js';
import { TaskForceVerifier } from '../src/autonomos/taskforce-verifier.js';
import { TaskForceWorker } from '../src/autonomos/taskforce-worker.js';
import { applySourceQuarantine } from '../src/autonomos/source-quarantine.js';
import { GlobalFeedPublisher } from '../src/autonomos/global-feed-publisher.js';
import { probeRuntimeEmailChannel } from '../src/autonomos/email-channel-probe.js';

// Build/verify runs must keep their isolated fixture config. Only the actual long-running
// service process enables persisted-runtime throughput overrides.
if (/^(1|true|yes|on)$/i.test(String(process.env.AUTONOMOS_PRODUCTION_SWARM_MODE||''))) {
  process.env.AUTONOMOS_RUNTIME_ENV_OVERRIDES='true';
}

applySourceQuarantine({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
migrateGlobalActionerState({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
probeRuntimeEmailChannel({env:process.env,logger:console}).catch(()=>{});

const internetHunter=enabled(process.env.AUTONOMOS_INTERNET_HUNTER_ENABLED,'true')
  ? new InternetHunter({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console}) : null;
const globalHunter=new GlobalWorkHunter({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
// Browser automation is optional only. If Browserbase is exhausted/unconfigured it is not
// instantiated at all and therefore cannot block the worldwide earning loop.
const browserActioner=enabled(process.env.AUTONOMOS_GLOBAL_ACTIONER_ENABLED,'false')
  ? new ReliableGlobalLeadActioner({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console}) : null;
const browserlessActioner=enabled(process.env.AUTONOMOS_BROWSERLESS_ACTIONER_ENABLED,'true')
  ? new SearchFirstLeadActioner({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console}) : null;
const taskForceVerifier=new TaskForceVerifier({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const taskForceWorker=new TaskForceWorker({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const globalFeedPublisher=new GlobalFeedPublisher({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});

internetHunter?.start();
globalHunter.start();
browserActioner?.start();
browserlessActioner?.start();
taskForceVerifier.start();
if(enabled(process.env.AUTONOMOS_TASKFORCE_WORKER_ENABLED,'true'))taskForceWorker.start();
globalFeedPublisher.start();

const stop=()=>{internetHunter?.stop();globalHunter.stop();browserActioner?.stop();browserlessActioner?.stop();taskForceVerifier.stop();taskForceWorker.stop();globalFeedPublisher.stop();};
process.on('SIGTERM',stop);
process.on('SIGINT',stop);

await import('../server.js');

function enabled(value,fallback='false'){return !/^(0|false|no|off)$/i.test(String(value??fallback));}
