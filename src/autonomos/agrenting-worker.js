import { runAcceptedJob } from './accepted-job-engine.js';
import { DynamicMarketRegistry } from './dynamic-market-registry.js';
import { ActionJournal } from './action-journal.js';
import { recoverFreeCapability } from './free-tool-recovery.js';
import { unifiedCapabilityContext, refreshCapabilities } from './capability-registry.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLlmClient } from './llm.js';
import { classifyOpportunity } from './capabilities.js';
import { executeExternalOpportunity } from './job-executor.js';
import { evaluateDeliverable } from './qa-engine.js';
import { createJobBudget } from './job-budget.js';
import { normalizeConfig, DEFAULT_AUTONOMOS_CONFIG } from './policy-engine.js';
import { computeEarnedSpendBudgetUsd } from './profit-engine.js';
import { AutonomOSStore } from './store.js';
import { ledgerEntry, appendUniqueLedgerEntry } from './financial-ledger.js';

const BASE='https://agrenting.com';
const SAFE_CAPABILITIES=['translation','copywriting','data_transform','code_analysis','document_generation','app_automation'];

// Free provider-market lane. Agrenting has no monthly provider fee; buyers pre-fund escrow.
// This worker never deposits funds, hires other agents, buys tools, or initiates withdrawals.
// It only registers the AutonomOS provider, receives already-funded hires, executes work and
// records revenue after Agrenting itself reports the hiring completed.
export class AgrentingWorker{
  constructor({env=process.env,storageDir='',logger=console}={}){
    this.env=env;this.logger=logger;this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');fs.mkdirSync(this.root,{recursive:true});
    this.stateFile=path.join(this.root,'agrenting-worker.json');this.secretFile=path.join(this.root,'agrenting-credentials.private.json');
    this.state=this.read(this.stateFile,{version:1,hirings:{},events:[],registered:false});
    this.actionJournal=new ActionJournal(this.root);this.store=new AutonomOSStore(this.root);this.llm=createLlmClient(env);this.timer=null;this.running=false;
  }
  start(){if(this.timer)return;const every=Math.max(60_000,Number(this.env.AUTONOMOS_AGRENTING_POLL_MS||3*60_000));setTimeout(()=>this.tick().catch(e=>this.event('tick_error',{error:safe(e)})),15_000).unref?.();this.timer=setInterval(()=>this.tick().catch(e=>this.event('tick_error',{error:safe(e)})),every);this.timer.unref?.();this.event('worker_started',{intervalMs:every,basePriceUsd:this.basePrice()});}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  async tick(){const config=this.currentConfig();if(!config.enabled||config.killSwitch)return;if(this.running||!enabled(this.env.AUTONOMOS_AGRENTING_ENABLED,'true'))return;this.running=true;try{const credential=await this.ensureCredential();if(!credential?.apiKey)return;await this.ensureActive(credential);await this.reconcileSubmitted(credential);await this.pollPending(credential);}finally{this.running=false;this.persist();}}

