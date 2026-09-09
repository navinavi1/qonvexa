import { recoverFreeCapability } from './free-tool-recovery.js';
import { refreshCapabilities } from './capability-registry.js';
import { classifyFailure } from './action-journal.js';
import { runAcceptedJob } from './accepted-job-engine.js';
import { FreelancerAdapter, freelancerAnalysis } from './freelancer-adapter.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { AutonomOSStore } from './store.js';
import { DynamicMarketRegistry } from './dynamic-market-registry.js';
import { NativeMarketAdapter,responseObject } from './native-market-adapter.js';
import { canonicalOpportunity,eligibility } from './canonical-opportunity.js';
import { classifyOpportunity } from './capabilities.js';
import { createJobBudget } from './job-budget.js';
import { computeEarnedSpendBudgetUsd } from './profit-engine.js';
import { ledgerEntry,appendUniqueLedgerEntry } from './financial-ledger.js';
const now=()=>new Date().toISOString();
export class NativeMarketWorker{
 constructor(actioner){this.a=actioner;this.env=actioner.env;this.root=actioner.root;this.store=new AutonomOSStore(this.root);this.registry=new DynamicMarketRegistry(this.root);this.running=false;}
 start(){this.timer=setInterval(()=>this.tick().catch(e=>this.a.event('native_market_error',{error:String(e.message).slice(0,200)})),60000);this.timer.unref?.();}
 stop(){clearInterval(this.timer);}
 save(id,patch){const rows=this.store.readJson('native-market-jobs.json',{});rows[id]={...rows[id],...patch,updatedAt:now()};this.store.writeJson('native-market-jobs.json',rows);return rows[id];}
 async tick(){
  const config=this.a.currentConfig();if(this.running||!config.enabled||config.killSwitch)return;this.running=true;
  try{
   const expansion=this.store.readJson('market-expansion.json',{}),credentials=this.store.readJson('dynamic-market-credentials.private.json',{}),feed=this.store.readJson('dynamic-market-feed.json',{});
   let jobs=this.store.readJson('native-market-jobs.json',{});
   if(this.env.FREELANCER_OAUTH_TOKEN){
    expansion.markets||={};expansion.markets['freelancer.com']={analysis:freelancerAnalysis};
    const leads=this.store.readJson('global-work-hunter.json',{}).leads||{};
    feed.rows||=[];for(const lead of Object.values(leads))if(lead.marketId==='freelancer.com'&&lead.externalId)feed.rows.push(lead);
   }
   for(const raw of feed.rows||[]){
    const market=expansion.markets?.[raw.marketId],analysis=market?.analysis;if(!analysis?.claim||!analysis.delivery||!analysis.details||!raw.externalId)continue;
    const id=crypto.createHash('sha256').update(raw.marketId+':'+raw.externalId).digest('hex').slice(0,24);
    if(!jobs[id])this.save(id,{id,externalId:raw.externalId,marketId:raw.marketId,status:'discovered',opportunity:canonicalOpportunity({...raw,source:raw.marketId,workType:'REAL_MARKET_JOB',claimRoute:'API_APPLICATION',competitive:analysis.claim.kind==='competitive'})});
   }
   jobs=this.store.readJson('native-market-jobs.json',{});
   const pending=Object.values(jobs).filter(j=>!['paid','rejected','expired'].includes(j.status)&&(!j.nextRetryAt||Date.parse(j.nextRetryAt)<=Date.now())).sort((a,b)=>Number(!!b.acceptedAt)-Number(!!a.acceptedAt)||Date.parse(a.opportunity.deadline||'9999-01-01')-Date.parse(b.opportunity.deadline||'9999-01-01'));
   await Promise.allSettled(pending.slice(0,10).map(async job=>{
    const analysis=expansion.markets?.[job.marketId]?.analysis;if(!analysis)return;
    const Adapter=job.marketId==='freelancer.com'?FreelancerAdapter:NativeMarketAdapter;const adapter=new Adapter({id:job.marketId,analysis,credential:credentials[job.marketId],root:this.root,env:this.env});
    const version=crypto.createHash('sha256').update(JSON.stringify([analysis,credentials[job.marketId]||{},job.marketId==='freelancer.com'?this.env.FREELANCER_OAUTH_TOKEN||'':''])).digest('hex');if(job.holdUntilChange&&job.connectorVersion===version)return;
    job=this.save(job.id,{connectorVersion:version,holdUntilChange:false});
    try{if(adapter.prepare)await adapter.prepare();await this.process(job,adapter,config);}catch(e){const failure=classifyFailure(Number(String(e.message).match(/http_(\d+)/)?.[1]||0),e.message);await this.fail(job,failure,String(e.message));}
   }));
  }finally{this.running=false;}
 }
 async fail(job,failure,reason){
  if(failure.type==='SCHEMA_DRIFT'){const repairs=this.store.readJson('connector-repair-requests.json',{});repairs[job.marketId]={requestedAt:now(),reason:String(reason).slice(0,180)};this.store.writeJson('connector-repair-requests.json',repairs);}
  this.save(job.id,{failure,reason:String(reason).slice(0,220),holdUntilChange:!failure.retryable,connectorVersion:job.connectorVersion,nextRetryAt:new Date(Date.now()+1800000).toISOString()});
 }
 evidence(job,kind,proof){this.registry.observe(job.marketId,{lastError:'',evidence:{[kind]:{...proof,verified:true,verifiedAt:now()}}});}
 async process(job,adapter,config){
  if(adapter.analysis.automationPermitted!==true){this.save(job.id,{reason:'automation_permission_unverified',nextRetryAt:new Date(Date.now()+86400000).toISOString()});return;}
  const detail=await adapter.request(adapter.analysis.details,{jobId:job.externalId});if(!detail.ok)throw Error('native_details_http_'+detail.status);
  const raw=responseObject(detail.data),status=String(raw.status||'').toLowerCase(),agentId=String(adapter.credential.agentId||adapter.credential.agent_id||adapter.credential.id||'');
  if(['expired','cancelled'].includes(status)){this.save(job.id,{status:'expired'});return;}
  const op=canonicalOpportunity({...job.opportunity,...raw,source:job.marketId,externalId:job.externalId,workType:raw.workType||job.opportunity.workType||'REAL_MARKET_JOB',claimRoute:'API_APPLICATION',observedAt:now(),fresh:true});
  if(raw.id||raw.job_id){this.evidence(job,'details',{externalId:String(raw.id||raw.job_id),url:detail.url});this.evidence(job,'status',{externalId:String(raw.id||raw.job_id),url:detail.url});}
  if(agentId&&adapter.analysis.details.security?.length)this.evidence(job,'authentication',{externalId:agentId,url:detail.url});
  const identity=String(raw.assigned_agent_id||raw.assignedAgentId||raw.provider_id||'');
  const assigned=!!agentId&&identity===agentId;
  if(!job.applicationId&&!assigned){
   if(job.status==='application_uncertain'){const recovered=await adapter.reconcile('claim',job);if(recovered)this.save(job.id,{applicationId:String(recovered.id),applied:true,status:'applied'});return;}
   const check=eligibility({...op,applicationCostUsd:adapter.analysis.applicationCostUsd},this.env,{phase:'application'});if(!check.eligible){this.save(job.id,{opportunity:op,reason:check.reasons.join(','),nextRetryAt:new Date(Date.now()+3600000).toISOString()});return;}
   let cap=classifyOpportunity({...op,budgetUsd:op.payoutUsd},this.a.capabilityContext());if(!cap.executable){for(const gap of cap.missingTools||[])await recoverFreeCapability(gap,this.env);await refreshCapabilities(this.env);cap=classifyOpportunity({...op,budgetUsd:op.payoutUsd},this.a.capabilityContext());}if(!cap.executable)throw Error('capability_recovery_required');
   const result=await adapter.write('claim',job,{job_id:job.externalId,jobId:job.externalId,task_id:job.externalId,agent_id:agentId,proposal:'AutonomOS is an AI-assisted digital services agency. We will execute and verify this task after assignment.',description:'AI-assisted execution with QA evidence.',amount:op.payoutUsd});
   if(result.ok)this.evidence(job,'application',result.proof);
   this.save(job.id,{opportunity:op,status:result.ok?'applied':result.uncertain?'application_uncertain':'application_failed',applicationId:result.proof?.externalId||'',applied:result.ok,reason:result.error||result.failure?.type||'',nextRetryAt:new Date(Date.now()+(result.ok?900000:3600000)).toISOString()});if(result.failure&&!result.uncertain)await this.fail(job,result.failure,result.failure.type);return;
  }
  if(['paid','settled','released'].includes(String(raw.payment_status||raw.payout?.status||'').toLowerCase())){
    const tx=raw.payment_transaction_id||raw.payout?.transaction_id,amount=Number(raw.payout?.amount_usd||raw.paid_amount_usd||0);
    const payments=Array.isArray(raw.payments)?raw.payments:[{id:tx,amountUsd:amount,feeUsd:Number(raw.payout?.fee_usd||0)}];
    let received=0;for(const payment of payments){if(!payment.id||!(Number(payment.amountUsd)>0))continue;received+=Number(payment.amountUsd);appendUniqueLedgerEntry(this.store,ledgerEntry({id:'native_'+job.marketId+'_'+payment.id,type:'revenue',jobId:job.id,externalId:job.externalId,externalTransactionId:String(payment.id),source:job.marketId,amountUsd:Number(payment.amountUsd),feeUsd:Number(payment.feeUsd||0),status:'settled'}));}
    if(received>0&&op.payoutUsd>0&&received>=op.payoutUsd){this.evidence(job,'payout',{externalId:String(payments.find(p=>p.id)?.id),url:detail.url});this.save(job.id,{status:'paid',paidAt:now()});return;}
    if(received>0)this.save(job.id,{receivedUsd:received,payoutStatus:'PARTIALLY_PAID'});
  }
  if(!assigned){this.save(job.id,{reason:'awaiting_market_assignment',nextRetryAt:new Date(Date.now()+900000).toISOString()});return;}
  if(['completed','accepted','approved'].includes(status)&&job.delivered){this.save(job.id,{status:'client_accepted',clientAcceptedAt:now(),nextRetryAt:new Date(Date.now()+1800000).toISOString()});return;}
  const revision=status==='revision_requested'&&String(raw.updated_at)!==job.revisionAt;
  if(revision)job=this.save(job.id,{status:'revision_requested',revision:Number(job.revision||0)+1,revisionAt:String(raw.updated_at),revisionRequestedAt:now(),delivered:false,feedback:String(raw.feedback||raw.revision_request||'')});
  if(job.status==='delivery_uncertain'){const receipt=await adapter.reconcile('delivery',job);if(receipt)this.save(job.id,{status:'submitted',delivered:true,submissionId:String(receipt.id),submittedAt:now()});return;}
  if(job.delivered){this.save(job.id,{nextRetryAt:new Date(Date.now()+900000).toISOString()});return;}
  job=this.save(job.id,{acceptedAt:job.acceptedAt||now(),status:'executing',opportunity:op});
  const limit=Math.min(computeEarnedSpendBudgetUsd(this.store.readNdjson('ledger.ndjson',-1),config),Number(op.payoutUsd)*.35,Number(config.maxPaidProcurementUsd||3));if(!(limit>0))throw Error('execution_budget_unavailable');
  const budget=createJobBudget(limit,{env:this.env,jobId:job.id,onCost:n=>this.a.recordCost(job.id,n)}),llm=budget.llm(this.a.llm),opportunity={...op,jobId:job.id,budgetUsd:op.payoutUsd,claimMode:'already_assigned',status:'active'};
  const {deliverable:output,qa}=await runAcceptedJob({opportunity,capability:classifyOpportunity(opportunity,this.a.capabilityContext()),llm,budget,env:this.env,config:{...config,availableSpendUsd:limit},store:this.store,revision:Number(job.revision||0),feedback:job.feedback||'',onPhase:(phase,detail)=>this.save(job.id,{status:phase,...detail})});
  if(!qa?.ok){this.save(job.id,{status:'qa_failed',reason:qa?.reasons?.join('; '),nextRetryAt:new Date(Date.now()+3600000).toISOString()});return;}
  this.evidence(job,'execution',{externalId:output.hash,url:detail.url});
  const result=await adapter.write('delivery',job,{job_id:job.externalId,task_id:job.externalId,application_id:job.applicationId,agent_id:agentId,content:output.content,result:output.content,output:output.content,feedback:output.content});
  if(result.ok)this.evidence(job,'delivery',result.proof);
  this.save(job.id,{status:result.ok?'submitted':result.uncertain?'delivery_uncertain':'delivery_failed',delivered:result.ok,submissionId:result.proof?.externalId||'',submittedAt:result.ok?now():'',reason:result.error||result.failure?.type||'',nextRetryAt:new Date(Date.now()+900000).toISOString()});if(result.failure&&!result.uncertain)await this.fail(job,result.failure,result.failure.type);
 }
}
