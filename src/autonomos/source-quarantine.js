import path from 'node:path';
import { AutonomOSStore } from './store.js';
import { createT2000OAuth } from './t2000-oauth.js';

export function applySourceQuarantine({env=process.env,storageDir='',logger=console}={}){
  const root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');
  const store=new AutonomOSStore(root);
  const disabled=new Set(String(env.AUTONOMOS_DISABLED_MARKETS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
  const hardIgnoreBelow=Math.max(0,Number(env.AUTONOMOS_HARD_IGNORE_BELOW_USD||0.10));
  const now=new Date().toISOString();
  const summary={disabled:[...disabled],archived:0,inFlightRemoved:0,t2000Disconnected:false};

  if(disabled.has('t2000')){
    try{
      const oauth=createT2000OAuth({store,siteUrl:env.SITE_URL||env.RENDER_EXTERNAL_URL||'https://qonvexa.co',env,logger});
      oauth.disconnect();
      summary.t2000Disconnected=true;
    }catch(error){logger.warn?.('[SourceQuarantine] t2000 disconnect failed: '+String(error?.message||error).slice(0,180));}
  }

  const inflight=store.readJson('in-flight-jobs.json',{});
  let inflightChanged=false;
  for(const [id,row] of Object.entries(inflight||{})){
    const source=String(row?.op?.source||row?.source||'').toLowerCase();
    if(disabled.has(source)){
      delete inflight[id];inflightChanged=true;summary.inFlightRemoved++;
    }
  }
  if(inflightChanged)store.writeJson('in-flight-jobs.json',inflight);

  const registry=store.readJson('job-registry.json',{});
  let registryChanged=false;
  for(const [identity,row] of Object.entries(registry||{})){
    const source=String(row?.source||identity.split(':')[0]||'').toLowerCase();
    const status=String(row?.status||'');
    const owned=Boolean(row?.everOwned)||['claimed','executing','qa','delivered','paid','settled','completed','bid_submitted'].includes(status);
    const payout=Number(row?.budgetUsd||0);
    const disabledSource=disabled.has(source);
    const worthless=!owned&&payout>0&&payout<hardIgnoreBelow;
    if(!disabledSource&&!worthless)continue;
    if(owned&&!disabledSource)continue;
    registry[identity]={
      ...row,
      status:'archived',
      terminal:true,
      failureOwner:disabledSource?'owner_policy':'economics',
      reasonCode:disabledSource?'source_disabled_by_owner':'hard_ignore_below_floor',
      reason:disabledSource?`Source ${source} disabled by owner; hidden from fresh agent work.`:`Payout $${payout.toFixed(4)} is below hard-ignore floor $${hardIgnoreBelow.toFixed(2)}.`,
      retryAfter:'',
      closedAt:row?.closedAt||now,
      lastStateAt:now
    };
    registryChanged=true;summary.archived++;
  }
  if(registryChanged)store.writeJson('job-registry.json',registry);

  try{logger.info?.('[SourceQuarantine] '+JSON.stringify(summary));}catch{}
  return summary;
}
