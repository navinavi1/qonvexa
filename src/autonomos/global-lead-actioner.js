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

const HUMAN_GATE=/\b(captcha|kyc|government id|identity verification|selfie|phone verification|sms verification|2fa|mfa|human verification|verify your identity)\b/i;
const HUMAN_IDENTITY=/\b(legal first name|legal last name|date of birth|social security|passport|driver'?s license|national id|personal tax id)\b/i;
const TERMINAL=/\b(position filled|no longer accepting|applications? closed|job closed|job expired|listing expired|cancelled|canceled|completed)\b/i;
const AI_PROHIBITED=/\b(no ai|ai[- ]generated (?:content|work) (?:is )?not allowed|do not use ai|human[- ]written only|no chatgpt)\b/i;
const EMPLOYMENT_ONLY=/\b(full[- ]time employee|part[- ]time employee|employment application|employee benefits|salary per year|on[- ]site required)\b/i;
const PAID_SIGNAL=/\b(paid|budget|fixed[- ]price|hourly|compensation|reward|bounty|usdt|usdc|usd|eur|gbp|eth|sol|btc)\b/i;
const ACCEPTED=/\b(application accepted|proposal accepted|you(?:'ve| have) been hired|contract started|work has started|selected for this (?:job|project)|project awarded|in progress)\b/i;
const REJECTED=/\b(application rejected|proposal rejected|not selected|another freelancer was selected|job awarded to someone else)\b/i;
const SUBMIT_OK=/\b(submission received|work submitted|deliverable submitted|submitted successfully|awaiting review|pending review)\b/i;
const APPLY_OK=/\b(application submitted|proposal submitted|proposal sent|application received|bid placed|applied successfully|your application has been sent)\b/i;
const COST_GATE=/\b(pay to apply|application fee|membership required|buy connects|purchase credits|stake required|deposit required|paywall|upgrade to apply)\b/i;
const FREELANCE_SIGNAL=/\b(freelance|freelancer|contractor|contract work|gig|project|bounty|task|remote contract|agency|vendor|service provider)\b/i;
const PHYSICAL=/\b(delivery driver|warehouse|construction|cleaner|nurse|doctor|mechanic|electrician|plumber|security guard|restaurant server|cashier|physical labor|on-site only)\b/i;
const MONEY=/(?:\$\s?([0-9][0-9,]*(?:\.\d+)?)|€\s?([0-9][0-9,]*(?:\.\d+)?)|£\s?([0-9][0-9,]*(?:\.\d+)?)|([0-9][0-9,]*(?:\.\d+)?)\s?(USDT|USDC|DAI|USD|EUR|GBP|ETH|SOL|BTC))/i;

export class GlobalLeadActioner {
  constructor({env=process.env,storageDir='',logger=console}={}){
    this.env=env;this.logger=logger;
    this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');
    fs.mkdirSync(this.root,{recursive:true});
    this.hunterFile=path.join(this.root,'global-work-hunter.json');
    this.stateFile=path.join(this.root,'global-lead-actioner.json');
    this.secretFile=path.join(this.root,'global-lead-accounts.private.json');
    this.store=new AutonomOSStore(this.root);
    this.llm=createLlmClient(env);
    this.state=this.read(this.stateFile,{version:1,actions:{},events:[],stats:{inspected:0,applied:0,accepted:0,submitted:0,archived:0}});
    this.timer=null;this.running=false;
  }

  start(){
    if(this.timer)return;
    const every=Math.max(20_000,Number(this.env.AUTONOMOS_GLOBAL_ACTIONER_INTERVAL_MS||30_000));
    setTimeout(()=>this.tick().catch(error=>this.event('tick_error',{error:safeError(error)})),7000).unref?.();
    this.timer=setInterval(()=>this.tick().catch(error=>this.event('tick_error',{error:safeError(error)})),every);this.timer.unref?.();
    this.event('actioner_started',{intervalMs:every,maxPerCycle:this.maxPerCycle(),maxParallel:this.maxParallel()});
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}

  async tick(){
    if(this.running)return;
    if(!truthy(this.env.AUTONOMOS_GLOBAL_ACTIONER_ENABLED,'true'))return;
    this.running=true;
    try{
      const hunter=this.read(this.hunterFile,{});
      await this.monitorApplications(hunter);
      const leads=Object.values(hunter?.leads||{})
        .filter(lead=>this.shouldInspect(lead))
        .sort((a,b)=>this.priority(b)-this.priority(a)||Date.parse(b.firstSeenAt||b.lastSeenAt||0)-Date.parse(a.firstSeenAt||a.lastSeenAt||0))
        .slice(0,this.maxPerCycle());
      await pool(leads,this.maxParallel(),lead=>this.inspectAndAct(lead));
    }finally{this.running=false;this.persist();}
  }

  shouldInspect(lead){
    if(!lead?.id||!/^https?:\/\//i.test(String(lead.url||'')))return false;
    const action=this.state.actions[lead.id];
    if(!action)return true;
    const status=String(action.status||'');
    if(['archived','human_gate','ai_prohibited','physical_or_employment','paid_registration_required','capability_blocked','applied','application_uncertain','account_or_email_verification_required','accepted','executing','accepted_repair_exhausted','submitted','paid'].includes(status))return false;
    const next=Date.parse(String(action.nextRetryAt||0));
    return !Number.isFinite(next)||next<=Date.now();
  }

  priority(lead){
    let score=Number(lead.searchScore||0)*10;
    if(Number(lead.amountUsd||0)>0)score+=Math.min(100,Number(lead.amountUsd||0));
    if(lead.cryptoPayout)score+=20;if(lead.payoutVerified)score+=20;
    if(/translation|copywriting|technical-writing|data-entry|research|development|website|automation|testing|seo|analytics|document/i.test(String(lead.category||'')))score+=12;
    return score;
  }

  async inspectAndAct(lead){
    const id=String(lead.id);const host=hostname(lead.url);if(!host)return;
    this.setAction(id,{status:'inspecting',host,title:lead.title,url:lead.url,category:lead.category,lastAttemptAt:now(),attempts:Number(this.state.actions[id]?.attempts||0)+1});
    let session;
    try{
      session=await this.openSession(lead.url,host);
      const initial=await pageText(session.page);
      this.state.stats.inspected=Number(this.state.stats.inspected||0)+1;
      const disposition=this.inspectPage(initial,lead);
      if(disposition){this.archive(id,disposition.status,disposition.reason);return;}
      // Capability must describe the job itself, not marketplace menus/footers such as
      // “buy services” or unrelated category links like “graphic design”. The full live
      // page is still used for status, payout and protected-gate checks.
      const capabilityText=`${String(lead.title||'')}\n${String(lead.snippet||'')}`.slice(0,6000);
      const capability=classifyOpportunity(this.toOpportunity(lead,capabilityText),this.capabilityContext());
      if(!capability.executable){
        this.setAction(id,{status:'needs_capability',missingTools:capability.missingTools||[],skill:capability.skill,nextRetryAt:new Date(Date.now()+6*60*60_000).toISOString()});
        this.event('lead_needs_capability',{id,host,skill:capability.skill,missingTools:capability.missingTools||[]});return;
      }
      const payout=this.resolvePayout(lead,initial);
      if(!payout.paid){this.setAction(id,{status:'payout_unverified',nextRetryAt:new Date(Date.now()+6*60*60_000).toISOString()});return;}
      const proposal=await this.makeProposal(lead,initial,capability,payout);
      const email=registrationEmail(this.env);
      if(!email){this.setAction(id,{status:'registration_email_missing',nextRetryAt:new Date(Date.now()+6*60*60_000).toISOString()});return;}
      const account=this.ensureAccount(host,email);
      const instruction=this.applicationInstruction({lead,proposal,email,account,payout});
      const action=await session.stagehand.act(instruction,{cache:{threshold:1}});
      await sleep(1200);
      const after=await pageText(session.page);const url=String(await session.page.url());
      await this.saveSession(host,session,account);
      if(HUMAN_GATE.test(after)||HUMAN_IDENTITY.test(after)){this.archive(id,'human_gate','identity/captcha/2FA/phone verification required');return;}
      if(COST_GATE.test(after)){this.archive(id,'paid_registration_required','fee, credits, stake or deposit required before application');return;}
      if(APPLY_OK.test(after)||/submitted|applied|sent/i.test(safeActionResult(action))){
        this.setAction(id,{status:'applied',appliedAt:now(),proposal:proposal.slice(0,1800),applicationUrl:url,nextCheckAt:new Date(Date.now()+15*60_000).toISOString(),payout,skill:capability.skill});
        this.state.stats.applied=Number(this.state.stats.applied||0)+1;this.event('lead_applied',{id,host,title:String(lead.title||'').slice(0,120),amountUsd:payout.amountUsd,currency:payout.currency,skill:capability.skill});return;
      }
      if(/sign in|log in|verify your email|check your email|activation link/i.test(after)){
        this.setAction(id,{status:'account_or_email_verification_required',nextCheckAt:new Date(Date.now()+12*60*60_000).toISOString(),applicationUrl:url});return;
      }
      // An application POST may have reached the site even when the UI result is ambiguous.
      // Never blindly resubmit. Revisit later using saved cookies first.
      this.setAction(id,{status:'application_uncertain',applicationUrl:url,nextCheckAt:new Date(Date.now()+30*60_000).toISOString(),lastResult:safeActionResult(action).slice(0,500)});
      this.event('lead_application_uncertain',{id,host});
    }catch(error){
      this.setAction(id,{status:'inspect_or_apply_failed',error:safeError(error),nextRetryAt:new Date(Date.now()+backoffMs(this.state.actions[id]?.attempts||1)).toISOString()});
      this.event('lead_action_failed',{id,host,error:safeError(error)});
    }finally{await this.closeSession(session);this.persist();}
  }

  inspectPage(text,lead){
    const combined=`${lead.title||''}\n${lead.snippet||''}\n${text||''}`;
    if(TERMINAL.test(combined))return{status:'archived',reason:'listing no longer accepts work'};
    if(AI_PROHIBITED.test(combined))return{status:'ai_prohibited',reason:'listing explicitly prohibits AI-assisted work'};
    if(PHYSICAL.test(combined)||EMPLOYMENT_ONLY.test(combined))return{status:'physical_or_employment',reason:'not an autonomous digital-service contract'};
    if(HUMAN_GATE.test(combined)||HUMAN_IDENTITY.test(combined))return{status:'human_gate',reason:'protected identity/CAPTCHA/2FA/phone flow required'};
    if(COST_GATE.test(combined))return{status:'paid_registration_required',reason:'application requires fee, credits, stake or deposit'};
    if(!FREELANCE_SIGNAL.test(combined))return{status:'archived',reason:'not clearly an explicit freelance/contract/gig task'};
    return null;
  }

  resolvePayout(lead,text){
    let amount=Number(lead.amountUsd||0);let currency=String(lead.payoutCurrency||'').toUpperCase();
    const m=String(text||'').match(MONEY);if(!amount&&m){amount=Number(String(m[1]||m[2]||m[3]||m[4]||'0').replace(/,/g,''))||0;if(!currency||currency==='UNKNOWN')currency=String(m[5]||(m[1]?'USD':m[2]?'EUR':m[3]?'GBP':'')).toUpperCase();}
    const floor=Math.max(0,Number(this.env.AUTONOMOS_GLOBAL_MIN_JOB_PAYOUT_USD||this.env.AUTONOMOS_MIN_JOB_PAYOUT_USD||0.5));
    const paid=amount>=floor||Boolean(lead.cryptoPayout&&PAID_SIGNAL.test(text))||Boolean(PAID_SIGNAL.test(`${lead.snippet||''} ${text||''}`)&&amount===0);
    return{paid,amountUsd:amount,currency:currency||'UNKNOWN',floor,crypto:Boolean(lead.cryptoPayout)};
  }

  async makeProposal(lead,text,capability,payout){
    const fallback=`AutonomOS can complete this ${capability.skill||lead.category||'digital'} project with tool-backed execution, verification and a clean final deliverable. We can start immediately and will follow the stated requirements.`;
    if(!this.llm.enabled)return fallback;
    const result=await this.llm.complete({system:'Write a short truthful freelance proposal for AutonomOS, an AI-assisted digital services agency. Never claim to be a human, never invent credentials or experience, never mention private data. Focus on the exact deliverable, tools, QA, and speed. 70-130 words, plain text.',user:`Job: ${String(lead.title||'').slice(0,300)}\nCategory: ${lead.category||''}\nPayout: ${payout.amountUsd||'unknown'} ${payout.currency}\nCapability: ${capability.skill||''}\nListing excerpt:\n${String(text||lead.snippet||'').slice(0,4500)}`,maxTokens:260,task:'copywriting',maxEmptyRetries:1});
    return result.ok&&String(result.text||'').trim()?String(result.text).trim().slice(0,1600):fallback;
  }

  applicationInstruction({lead,proposal,email,account,payout}){
    const site=String(this.env.SITE_URL||this.env.RENDER_EXTERNAL_URL||'https://qonvexa.co');
    return `This is an explicit paid freelance/contract job application. Apply only to this specific listing as the AutonomOS digital-services agency. Use display name "AutonomOS", email "${email}", website "${site}", and this proposal:\n\n${proposal}\n\nYou may create a normal self-service agency/freelancer account on this site if needed using email ${email} and password ${account.password}. Do NOT claim the applicant is a human. Do NOT enter a personal legal name, birth date, government ID, tax ID, phone number, address, or fake work history. Do NOT bypass or solve CAPTCHA, KYC, 2FA/MFA, phone/SMS verification, identity checks, wallet-signature prompts, access controls, or anti-bot controls. Do NOT pay fees, buy credits/connects, stake, deposit, subscribe, or spend money to apply. Do NOT accept unrelated terms that certify individual human identity. If any such gate appears, stop. Otherwise fill the legitimate application/proposal fields and submit exactly once. Expected payout: ${payout.amountUsd||'not stated'} ${payout.currency}.`;
  }

  async monitorApplications(hunter){
    const due=Object.entries(this.state.actions).filter(([,a])=>['applied','application_uncertain','accepted','submission_uncertain'].includes(String(a.status||''))&&(!a.nextCheckAt||Date.parse(a.nextCheckAt)<=Date.now())).slice(0,Math.max(2,Math.min(10,this.maxParallel()*2)));
    for(const [id,action] of due){
      const lead=hunter?.leads?.[id]||{id,title:action.title,url:action.url||action.applicationUrl,category:action.category,amountUsd:action.payout?.amountUsd,payoutCurrency:action.payout?.currency};
      if(!lead?.url)continue;
      await this.checkApplication(lead,action);
    }
  }

  async checkApplication(lead,action){
    const id=String(lead.id),host=hostname(lead.url);let session;
    try{
      session=await this.openSession(action.applicationUrl||lead.url,host);const text=await pageText(session.page);await this.saveSession(host,session,this.ensureAccount(host,registrationEmail(this.env)));
      if(REJECTED.test(text)||TERMINAL.test(text)){this.archive(id,'archived','application rejected or listing closed');return;}
      if(ACCEPTED.test(text)){
        this.setAction(id,{status:'accepted',acceptedAt:action.acceptedAt||now(),nextCheckAt:'',applicationUrl:String(await session.page.url())});
        this.state.stats.accepted=Number(this.state.stats.accepted||0)+1;this.event('lead_accepted',{id,host,title:String(lead.title||'').slice(0,120)});
        await this.executeAcceptedWebLead(lead,text,session);return;
      }
      if(action.status==='accepted'){await this.executeAcceptedWebLead(lead,text,session);return;}
      if(action.status==='submitted'&&/paid|payment released|escrow released|funds released/i.test(text)){this.setAction(id,{status:'paid',paidAt:now()});this.event('lead_platform_reports_paid',{id,host});return;}
      this.setAction(id,{nextCheckAt:new Date(Date.now()+30*60_000).toISOString(),lastCheckedAt:now()});
    }catch(error){this.setAction(id,{nextCheckAt:new Date(Date.now()+60*60_000).toISOString(),monitorError:safeError(error)});}finally{await this.closeSession(session);this.persist();}
  }

  async executeAcceptedWebLead(lead,pageContent,session){
    const id=String(lead.id),prior=this.state.actions[id]||{};
    if(['executing','submitted','paid'].includes(String(prior.status||'')))return;
    const opportunity=this.toOpportunity(lead,pageContent);opportunity.claimMode='already_assigned';opportunity.status='active';opportunity.description=String(pageContent||lead.snippet||'').slice(0,14000);
    // Use job-specific discovery text for capability gating; execution still receives the
    // accepted work page itself. This prevents marketplace chrome from inventing missing tools.
    const capabilityInput={...opportunity,description:`${String(lead.title||'')}\n${String(lead.snippet||'')}`.slice(0,6000)};
    const capability=classifyOpportunity(capabilityInput,this.capabilityContext());
    if(!capability.executable){this.setAction(id,{status:'accepted_needs_capability',missingTools:capability.missingTools||[],skill:capability.skill,nextCheckAt:new Date(Date.now()+2*60*60_000).toISOString()});return;}
    const config=this.currentConfig();const ledger=this.store.readNdjson('ledger.ndjson',-1);const treasury=computeEarnedSpendBudgetUsd(ledger,config);
    if(treasury<=0.000001){this.setAction(id,{status:'accepted_waiting_treasury',nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});return;}
    const budget=createJobBudget(treasury,{env:this.env,onCost:amount=>this.recordCost(id,amount)});const budgetedLlm=budget.llm(this.llm);const executionConfig={...config,availableSpendUsd:treasury,maxPaidProcurementUsd:Math.max(Number(config.maxPaidProcurementUsd||0),treasury)};
    let deliverable=null,qa=null,briefing='';const maxRepairs=Math.max(1,Math.min(5,Number(this.env.AUTONOMOS_GLOBAL_QA_REPAIRS||3)));
    for(let attempt=1;attempt<=maxRepairs;attempt++){
      this.setAction(id,{status:'executing',attempt,skill:capability.skill,treasuryBudgetUsd:treasury,budgetRemainingUsd:budget.remaining});
      try{deliverable=await executeExternalOpportunity(opportunity,capability,{llm:budgetedLlm,siteUrl:String(this.env.SITE_URL||''),env:this.env,config:executionConfig,briefing,budget});qa=await evaluateDeliverable(opportunity,deliverable,{llm:budgetedLlm,env:this.env});if(qa.ok)break;briefing=`Repair the previous deliverable. QA reasons: ${(qa.reasons||[]).join('; ')}. Previous output:\n${String(deliverable?.content||'').slice(0,5000)}`;}catch(error){briefing=`Execution failed. Change approach/tools and finish the accepted task. Error: ${safeError(error)}`;}
    }
    if(!deliverable||!qa?.ok){this.setAction(id,{status:'accepted_repair_exhausted',qaReasons:qa?.reasons||[],nextCheckAt:new Date(Date.now()+2*60*60_000).toISOString()});return;}
    const artifactUrls=(deliverable?.evidence?.toolCalls||[]).flatMap(x=>x?.artifacts||[]).filter(x=>x?.ok&&x?.url).map(x=>x.url).slice(0,10);
    const submitInstruction=`Submit the completed work to this already-accepted freelance/contract job exactly once. Final deliverable:\n\n${String(deliverable.content||'').slice(0,12000)}\n\nArtifact URLs if the form supports links: ${artifactUrls.join(', ')||'none'}. Do not change payout settings, do not purchase anything, do not bypass CAPTCHA/KYC/2FA/phone/wallet-signature gates. If submission requires one of those gates, stop without submitting.`;
    const result=await session.stagehand.act(submitInstruction,{cache:{threshold:1}});await sleep(1200);const after=await pageText(session.page);
    if(SUBMIT_OK.test(after)||/submitted|delivered/i.test(safeActionResult(result))){this.setAction(id,{status:'submitted',submittedAt:now(),qaScore:Number(qa.score||1),budgetSpentUsd:budget.spent,nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});this.state.stats.submitted=Number(this.state.stats.submitted||0)+1;this.event('lead_work_submitted',{id,host:hostname(lead.url),qaScore:Number(qa.score||1)});return;}
    this.setAction(id,{status:'submission_uncertain',submitResult:safeActionResult(result).slice(0,500),nextCheckAt:new Date(Date.now()+60*60_000).toISOString()});
  }

  toOpportunity(lead,text){return{source:'global-web',externalId:String(lead.id),title:String(lead.title||'Paid digital work'),description:String(text||lead.snippet||'').slice(0,14000),category:String(lead.category||'general-digital'),budgetUsd:Number(lead.amountUsd||0),currency:String(lead.payoutCurrency||'USD'),network:lead.cryptoPayout?'crypto':'fiat',escrowed:Boolean(lead.payoutVerified),claimMode:'competitive_submission',status:'open',url:String(lead.url||''),skills:[]};}
  capabilityContext(){return{llmEnabled:Boolean(this.llm?.enabled),hasGithubPrTool:Boolean(this.env.GITHUB_TOKEN),hasShellTool:Boolean(this.env.E2B_API_KEY),hasBrowserTool:Boolean(this.env.BROWSERBASE_API_KEY&&this.env.BROWSERBASE_PROJECT_ID),hasDeployTool:Boolean(this.env.AUTONOMOS_DEPLOY_WEBHOOK_URL),hasArtifactTool:Boolean((this.env.S3_ENDPOINT||this.env.R2_ENDPOINT)&&(this.env.S3_BUCKET||this.env.R2_BUCKET)),hasAppTool:Boolean(this.env.COMPOSIO_API_KEY),connectedApps:[],hasWebSearchTool:Boolean(this.env.FIRECRAWL_API_KEY||this.env.TAVILY_API_KEY),hasDesignMediaTool:Boolean(this.env.AUTONOMOS_DESIGN_MEDIA_ENABLED)};}
  currentConfig(){return normalizeConfig(this.store.readJson('config.json',{...DEFAULT_AUTONOMOS_CONFIG,enabled:true}));}
  recordCost(id,amount){const n=Number(amount||0);if(!(n>0))return;appendUniqueLedgerEntry(this.store,ledgerEntry({id:`global_web_cost_${id}_${crypto.randomUUID()}`,type:'cost',source:'global-web',amountUsd:n,grossUsd:n,currency:'USD',status:'incurred',note:`Tool/model cost for ${id}`}));}

  async openSession(url,host){
    const apiKey=String(this.env.BROWSERBASE_API_KEY||'').trim();if(!apiKey)throw new Error('browserbase_not_configured');
    const {browserbase,Stagehand}=await import('@browserbasehq/stagehand');const browser=await browserbase.launch({apiKey});const stagehand=await Stagehand.create({browser,selfHeal:true,cache:{threshold:2}});
    try{await browser.context.setDomainPolicy({allowedDomains:[host,...csv(this.env.AUTONOMOS_BROWSER_ALLOWED_DOMAINS)]});}catch{}
    const pages=await browser.context.pages();const page=pages[0]||await browser.context.newPage();
    const secrets=this.read(this.secretFile,{accounts:{}});const cookies=secrets?.accounts?.[host]?.cookies;if(Array.isArray(cookies)&&cookies.length){try{await browser.context.addCookies(cookies);}catch{}}
    await page.goto(String(url),{waitUntil:'domcontentloaded'});return{browser,stagehand,page};
  }
  async saveSession(host,session,account){
    if(!host||!session?.browser)return;const secrets=this.read(this.secretFile,{accounts:{}});secrets.accounts=secrets.accounts||{};let cookies=[];try{cookies=await session.browser.context.cookies();}catch{}secrets.accounts[host]={...(secrets.accounts[host]||{}),email:account?.email||'',password:account?.password||secrets.accounts[host]?.password||'',cookies:Array.isArray(cookies)?cookies.slice(0,120):[],updatedAt:now()};this.writeSecret(this.secretFile,secrets);
  }
  ensureAccount(host,email){const secrets=this.read(this.secretFile,{accounts:{}});secrets.accounts=secrets.accounts||{};let row=secrets.accounts[host];if(!row){row={email,password:crypto.randomBytes(24).toString('base64url'),createdAt:now(),cookies:[]};secrets.accounts[host]=row;this.writeSecret(this.secretFile,secrets);}return row;}
  async closeSession(session){try{await session?.stagehand?.close();}catch{}try{await session?.browser?.close();}catch{}}

  setAction(id,patch){this.state.actions[id]={...(this.state.actions[id]||{}),...patch,updatedAt:now()};this.persist();}
  archive(id,status,reason){this.setAction(id,{status,reason,archivedAt:now(),nextRetryAt:''});this.state.stats.archived=Number(this.state.stats.archived||0)+1;this.event('lead_archived',{id,status,reason:String(reason||'').slice(0,160)});}
  maxPerCycle(){return Math.max(1,Math.min(100,Number(this.env.AUTONOMOS_GLOBAL_ACTIONER_MAX_PER_CYCLE||12)));}
  maxParallel(){return Math.max(1,Math.min(8,Number(this.env.AUTONOMOS_GLOBAL_ACTIONER_MAX_PARALLEL||3)));}
  event(type,detail={}){const row={at:now(),type,...detail};this.state.events.unshift(row);if(this.state.events.length>500)this.state.events.length=500;this.persist();try{this.logger.info?.('[GlobalLeadActioner] '+JSON.stringify(row));}catch{}}
  persist(){try{fs.writeFileSync(this.stateFile,JSON.stringify(this.state,null,2),{mode:0o600});}catch{}}
  read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return structuredClone(fallback);}}
  writeSecret(file,value){const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});try{fs.chmodSync(tmp,0o600);}catch{}fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}}
}

