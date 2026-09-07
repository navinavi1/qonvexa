import fs from 'node:fs';
import path from 'node:path';

export function migrateGlobalActionerState({env=process.env,storageDir='',logger=console}={}){
  const root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');
  const file=path.join(root,'global-lead-actioner.json');
  let state;
  try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return{ok:true,requeued:0};}
  let requeued=0;
  for(const action of Object.values(state?.actions||{})){
    if(String(action?.status||'')!=='needs_capability')continue;
    const missing=Array.isArray(action?.missingTools)?action.missingTools.map(String):[];
    const skill=String(action?.skill||'').toLowerCase();
    const procurementFalsePositive=missing.length===1&&missing[0]==='external_procurement';
    const designChromeFalsePositive=missing.length===1&&missing[0]==='design_media_tool'&&['translation','copywriting','web-research','data-transform','document-generation'].includes(skill);
    if(!procurementFalsePositive&&!designChromeFalsePositive)continue;
    action.status='retry';
    action.nextRetryAt='';
    action.missingTools=[];
    action.reason=procurementFalsePositive?'requeued_after_procurement_classifier_fix':'requeued_after_job_content_classifier_fix';
    action.updatedAt=new Date().toISOString();
    requeued++;
  }
  if(requeued){
    const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp,JSON.stringify(state,null,2),{mode:0o600});
    fs.renameSync(tmp,file);
  }
  try{logger.info?.('[GlobalActionerMigration] '+JSON.stringify({requeued}));}catch{}
  return{ok:true,requeued};
}
