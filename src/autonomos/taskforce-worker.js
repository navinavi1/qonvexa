import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLlmClient } from './llm.js';
import { classifyOpportunity } from './capabilities.js';
import { executeExternalOpportunity } from './job-executor.js';
import { evaluateDeliverable } from './qa-engine.js';
import { createJobBudget } from './job-budget.js';
import { normalizeConfig, DEFAULT_AUTONOMOS_CONFIG } from './policy-engine.js';
import { computeEarnedSpendBudgetUsd, allocateRevenue } from './profit-engine.js';
import { AutonomOSStore } from './store.js';
import { ledgerEntry, appendUniqueLedgerEntry } from './financial-ledger.js';
import { paymentDestinations } from './payment-router.js';

const BASE='https://www.task-force.app';
const ACCEPTED=new Set(['ACCEPTED','IN_PROGRESS','WORKING','SUBMISSION_REJECTED']);

export class TaskForceWorker {
  constructor({env=process.env,storageDir='',logger=console}={}){
    this.env=env;this.logger=logger;
    this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');
    fs.mkdirSync(this.root,{recursive:true});
    this.globalStateFile=path.join(this.root,'global-work-hunter.json');
    this.secretFile=path.join(this.root,'global-work-credentials.private.json');
    this.stateFile=path.join(this.root,'taskforce-worker.json');
    this.store=new AutonomOSStore(this.root);
    this.llm=createLlmClient(env);
    this.state=this.read(this.stateFile,{version:1,tasks:{},settlements:{},withdrawals:{},events:[]});
    this.timer=null;this.running=false;
  }

  start(){
    if(this.timer)return;
    const every=Math.max(10_000,Number(this.env.AUTONOMOS_TASKFORCE_WORKER_INTERVAL_MS||15_000));
    setTimeout(()=>this.tick().catch(error=>this.event('worker_error',{error:safeError(error)})),5000).unref?.();
    this.timer=setInterval(()=>this.tick().catch(error=>this.event('worker_error',{error:safeError(error)})),every);this.timer.unref?.();
    this.event('worker_started',{intervalMs:every});
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}

  async tick(){
    if(this.running)return;
    this.running=true;
    try{
      const credential=this.read(this.secretFile,{}).taskforce;
      if(!credential?.apiKey||!credential?.verified)return;
      await this.reconcileEarnings(credential).catch(error=>this.event('earnings_error',{error:safeError(error)}));
      await this.withdrawOwnerShare(credential).catch(error=>this.event('withdraw_error',{error:safeError(error)}));
      const global=this.read(this.globalStateFile,{});
      const applications=global?.taskforce?.applications||{};
      const accepted=Object.entries(applications).filter(([,app])=>ACCEPTED.has(String(app?.status||'').toUpperCase()));
      for(const [taskId,app] of accepted){
        const row=this.state.tasks[taskId]||{};
        const appStatus=String(app?.status||'').toUpperCase();
        if(['submitted','submission_uncertain','completed','paid','blocked_capability'].includes(row.status)&&appStatus!=='SUBMISSION_REJECTED')continue;
        if(appStatus==='SUBMISSION_REJECTED'&&Number(row.repairCycles||0)>=3){this.state.tasks[taskId]={...row,status:'rejected_after_repairs',updatedAt:new Date().toISOString()};this.persist();continue;}
        await this.executeAccepted(taskId,app,global,credential);
        // One accepted task at a time prevents several workers reserving the same earned treasury.
        break;
      }
    }finally{this.running=false;}
  }