  async ensureCredential(){
    const saved=this.read(this.secretFile,{});if(saved?.agrenting?.apiKey)return saved.agrenting;
    if(!enabled(this.env.AUTONOMOS_AGRENTING_AUTO_REGISTER,'true'))return null;
    const registration=this.actionJournal.begin('agrenting','AutonomOS','register');if(!registration.ok){this.event('registration_reconcile_required',{status:registration.status});return null;}
    const did=`did:autonomos:${hash(String(this.env.AUTONOMOS_OWNER_WALLET||this.env.AUTONOMOS_REGISTRATION_EMAIL||'qonvexa'))}`;
    const body={agent:{name:'AutonomOS',did,capabilities:SAFE_CAPABILITIES,category:'custom',pricing_model:'fixed',base_price:this.basePrice().toFixed(2)}};
    const r=await fetch(`${BASE}/api/v1/agents/register`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json','user-agent':'AutonomOS-Agrenting/1.0'},body:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});const data=await json(r);
    if(!r.ok){this.event('registration_failed',{status:r.status,error:publicError(data)});return null;}
    const row=data?.data||data;const apiKey=String(row?.api_key||row?.apiKey||'');const agent=row?.agent||{};const agentId=String(agent?.id||row?.agent_id||'');if(!apiKey||!agentId){this.event('registration_failed',{status:r.status,error:'registration_response_missing_api_key_or_agent_id'});return null;}
    const credential={apiKey,agentId,did:String(agent?.did||did),registeredAt:new Date().toISOString()};this.writeSecret(this.secretFile,{...saved,agrenting:credential});this.actionJournal.finish(registration.id,'confirmed',{externalId:agentId});
    this.state.registered=true;this.state.agentId=agentId;this.state.did=credential.did;this.state.legalVersion=String(row?.legal?.terms?.version||row?.legal?.version||'');this.state.legalReviewNotice=String(row?.legal?.review_notice||row?.legal?.reviewNotice||'').slice(0,1000);this.persist();
    this.event('registered',{agentId,did:credential.did,basePriceUsd:this.basePrice(),legalVersion:this.state.legalVersion||'unknown'});return credential;
  }

  async auth(credential){
    if(credential.sessionToken&&Date.parse(String(credential.sessionExpiresAt||0))>Date.now()+10*60_000)return credential.sessionToken;
    const r=await fetch(`${BASE}/api/v1/auth/authenticate`,{method:'POST',headers:{'content-type':'application/json','x-api-key':credential.apiKey,accept:'application/json'},signal:AbortSignal.timeout(12_000)});const data=await json(r);if(!r.ok)return'';const row=data?.data||data;credential.sessionToken=String(row?.session_token||'');credential.sessionExpiresAt=String(row?.expires_at||new Date(Date.now()+20*60*60_000).toISOString());const saved=this.read(this.secretFile,{});saved.agrenting=credential;this.writeSecret(this.secretFile,saved);return credential.sessionToken;
  }

  async ensureActive(credential){
    const due=!this.state.lastActiveSyncAt||Date.now()-Date.parse(this.state.lastActiveSyncAt)>30*60_000;if(!due)return;
    const token=await this.auth(credential);if(!token){this.event('auth_failed');return;}
    const site=String(this.env.SITE_URL||this.env.RENDER_EXTERNAL_URL||'https://qonvexa.co').replace(/\/$/,'');
    const body={agent:{status:'active',description:'Autonomous AI-assisted digital services: coding, structured data, document generation, translation, copywriting and connected-app automation. Work is tool-checked and QA verified before delivery.',capabilities:SAFE_CAPABILITIES,pricing_model:'fixed',base_price:this.basePrice().toFixed(2),metadata:{callback_url:`${site}/health`}}};
    const r=await fetch(`${BASE}/api/v1/agents/${encodeURIComponent(credential.agentId)}`,{method:'PATCH',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12_000)});if(r.ok){this.state.lastActiveSyncAt=new Date().toISOString();this.event('agent_active',{agentId:credential.agentId,callbackUrl:`${site}/health`});}else{const data=await json(r);this.event('active_sync_failed',{status:r.status,error:publicError(data)});}
  }

  async pollPending(credential){
    const r=await fetch(`${BASE}/api/v1/hirings/pending`,{headers:{'x-api-key':credential.apiKey,accept:'application/json'},signal:AbortSignal.timeout(12_000)});const data=await json(r);if(!r.ok){this.event('pending_poll_failed',{status:r.status,error:publicError(data)});return;}
    const rows=arrayFrom(data,['hirings','items','data']);new DynamicMarketRegistry(this.root).observe('agrenting',{name:'Agrenting',homepage:BASE,lastJobsCount:rows.length,evidence:{authentication:{verified:true,externalId:credential.agentId,verifiedAt:new Date().toISOString()},...(rows.length?{jobs:{verified:true,url:BASE+'/api/v1/hirings/pending',verifiedAt:new Date().toISOString()}}:{})},blocker:rows.length?'':'NO_ASSIGNED_HIRINGS'});this.event('pending_polled',{count:rows.length});
    const pending=rows.map(normalizeHiring).filter(h=>h.id&&['in_progress','paid','revision_requested'].includes(h.status)&&!this.state.hirings[h.id]?.submittedAt).sort((a,b)=>Date.parse(a.deadlineAt||'9999-01-01')-Date.parse(b.deadlineAt||'9999-01-01'));
    await Promise.allSettled(pending.slice(0,10).map(h=>this.executeHiring({...h,clientMessage:this.state.hirings[h.id]?.clientMessage||h.clientMessage},credential).catch(e=>this.event('hiring_retry',{id:h.id,error:safe(e)}))));
  }

