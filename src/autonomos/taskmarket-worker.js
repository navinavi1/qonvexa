import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AutonomOSStore } from './store.js';
import { createTaskmarketClient, tasksFromListing, normalizeTask } from './taskmarket.js';
import { canonicalOpportunity, eligibility } from './canonical-opportunity.js';
import { classifyOpportunity } from './capabilities.js';
import { createJobBudget } from './job-budget.js';
import { computeEarnedSpendBudgetUsd } from './profit-engine.js';
import { ledgerEntry, appendUniqueLedgerEntry } from './financial-ledger.js';
import { runAcceptedJob } from './accepted-job-engine.js';

const now=()=>new Date().toISOString();
const STATE_FILE='taskmarket-jobs.json';
const TERMINAL=['paid','rejected','expired','abandoned'];

export class TaskmarketWorker{
  constructor(actioner,{env=actioner?.env,storageDir=actioner?.root,logger=console,client=null}={}){
    this.a=actioner;this.env=env||process.env;this.root=storageDir;this.logger=logger;
    this.store=new AutonomOSStore(this.root);
    this.client=client||createTaskmarketClient({env:this.env,logger});
    this.intervalMs=Math.max(60000,Number(this.env.AUTONOMOS_TASKMARKET_INTERVAL_MS||180000));
    this.running=false;
  }
  start(){if(!this.client.enabled){this.logger?.info?.('[Taskmarket] '+JSON.stringify({started:false,reason:'AUTONOMOS_TASKMARKET_ENABLED is not set'}));return;}
    this.timer=setInterval(()=>this.tick().catch(e=>this.logger?.warn?.('[Taskmarket] tick_error '+String(e.message).slice(0,200))),this.intervalMs);this.timer.unref?.();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}

  save(id,patch){const rows=this.store.readJson(STATE_FILE,{});rows[id]={...rows[id],...patch,updatedAt:now()};this.store.writeJson(STATE_FILE,rows);return rows[id];}
  jobId(taskId){return crypto.createHash('sha256').update('taskmarket:'+taskId).digest('hex').slice(0,24);}

  // Taskmarket requires a signed acceptance of its Terms, Privacy Policy, Risk Disclosure
  // and Acceptable Use Policy before the first marketplace write. That is an agreement
  // binding the owner, so the agent must never sign it on their behalf and must never infer
  // assent from the lane simply being switched on. Discovery is a read and stays allowed;
  // claiming stops here with the exact command the owner runs once they have read them.
  async legalAccepted(){
    if(this.legalOk===true)return true;
    const status=await this.client.legalStatus();
    const text=JSON.stringify(status?.data??status??{});
    const accepted=status.ok===true&&/"(accepted|current|valid)"\s*:\s*true|"status"\s*:\s*"(accepted|current)"/i.test(text);
    if(accepted)this.legalOk=true;
    else this.logger?.warn?.('[Taskmarket] '+JSON.stringify({claiming:false,reason:'legal_terms_not_accepted',
      action:'the owner must review the policy bundle and run: taskmarket legal accept'}));
    return accepted;
  }

  async tick(){
    const config=this.a?.currentConfig?.()||{enabled:true,killSwitch:false};
    if(this.running||!config.enabled||config.killSwitch)return;
    this.running=true;
    try{
      await this.discover();
      if(!await this.legalAccepted())return;
      const jobs=this.store.readJson(STATE_FILE,{});
      const pending=Object.values(jobs)
        .filter(job=>!TERMINAL.includes(job.status))
        .filter(job=>!job.nextRetryAt||Date.parse(job.nextRetryAt)<=Date.now())
        .sort((a,b)=>Number(b.rewardUsd||0)-Number(a.rewardUsd||0));
      for(const job of pending.slice(0,3)){
        try{await this.process(job,config);}
        catch(e){this.save(job.id,{reason:String(e.message).slice(0,220),nextRetryAt:new Date(Date.now()+1800000).toISOString()});}
      }
    }finally{this.running=false;}
  }

  async discover(){
    const listing=await this.client.listOpenTasks({mode:'claim',limit:20});
    if(!listing.ok){this.logger?.warn?.('[Taskmarket] '+JSON.stringify({discover:false,reason:listing.error||'listing_failed'}));return;}
    const tasks=tasksFromListing(listing);
    this.logger?.info?.('[Taskmarket] '+JSON.stringify({discovered:tasks.length,openToAgents:tasks.filter(t=>!t.claimedBy).length}));
    const known=this.store.readJson(STATE_FILE,{});
    for(const task of tasks){
      if(task.claimedBy)continue;
      const id=this.jobId(task.taskId);
      if(known[id])continue;
      this.save(id,{id,taskId:task.taskId,status:'discovered',mode:task.mode,rewardUsd:task.rewardUsd,deadline:task.deadline,description:task.description.slice(0,500),discoveredAt:now()});
    }
  }

