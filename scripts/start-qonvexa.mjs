// One persistent disk, separate OS processes: HTTP never runs audit work inline.
import 'dotenv/config';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
let stopping=false,worker,restarts=0,timer;
const web=spawn(process.execPath,['server.js'],{cwd:root,env:process.env,stdio:'inherit'});
function shutdown(code=0){if(stopping)return;stopping=true;clearTimeout(timer);web.kill('SIGTERM');worker?.kill('SIGTERM');setTimeout(()=>{web.kill('SIGKILL');worker?.kill('SIGKILL');process.exit(code);},5000).unref();process.exitCode=code;}
web.on('error',()=>{console.error('qonvexa_web_spawn_failed');shutdown(1);});
web.on('exit',code=>{if(!stopping)shutdown(code||1);});
function runWorker(){
 if(stopping)return;
 worker=spawn(process.execPath,['scripts/qonvexa-worker.mjs'],{cwd:root,env:process.env,stdio:'inherit'});
 console.log(JSON.stringify({event:'qonvexa_worker_started',attempt:restarts+1}));
 worker.on('error',()=>console.error('qonvexa_worker_spawn_failed'));
 worker.on('exit',()=>{if(stopping)return;if(restarts++<3){timer=setTimeout(runWorker,1000*restarts);}else console.error('qonvexa_worker_restart_limit_reached');});
}
runWorker();process.on('SIGTERM',()=>shutdown());process.on('SIGINT',()=>shutdown());