  async executeHiring(h,credential){
    const prior=this.state.hirings[h.id]||{};
    if(prior.retryAt&&Date.parse(prior.retryAt)>Date.now())return;
    if(['submitting','submission_uncertain','submitted'].includes(prior.status)){await this.reconcileOne(h.id,credential);return;}
    if(prior.deliverableSnapshot&&prior.qaSnapshot?.ok&&prior.status==='submission_failed'){await this.submitResult(h,prior.deliverableSnapshot,prior.qaSnapshot,credential);return;}
    // Pending hirings are already funded/assigned obligations; price filters apply to new offers only.
    const opportunity={source:'agrenting',externalId:h.id,jobId:`agrenting_${h.id}`,deadline:h.deadlineAt,title:h.title,description:`${h.description}\n${h.clientMessage}\n${safeJson(h.taskInput)}`.slice(0,12000),category:categoryFor(h.capability),budgetUsd:h.price,currency:'USD',network:'crypto_convertible',escrowed:true,claimMode:'already_assigned',status:'active',url:`${BASE}/`,skills:[h.capability]};
    await refreshCapabilities(this.env);let capability=classifyOpportunity(opportunity,this.capabilityContext());
    if(!capability.executable){for(const gap of capability.missingTools||[])await recoverFreeCapability(gap,this.env);capability=classifyOpportunity(opportunity,this.capabilityContext());}
    if(!capability.executable){this.state.hirings[h.id]={...h,status:'waiting_capability',missingTools:capability.missingTools||[],retryAt:new Date(Date.now()+60_000).toISOString(),updatedAt:new Date().toISOString()};this.persist();return;}
    const config=normalizeConfig(this.store.readJson('config.json',{...DEFAULT_AUTONOMOS_CONFIG,enabled:true}));const treasury=computeEarnedSpendBudgetUsd(this.store.readNdjson('ledger.ndjson',-1),config);const maxJobSpend=Math.max(0.05,Number(this.env.AUTONOMOS_AGRENTING_MAX_JOB_SPEND_USD||2));const spendCap=Math.min(treasury,maxJobSpend,Math.max(0,h.price)*.35);
    if(spendCap<=0.000001&&!capability.mode?.includes('deterministic')){this.state.hirings[h.id]={...h,status:'waiting_treasury',updatedAt:new Date().toISOString()};this.persist();return;}
    const budget=createJobBudget(Math.max(0,spendCap),{env:this.env,onCost:amount=>this.recordCost(h.id,amount)});const llm=budget.llm(this.llm);const execConfig={...config,availableSpendUsd:spendCap,maxPaidProcurementUsd:0,allowExternalSpending:false};
    let deliverable=null,qa=null,briefing='';const repairs=Math.max(1,Math.min(4,Number(this.env.AUTONOMOS_AGRENTING_QA_REPAIRS||3)));
    this.state.hirings[h.id]={...prior,...h,status:'executing',startedAt:new Date().toISOString(),skill:capability.skill};this.persist();
    try{({deliverable,qa}=await runAcceptedJob({opportunity,capability,llm,budget,env:this.env,config:execConfig,store:this.store,revision:Number(prior.revision||0),maxRepairs:repairs,feedback:h.clientMessage,onPhase:(phase,detail)=>{this.state.hirings[h.id]={...this.state.hirings[h.id],status:phase,...detail,acceptedAt:prior.acceptedAt||new Date().toISOString()};this.persist();}}));}
    catch(error){this.state.hirings[h.id]={...this.state.hirings[h.id],status:'execution_recovery_pending',retryAt:new Date(Date.now()+1800000).toISOString(),error:safe(error)};this.persist();return;}

    if(!deliverable||!qa?.ok){this.state.hirings[h.id]={...this.state.hirings[h.id],status:'qa_failed',retryAt:new Date(Date.now()+3600000).toISOString(),qaReasons:qa?.reasons||[],updatedAt:new Date().toISOString()};this.persist();this.event('hiring_qa_retry_pending',{id:h.id,reasons:qa?.reasons||[]});return;}
    this.state.hirings[h.id]={...this.state.hirings[h.id],deliverableSnapshot:deliverable,qaSnapshot:qa,budgetSpentUsd:budget.spent};this.persist();
    await this.submitResult(h,deliverable,qa,credential);
  }

