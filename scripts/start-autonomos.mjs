import 'dotenv/config';
import { InternetHunter } from '../src/autonomos/internet-hunter.js';
import { GlobalWorkHunter } from '../src/autonomos/global-work-hunter.js';

const hunter=new InternetHunter({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
const globalHunter=new GlobalWorkHunter({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});

hunter.start();
globalHunter.start();

const stop=()=>{hunter.stop();globalHunter.stop();};
process.on('SIGTERM',stop);
process.on('SIGINT',stop);

await import('../server.js');