function registrationEmail(env){return String(env.AUTONOMOS_REGISTRATION_EMAIL||env.CONTACT_EMAIL||env.SUPPORT_EMAIL||env.ADMIN_EMAIL||'').trim();}
function hostname(url){try{return new URL(String(url)).hostname.toLowerCase().replace(/^www\./,'');}catch{return'';}}
function truthy(value,fallback='false'){return /^(1|true|yes|on)$/i.test(String(value??fallback));}
function now(){return new Date().toISOString();}
function csv(v){return String(v||'').split(',').map(x=>x.trim().toLowerCase()).filter(x=>/^[a-z0-9.-]+$/.test(x));}
function safeError(error){return String(error?.message||error||'').slice(0,300);}
function safeActionResult(value){try{return JSON.stringify(value?.data??value?.result??value).slice(0,2000);}catch{return String(value||'').slice(0,2000);}}
function backoffMs(attempt){return Math.min(24*60*60_000,Math.max(15*60_000,15*60_000*Math.pow(2,Math.min(6,Math.max(0,Number(attempt||1)-1)))));}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function pageText(page){
  for(const selector of ['main','article','[role="main"]','body']){
    try{const text=String(await page.locator(selector).first().innerText({timeout:5000})).trim();if(text.length>=80)return text.slice(0,30000);}catch{}
  }
  return'';
}
async function pool(items,limit,worker){let index=0;const runners=Array.from({length:Math.min(limit,items.length)},async()=>{while(index<items.length){const item=items[index++];await worker(item);}});await Promise.allSettled(runners);}
