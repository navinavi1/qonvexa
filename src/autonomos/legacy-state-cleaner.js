import fs from 'node:fs';
import path from 'node:path';
import { isRetiredMarket } from './retired-markets.js';
export function cleanLegacyState({storageDir=process.env.STORAGE_DIR,logger=console}={}){
 const root=path.join(storageDir||'data','autonomos');if(!fs.existsSync(root))return{ok:true,skipped:true};
 let retired=0;
 for(const name of ['job-registry.json','in-flight-jobs.json']){
  const file=path.join(root,name);if(!fs.existsSync(file))continue;
  const rows=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const [id,row] of Object.entries(rows))if(isRetiredMarket(row.op||row.opportunity||row)||isRetiredMarket(id.split(':')[0])){
   if(row.status==='retired')continue;
   rows[id]={...row,previousStatus:row.status,status:'retired',retiredAt:new Date().toISOString(),reason:'DO_NOT_RESTORE'};retired++;
  }
  const tmp=file+'.retired.tmp';fs.writeFileSync(tmp,JSON.stringify(rows,null,2),{mode:0o600});fs.renameSync(tmp,file);
 }
 logger.info?.('[LegacyStateCleaner] '+JSON.stringify({retired,financialHistoryPreserved:true}));return{ok:true,retired};
}
