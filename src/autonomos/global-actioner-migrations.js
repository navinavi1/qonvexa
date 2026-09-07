import fs from 'node:fs';
import path from 'node:path';

export function migrateGlobalActionerState({env=process.env,storageDir='',logger=console}={}){
  const root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');
  const file=path.join(root,'global-lead-actioner.json');
  let state;
  try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return{ok:true,requeued:0};}
  let requeued=0;
  const reasons={};
  for(const action of Object.values(state?.actions||{})){
    const status=String(action?.status||'');
    const missing=Array.isArray(action?.missingTools)?action.missingTools.map(String):[];
    const skill=String(action?.skill||'').toLowerCase();
    const procurementFalsePositive=status==='needs_capability'&&missing.length===1&&missing[0]==='external_procurement';
    const designChromeFalsePositive=status==='needs_capability'&&missing.length===1&&missing[0]==='design_media_tool'&&['translation','copywriting','web-research','data-transform','document-generation','code-analysis','app-automation','general-digital'].includes(skill);
    // These states are safe to retry because no external application side effect was ever
    // confirmed. Route discovery and Gmail sending changed materially, so keeping the old
    // retry timers would leave good leads asleep after the fix.
    const staleRouteHold=status==='no_direct_route';
    const staleEmailUnavailable=status==='email_channel_unavailable';
    const safePreSendFailure=status==='direct_action_failed';
    const queuedByOldEmailCap=status==='email_rate_limited';
    if(!procurementFalsePositive&&!designChromeFalsePositive&&!staleRouteHold&&!staleEmailUnavailable&&!safePreSendFailure&&!queuedByOldEmailCap)continue;
    // Never touch states whose outbound outcome may be uncertain or already successful.
    if(['email_send_in_progress','application_uncertain','applied_email','accepted_email','executing_email','delivered_email'].includes(status))continue;
    action.status='retry';
    action.nextRetryAt='';
    action.nextCheckAt='';
    action.missingTools=[];
    const reason=procurementFalsePositive?'procurement_classifier_fix':designChromeFalsePositive?'job_content_classifier_fix':staleRouteHold?'route_discovery_fix':staleEmailUnavailable?'gmail_send_fix':queuedByOldEmailCap?'email_pacing_cap_raised':'pre_send_retry';
    action.reason=`requeued_after_${reason}`;
    action.updatedAt=new Date().toISOString();
    reasons[reason]=(reasons[reason]||0)+1;
    requeued++;
  }
  if(requeued){
    const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp,JSON.stringify(state,null,2),{mode:0o600});
    fs.renameSync(tmp,file);
  }
  try{logger.info?.('[GlobalActionerMigration] '+JSON.stringify({requeued,reasons}));}catch{}
  return{ok:true,requeued,reasons};
}