  async executeAccepted(taskId,application,global,credential){
    const started=Date.now();
    const previous=this.state.tasks[taskId]||{};
    this.state.tasks[taskId]={...previous,status:'preparing',applicationId:String(application?.applicationId||''),updatedAt:new Date().toISOString()};this.persist();
    const task=await this.fetchTask(taskId,global?.taskforce?.tasks?.[taskId],credential);
    if(!task){this.state.tasks[taskId]={...this.state.tasks[taskId],status:'task_detail_unavailable',updatedAt:new Date().toISOString()};this.persist();return;}
    const messages=await this.fetchMessages(taskId,credential);
    const opportunity={...task,jobId:`taskforce_${taskId}`,source:'taskforce',externalId:taskId,escrowed:true,status:'active',claimMode:'already_assigned',description:[task.description,messages.length?'\nTask conversation / clarifications:\n'+messages.map(m=>`- ${m}`).join('\n'):''].join('\n').slice(0,14000)};
    const capability=classifyOpportunity(opportunity,this.capabilityContext());
    if(!capability.executable){
      this.state.tasks[taskId]={...this.state.tasks[taskId],status:'blocked_capability',skill:capability.skill,missingTools:capability.missingTools||[],updatedAt:new Date().toISOString()};this.persist();
      this.event('task_blocked_capability',{taskId,skill:capability.skill,missingTools:capability.missingTools||[]});return;
    }

    const config=this.currentConfig();
    const ledger=this.store.readNdjson('ledger.ndjson',-1);
    const treasuryUsd=computeEarnedSpendBudgetUsd(ledger,config);
    if(treasuryUsd<=0.000001){this.state.tasks[taskId]={...this.state.tasks[taskId],status:'waiting_agent_treasury',updatedAt:new Date().toISOString()};this.persist();return;}
    const budget=createJobBudget(treasuryUsd,{env:this.env,onCost:amount=>this.recordCost(taskId,amount)});
    const budgetedLlm=budget.llm(this.llm);
    const executionConfig={...config,availableSpendUsd:treasuryUsd,maxPaidProcurementUsd:Math.max(Number(config.maxPaidProcurementUsd||0),treasuryUsd)};
    let briefing='';let deliverable=null;let qa=null;const maxRepairs=Math.max(1,Math.min(5,Number(this.env.AUTONOMOS_TASKFORCE_QA_REPAIRS||3)));
    const baseRepair=String(application?.status||'').toUpperCase()==='SUBMISSION_REJECTED'?Number(previous.repairCycles||0)+1:Number(previous.repairCycles||0);

    for(let attempt=0;attempt<maxRepairs;attempt++){
      this.state.tasks[taskId]={...this.state.tasks[taskId],status:'executing',attempt:attempt+1,skill:capability.skill,treasuryBudgetUsd:treasuryUsd,budgetRemainingUsd:budget.remaining,updatedAt:new Date().toISOString()};this.persist();
      try{
        deliverable=await executeExternalOpportunity(opportunity,capability,{llm:budgetedLlm,siteUrl:String(this.env.SITE_URL||this.env.PUBLIC_URL||''),env:this.env,config:executionConfig,briefing,budget});
        qa=await evaluateDeliverable(opportunity,deliverable,{llm:budgetedLlm,env:this.env});
        if(qa.ok)break;
        briefing=`Previous attempt failed QA. Repair the deliverable instead of repeating it. QA reasons: ${(qa.reasons||[]).join('; ')}. Previous output:\n${String(deliverable?.content||'').slice(0,5000)}`;
        this.event('task_qa_repair',{taskId,attempt:attempt+1,reasons:qa.reasons||[]});
      }catch(error){
        briefing=`Previous execution failed. Change approach/tools and finish the accepted task. Failure: ${safeError(error)}`;
        this.event('task_execution_repair',{taskId,attempt:attempt+1,error:safeError(error)});
        if(/job_spend_limit|job_spend_ceiling|emergency_stop/i.test(String(error?.message||error)))break;
      }
    }

    if(!deliverable||!qa?.ok){
      this.state.tasks[taskId]={...this.state.tasks[taskId],status:'repair_exhausted',repairCycles:baseRepair+1,qaReasons:qa?.reasons||[],budgetSpentUsd:budget.spent,updatedAt:new Date().toISOString()};this.persist();return;
    }
    await this.submit(taskId,deliverable,qa,credential,{started,repairCycles:baseRepair,budgetSpentUsd:budget.spent});
  }

