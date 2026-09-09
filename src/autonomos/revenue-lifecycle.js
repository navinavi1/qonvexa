import { emailAddress } from './gmail-mailbox.js';
import { isRetiredMarket } from './retired-markets.js';
import { businessSnapshot } from './business-snapshot.js';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_AUTONOMOS_CONFIG, normalizeConfig } from './policy-engine.js';
import { allocateRevenue } from './profit-engine.js';
import { taskForceHeaders } from './taskforce-auth.js';

const EMAIL_ACCEPTED_RETRY = new Set([
  'accepted_email','accepted_needs_capability','accepted_waiting_treasury','accepted_repair_exhausted'
]);
const EMAIL_MONITOR = new Set(['applied_email','submitted_email','email_needs_info','application_uncertain']);
const TF_ACCEPTED = new Set(['ACCEPTED','IN_PROGRESS','WORKING','ASSIGNED','AWARDED','SUBMISSION_REJECTED']);
const TF_FINAL = new Set(['submitted','completed','paid','rejected_after_repairs']);
const PAYMENT_SIGNAL=/\b(?:payment sent|payment released|funds released|paid you|payment completed|transaction (?:hash|id)|usdc sent|usdt sent)\b/i;

function due(value){const t=Date.parse(String(value||0));return !Number.isFinite(t)||t<=Date.now();}
function ageMs(value){const t=Date.parse(String(value||0));return Number.isFinite(t)?Math.max(0,Date.now()-t):Number.POSITIVE_INFINITY;}
function ownEmail(env){return String(env.AUTONOMOS_REGISTRATION_EMAIL||env.CONTACT_EMAIL||env.SUPPORT_EMAIL||env.ADMIN_EMAIL||'').trim().toLowerCase();}
function maskEmail(email){const m=String(email||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);if(!m)return'redacted';const [l,d]=m[0].toLowerCase().split('@');return `${l.slice(0,2)}***@${d}`;}
function safe(error){return String(error?.message||error||'').slice(0,260);}
function arrayFrom(data,keys){if(Array.isArray(data))return data;for(const k of keys)if(Array.isArray(data?.[k]))return data[k];return[];}
function tfHeaders(key){return taskForceHeaders(key,'AutonomOS-RevenueLifecycle/1.0');}
async function safeJson(r){try{return await r.json();}catch{return{};}}

// 1) Once an email lead has been accepted, the browserless application worker must never
// overwrite it back to inspecting/applying. This was a real lifecycle race between the
// application lane and Gmail acceptance lane.
export function lifecycleAwareShouldInspect(lead, original){
  const action=this.state?.actions?.[lead?.id]||{};
  const status=String(action.status||'');
  if(action.acceptedAt||['application_uncertain','submitted','qa','repairing','delivery_ready','executing_github'].includes(status))return false;
  if(EMAIL_ACCEPTED_RETRY.has(status)||['executing_email','delivery_email_in_progress','submitted_email','paid'].includes(status))return false;
  if(status==='submission_uncertain'&&action.acceptedAt)return false;
  return original.call(this,lead);
};

// 2) Accepted email work previously became terminal by accident: statuses such as
// accepted_needs_capability / accepted_waiting_treasury / accepted_repair_exhausted were
// not included in GmailJobMonitor.tick(), so they were never retried. Recover stale
// execution after restarts, and reconcile ambiguous delivery by checking the Gmail thread
// before ever attempting another send.
export async function hardenedGmailTick(){
  if(this.running||!this.actioner)return;
  const config=this.actioner.currentConfig?.();if(config&&(config.killSwitch||config.enabled===false))return;
  this.running=true;
  try{
    await this.probeMailbox();
    const entries=Object.entries(this.actioner.state?.actions||{}).filter(([,a])=>{
      const s=String(a?.status||'');
      if(a.route==='github_issue_comment')return false;
      if(a.acceptedAt&&['planning','qa','repairing','delivery_ready'].includes(s))return ageMs(a.updatedAt)>15*60_000;
      if(EMAIL_MONITOR.has(s)||EMAIL_ACCEPTED_RETRY.has(s)||s==='submission_uncertain')return due(a?.nextCheckAt);
      if(s==='executing_email'||s==='delivery_email_in_progress')return ageMs(a?.updatedAt)>15*60_000;
      return false;
    }).sort(([,a],[,b])=>Number(!!b.acceptedAt)-Number(!!a.acceptedAt)||Date.parse(a.deadline||'9999-01-01')-Date.parse(b.deadline||'9999-01-01')).slice(0,40);
    let cursor=0;await Promise.all(Array.from({length:Math.min(3,entries.length)},async()=>{while(cursor<entries.length){const [id,action]=entries[cursor++];
      const status=String(action?.status||'');
      try{
        if(EMAIL_ACCEPTED_RETRY.has(status)){
          await this.executeAndDeliver(id,action);continue;
        }
        if(status==='executing_email'||action.acceptedAt&&['planning','qa','repairing','delivery_ready'].includes(status)){
          this.actioner.setAction(id,{status:'accepted_email',recoveredFrom:'stale_executing_email',nextCheckAt:''});
          this.log('email_execution_recovered_after_restart',{id});
          await this.executeAndDeliver(id,this.actioner.state.actions[id]);continue;
        }
        if(status==='delivery_email_in_progress'||(status==='submission_uncertain'&&action?.acceptedAt)){
          await reconcileEmailDelivery.call(this,id,action);continue;
        }
        await this.checkOne(id,action);
      }catch(error){
        this.actioner.setAction(id,{nextCheckAt:new Date(Date.now()+15*60_000).toISOString(),lifecycleRecoveryError:safe(error)});
        this.log('gmail_lifecycle_item_error',{id,status,error:safe(error)});
      }
    }}));
  }finally{this.running=false;this.actioner.persist?.();}
};

