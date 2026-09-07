import 'dotenv/config';
import { InternetHunter } from '../src/autonomos/internet-hunter.js';
import { GlobalWorkHunter } from '../src/autonomos/global-work-hunter.js';
import { TaskForceVerifier } from '../src/autonomos/taskforce-verifier.js';

// Build/verify runs must keep their isolated fixture config. Only the actual long-running
// service process enables persisted-runtime throughput overrides.
if (/^(1|true|yes|on)$/i.test(String(process.env.AUTONOMOS_PRODUCTION_SWARM_MODE||''))) {
  process.env.AUTONOMOS_RUNTIME_ENV_OVERRIDES='true';
}

const hunter=new InternetHunter({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const globalHunter=new GlobalWorkHunter({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const taskForceVerifier=new TaskForceVerifier({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});

hunter.start();
globalHunter.start();
taskForceVerifier.start();

const stop=()=>{hunter.stop();globalHunter.stop();taskForceVerifier.stop();};
process.on('SIGTERM',stop);
process.on('SIGINT',stop);

await import('../server.js');