  async submitResult(h,deliverable,qa,credential){
    const revision=Number(this.state.hirings[h.id]?.revision||0),intent=this.actionJournal.begin('agrenting',h.id,'deliver:'+revision);
    if(!intent.ok){await this.reconcileOne(h.id,credential);return;}
    this.state.hirings[h.id]={...this.state.hirings[h.id],status:'submitting',submissionIntentId:intent.id};this.persist();
    const urls=(deliverable.evidence?.toolCalls||[]).flatMap(x=>x.artifacts||[]).filter(x=>x.ok&&x.url).map(x=>x.url);
    try{
      const r=await fetch(`${BASE}/api/v1/hirings/${encodeURIComponent(h.id)}/result`,{method:'POST',headers:{'x-api-key':credential.apiKey,'content-type':'application/json',accept:'application/json','idempotency-key':`autonomos-result-${h.id}-${revision}`},body:JSON.stringify({output:{content:deliverable.content,artifacts:urls,qa_score:qa.score,completed_by:'AutonomOS'}}),signal:AbortSignal.timeout(20000)});
      const data=await json(r),result=data.data?.result||data.result||data.data||data;
      const proof=result.id||result.submission_id||result.result_id;
      if(r.ok&&proof){this.actionJournal.finish(intent.id,'confirmed',{externalId:String(proof)});this.state.hirings[h.id]={...this.state.hirings[h.id],status:'submitted',submissionId:String(proof),submittedAt:new Date().toISOString()};}
      else{const definite=[400,401,403,404,410,422,429].includes(r.status);this.actionJournal.finish(intent.id,definite?'definite_failure':'uncertain',{httpStatus:r.status});this.state.hirings[h.id]={...this.state.hirings[h.id],status:definite?'submission_failed':'submission_uncertain',retryAt:new Date(Date.now()+1800000).toISOString(),error:'result_http_'+r.status};}
    }catch{this.actionJournal.finish(intent.id,'uncertain');this.state.hirings[h.id]={...this.state.hirings[h.id],status:'submission_uncertain'};}
    this.persist();await this.reconcileOne(h.id,credential);
  }

  async failHiring(h,credential,reason){
    const r=await fetch(`${BASE}/api/v1/hirings/${encodeURIComponent(h.id)}/failure`,{method:'POST',headers:{'x-api-key':credential.apiKey,'content-type':'application/json',accept:'application/json'},body:JSON.stringify({reason:String(reason||'unsupported').slice(0,500)}),signal:AbortSignal.timeout(12_000)});this.state.hirings[h.id]={...(this.state.hirings[h.id]||h),status:r.ok?'failed_reported':'failure_report_uncertain',failureReason:String(reason||'').slice(0,500),updatedAt:new Date().toISOString()};this.persist();this.event('hiring_failed',{id:h.id,reported:r.ok,reason:String(reason||'').slice(0,180)});
  }

  async reconcileSubmitted(credential){for(const [id,row] of Object.entries(this.state.hirings||{})){if(!row?.submissionIntentId&&!row?.submittedAt||row.revenueRecordedAt)continue;await this.reconcileOne(id,credential);}}
  async reconcileOne(id,credential){
    const r=await fetch(`${BASE}/api/v1/hirings/${encodeURIComponent(id)}`,{headers:{'x-api-key':credential.apiKey,accept:'application/json'},signal:AbortSignal.timeout(12_000)});const data=await json(r);if(!r.ok)return;const row=data?.data?.hiring||data?.data||data?.hiring||data;const status=String(row?.status||'').toLowerCase();this.state.hirings[id]={...(this.state.hirings[id]||{}),marketStatus:status,lastReconciledAt:new Date().toISOString()};
    const local=this.state.hirings[id];
    const resultId=row?.result?.id||row?.submission_id||row?.result_id;
    if(resultId&&['submitted','in_review','completed','paid','revision_requested'].includes(status)){
      local.submissionId=String(resultId);local.submittedAt=local.submittedAt||new Date().toISOString();local.status='submitted';
      if(local.submissionIntentId)this.actionJournal.finish(local.submissionIntentId,'confirmed',{externalId:String(resultId)});
    }
    if(status==='revision_requested'&&row.updated_at!==local.lastRevisionAt){local.status='revision_requested';local.revision=Number(local.revision||0)+1;local.lastRevisionAt=row.updated_at;local.clientMessage=String(row.revision_request||row.feedback||'');delete local.deliverableSnapshot;delete local.qaSnapshot;delete local.submittedAt;}
    if(status==='completed'||status==='paid')local.clientAcceptedAt=local.clientAcceptedAt||new Date().toISOString();
    const payment=row.payment||row.payout||{},paymentStatus=String(payment.status||row.payment_status||'').toLowerCase(),transactionId=String(payment.transaction_id||payment.tx_hash||row.payment_transaction_id||'');
    if(['paid','settled','released','confirmed'].includes(paymentStatus)&&transactionId&&!local.revenueRecordedAt){
      const price=Number(payment.amount_usd||row.price||0),fee=Number(payment.fee_usd||0);
      if(price>0){appendUniqueLedgerEntry(this.store,ledgerEntry({id:`agrenting_revenue_${transactionId}`,type:'revenue',jobId:`agrenting_${id}`,externalId:id,externalTransactionId:transactionId,source:'agrenting',amountUsd:price,feeUsd:fee,currency:'USD',rail:'agrenting_escrow',status:'settled'}));local.revenueRecordedAt=new Date().toISOString();local.settledNetUsd=price-fee;local.status='paid';this.event('revenue_settled',{id,grossUsd:price,feeUsd:fee,netUsd:price-fee});}
    }
    this.persist();
  }

