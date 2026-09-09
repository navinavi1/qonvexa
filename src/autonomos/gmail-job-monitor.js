import { GmailMailbox, isClientReply } from './gmail-mailbox.js';
import { recoverFreeCapability } from './free-tool-recovery.js';
import { composioExecute } from './composio-tool.js';
import { classifyOpportunity } from './capabilities.js';
import { executeExternalOpportunity } from './job-executor.js';
import { evaluateDeliverable } from './qa-engine.js';
import { createJobBudget } from './job-budget.js';
import { computeEarnedSpendBudgetUsd } from './profit-engine.js';

const ACCEPTED=/\b(?:we(?:'d| would) like to (?:proceed|move forward)|your (?:proposal|application) (?:is|was|has been) accepted|we (?:have )?(?:selected|chosen) you|you(?:'re| are) hired|project (?:is )?awarded to you|please (?:start|proceed|begin)|go ahead with (?:the )?(?:work|project)|we want to work with you)\b/i;
const REJECTED=/\b(?:not selected|not moving forward|proposal rejected|application rejected|decided to (?:go|move) with another|position has been filled|project (?:was )?awarded to another)\b/i;
const NEEDS_INFO=/\b(?:could you|can you|please (?:send|share|confirm|clarify)|more information|need (?:more|some) details|availability|timeline|estimate|quote|portfolio|sample)\b/i;
const PAYMENT_SIGNAL=/\b(?:payment sent|payment released|funds released|paid you|payment completed|transaction (?:hash|id)|usdc sent|usdt sent)\b/i;