  async submit(taskId,deliverable,qa,credential,meta={}){
    const artifactUrls=(deliverable?.evidence?.toolCalls||[]).flatMap(row=>row?.artifacts||[]).filter(x=>x?.ok&&x?.url).map(x=>x.url).slice(0,10);
    const intentId=crypto.randomUUID();
    this.state.tasks[taskId]={...(this.state.tasks[taskId]||{}),status:'submitting',submissionIntentId:intentId,submissionIntentAt:new Date().toISOString(),updatedAt:new Date().toISOString()};this.persist();
    const body={
      feedback:String(deliverable.content||'').slice(0,5000),
      deliverable:{format:String(deliverable.format||'text/markdown'),content:String(deliverable.content||'').slice(0,20000),artifactUrls,qa:{score:Number(qa.score||1),mode:String(qa.mode||'')}} ,
      timeSpent:Math.max(1,Math.ceil((Date.now()-Number(meta.started||Date.now()))/60000))
    };
    try{
      const r=await fetch(`${BASE}/api/agent/tasks/${encodeURIComponent(taskId)}/submit`,{method:'POST',headers:{...authHeaders(credential.apiKey),'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
      const data=await safeJson(r);
      if(r.ok||r.status===409&&/already|submitted/i.test(publicError(data))){
        const submission=data?.submission||data?.data||data;
        this.state.tasks[taskId]={...(this.state.tasks[taskId]||{}),status:'submitted',submissionId:String(submission?.id||''),submittedAt:new Date().toISOString(),repairCycles:Number(meta.repairCycles||0),budgetSpentUsd:Number(meta.budgetSpentUsd||0),qaScore:Number(qa.score||1),updatedAt:new Date().toISOString()};this.persist();
        this.event('task_submitted',{taskId,submissionId:String(submission?.id||''),qaScore:Number(qa.score||1)});return;
      }
      const uncertain=r.status>=500||r.status===408||r.status===429;
      this.state.tasks[taskId]={...(this.state.tasks[taskId]||{}),status:uncertain?'submission_uncertain':'submit_failed',submitHttpStatus:r.status,submitError:publicError(data),updatedAt:new Date().toISOString()};this.persist();
      this.event('task_submit_failed',{taskId,status:r.status,uncertain,error:publicError(data)});
    }catch(error){
      // The request may have reached the marketplace. Never replay an uncertain submit blindly.
      this.state.tasks[taskId]={...(this.state.tasks[taskId]||{}),status:'submission_uncertain',submitError:safeError(error),updatedAt:new Date().toISOString()};this.persist();
      this.event('task_submit_uncertain',{taskId,error:safeError(error)});
    }
  }

  async fetchTask(taskId,fallback,credential){
    for(const status of ['IN_PROGRESS','ACTIVE']){
      try{const r=await fetch(`${BASE}/api/agent/tasks?status=${status}&limit=100`,{headers:authHeaders(credential.apiKey),signal:AbortSignal.timeout(12000)});const data=await safeJson(r);if(!r.ok)continue;const rows=arrayFrom(data,['tasks','items','data']);const raw=rows.find(x=>String(x?.id||x?.taskId||'')===String(taskId));if(raw)return normalizeTask(raw);}catch{}
    }
    return fallback?{...fallback,budgetUsd:Number(fallback.budgetUsd||fallback.amount||0),currency:'USDC',network:'solana'}:null;
  }

  async fetchMessages(taskId,credential){
    try{const r=await fetch(`${BASE}/api/agent/tasks/${encodeURIComponent(taskId)}/messages?limit=100`,{headers:authHeaders(credential.apiKey),signal:AbortSignal.timeout(12000)});const data=await safeJson(r);if(!r.ok)return[];return arrayFrom(data,['messages','items','data']).slice(-100).map(m=>String(m?.content||m?.message||'').trim()).filter(Boolean).map(x=>x.slice(0,1500));}catch{return[];}
  }

  async reconcileEarnings(credential){
    const r=await fetch(`${BASE}/api/agent/earnings`,{headers:authHeaders(credential.apiKey),signal:AbortSignal.timeout(12000)});const data=await safeJson(r);if(!r.ok)return;
    const config=this.currentConfig();
    for(const tx of arrayFrom(data,['transactions','items','data'])){
      const amount=Number(tx?.amount||tx?.amountUsd||0);if(!(amount>0))continue;
      const stable=String(tx?.transactionHash||tx?.txHash||hash(JSON.stringify([tx?.taskTitle,amount,tx?.date])));
      const id=`taskforce_revenue_${hash(stable)}`;const allocation=allocateRevenue(amount,config);
      const added=appendUniqueLedgerEntry(this.store,ledgerEntry({id,type:'revenue',source:'taskforce',grossUsd:amount,amountUsd:amount,currency:'USDC',rail:'taskforce_solana_wallet',network:'solana',txId:String(tx?.transactionHash||tx?.txHash||''),status:'settled',allocation,note:String(tx?.taskTitle||'TaskForce completed task').slice(0,200)}));
      this.state.settlements[id]={id,amountUsd:amount,allocation,txHash:String(tx?.transactionHash||tx?.txHash||''),taskTitle:String(tx?.taskTitle||''),date:String(tx?.date||''),ledgerRecorded:true,ownerWithdrawn:Boolean(this.state.settlements[id]?.ownerWithdrawn),withdrawalState:this.state.settlements[id]?.withdrawalState||''};
      if(added)this.event('revenue_settled',{id,amountUsd:amount,ownerUsd:allocation.ownerUsd,agentTreasuryUsd:allocation.treasuryUsd});
    }
    this.persist();
  }

  async withdrawOwnerShare(credential){
    if(!/^(1|true|yes|on)$/i.test(String(this.env.AUTONOMOS_TASKFORCE_AUTO_OWNER_WITHDRAW||'false')))return;
    const destinations=paymentDestinations(this.env);const phantom=destinations.crypto?.wallets?.solana;if(!phantom?.configured)return;
    const pending=Object.values(this.state.settlements).find(x=>!x.ownerWithdrawn&&!['intent','uncertain'].includes(String(x.withdrawalState||''))&&Number(x.allocation?.ownerUsd||0)>0);if(!pending)return;
    const balanceRes=await fetch(`${BASE}/api/user/wallet/balance`,{headers:authHeaders(credential.apiKey),signal:AbortSignal.timeout(12000)});const balance=await safeJson(balanceRes);if(!balanceRes.ok)return;
    const usdc=Number(balance?.solana?.usdc||0),sol=Number(balance?.solana?.sol||0),amount=Number(pending.allocation.ownerUsd||0);const minGas=Number(this.env.AUTONOMOS_TASKFORCE_MIN_SOL_GAS||0.005);
    if(usdc+1e-9<amount||sol<minGas){pending.withdrawalState='waiting_balance_or_gas';pending.lastBalance={usdc,sol};this.persist();return;}
    pending.withdrawalState='intent';pending.withdrawalIntentAt=new Date().toISOString();this.persist();
    try{
      const r=await fetch(`${BASE}/api/agent/wallet/withdraw`,{method:'POST',headers:{...authHeaders(credential.apiKey),'content-type':'application/json'},body:JSON.stringify({destination:phantom.wallet,amount,chain:'solana'}),signal:AbortSignal.timeout(20000)});const data=await safeJson(r);
      if(r.ok){pending.ownerWithdrawn=true;pending.withdrawalState='confirmed';pending.withdrawalTxHash=String(data?.transactionHash||data?.txHash||data?.signature||'');pending.ownerDestination='phantom';pending.withdrawnAt=new Date().toISOString();this.persist();this.event('owner_share_withdrawn',{settlementId:pending.id,amountUsd:amount,destination:'phantom',txHash:pending.withdrawalTxHash});return;}
      pending.withdrawalState=r.status>=500?'uncertain':'failed';pending.withdrawalError=`http_${r.status}:${publicError(data)}`.slice(0,240);this.persist();
    }catch(error){pending.withdrawalState='uncertain';pending.withdrawalError=safeError(error);this.persist();}
  }

  currentConfig(){const raw=this.store.readJson('config.json',{...DEFAULT_AUTONOMOS_CONFIG,enabled:true});return normalizeConfig(raw);}
  recordCost(taskId,amount){if(!(Number(amount)>0))return;appendUniqueLedgerEntry(this.store,ledgerEntry({id:`taskforce_cost_${taskId}_${crypto.randomUUID()}`,type:'cost',jobId:`taskforce_${taskId}`,externalId:taskId,source:'taskforce',amountUsd:Number(amount),currency:'USD',status:'estimated',estimated:true,note:'TaskForce execution/QA reserved model or tool cost'}));}
  capabilityContext(){return{llmEnabled:Boolean(this.llm?.available??this.llm?.enabled),hasGithubPrTool:Boolean(this.env.GITHUB_TOKEN),hasShellTool:Boolean(this.env.E2B_API_KEY),hasBrowserTool:false,hasDeployTool:Boolean(this.env.AUTONOMOS_DEPLOY_WEBHOOK_URL),hasArtifactTool:Boolean((this.env.S3_ENDPOINT||this.env.R2_ENDPOINT)&&(this.env.S3_BUCKET||this.env.R2_BUCKET)),hasAppTool:Boolean(this.env.COMPOSIO_API_KEY),connectedApps:[],hasWebSearchTool:true,hasDesignMediaTool:false};}
  read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return structuredClone(fallback);}}
  persist(){const tmp=`${this.stateFile}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(this.state,null,2),{mode:0o600});fs.renameSync(tmp,this.stateFile);}
  event(type,detail={}){const row={at:new Date().toISOString(),type,...detail};this.state.events.unshift(row);if(this.state.events.length>500)this.state.events.length=500;this.persist();try{this.logger.info?.('[TaskForceWorker] '+JSON.stringify(row));}catch{}}
}

function normalizeTask(raw){const id=String(raw?.id||raw?.taskId||'');return{source:'taskforce',externalId:id,title:String(raw?.title||raw?.name||'TaskForce task'),description:[raw?.description,raw?.requirements].filter(Boolean).join('\n\nRequirements:\n').slice(0,10000),category:String(raw?.category||'other').toLowerCase(),budgetUsd:Number(raw?.totalBudget??raw?.budget??raw?.amount??raw?.reward??0),currency:'USDC',network:'solana',escrowed:true,status:String(raw?.status||'IN_PROGRESS').toLowerCase(),url:`${BASE}/tasks/${id}`,skills:Array.isArray(raw?.skillsRequired)?raw.skillsRequired:[]};}
function authHeaders(key){return{accept:'application/json','x-api-key':String(key||''),'user-agent':'AutonomOS-TaskForceWorker/1.0'};}
function arrayFrom(value,keys=[]){if(Array.isArray(value))return value;for(const key of keys){if(Array.isArray(value?.[key]))return value[key];}return[];}
function hash(value){return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,24);}
function safeError(error){return String(error?.message||error||'').slice(0,300);}
function publicError(value){if(typeof value==='string')return value.slice(0,300);return String(value?.error?.message||value?.error||value?.message||'').slice(0,300);}
async function safeJson(response){const raw=await response.text().catch(()=>'');try{return JSON.parse(raw);}catch{return{message:raw.slice(0,600)}}}
