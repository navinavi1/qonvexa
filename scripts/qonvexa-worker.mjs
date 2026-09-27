import 'dotenv/config';
import path from 'node:path';
import { Store } from '../src/qonvexa/store.js';
import { config } from '../src/qonvexa/config.js';
import { tick } from '../src/qonvexa/worker.js';
const store=new Store(path.resolve(process.env.STORAGE_DIR||'data'));const cfg=config();let stop=false;
process.on('SIGINT',()=>{stop=true;});process.on('SIGTERM',()=>{stop=true;});
while(!stop){const worked=await tick(store,cfg);if(process.argv.includes('--once'))break;if(!worked)await new Promise(r=>setTimeout(r,1000));}
store.close();