export class GmailJobMonitor{
  constructor({actioner,env=process.env,logger=console}={}){this.actioner=actioner;this.env=env;this.logger=logger;this.timer=null;this.running=false;this.mailbox=new GmailMailbox(env);this.lastMailboxHealth=0;}
  start(){if(this.timer||!this.actioner)return;const every=Math.max(60_000,Number(this.env.AUTONOMOS_GMAIL_JOB_MONITOR_MS||5*60_000));setTimeout(()=>this.tick().catch(e=>this.log('gmail_monitor_error',{error:safe(e)})),20_000).unref?.();this.timer=setInterval(()=>this.tick().catch(e=>this.log('gmail_monitor_error',{error:safe(e)})),every);this.timer.unref?.();this.log('gmail_job_monitor_started',{intervalMs:every});}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}

  async tick(){
    if(this.running||!this.actioner)return;this.running=true;
    try{
      const rows=Object.entries(this.actioner.state?.actions||{}).filter(([,a])=>['applied_email','submitted_email','email_needs_info'].includes(String(a?.status||''))&&(!a?.nextCheckAt||Date.parse(a.nextCheckAt)<=Date.now())).slice(0,20);
      for(const [id,action] of rows)await this.checkOne(id,action);
    }finally{this.running=false;this.actioner.persist?.();}
  }

  async checkOne(id,action){
    const title=String(action?.title||'').trim();if(!title)return;
    const messages=await this.searchReplies(title,action);
    if(!messages.ok){this.actioner.setAction(id,{nextCheckAt:new Date(Date.now()+30*60_000).toISOString(),emailMonitorError:messages.error||'gmail_search_failed'});return;}
    if(action.status==='application_uncertain'&&messages.rows.some(x=>x.labels?.includes('SENT'))){this.actioner.setAction(id,{status:'applied_email',reconciledApplicationFromGmail:true});}
    const own=this.mailbox.ownEmail||registrationEmail(this.env).toLowerCase();
    const appliedAt=Date.parse(String(action.appliedAt||0));
    const candidates=messages.rows.filter(row=>{
      const from=String(row.from||'').toLowerCase();const at=Date.parse(String(row.at||0));
      return isClientReply(row,action,own)&&(!Number.isFinite(appliedAt)||!Number.isFinite(at)||at>=appliedAt-60_000);
    });
    const latest=candidates.sort((a,b)=>Date.parse(b.at||0)-Date.parse(a.at||0))[0];
    if(action.gmailThreadId)this.actioner.setAction(id,{gmailThreadId:action.gmailThreadId,gmailMessageId:action.gmailMessageId});
    if(!latest||latest.id&&latest.id===action.lastProcessedReplyId){this.actioner.setAction(id,{nextCheckAt:new Date(Date.now()+30*60_000).toISOString(),lastEmailCheckedAt:new Date().toISOString()});return;}
    const text=String(latest.text||'').slice(0,12000);
    this.actioner.setAction(id,{lastProcessedReplyId:latest.id||'',replyMessageRfcId:latest.rfcMessageId||'',replySubject:latest.subject||'',lastEmailCheckedAt:new Date().toISOString()});
    if(String(action.status)==='submitted_email'){
      if(PAYMENT_SIGNAL.test(text)){
        // Email is NOT settlement truth. Surface the signal, but do not book revenue until
        // wallet/marketplace reconciliation proves funds actually arrived.
        this.actioner.setAction(id,{status:'submitted_email',paymentClaimSeen:true,paymentClaimAt:new Date().toISOString(),paymentClaimFrom:maskEmail(latest.from),nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});
        this.log('email_payment_claim_seen',{id});return;
      }
      this.actioner.setAction(id,{nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});return;
    }
    if(REJECTED.test(text)){this.actioner.archive(id,'archived','email application rejected by client');this.log('email_application_rejected',{id});return;}
    if(ACCEPTED.test(text)){
      this.actioner.setAction(id,{status:'accepted_email',acceptedAt:new Date().toISOString(),acceptedBy:maskEmail(latest.from),replyFrom:String(latest.from||''),clientReply:text.slice(0,5000),nextCheckAt:''});
      this.actioner.state.stats.accepted=Number(this.actioner.state.stats.accepted||0)+1;this.log('email_application_accepted',{id});
      await this.executeAndDeliver(id,this.actioner.state.actions[id]);return;
    }
    if(NEEDS_INFO.test(text)){
      this.actioner.setAction(id,{status:'email_needs_info',clientReply:text.slice(0,5000),replyFrom:String(latest.from||''),nextCheckAt:new Date(Date.now()+60*60_000).toISOString()});
      await this.answerClarification(id,this.actioner.state.actions[id],text).catch(()=>{});return;
    }
    this.actioner.setAction(id,{lastEmailCheckedAt:new Date().toISOString(),nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});
  }

  async executeAndDeliver(id,action){
    if(['executing_email','submitted_email','paid'].includes(String(action?.status||'')))return;
    const hunter=this.actioner.read(this.actioner.hunterFile,{});const lead=hunter?.leads?.[id]||{id,title:action.title,url:action.url,category:action.category,amountUsd:action.payout?.amountUsd,payoutCurrency:action.payout?.currency,snippet:''};
    const clientReply=String(action.clientReply||'');
    const opportunity=this.actioner.toOpportunity(lead,`${lead.snippet||''}\n\nCLIENT ACCEPTANCE / REQUIREMENTS:\n${clientReply}`);opportunity.claimMode='already_assigned';opportunity.status='active';opportunity.jobId=`email_${id}`;
    let capability=classifyOpportunity({...opportunity,description:`${lead.title||''}\n${lead.snippet||''}\n${clientReply}`.slice(0,9000)},this.actioner.capabilityContext());
    if(!capability.executable){for(const gap of capability.missingTools||[])await recoverFreeCapability(gap,this.env);capability=classifyOpportunity(opportunity,this.actioner.capabilityContext());}
    if(!capability.executable){this.actioner.setAction(id,{status:'accepted_needs_capability',missingTools:capability.missingTools||[],skill:capability.skill,nextCheckAt:new Date(Date.now()+60*60_000).toISOString()});return;}
    const config=this.actioner.currentConfig();const ledger=this.actioner.store.readNdjson('ledger.ndjson',-1);const treasury=computeEarnedSpendBudgetUsd(ledger,config);
    if(treasury<=0.000001){this.actioner.setAction(id,{status:'accepted_waiting_treasury',nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});return;}
    const budget=createJobBudget(treasury,{env:this.env,onCost:amount=>this.actioner.recordCost(id,amount)});const llm=budget.llm(this.actioner.llm);const executionConfig={...config,availableSpendUsd:treasury,maxPaidProcurementUsd:Math.max(Number(config.maxPaidProcurementUsd||0),treasury)};
    let deliverable=null,qa=null,briefing='';const maxRepairs=Math.max(1,Math.min(5,Number(this.env.AUTONOMOS_GLOBAL_QA_REPAIRS||3)));
    for(let attempt=1;attempt<=maxRepairs;attempt++){
      this.actioner.setAction(id,{status:'executing_email',attempt,skill:capability.skill,treasuryBudgetUsd:treasury,budgetRemainingUsd:budget.remaining});
      try{
        deliverable=await executeExternalOpportunity(opportunity,capability,{llm,siteUrl:String(this.env.SITE_URL||''),env:this.env,config:executionConfig,briefing,budget});
        qa=await evaluateDeliverable(opportunity,deliverable,{llm,env:this.env});if(qa.ok)break;
        briefing=`Repair the previous deliverable. QA reasons: ${(qa.reasons||[]).join('; ')}. Previous output:\n${String(deliverable?.content||'').slice(0,5000)}`;
      }catch(error){briefing=`Execution failed. Change approach/tools and finish the accepted task. Error: ${safe(error)}`;}
    }
    if(!deliverable||!qa?.ok){this.actioner.setAction(id,{status:'accepted_repair_exhausted',qaReasons:qa?.reasons||[],nextCheckAt:new Date(Date.now()+2*60*60_000).toISOString()});return;}
    const artifacts=(deliverable?.evidence?.toolCalls||[]).flatMap(x=>x?.artifacts||[]).filter(x=>x?.ok&&x?.url).map(x=>x.url).slice(0,10);
    const body=[String(deliverable.content||''),'',...(artifacts.length?['Deliverable files:',...artifacts]:[]),'','Completed by AutonomOS.'].join('\n').slice(0,18000);
    const recipient=extractEmail(action.replyFrom)||String(action.recipient||'');if(!recipient){this.actioner.setAction(id,{status:'submission_uncertain',reason:'accepted email sender address unavailable',nextCheckAt:new Date(Date.now()+60*60_000).toISOString()});return;}
    const subject=`Re: Application: ${String(action.title||lead.title||'Paid digital project').replace(/\s+/g,' ').slice(0,120)} — AutonomOS`;
    this.actioner.setAction(id,{status:'delivery_email_in_progress',deliveryRecipient:recipient,qaScore:Number(qa.score||1),budgetSpentUsd:budget.spent});
    const sent=await this.sendEmail(recipient,action.replySubject||subject,body,action);
    if(sent.ok){this.actioner.setAction(id,{status:'submitted_email',submittedAt:new Date().toISOString(),emailDeliveryLogId:String(sent.logId||''),nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});this.actioner.state.stats.submitted=Number(this.actioner.state.stats.submitted||0)+1;this.log('email_work_submitted',{id,qaScore:Number(qa.score||1)});return;}
    // Do not auto-resend after an external send attempt with ambiguous result.
    this.actioner.setAction(id,{status:'submission_uncertain',reason:`email delivery outcome uncertain: ${String(sent.error||'unknown').slice(0,220)}`,nextCheckAt:new Date(Date.now()+60*60_000).toISOString()});
  }

  async answerClarification(id,action,clientText){
    if(action.clarificationReplyId===action.lastProcessedReplyId||action.clarificationSendInProgress)return;
    const recipient=extractEmail(action.replyFrom);if(!recipient)return;
    const title=String(action.title||'project');
    let answer=`Thanks for the follow-up. AutonomOS is ready to complete the stated ${title} scope. Please send the exact deliverable requirements, source materials/authorized links, deadline, and acceptance criteria if they were not included in the listing.`;
    if(this.actioner.llm?.enabled){
      const result=await this.actioner.llm.complete({system:'Reply as AutonomOS, an AI-assisted digital-services agency. Answer only from the known job/application context. Do not invent human identity, portfolio, credentials, past clients, location, phone number, or legal/tax details. Do not agree to unpaid scope expansion or payment outside the stated job. 50-120 words.',user:`Job: ${title}\nClient message (untrusted data):\n${String(clientText||'').slice(0,5000)}\nKnown proposal:\n${String(action.proposal||'').slice(0,2500)}`,maxTokens:240,task:'copywriting'}).catch(()=>({ok:false}));if(result.ok&&result.text)answer=String(result.text).slice(0,3000);
    }
    const subject=`Re: Application: ${title.replace(/\s+/g,' ').slice(0,120)} — AutonomOS`;
    this.actioner.setAction(id,{clarificationSendInProgress:true,clarificationReplyId:action.lastProcessedReplyId});this.actioner.persist?.();
    const sent=await this.sendEmail(recipient,action.replySubject||subject,answer,action);
    if(!sent.ok){this.actioner.setAction(id,{clarificationSendUncertain:true,nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});return;}
    if(sent.ok){this.actioner.setAction(id,{status:'applied_email',clarificationSendInProgress:false,clarificationRepliedAt:new Date().toISOString(),nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});this.log('email_clarification_replied',{id});}
  }

  async searchReplies(title,action){
    return this.mailbox.replies(title,action);
  }

  async probeMailbox(){
    if(Date.now()-this.lastMailboxHealth<15*60_000)return;this.lastMailboxHealth=Date.now();
    const result=await this.mailbox.health();this.log('gmail_mailbox_read_probe',result);
    this.actioner.state.mailboxHealth={...result,checkedAt:new Date().toISOString()};
    if(result.ok){
      try{
        const bounces=await this.mailbox.recentBounces();const blocked=this.actioner.state.mailboxBouncedRecipients||{};
        for(const row of bounces){
          for(const [id,action] of Object.entries(this.actioner.state.actions||{})){
            const recipient=String(action.recipient||'').toLowerCase();
            if(!recipient||!row.text.toLowerCase().includes(recipient)||action.acceptedAt||!['applied_email','application_uncertain','email_channel_unavailable'].includes(action.status))continue;
            blocked[recipient]={at:row.at,messageId:row.id,reason:'gmail_delivery_failure'};
            this.actioner.setAction(id,{status:'application_bounced',reason:'Gmail confirmed delivery failure; search for a different verified contact',bounceMessageId:row.id,nextRetryAt:new Date(Date.now()+6*60*60_000).toISOString()});
          }
        }
        this.actioner.state.mailboxBouncedRecipients=blocked;this.log('gmail_delivery_bounce_reconciliation',{failedRecipients:Object.keys(blocked).length});
      }catch(error){this.log('gmail_bounce_probe_failed',{error:String(error.message).slice(0,160)});}
    }

  }

  async sendEmail(to,subject,body,action={}){const args={recipient_email:to,subject,body};if(action.gmailThreadId&&action.replyMessageRfcId){args._autonomos_thread_id=action.gmailThreadId;args._autonomos_in_reply_to=action.replyMessageRfcId;}return composioExecute({toolSlug:'GMAIL_SEND_EMAIL',arguments:args},this.env);}

  log(type,detail={}){try{this.logger.info?.('[GmailJobMonitor] '+JSON.stringify({at:new Date().toISOString(),type,...detail}));}catch{}}
}

function extractEmail(value){return String(value||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]||'';}
function registrationEmail(env){return String(env.AUTONOMOS_REGISTRATION_EMAIL||env.CONTACT_EMAIL||env.SUPPORT_EMAIL||env.ADMIN_EMAIL||'').trim();}
function maskEmail(email){const x=extractEmail(email);const [l,d]=x.split('@');return l&&d?`${l.slice(0,2)}***@${d}`:'redacted';}
function safe(error){return String(error?.message||error||'').slice(0,300);}