  currentConfig(){return normalizeConfig(this.store.readJson('config.json',{...DEFAULT_AUTONOMOS_CONFIG,enabled:true}));}
  capabilityContext(){return unifiedCapabilityContext(this.env,{llm:this.llm});}
  basePrice(){return Math.max(10,Number(this.env.AUTONOMOS_AGRENTING_MIN_PRICE_USD||30));}
  recordCost(id,amount){const n=Number(amount||0);if(!(n>0))return;appendUniqueLedgerEntry(this.store,ledgerEntry({id:`agrenting_cost_${id}_${crypto.randomUUID()}`,type:'cost',jobId:`agrenting_${id}`,externalId:id,source:'agrenting',amountUsd:n,grossUsd:n,currency:'USD',status:'incurred',note:`Execution cost for Agrenting hiring ${id}`}));}
  event(type,detail={}){const row={at:new Date().toISOString(),type,...detail};this.state.events.unshift(row);if(this.state.events.length>300)this.state.events.length=300;this.persist();try{this.logger.info?.('[AgrentingWorker] '+JSON.stringify(row));}catch{}}
  persist(){const tmp=this.stateFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.state,null,2),{mode:0o600});fs.renameSync(tmp,this.stateFile);}
  read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return structuredClone(fallback);}}
  writeSecret(file,value){const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});try{fs.chmodSync(tmp,0o600);}catch{}fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}}
}

function normalizeHiring(raw){const row=raw?.hiring||raw;const task=row?.task||{};return{id:String(row?.id||row?.hiring_id||''),status:String(row?.status||'').toLowerCase(),title:String(row?.task_description||task?.description||'Paid Agrenting task').slice(0,300),description:String(task?.description||row?.task_description||'').slice(0,8000),clientMessage:String(row?.client_message||'').slice(0,4000),taskInput:row?.task_input||task?.input||{},capability:String(row?.capability_requested||row?.capability||'').slice(0,120),price:Number(row?.price||0),deadlineAt:String(row?.deadline_at||''),deliveryMode:String(row?.delivery_mode||'output'),observedAt:new Date().toISOString()};}
function categoryFor(cap){const c=String(cap||'').toLowerCase();if(/translat/.test(c))return'translation';if(/code|develop|api|script/.test(c))return'coding';if(/data|csv|json|sheet/.test(c))return'data';if(/document|pdf|ppt|presentation/.test(c))return'document';if(/automat|gmail|notion|slack|calendar/.test(c))return'automation';if(/write|copy|content/.test(c))return'writing';return'custom';}
function arrayFrom(value,keys=[]){if(Array.isArray(value))return value;for(const key of keys){const v=value?.[key];if(Array.isArray(v))return v;if(v&&typeof v==='object'){for(const inner of ['items','hirings','data'])if(Array.isArray(v?.[inner]))return v[inner];}}return[];}
async function json(r){try{return await r.json();}catch{return{};}}
function publicError(data){return String(data?.errors?.[0]?.detail||data?.error?.message||data?.error||data?.message||data?.detail||'').slice(0,300);}
function enabled(value,fallback='false'){return !/^(0|false|no|off)$/i.test(String(value??fallback));}
function hash(value){return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,24);}
function safe(value){return String(value?.message||value||'').slice(0,300);}
function safeJson(value){try{return JSON.stringify(value||{}).slice(0,5000);}catch{return'{}';}}