async function reconcileEmailDelivery(id,action){
  const title=String(action?.title||'').trim();if(!title){this.actioner.setAction(id,{nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});return;}
  const messages=await this.searchReplies(title,action);
  if(!messages?.ok){this.actioner.setAction(id,{nextCheckAt:new Date(Date.now()+30*60_000).toISOString(),emailMonitorError:messages?.error||'gmail_search_failed'});return;}
  const own=ownEmail(this.env);const since=Date.parse(String(action?.deliveryIntentAt||action?.updatedAt||action?.acceptedAt||0));
  const sent=(messages.rows||[]).find(row=>{
    const from=String(row?.from||'').toLowerCase(),at=Date.parse(String(row?.at||0)),text=String(row?.text||'');
    const matchingBody=action.deliveryMarker?text.includes(action.deliveryMarker):action.deliveryBody&&text.replace(/\s+/g,' ').trim()===String(action.deliveryBody).replace(/\s+/g,' ').trim();
    return own&&emailAddress(from)===own&&row.labels?.includes('SENT')&&matchingBody&&Number.isFinite(at)&&(!Number.isFinite(since)||at>=since-60_000);
  });
  if(sent&&sent.id){
    const already=String(this.actioner.state?.actions?.[id]?.status||'')==='submitted_email';
    this.actioner.setAction(id,{status:'submitted_email',gmailDeliveryMessageId:String(sent.id),submittedAt:action?.submittedAt||new Date().toISOString(),reconciledFromGmail:true,nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});
    if(!already)this.actioner.state.stats.submitted=Number(this.actioner.state.stats.submitted||0)+1;
    this.log('email_delivery_reconciled',{id});return;
  }
  const incoming=(messages.rows||[]).find(row=>{
    const from=String(row?.from||'').toLowerCase();return row?.text&&(!own||!from.includes(own));
  });
  if(incoming&&PAYMENT_SIGNAL.test(String(incoming.text||''))){
    this.actioner.setAction(id,{paymentClaimSeen:true,paymentClaimAt:new Date().toISOString(),paymentClaimFrom:maskEmail(incoming.from),nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});
    this.log('email_payment_claim_seen',{id});return;
  }
  const reason=String(action?.reason||action?.submitError||'');
  if(String(action?.status||'')==='submission_uncertain'&&/not connected|connected account|unauthor|forbidden|auth|schema|send tool/i.test(reason)&&ageMs(action?.updatedAt)>20*60_000){
    // These failures happen before a successful external send, so retrying the accepted job
    // after the channel recovers does not create a duplicate delivery.
    this.actioner.setAction(id,{status:'accepted_email',recoveredFrom:'definite_delivery_channel_failure',nextCheckAt:''});
    await this.executeAndDeliver(id,this.actioner.state.actions[id]);return;
  }
  if(String(action?.status||'')==='delivery_email_in_progress'&&ageMs(action?.updatedAt)>30*60_000){
    this.actioner.setAction(id,{status:'submission_uncertain',reason:'stale delivery intent; Gmail sent thread has no confirmed delivery yet',nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});return;
  }
  this.actioner.setAction(id,{nextCheckAt:new Date(Date.now()+30*60_000).toISOString(),lastDeliveryReconcileAt:new Date().toISOString()});
}

