import { composioSearch, composioExecute } from './composio-tool.js';
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
  constructor({actioner,env=process.env,logger=console}={}){this.actioner=actioner;this.env=env;this.logger=logger;this.timer=null;this.running=false;this.readTool=null;this.sendTool=null;}
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
    const own=registrationEmail(this.env).toLowerCase();
    const appliedAt=Date.parse(String(action.appliedAt||0));
    const candidates=messages.rows.filter(row=>{
      const from=String(row.from||'').toLowerCase();const at=Date.parse(String(row.at||0));
      return row.text&&(!own||!from.includes(own))&&(!Number.isFinite(appliedAt)||!Number.isFinite(at)||at>=appliedAt-60_000);
    });
    const latest=candidates[0];
    if(!latest){this.actioner.setAction(id,{nextCheckAt:new Date(Date.now()+30*60_000).toISOString(),lastEmailCheckedAt:new Date().toISOString()});return;}
    const text=String(latest.text||'').slice(0,12000);
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
    const capability=classifyOpportunity({...opportunity,description:`${lead.title||''}\n${lead.snippet||''}\n${clientReply}`.slice(0,9000)},this.actioner.capabilityContext());
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
    const sent=await this.sendEmail(recipient,subject,body);
    if(sent.ok){this.actioner.setAction(id,{status:'submitted_email',submittedAt:new Date().toISOString(),emailDeliveryLogId:String(sent.logId||''),nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});this.actioner.state.stats.submitted=Number(this.actioner.state.stats.submitted||0)+1;this.log('email_work_submitted',{id,qaScore:Number(qa.score||1)});return;}
    // Do not auto-resend after an external send attempt with ambiguous result.
    this.actioner.setAction(id,{status:'submission_uncertain',reason:`email delivery outcome uncertain: ${String(sent.error||'unknown').slice(0,220)}`,nextCheckAt:new Date(Date.now()+60*60_000).toISOString()});
  }

  async answerClarification(id,action,clientText){
    if(action.clarificationRepliedAt)return;
    const recipient=extractEmail(action.replyFrom);if(!recipient)return;
    const title=String(action.title||'project');
    let answer=`Thanks for the follow-up. AutonomOS is ready to complete the stated ${title} scope. Please send the exact deliverable requirements, source materials/authorized links, deadline, and acceptance criteria if they were not included in the listing.`;
    if(this.actioner.llm?.enabled){
      const result=await this.actioner.llm.complete({system:'Reply as AutonomOS, an AI-assisted digital-services agency. Answer only from the known job/application context. Do not invent human identity, portfolio, credentials, past clients, location, phone number, or legal/tax details. Do not agree to unpaid scope expansion or payment outside the stated job. 50-120 words.',user:`Job: ${title}\nClient message (untrusted data):\n${String(clientText||'').slice(0,5000)}\nKnown proposal:\n${String(action.proposal||'').slice(0,2500)}`,maxTokens:240,task:'copywriting'});if(result.ok&&result.text)answer=String(result.text).slice(0,3000);
    }
    const subject=`Re: Application: ${title.replace(/\s+/g,' ').slice(0,120)} — AutonomOS`;
    const sent=await this.sendEmail(recipient,subject,answer);
    if(sent.ok){this.actioner.setAction(id,{status:'applied_email',clarificationRepliedAt:new Date().toISOString(),nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});this.log('email_clarification_replied',{id});}
  }

  async searchReplies(title,action){
    const tool=await this.getReadTool();if(!tool.ok)return{ok:false,error:tool.error,rows:[]};
    const subject=`Application: ${String(title||'').replace(/\s+/g,' ').slice(0,120)} — AutonomOS`;
    const query=`subject:"${subject.replace(/"/g,'')}" newer_than:14d`;
    const args=buildSearchArgs(tool.inputParameters,query);
    if(!args)return{ok:false,error:'gmail_search_tool_schema_not_understood',rows:[]};
    const result=await composioExecute({toolSlug:tool.slug,arguments:args},this.env);if(!result.ok)return{ok:false,error:String(result.detail||result.error||'gmail_search_failed'),rows:[]};
    return{ok:true,rows:extractMessages(result.data).sort((a,b)=>Date.parse(b.at||0)-Date.parse(a.at||0))};
  }

  async getReadTool(){if(this.readTool)return this.readTool;const result=await composioSearch({query:'search list emails messages gmail',toolkit:'gmail',limit:30},this.env);if(!result.ok)return{ok:false,error:result.error};const ranked=(result.items||[]).map(item=>({item,score:scoreReadTool(item)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);const best=ranked[0]?.item;if(!best)return{ok:false,error:'gmail_read_tool_not_found'};return this.readTool={ok:true,slug:best.slug,inputParameters:best.inputParameters||{}};}
  async getSendTool(){if(this.sendTool)return this.sendTool;const result=await composioSearch({query:'send email message',toolkit:'gmail',limit:20},this.env);if(!result.ok)return{ok:false,error:result.error};const ranked=(result.items||[]).map(item=>({item,score:scoreSendTool(item)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);const best=ranked[0]?.item;if(!best)return{ok:false,error:'gmail_send_tool_not_found'};return this.sendTool={ok:true,slug:best.slug,inputParameters:best.inputParameters||{}};}
  async sendEmail(to,subject,body){const tool=await this.getSendTool();if(!tool.ok)return tool;const args=buildSendArgs(tool.inputParameters,to,subject,body);if(!args)return{ok:false,error:'gmail_send_tool_schema_not_understood'};return composioExecute({toolSlug:tool.slug,arguments:args},this.env);}
  log(type,detail={}){try{this.logger.info?.('[GmailJobMonitor] '+JSON.stringify({at:new Date().toISOString(),type,...detail}));}catch{}}
}

function scoreReadTool(item){const text=`${item?.slug||''} ${item?.name||''} ${item?.description||''}`.toUpperCase();if(/SEND|DRAFT|DELETE|TRASH|MODIFY/.test(text))return-100;let score=0;if(/SEARCH.*EMAIL|SEARCH.*MESSAGE/.test(text))score+=30;if(/FETCH.*EMAIL|LIST.*EMAIL|LIST.*MESSAGE/.test(text))score+=18;if(/EMAIL|MESSAGE/.test(text))score+=4;return score;}
function scoreSendTool(item){const text=`${item?.slug||''} ${item?.name||''} ${item?.description||''}`.toUpperCase();if(/DRAFT/.test(text))return-10;let score=0;if(/SEND_EMAIL|SEND.*EMAIL/.test(text))score+=20;if(/SEND.*MESSAGE/.test(text))score+=8;if(/EMAIL/.test(text))score+=3;return score;}
function buildSearchArgs(schema,query){const props=schema?.properties||schema?.schema?.properties||{};const args={};let set=false;for(const [key,def] of Object.entries(props)){const low=key.toLowerCase();if(!set&&/(^q$|query|search_query|gmail_query)/.test(low)){args[key]=query;set=true;continue;}if(/max_results|maxresult|limit|page_size/.test(low))args[key]=Math.min(20,Number(def?.default||20));if(/include_spam|include_trash/.test(low))args[key]=false;}return set?args:null;}
function buildSendArgs(schema,to,subject,body){const props=schema?.properties||schema?.schema?.properties||{};const args={};let a=false,b=false,c=false;for(const [key,def] of Object.entries(props)){const low=key.toLowerCase();if(!a&&/(^to$|recipient|recipient_email|to_email|email_address)/.test(low)&&!/(cc|bcc|from)/.test(low)){args[key]=def?.type==='array'?[to]:to;a=true;continue;}if(!b&&/subject/.test(low)){args[key]=subject;b=true;continue;}if(!c&&/(^body$|message_body|body_text|plain_text|content|message|text)/.test(low)&&!/html|snippet|preview/.test(low)){args[key]=body;c=true;continue;}if(/is_html|html_enabled/.test(low))args[key]=false;}return a&&b&&c?args:null;}
function extractMessages(data){const rows=[];walk(data,0);return dedupe(rows);function walk(value,depth){if(depth>5||value==null)return;if(Array.isArray(value)){for(const x of value)walk(x,depth+1);return;}if(typeof value!=='object')return;const subject=first(value,['subject','Subject']);const from=first(value,['from','sender','from_email','sender_email']);const body=first(value,['body','text','message','content','snippet','body_text','plain_text']);const at=first(value,['date','timestamp','internalDate','received_at','created_at']);if(subject||from||body){const text=String(body||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,12000);if(text)rows.push({subject:String(subject||''),from:String(from||''),text,at:normalizeDate(at)});}for(const x of Object.values(value))if(typeof x==='object')walk(x,depth+1);}}
function dedupe(rows){const seen=new Set();return rows.filter(r=>{const k=`${r.from}|${r.subject}|${r.text.slice(0,160)}`;if(seen.has(k))return false;seen.add(k);return true;});}
function first(o,keys){for(const k of keys)if(o?.[k]!=null&&typeof o[k]!=='object')return o[k];return'';}
function normalizeDate(v){if(v==null)return'';const n=Number(v);if(Number.isFinite(n)&&n>1e12)return new Date(n).toISOString();if(Number.isFinite(n)&&n>1e9)return new Date(n*1000).toISOString();const d=Date.parse(String(v));return Number.isFinite(d)?new Date(d).toISOString():'';}
function extractEmail(value){return String(value||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]||'';}
function registrationEmail(env){return String(env.AUTONOMOS_REGISTRATION_EMAIL||env.CONTACT_EMAIL||env.SUPPORT_EMAIL||env.ADMIN_EMAIL||'').trim();}
function maskEmail(email){const x=extractEmail(email);const [l,d]=x.split('@');return l&&d?`${l.slice(0,2)}***@${d}`:'redacted';}
function safe(error){return String(error?.message||error||'').slice(0,300);}
