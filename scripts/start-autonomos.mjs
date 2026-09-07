import 'dotenv/config';
import { InternetHunter } from '../src/autonomos/internet-hunter.js';
import { GlobalWorkHunter } from '../src/autonomos/global-work-hunter.js';
import { GlobalLeadActioner } from '../src/autonomos/global-lead-actioner.js';
import { TaskForceVerifier } from '../src/autonomos/taskforce-verifier.js';
import { TaskForceWorker } from '../src/autonomos/taskforce-worker.js';
import { applySourceQuarantine } from '../src/autonomos/source-quarantine.js';
import { GlobalFeedPublisher } from '../src/autonomos/global-feed-publisher.js';

// Build/verify runs must keep their isolated fixture config. Only the actual long-running
// service process enables persisted-runtime throughput overrides.
if (/^(1|true|yes|on)$/i.test(String(process.env.AUTONOMOS_PRODUCTION_SWARM_MODE||''))) {
  process.env.AUTONOMOS_RUNTIME_ENV_OVERRIDES='true';
}

applySourceQuarantine({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});

const hunter=new InternetHunter({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const globalHunter=new GlobalWorkHunter({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const globalLeadActioner=new GlobalLeadActioner({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const taskForceVerifier=new TaskForceVerifier({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const taskForceWorker=new TaskForceWorker({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const globalFeedPublisher=new GlobalFeedPublisher({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});

hunter.start();
globalHunter.start();
globalLeadActioner.start();
taskForceVerifier.start();
if(!/^(0|false|no|off)$/i.test(String(process.env.AUTONOMOS_TASKFORCE_WORKER_ENABLED||'true')))taskForceWorker.start();
globalFeedPublisher.start();

const stop=()=>{hunter.stop();globalHunter.stop();globalLeadActioner.stop();taskForceVerifier.stop();taskForceWorker.stop();globalFeedPublisher.stop();};
process.on('SIGTERM',stop);
process.on('SIGINT',stop);

await import('../server.js');