// 3) TaskForce apply failures used to block a task forever because any application record,
// including apply_failed, counted as "already applied". Remove only stale definite failures
// so the normal idempotent application path can try again. Also recover acceptance from the
// authoritative IN_PROGRESS/WORKING task lists when a notification was missed.
export async function hardenedPollTaskForce(credential, original){
  const apps=this.state?.taskforce?.applications||{};let released=0;
  for(const [taskId,app] of Object.entries(apps)){
    if(String(app?.status||'').toLowerCase()==='apply_failed'&&app?.failure?.retryable!==false&&ageMs(app?.at||app?.updatedAt)>15*60_000){delete apps[taskId];released++;}
  }
  if(released)this.event?.('taskforce_failed_applications_requeued',{released});
  const result=await original.call(this,credential);
  try{
    const h=tfHeaders(credential?.apiKey);let recovered=0;
    for(const status of ['IN_PROGRESS','WORKING']){
      const r=await fetch(`https://www.task-force.app/api/agent/tasks?status=${status}&limit=100`,{headers:h,signal:AbortSignal.timeout(12000)});const data=await safeJson(r);if(!r.ok)continue;
      for(const raw of arrayFrom(data,['tasks','items','data'])){
        const taskId=String(raw?.id||raw?.taskId||'').trim();if(!taskId||!apps[taskId])continue;
        const assignments=raw.applications||[];const mine=assignments.find(a=>String(a.agentId||a.agent_id||'')===String(credential.agentId||''));
        if(!credential.agentId||!(String(raw.assignedAgentId||raw.agentId||'')===String(credential.agentId)||mine&&TF_ACCEPTED.has(String(mine.status||'').toUpperCase())))continue;
        const prior=String(apps[taskId].status||'').toUpperCase();
        if(!TF_ACCEPTED.has(prior)){apps[taskId].status=status;apps[taskId].updatedAt=new Date().toISOString();recovered++;}
      }
    }
    if(recovered){this.persist?.();this.event?.('taskforce_acceptance_recovered_from_task_state',{recovered});}
  }catch(error){this.event?.('taskforce_state_reconcile_failed',{error:safe(error)});}
  return result;
};

// 4) Persist a verified deliverable before TaskForce submission. A definite 4xx submission
// failure no longer forces the agents to spend money and time executing the whole job again.
export async function hardenedTaskForceSubmit(taskId,deliverable,qa,credential,meta={},original){
  const prior=this.state.tasks?.[taskId]||{};
  this.state.tasks[taskId]={...prior,deliverableSnapshot:{content:String(deliverable?.content||'').slice(0,20000),format:String(deliverable?.format||'text/markdown'),evidence:{toolCalls:Array.isArray(deliverable?.evidence?.toolCalls)?deliverable.evidence.toolCalls.slice(-40):[]}},qaSnapshot:{ok:Boolean(qa?.ok),score:Number(qa?.score||1),mode:String(qa?.mode||''),reasons:Array.isArray(qa?.reasons)?qa.reasons.slice(0,8):[]},submitMeta:{started:Number(meta?.started||Date.now()),repairCycles:Number(meta?.repairCycles||0),budgetSpentUsd:Number(meta?.budgetSpentUsd||0)},updatedAt:new Date().toISOString()};
  this.persist();
  return original.call(this,taskId,deliverable,qa,credential,meta);
};

