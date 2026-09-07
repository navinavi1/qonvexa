import fs from 'node:fs';
import path from 'node:path';

export class GlobalFeedPublisher{
  constructor({env=process.env,storageDir='',logger=console}={}){
    this.env=env;this.logger=logger;
    this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');
    this.publicFile=path.join(process.cwd(),'public','autonomos-global-feed.json');
    this.timer=null;
  }
  start(){
    if(this.timer)return;
    const every=Math.max(5000,Number(this.env.AUTONOMOS_GLOBAL_FEED_PUBLISH_MS||10000));
    this.publish();
    this.timer=setInterval(()=>this.publish(),every);this.timer.unref?.();
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  publish(){
    try{
      const hunter=readJson(path.join(this.root,'global-work-hunter.json'),{});
      const actioner=readJson(path.join(this.root,'global-lead-actioner.json'),{});
      const taskforceWorker=readJson(path.join(this.root,'taskforce-worker.json'),{});
      const registry=readJson(path.join(this.root,'job-registry.json'),{});
      const disabled=new Set(String(this.env.AUTONOMOS_DISABLED_MARKETS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
      const rows=[];
      const seen=new Set();
      for(const lead of Object.values(hunter?.leads||{})){
        const source=String(lead?.source||'web').toLowerCase();if(disabled.has(source))continue;
        const id=String(lead?.id||lead?.url||'');if(!id||seen.has(id))continue;seen.add(id);
        const action=actioner?.actions?.[id]||{};
        const actionState=String(action?.status||'');
        const bucket=webActionBucket(actionState,lead);
        rows.push({
          id,
          title:String(lead?.title||'Paid digital work').slice(0,220),source,url:safeUrl(lead?.url),category:String(lead?.category||'general-digital'),
          amountUsd:num(action?.payout?.amountUsd??lead?.amountUsd),currency:String(action?.payout?.currency||lead?.payoutCurrency||'UNKNOWN').toUpperCase(),
          bucket,status:actionState||(lead?.applyReady?'ready':'new'),firstSeenAt:String(lead?.firstSeenAt||''),lastSeenAt:String(action?.updatedAt||lead?.lastSeenAt||''),
          reason:String(action?.reason||action?.error||lead?.blocker||'').slice(0,220),cryptoPayout:Boolean(lead?.cryptoPayout),payoutVerified:Boolean(lead?.payoutVerified),
          attempts:Number(action?.attempts||0),applicationUrl:safeUrl(action?.applicationUrl)
        });
      }
      for(const [key,app] of Object.entries(hunter?.taskforce?.applications||{})){
        const task=hunter?.taskforce?.tasks?.[key]||{};const worker=taskforceWorker?.tasks?.[key]||{};
        const appStatus=String(app?.status||'').toUpperCase();const workerStatus=String(worker?.status||'');
        const bucket=taskforceBucket(appStatus,workerStatus);
        rows.push({id:`taskforce:${key}`,title:String(task?.title||app?.title||'TaskForce task').slice(0,220),source:'taskforce',url:safeUrl(task?.url),category:String(task?.category||app?.skill||worker?.skill||'digital'),amountUsd:num(task?.budgetUsd||app?.budgetUsd),currency:'USDC',bucket,status:workerStatus||appStatus.toLowerCase(),firstSeenAt:String(app?.appliedAt||task?.observedAt||''),lastSeenAt:String(worker?.updatedAt||app?.updatedAt||app?.appliedAt||task?.observedAt||''),reason:String(worker?.submitError||worker?.qaReasons?.join?.('; ')||app?.error||'').slice(0,220),cryptoPayout:true,payoutVerified:true});
      }
      for(const row of Object.values(registry||{})){
        const source=String(row?.source||'').toLowerCase();if(!source||disabled.has(source))continue;
        const id=`registry:${row.identity||`${source}:${row.externalId||''}`}`;if(seen.has(id))continue;
        const status=String(row?.status||'new');
        const bucket=['dispatch_pending','bid_submitted','claimed','executing','qa'].includes(status)?'working':['delivered','completed'].includes(status)?'done':['paid','settled'].includes(status)?'paid':['archived','graveyard','stale_check','policy_hold','not_eligible','system_blocked','capability_hold','manual_attention','rejected','expired','cancelled'].includes(status)?'archive':status==='ready'?'ready':'new';
        rows.push({id,title:String(row?.title||row?.externalId||'Marketplace job').slice(0,220),source,url:safeUrl(row?.url),category:'marketplace',amountUsd:num(row?.budgetUsd),currency:String(row?.currency||'USD').toUpperCase(),bucket,status,firstSeenAt:String(row?.firstSeenAt||''),lastSeenAt:String(row?.lastSeenAt||row?.lastStateAt||''),reason:String(row?.reason||row?.reasonCode||'').slice(0,220),cryptoPayout:['USDC','USDT','ETH','BTC','SOL','DAI'].includes(String(row?.currency||'').toUpperCase()),payoutVerified:false});
      }
      const order={working:0,ready:1,new:2,done:3,paid:4,archive:9};
      rows.sort((a,b)=>(order[a.bucket]??5)-(order[b.bucket]??5)||Date.parse(b.lastSeenAt||b.firstSeenAt||0)-Date.parse(a.lastSeenAt||a.firstSeenAt||0));
      const counts={};for(const row of rows)counts[row.bucket]=(counts[row.bucket]||0)+1;
      const payload={generatedAt:new Date().toISOString(),scope:'worldwide',intervalSeconds:30,total:rows.length,counts,actioner:actioner?.stats||{},rows:rows.slice(0,1200)};
      fs.writeFileSync(this.publicFile,JSON.stringify(payload),{encoding:'utf8',mode:0o644});
    }catch(error){try{this.logger.warn?.('[GlobalFeedPublisher] '+String(error?.message||error).slice(0,180));}catch{}}
  }
}
function webActionBucket(status,lead){
  if(['applied','application_uncertain','account_or_email_verification_required'].includes(status))return'ready';
  if(['accepted','accepted_waiting_treasury','accepted_needs_capability','executing','submission_uncertain'].includes(status))return'working';
  if(status==='submitted')return'done';if(status==='paid')return'paid';
  if(['archived','human_gate','ai_prohibited','physical_or_employment','paid_registration_required','capability_blocked','accepted_repair_exhausted'].includes(status))return'archive';
  if(status==='needs_capability'||status==='payout_unverified'||status==='registration_email_missing'||status==='inspect_or_apply_failed')return'new';
  return lead?.applyReady?'ready':'new';
}
function taskforceBucket(appStatus,workerStatus){
  if(['paid','completed'].includes(workerStatus)||appStatus==='PAID_OR_APPROVED')return'paid';
  if(['submitted'].includes(workerStatus)||appStatus==='SUBMITTED')return'done';
  if(['preparing','executing','submission_uncertain','waiting_agent_treasury'].includes(workerStatus)||['ACCEPTED','IN_PROGRESS','WORKING','SUBMISSION_REJECTED'].includes(appStatus))return'working';
  if(['rejected_after_repairs','blocked_capability','repair_exhausted','submit_failed'].includes(workerStatus)||['REJECTED','APPLY_FAILED'].includes(appStatus))return'archive';
  return'ready';
}
function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback}}
function safeUrl(value){const v=String(value||'');return /^https?:\/\//i.test(v)?v:''}
function num(value){const n=Number(value||0);return Number.isFinite(n)?n:0}
