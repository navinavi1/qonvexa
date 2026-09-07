import 'dotenv/config';
import { InternetHunter } from '../src/autonomos/internet-hunter.js';

const hunter=new InternetHunter({env:process.env,storageDir:process.env.STORAGE_DIR,logger:console});
hunter.start();
process.on('SIGTERM',()=>hunter.stop());
process.on('SIGINT',()=>hunter.stop());

await import('../server.js');