// 5) Replace the old TaskForce one-item queue behavior with a recoverable sequential queue.
// It still executes sequentially (no treasury race), but can finish several already-accepted
// jobs per tick and retries capability/QA/definite-submit failures with bounded backoff.
export async function hardenedTaskForceTick(){
  if(this.running)return;const config=this.currentConfig();if(!config.enabled||config.killSwitch)return;this.running=true;
  try{
    const credential=this.read(this.secretFile,{}).taskforce;
    if(!credential?.apiKey||!credential?.verified){if(ageMs(this._lastAuthWaitLog)>5*60_000){this._lastAuthWaitLog=new Date().toISOString();this.event('worker_waiting_auth',{hasApiKey:Boolean(credential?.apiKey),verified:Boolean(credential?.verified)});}return;}
    await this.reconcileEarnings(credential).catch(error=>this.event('earnings_error',{error:safe(error)}));
    await this.withdrawOwnerShare(credential).catch(error=>this.event('withdraw_error',{error:safe(error)}));
    const global=this.read(this.globalStateFile,{}),apps=global?.taskforce?.applications||{};
    const accepted=Object.entries(apps).filter(([,app])=>TF_ACCEPTED.has(String(app?.status||'').toUpperCase()));
    const maxSequential=Math.max(1,Math.min(20,Number(this.env.AUTONOMOS_TASKFORCE_ACCEPTED_PER_TICK||5)));let processed=0;const queued=[];
    accepted.sort(([a],[b])=>Date.parse(global.taskforce.tasks?.[a]?.deadline||'9999-01-01')-Date.parse(global.taskforce.tasks?.[b]?.deadline||'9999-01-01'));
    for(const [taskId,app] of accepted){
      const row=this.state.tasks[taskId]||{},status=String(row.status||''),appStatus=String(app?.status||'').toUpperCase();
      if(status==='submitting'){this.state.tasks[taskId]={...row,status:'submission_uncertain',submitError:'restart_after_delivery_intent'};this.persist();continue;}
      if((TF_FINAL.has(status)&&appStatus!=='SUBMISSION_REJECTED')||status==='submission_uncertain')continue;
      if(row.retryAt&&!due(row.retryAt))continue;
      if(status==='blocked_capability'&&ageMs(row.updatedAt)<15*60_000)continue;
      if(status==='repair_exhausted'&&ageMs(row.updatedAt)<20*60_000)continue;
      if(status==='submit_failed'&&ageMs(row.updatedAt)<10*60_000)continue;
      if(appStatus==='SUBMISSION_REJECTED'&&Number(row.repairCycles||0)>=3){this.state.tasks[taskId]={...row,status:'rejected_after_repairs',updatedAt:new Date().toISOString()};this.persist();continue;}
      if(status==='submit_failed'&&row.deliverableSnapshot&&row.qaSnapshot?.ok){
        this.event('task_submit_retry_from_snapshot',{taskId});
        queued.push(()=>this.submit(taskId,row.deliverableSnapshot,row.qaSnapshot,credential,row.submitMeta||{}));processed++;
      }else{
        if(status==='blocked_capability')this.event('task_capability_recheck',{taskId,missingTools:row.missingTools||[]});
        queued.push(()=>this.executeAccepted(taskId,app,global,credential));processed++;
      }
      if(processed>=maxSequential)break;
    }
    await Promise.allSettled(queued.map(run=>run()));
    const pending=Object.values(apps).filter(a=>String(a?.status||'').toUpperCase()==='PENDING').length;
    if(accepted.length||pending)this.event('worker_queue_diagnostics',{accepted:accepted.length,pending,processed,localTasks:Object.keys(this.state.tasks||{}).length});
  }finally{this.running=false;}
};