  // Taskmarket task text is untrusted input: it is only ever passed to the job
  // executor as a work description, never interpolated into a shell or a CLI flag
  // that could change which command runs.
  opportunityFor(job){
    return canonicalOpportunity({
      externalId:job.taskId,source:'taskmarket.dev',title:('Taskmarket task '+job.taskId).slice(0,120),
      description:String(job.description||''),payoutUsd:Number(job.rewardUsd||0),currency:'USDC',
      deadline:job.deadline||'',workType:'REAL_MARKET_JOB',claimRoute:'API_APPLICATION',
      competitive:false,observedAt:now(),fresh:true
    });
  }

  async process(job,config){
    const detail=await this.client.getTask(job.taskId);
    if(!detail.ok){this.save(job.id,{reason:detail.error||'task_get_failed',nextRetryAt:new Date(Date.now()+3600000).toISOString()});return;}
    const task=normalizeTask(detail.data||detail.task||detail);
    if(['cancelled','expired','completed'].includes(task.status)&&job.status!=='submitted'){this.save(job.id,{status:'expired',reason:'task_'+task.status});return;}

    const opportunity=this.opportunityFor({...job,rewardUsd:task.rewardUsd||job.rewardUsd,description:task.description||job.description});
    const check=eligibility({...opportunity,applicationCostUsd:0},this.env,{phase:'application'});
    if(!check.eligible){this.save(job.id,{status:'skipped',reason:check.reasons.join(','),nextRetryAt:new Date(Date.now()+86400000).toISOString()});return;}

    const capability=classifyOpportunity({...opportunity,budgetUsd:opportunity.payoutUsd},this.a?.capabilityContext?.()||{});
    if(!capability.executable){this.save(job.id,{status:'skipped',reason:'capability_missing:'+(capability.missingTools||[]).join(','),nextRetryAt:new Date(Date.now()+86400000).toISOString()});return;}

    if(!job.claimed){
      const claim=await this.client.claimTask(job.taskId);
      if(!claim.ok){this.save(job.id,{reason:claim.error||'claim_failed',nextRetryAt:new Date(Date.now()+3600000).toISOString()});return;}
      job=this.save(job.id,{status:'claimed',claimed:true,claimedAt:now()});
    }
    if(job.submitted){this.save(job.id,{nextRetryAt:new Date(Date.now()+900000).toISOString()});return;}

    const ledger=this.store.readNdjson('ledger.ndjson',-1);
    const limit=Math.min(computeEarnedSpendBudgetUsd(ledger,config),Number(opportunity.payoutUsd)*0.35,Number(config.maxPaidProcurementUsd||3));
    if(!(limit>0)){this.save(job.id,{status:'claimed',reason:'execution_budget_unavailable',nextRetryAt:new Date(Date.now()+3600000).toISOString()});return;}

    const budget=createJobBudget(limit,{env:this.env,jobId:job.id,onCost:n=>this.a?.recordCost?.(job.id,n)});
    const {deliverable,qa}=await runAcceptedJob({
      opportunity:{...opportunity,jobId:job.id,budgetUsd:opportunity.payoutUsd,claimMode:'already_assigned',status:'active'},
      capability,llm:budget.llm(this.a?.llm),budget,env:this.env,
      config:{...config,availableSpendUsd:limit},store:this.store,revision:0,feedback:'',
      onPhase:(phase,detail)=>this.save(job.id,{status:phase,...detail})
    });
    if(!qa?.ok){this.save(job.id,{status:'qa_failed',reason:(qa?.reasons||[]).join('; ').slice(0,220),nextRetryAt:new Date(Date.now()+3600000).toISOString()});return;}

    const file=this.writeDeliverable(job.id,deliverable.content);
    const submission=await this.client.submitWork(job.taskId,[file]);
    this.save(job.id,{status:submission.ok?'submitted':'submission_failed',submitted:Boolean(submission.ok),submittedAt:submission.ok?now():'',reason:submission.error||'',nextRetryAt:new Date(Date.now()+900000).toISOString()});
  }

  writeDeliverable(jobId,content){
    const dir=path.join(this.root,'taskmarket-deliverables');
    fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,jobId+'.md');
    fs.writeFileSync(file,String(content||''),{mode:0o600});
    return file;
  }

  // Called once a Taskmarket payout is observed; keeps the ledger the single source
  // of truth for the owner/agent split rather than trusting the platform's own totals.
  recordPayout(job,{transactionId,amountUsd}){
    if(!transactionId||!(Number(amountUsd)>0))return false;
    // Report what the ledger actually did. Discarding appendUniqueLedgerEntry's result and
    // returning true regardless meant a replayed settlement looked like fresh revenue to
    // every caller, even though the ledger had correctly refused to double-count it.
    const recorded=appendUniqueLedgerEntry(this.store,ledgerEntry({
      id:'taskmarket_'+transactionId,type:'revenue',jobId:job.id,externalId:job.taskId,
      externalTransactionId:String(transactionId),source:'taskmarket.dev',
      amountUsd:Number(amountUsd),feeUsd:0,currency:'USDC',network:'eip155:8453',status:'settled'
    }));
    // Closing the job stays idempotent: a replay of a payout we already booked must still
    // leave the job paid, it just is not new money.
    this.save(job.id,{status:'paid',paidAt:now(),receivedUsd:Number(amountUsd)});
    return recorded;
  }
}
