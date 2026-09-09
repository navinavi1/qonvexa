import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
const pools=new Map();
export async function coordinateExecution(op,env,run){
 const root=path.resolve(env.STORAGE_DIR||'data','autonomos');fs.mkdirSync(root,{recursive:true});
 const key=String(op.jobId||`${op.source}:${op.externalId}`);
 const requested=Number(env.AUTONOMOS_EXECUTION_CONCURRENCY||2);const capacity=Math.max(1,Math.min(8,Number.isFinite(requested)?requested:2,Math.max(1,Math.floor(os.freemem()/(128*1024*1024)))));
 let pool=pools.get(root);if(!pool){pool={active:new Set(),waiting:[]};pools.set(root,pool);}
 if(pool.active.has(key))throw Error('job_already_executing');
 if(pool.active.size>=capacity)await new Promise(resolve=>pool.waiting.push(resolve));
 if(pool.active.has(key))throw Error('job_already_executing');
 pool.active.add(key);
 const file=path.join(root,'execution-workforce.json');
 const update=(phase,extra={})=>{let rows={};try{rows=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}rows[key]={...rows[key],jobId:key,source:op.source,phase,...extra,updatedAt:new Date().toISOString(),pid:process.pid,concurrency:capacity};const entries=Object.entries(rows);if(entries.length>2000)for(const [id,r]of entries)if(id!==key&&!pool.active.has(id)){delete rows[id];if(Object.keys(rows).length<=2000)break;}const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(rows,null,2),{mode:0o600});fs.renameSync(tmp,file);};
 update('executing',{startedAt:new Date().toISOString(),workerId:crypto.randomUUID(),active:true});
 try{const result=await run();update('execution_finished',{active:false,executionOk:true});return result;}
 catch(error){update('execution_failed',{active:false,executionOk:false,error:String(error.message).slice(0,240)});throw error;}
 finally{pool.active.delete(key);pool.waiting.shift()?.();}
}