// 6) Money/dashboard truth: include TaskForce accepted/executing/submitted states instead of
// looking only at the global email/browser actioner. Revenue remains ledger-authoritative.
export function hardenedMoneyRefresh(){try{
  const now=new Date(),day=now.toISOString().slice(0,10),root=this.root;
  const ledger=readNdjson(`${root}/ledger.ndjson`),hunter=readJson(`${root}/global-work-hunter.json`,{}),actioner=readJson(`${root}/global-lead-actioner.json`,{}),registry=readJson(`${root}/job-registry.json`,{}),tf=readJson(`${root}/taskforce-worker.json`,{}),config=normalizeConfig(readJson(`${root}/config.json`,{...DEFAULT_AUTONOMOS_CONFIG,enabled:true}));
  const todays=ledger.filter(x=>String(x?.at||'').startsWith(day)&&!x?.testnet);let gross=0,cost=0,fees=0,owner=0,treasury=0;const bySource={};
  for(const row of todays){const source=String(row?.source||'unknown');bySource[source]=bySource[source]||{revenueUsd:0,costUsd:0,netUsd:0};if(row.type==='revenue'){const amount=Number(row.amountUsd??row.grossUsd??0)||0,fee=Number(row.feeUsd||0)+Number(row.apiCostUsd||0)+Number(row.networkFeeUsd||0);gross+=amount;fees+=fee;const alloc=row.allocation||allocateRevenue(Math.max(0,amount-fee),config);owner+=Number(alloc.ownerUsd||0);treasury+=Number(alloc.treasuryUsd||0);bySource[source].revenueUsd+=amount;bySource[source].netUsd+=amount-fee;}else if(row.type==='cost'){const n=Number(row.amountUsd||0)||0;cost+=n;bySource[source].costUsd+=n;bySource[source].netUsd-=n;}}
  const actions=Object.values(actioner?.actions||{}),tfApps=Object.values(hunter?.taskforce?.applications||{}),tfTasks=Object.values(tf?.tasks||{}),settlements=Object.values(tf?.settlements||{});
  const counts={
    found:Object.keys(hunter?.leads||{}).length,
    applied:actions.filter(a=>['applied','applied_email'].includes(String(a?.status||''))).length+tfApps.filter(a=>['PENDING','ACCEPTED','IN_PROGRESS','WORKING','ASSIGNED','AWARDED','SUBMISSION_REJECTED'].includes(String(a?.status||'').toUpperCase())).length,
    accepted:actions.filter(a=>/^accepted/.test(String(a?.status||''))).length+tfApps.filter(a=>TF_ACCEPTED.has(String(a?.status||'').toUpperCase())).length,
    working:actions.filter(a=>/executing|working|delivery_email_in_progress/.test(String(a?.status||''))).length+tfTasks.filter(t=>['preparing','executing'].includes(String(t?.status||''))).length,
    submitted:actions.filter(a=>['submitted','submitted_email'].includes(String(a?.status||''))).length+tfTasks.filter(t=>String(t?.status||'')==='submitted').length,
    paid:actions.filter(a=>String(a?.status||'')==='paid').length+settlements.filter(s=>Number(s?.amountUsd||0)>0&&s?.ledgerRecorded).length,
    registryOpen:Object.values(registry||{}).filter(r=>!['archived','graveyard','rejected','expired','cancelled','settled','paid'].includes(String(r?.status||''))).length
  };
  const report={generatedAt:now.toISOString(),date:day,split:{ownerPercent:Number(config.ownerRevenuePercent||50),agentTreasuryPercent:Number(config.agentTreasuryPercent||50)},counts,money:{grossRevenueUsd:round(gross),feesUsd:round(fees),toolAndInfraCostUsd:round(cost),netProfitUsd:round(gross-fees-cost),ownerShareUsd:round(owner),agentTreasuryShareUsd:round(treasury)},bySource:Object.fromEntries(Object.entries(bySource).map(([k,v])=>[k,{revenueUsd:round(v.revenueUsd),costUsd:round(v.costUsd),netUsd:round(v.netUsd)}]).sort((a,b)=>b[1].netUsd-a[1].netUsd)),guardrails:{earnedFundsOnly:Boolean(config.earnedFundsOnly),allowExternalSpending:Boolean(config.allowExternalSpending),autoReplication:Boolean(config.autoReplication),survivalMode:Boolean(config.survivalMode)}};
  const truth=businessSnapshot(path.dirname(this.root),this.env);report.counts={...report.counts,found:truth.counts.discovered,applied:truth.counts.applications,accepted:truth.counts.accepted,working:truth.counts.executing,submitted:truth.counts.delivered,paid:truth.counts.paid};report.funnel=truth.counts;report.money={...report.money,grossRevenueUsd:truth.money.grossRevenueUsd,feesUsd:truth.money.feesUsd,toolAndInfraCostUsd:truth.money.costUsd,netProfitUsd:truth.money.netProfitUsd,costsAreEstimates:truth.money.costsAreEstimates,ownerShareUsd:Math.max(0,truth.money.netProfitUsd)*Number(config.ownerRevenuePercent||50)/100,agentTreasuryShareUsd:Math.max(0,truth.money.netProfitUsd)*Number(config.agentTreasuryPercent||50)/100};report.counts.registryOpen=Object.values(registry||{}).filter(r=>!isRetiredMarket(r)&&!['retired','archived','graveyard','rejected','expired','cancelled','settled','paid'].includes(String(r.status))).length;
  writeJson(this.file,report,0o600);writeJson(this.publicFile,report,0o644);
  const summary={type:this.lastDaily!==day?'daily_money_report':'money_report_updated',date:day,netProfitUsd:report.money.netProfitUsd,ownerShareUsd:report.money.ownerShareUsd,agentTreasuryShareUsd:report.money.agentTreasuryShareUsd,...report.counts};this.lastDaily=day;this.logger.info?.('[MoneyReport] '+JSON.stringify(summary));
}catch(error){try{this.logger.warn?.('[MoneyReport] '+safe(error));}catch{}}};

function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return structuredClone(fallback);}}
function readNdjson(file){try{return fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);}catch{return[];}}
function writeJson(file,value,mode){const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode});fs.renameSync(tmp,file);}
function round(v){return Math.round((Number(v||0)+Number.EPSILON)*1e6)/1e6;}
