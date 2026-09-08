import path from 'node:path';
import { AutonomOSStore } from './store.js';
import { createT2000OAuth } from './t2000-oauth.js';

export function applySourceQuarantine({env=process.env,storageDir='',logger=console}={}){
  const root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');
  const store=new AutonomOSStore(root);
  const disabled=new Set(String(env.AUTONOMOS_DISABLED_MARKETS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
  const hardIgnoreBelow=Math.max(0,Number(env.AUTONOMOS_HARD_IGNORE_BELOW_USD||0.10));
  const now=new Date().toISOString();
  const summary={disabled:[...disabled],archived:0,unarchived:0,inFlightRemoved:0,t2000Disconnected:false,t2000CredentialRemoved:false,registryWriteDeferred:false};

  if(disabled.has('t2000')){
    try{
      // Hard-disable both the modern OAuth state and the legacy persisted credential.
      // Older releases can otherwise resurrect credentials.private.json.t2000 after an
      // OAuth disconnect, which makes discovery silently come back after restart.
      const credentials=store.readJson('credentials.private.json',{});
      if(credentials?.t2000){
        const next={...credentials};delete next.t2000;
        store.writeSecretJson('credentials.private.json',next);
        summary.t2000CredentialRemoved=true;
      }
      const oauth=createT2000OAuth({store,siteUrl:env.SITE_URL||env.RENDER_EXTERNAL_URL||'https://qonvexa.co',env,logger});
      oauth.disconnect();
      // Remove any process-level aliases if a legacy deployment supplied one.
      delete env.T2000_ACCESS_TOKEN;
      delete env.T2000_TOKEN;
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
  if(inflightChanged){
    try{store.writeJson('in-flight-jobs.json',inflight);}
    catch(error){logger.warn?.('[SourceQuarantine] in-flight cleanup deferred: '+String(error?.message||error).slice(0,180));}
  }

  const registry=store.readJson('job-registry.json',{});
  let registryChanged=false;
  for(const [identity,row] of Object.entries(registry||{})){
    const source=String(row?.source||identity.split(':')[0]||'').toLowerCase();
    const status=String(row?.status||'');
    const owned=Boolean(row?.everOwned)||['claimed','executing','qa','delivered','paid','settled','completed','bid_submitted'].includes(status);
    const payout=Number(row?.budgetUsd||0);
    const disabledSource=disabled.has(source);

    // Owner re-enabled this source. Reverse only the quarantine that was created by the
    // owner's disabled-market policy; never revive real marketplace failures or completed
    // work. This makes AUTONOMOS_DISABLED_MARKETS reversible instead of a one-way tombstone.
    if(!disabledSource&&status==='archived'&&row?.terminal===true&&String(row?.reasonCode||'')==='source_disabled_by_owner'){
      registry[identity]={
        ...row,
        status:'policy_hold',
        terminal:false,
        failureOwner:'owner_policy',
        reasonCode:'source_reenabled_by_owner',
        reason:`Source ${source} re-enabled by owner; eligible for fresh discovery and preflight.`,
        retryAfter:'',
        closedAt:'',
        lastStateAt:now
      };
      registryChanged=true;summary.unarchived++;
      continue;
    }

    const worthless=!owned&&payout>0&&payout<hardIgnoreBelow;
    if(!disabledSource&&!worthless)continue;
    if(owned&&!disabledSource)continue;
    const desiredReason=disabledSource?'source_disabled_by_owner':'hard_ignore_below_floor';
    // Rolling deploys share the persistent disk. Do not rewrite hundreds of rows that are
    // already quarantined; that only creates lock contention with the outgoing instance.
    if(status==='archived'&&row?.terminal===true&&String(row?.reasonCode||'')===desiredReason)continue;
    registry[identity]={
      ...row,
      status:'archived',
      terminal:true,
      failureOwner:disabledSource?'owner_policy':'economics',
      reasonCode:desiredReason,
      reason:disabledSource?`Source ${source} disabled by owner; hidden from fresh agent work.`:`Payout $${payout.toFixed(4)} is below hard-ignore floor $${hardIgnoreBelow.toFixed(2)}.`,
      retryAfter:'',
      closedAt:row?.closedAt||now,
      lastStateAt:now
    };
    registryChanged=true;summary.archived++;
  }
  if(registryChanged){
    try{store.writeJson('job-registry.json',registry);}
    catch(error){summary.registryWriteDeferred=true;logger.warn?.('[SourceQuarantine] registry cleanup deferred: '+String(error?.message||error).slice(0,180));}
  }

  try{logger.info?.('[SourceQuarantine] '+JSON.stringify(summary));}catch{}
  return summary;
}
