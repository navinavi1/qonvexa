import { DynamicMarketRegistry } from './dynamic-market-registry.js';
import { ActionJournal, classifyFailure } from './action-journal.js';
import { hardenedPollTaskForce } from './revenue-lifecycle.js';
import { pollTaskForceNotificationsRecovered } from './taskforce-notifications.js';
import { minimumJobPayoutUsd } from './payout-floor.js';
import { unifiedCapabilityContext, refreshCapabilities } from './capability-registry.js';
import { isRetiredMarket } from './retired-markets.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { freeWebSearch } from './free-web-tool.js';
import { createLlmClient } from './llm.js';
import { classifyOpportunity } from './capabilities.js';
import { taskForceHeaders } from './taskforce-auth.js';

// Broad, rotating worldwide discovery. These intentionally cover normal freelance work as
// well as agent-native markets; crypto words are NOT required for discovery because payout
// routing is a later gate. The crawler rotates through the whole matrix continuously.
const GLOBAL_QUERIES = [
  'worldwide remote freelance translation localization transcreation jobs paid',
  'worldwide remote transcription subtitles captions freelance jobs paid',
  'worldwide remote copywriting content writing proofreading editing freelance jobs',
  'worldwide remote blog article SEO content product description freelance jobs',
  'worldwide remote data entry spreadsheet excel csv cleanup freelance jobs',
  'worldwide remote web research market research lead generation freelance jobs',
  'worldwide remote virtual assistant admin operations freelance jobs',
  'worldwide remote customer support chat email support freelance jobs',
  'worldwide remote python javascript typescript node API freelance jobs',
  'worldwide remote frontend backend full stack bug fix freelance jobs',
  'worldwide remote wordpress shopify woocommerce webflow freelance jobs',
  'worldwide remote website design landing page UI UX freelance jobs',
  'worldwide remote graphic design banner social media creative freelance jobs',
  'worldwide remote presentation powerpoint pitch deck document design freelance jobs',
  'worldwide remote video editing subtitles short form freelance jobs',
  'worldwide remote audio editing podcast cleanup voice transcription freelance jobs',
  'worldwide remote QA software testing website testing bug report freelance jobs',
  'worldwide remote automation workflow zapier make n8n CRM freelance jobs',
  'worldwide remote web scraping public data extraction freelance jobs',
  'worldwide remote API integration webhook automation freelance jobs',
  'worldwide remote SEO audit keyword research on page SEO freelance jobs',
  'worldwide remote digital marketing email marketing campaign freelance jobs',
  'worldwide remote social media content scheduling community management freelance jobs',
  'worldwide remote ecommerce product listing catalog management freelance jobs',
  'worldwide remote analytics dashboard reporting data visualization freelance jobs',
  'worldwide remote no code airtable notion bubble softr freelance jobs',
  'worldwide remote AI prompt workflow chatbot automation freelance jobs',
  'worldwide remote documentation technical writing SOP manuals freelance jobs',
  'worldwide remote resume CV formatting business document freelance jobs',
  'remote freelance microtasks digital tasks paid USD EUR worldwide',
  'remote freelance digital jobs paid USDT USDC crypto worldwide',
  'AI agent work marketplace paid tasks USDC USDT API worldwide',
  'site:upwork.com/freelance-jobs remote translation writing data automation',
  'site:freelancer.com/jobs remote writing translation data software',
  'site:peopleperhour.com freelance remote writing design development marketing',
  'site:contra.com jobs freelance remote design writing development marketing'
];

const CATEGORY_RULES = [
  ['translation', /\b(translation|translate|translator|localization|localisation|transcreation|language pair)\b/i],
  ['transcription', /\b(transcription|transcribe|subtitles?|captions?|closed captions?)\b/i],
  ['copywriting', /\b(copywriting|copywriter|content writing|writer|writing|proofread|editing|rewrite|article|blog|product description)\b/i],
  ['technical-writing', /\b(technical writing|documentation|docs|manual|SOP|standard operating procedure|knowledge base)\b/i],
  ['data-entry', /\b(data entry|spreadsheet|excel|google sheets|csv|data cleanup|data cleaning|catalog entry)\b/i],
  ['research', /\b(web research|market research|competitor research|research assistant|lead research|lead generation)\b/i],
  ['development', /\b(python|javascript|typescript|node\.?js|api|script|coding|developer|software|frontend|backend|full stack|react|next\.?js)\b/i],
  ['website', /\b(wordpress|shopify|woocommerce|webflow|website build|landing page|cms)\b/i],
  ['automation', /\b(automation|workflow|integration|zapier|make\.com|n8n|crm|webhook|browser automation)\b/i],
  ['scraping', /\b(web scraping|data extraction|scrape public|crawler|public data collection)\b/i],
  ['testing', /\b(qa|quality assurance|software testing|website testing|bug report|usability testing|test cases?)\b/i],
  ['ui-ux', /\b(ui\/?ux|user interface|user experience|wireframe|figma|website design|app design)\b/i],
  ['graphic-design', /\b(graphic design|banner|social media creative|thumbnail|brand asset|ad creative)\b/i],
  ['presentation', /\b(presentation|powerpoint|pitch deck|slide deck|google slides)\b/i],
  ['video', /\b(video editing|short form video|reels|tiktok edit|youtube edit|motion graphics)\b/i],
  ['audio', /\b(audio editing|podcast editing|noise reduction|audio cleanup)\b/i],
  ['seo', /\b(seo|keyword research|on-page seo|technical seo|search engine optimization)\b/i],
  ['marketing', /\b(digital marketing|email marketing|marketing campaign|growth marketing|ad campaign|advertising)\b/i],
  ['social-media', /\b(social media|community management|content scheduling|instagram|linkedin content|x content|twitter content)\b/i],
  ['ecommerce', /\b(ecommerce|e-commerce|product listing|product catalog|amazon listing|etsy listing|shopify product)\b/i],
  ['analytics', /\b(analytics|dashboard|reporting|data visualization|looker studio|power bi|tableau)\b/i],
  ['no-code', /\b(no-code|nocode|airtable|notion|bubble|softr|glide)\b/i],
  ['virtual-assistant', /\b(virtual assistant|administrative assistant|admin support|operations assistant)\b/i],
  ['customer-support', /\b(customer support|customer service|chat support|email support|helpdesk)\b/i],
  ['ai-workflow', /\b(ai automation|prompt engineering|chatbot|llm workflow|ai workflow|agent workflow)\b/i],
  ['document-generation', /\b(resume|cv formatting|document formatting|pdf|docx|business document|proposal document)\b/i]
];

const MONEY = /(?:\$\s?([0-9][0-9,]*(?:\.\d+)?)|€\s?([0-9][0-9,]*(?:\.\d+)?)|£\s?([0-9][0-9,]*(?:\.\d+)?)|([0-9][0-9,]*(?:\.\d+)?)\s?(USDT|USDC|DAI|USD|EUR|GBP|ETH|SOL|BTC))/i;
const CRYPTO = /\b(USDT|USDC|DAI|ETH|SOL|BTC|BNB|stablecoin|cryptocurrency|crypto payment|paid in crypto)\b/i;
const WORK_SIGNAL = /\b(job|jobs|freelance|freelancer|gig|gigs|task|tasks|contract|contractor|bounty|work|project|hiring|hire)\b/i;
const HUMAN_GATE = /\b(captcha|KYC|government ID|selfie verification|2FA|MFA|phone verification|human verification)\b/i;
const UNSAFE = /\b(malware|ransomware|phishing|credential theft|steal passwords?|fake reviews?|mass spam|spam campaign|weapons?|firearms?|explosives?|illegal drugs?|money laundering)\b/i;
const TERMINAL_TEXT = /\b(closed|expired|filled|position filled|no longer accepting|cancelled|canceled|completed)\b/i;

export class GlobalWorkHunter {
  constructor({env=process.env,storageDir='',logger=console}={}){
    this.env=env;this.logger=logger;
    this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');
    fs.mkdirSync(this.root,{recursive:true});
    this.actionJournal=new ActionJournal(this.root);
    this.stateFile=path.join(this.root,'global-work-hunter.json');
    this.feedFile=path.join(this.root,'global-work-feed.json');
    this.archiveFile=path.join(this.root,'global-work-archive.json');
    this.secretFile=path.join(this.root,'global-work-credentials.private.json');
    const fallback={version:2,startedAt:'',lastScanAt:'',scans:0,queryCursor:0,leads:{},ignored:{},taskforce:{applications:{},tasks:{},events:[]},events:[]};
    this.state=this.read(this.stateFile,fallback);
    this.state.version=2;this.state.leads=this.state.leads||{};this.state.ignored=this.state.ignored||{};this.state.taskforce=this.state.taskforce||fallback.taskforce;this.state.events=this.state.events||[];
    this.timer=null;this.running=false;this.llm=createLlmClient(env);
  }

  start(){
    if(this.timer)return;
    const initial=Math.max(1000,Number(this.env.AUTONOMOS_GLOBAL_HUNTER_INITIAL_DELAY_MS||3000));
    const every=Math.max(20_000,Number(this.env.AUTONOMOS_GLOBAL_HUNTER_INTERVAL_MS||30_000));
    this.state.startedAt=this.state.startedAt||new Date().toISOString();this.persist();
    setTimeout(()=>this.cycle().catch(error=>this.event('cycle_error',{error:safeError(error)})),initial).unref?.();
    this.timer=setInterval(()=>this.cycle().catch(error=>this.event('cycle_error',{error:safeError(error)})),every);this.timer.unref?.();
    this.event('global_work_hunter_started',{intervalMs:every,scope:'worldwide_all_legal_digital_work',categories:CATEGORY_RULES.map(x=>x[0]),queryCount:GLOBAL_QUERIES.length});
  }

  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}

  async cycle(){
    if(this.running)return{ok:false,reason:'cycle_already_running'};
    if(String(this.env.AUTONOMOS_GLOBAL_HUNTER_ENABLED||'true').toLowerCase()==='false')return{ok:false,reason:'disabled'};
    this.running=true;const started=Date.now();
    try{
      const search=await this.searchWorldwide();
      const taskforce=await this.runTaskForce();
      this.state.scans=Number(this.state.scans||0)+1;this.state.lastScanAt=new Date().toISOString();this.state.lastScanMs=Date.now()-started;
      this.pruneLeads();this.persist();
      const categories=countBy(Object.values(this.state.leads),x=>x.category||'other');
      this.event('global_scan_completed',{newLeads:search.newLeads,totalLeads:Object.keys(this.state.leads).length,ignored:Object.keys(this.state.ignored).length,taskforceOpen:taskforce.open||0,taskforceApplied:taskforce.applied||0,categories,ms:this.state.lastScanMs});
      return{ok:true,...search,taskforce};
    }finally{this.running=false;}
  }

  async searchWorldwide(){
    const perCycle=Math.max(2,Math.min(12,Number(this.env.AUTONOMOS_GLOBAL_QUERIES_PER_CYCLE||8)));
    let cursor=Number(this.state.queryCursor||0)%GLOBAL_QUERIES.length,newLeads=0;
    for(let i=0;i<perCycle;i++){
      const query=GLOBAL_QUERIES[(cursor+i)%GLOBAL_QUERIES.length];
      const result=await freeWebSearch(query,this.env);
      if(!result.ok){this.event('global_search_failed',{query,error:result.error||''});continue;}
      for(const row of result.results||[]){
        const url=String(row?.url||'').trim();if(!/^https?:\/\//i.test(url))continue;
        const id=`webwork_${hash(url)}`;if(this.state.ignored[id])continue;
        const lead=this.classifyWebLead(row,query);if(!lead)continue;
        if(lead.terminal){this.archiveLead(lead.id,'listing_terminal',lead);continue;}
        if(lead.humanGate){this.archiveLead(lead.id,'protected_registration_or_identity_step_required',lead);continue;}
        const prev=this.state.leads[lead.id];if(!prev)newLeads++;
        this.state.leads[lead.id]={...prev,...lead,firstSeenAt:prev?.firstSeenAt||new Date().toISOString(),lastSeenAt:new Date().toISOString()};
      }
    }
    this.state.queryCursor=(cursor+perCycle)%GLOBAL_QUERIES.length;this.persist();return{newLeads};
  }

  classifyWebLead(row,query){
    if(isRetiredMarket(row))return null;
    const url=String(row?.url||'').trim();if(!/^https?:\/\//i.test(url))return null;
    let host='';try{host=new URL(url).hostname.toLowerCase().replace(/^www\./,'');}catch{return null;}
    const text=`${row?.title||''} ${row?.snippet||''}`;if(UNSAFE.test(text)||!WORK_SIGNAL.test(text))return null;
    const category=categoryOf(text)||'general-digital';
    const money=text.match(MONEY);
    const rawAmount=money?.[1]||money?.[2]||money?.[3]||money?.[4]||'0';
    const amount=Number(String(rawAmount).replace(/,/g,''))||0;
    let explicitCurrency=String(money?.[5]||'').toUpperCase();
    if(!explicitCurrency&&money?.[1])explicitCurrency='USD';if(!explicitCurrency&&money?.[2])explicitCurrency='EUR';if(!explicitCurrency&&money?.[3])explicitCurrency='GBP';
    const cryptoMatch=text.match(CRYPTO);
    const cryptoPayout=Boolean(cryptoMatch);
    const payoutCurrency=explicitCurrency||String(cryptoMatch?.[1]||'').toUpperCase()||'UNKNOWN';
    const humanGate=HUMAN_GATE.test(text);const terminal=TERMINAL_TEXT.test(text);
    return{id:`webwork_${hash(url)}`,source:host,title:String(row?.title||'Paid digital work').slice(0,220),url,category,amountUsd:amount,payoutCurrency,cryptoPayout,payoutVerified:false,worldwide:/worldwide|remote|global/i.test(text),humanGate,terminal,applyReady:false,applyMode:'direct_or_native_route_required',blocker:humanGate?'protected_registration_or_identity_step_required':'verified application route required',searchScore:Number(row?.score||0),discoveredBy:query,snippet:String(row?.snippet||'').slice(0,1500)};
  }

  async runTaskForce(){
    const credential=await this.ensureTaskForceCredential();if(!credential?.apiKey)return{open:0,applied:0,reason:'registration_not_ready'};
    if(!credential.verified)await this.verifyTaskForceAgent(credential);
    const result=await this.pollTaskForce(credential);const marketRegistry=new DynamicMarketRegistry(this.root);const oldMarket=marketRegistry.read().taskforce||{};marketRegistry.observe('taskforce',{name:'TaskForce',homepage:'https://www.task-force.app',lastJobsCount:result.open||0,evidence:{...oldMarket.evidence,...(result.open>0?{jobs:{verified:true,url:'https://www.task-force.app/api/agent/tasks',verifiedAt:new Date().toISOString()},authentication:{verified:true,externalId:String(credential.agentId||''),verifiedAt:new Date().toISOString()}}:{})},blocker:result.belowFloor===result.open&&result.open>0?'BELOW_MIN_JOB_VALUE':'awaiting_eligible_work'});await this.pollTaskForceNotifications(credential).catch(error=>this.event('taskforce_notifications_failed',{error:safeError(error)}));return result;
  }

  async ensureTaskForceCredential(){
    const secrets=this.read(this.secretFile,{});let credential=secrets.taskforce||null;if(credential?.apiKey)return credential;
    const registration=this.actionJournal.begin('taskforce','AutonomOS','register');if(!registration.ok){this.event('taskforce_registration_reconcile_required',{status:registration.status});return null;}
    try{
      const body={name:String(this.env.AUTONOMOS_AGENT_NAME||'AutonomOS').slice(0,100),capabilities:CATEGORY_RULES.map(x=>x[0]).slice(0,40)};
      const r=await fetch('https://task-force.app/api/agent/register',{method:'POST',headers:{'content-type':'application/json',accept:'application/json','user-agent':'AutonomOS-GlobalHunter/2.0'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
      const data=await safeJson(r);if(!r.ok){this.event('taskforce_registration_failed',{status:r.status,error:publicError(data)});return null;}
      const apiKey=String(data?.apiKey||data?.api_key||''),agent=data?.agent||{};if(!apiKey){this.event('taskforce_registration_failed',{status:r.status,error:'missing_api_key'});return null;}
      credential={apiKey,agentId:String(agent?.id||data?.agentId||''),walletAddress:String(agent?.walletAddress||data?.walletAddress||''),status:String(agent?.status||''),verified:false,createdAt:new Date().toISOString()};secrets.taskforce=credential;this.writeSecret(this.secretFile,secrets);this.actionJournal.finish(registration.id,credential.agentId?'confirmed':'uncertain',credential.agentId?{externalId:credential.agentId}:{reason:'registration_missing_agent_id'});this.event('taskforce_registered',{agentId:credential.agentId,walletAddress:credential.walletAddress,status:credential.status});return credential;
    }catch(error){this.event('taskforce_registration_failed',{error:safeError(error)});return null;}
  }

  async verifyTaskForceAgent(credential){
    if(!credential?.apiKey||credential.verified)return Boolean(credential?.verified);
    // Keep this best-effort; TaskForceVerifier also repairs auth independently.
    const headers=taskForceHeaders(credential.apiKey,'AutonomOS-GlobalHunter/2.0');
    try{
      const challengeRes=await fetch('https://task-force.app/api/agent/verify/challenge',{method:'POST',headers,signal:AbortSignal.timeout(12000)});const challenge=await safeJson(challengeRes);
      if(!challengeRes.ok){if(challengeRes.status===409||/already verified/i.test(publicError(challenge))){credential.verified=true;this.saveTaskForceCredential(credential);return true;}this.event('taskforce_verification_failed',{stage:'challenge',status:challengeRes.status,error:publicError(challenge)});return false;}
      const challengeId=String(challenge?.challengeId||challenge?.id||''),prompt=String(challenge?.prompt||challenge?.question||'').trim();if(!challengeId||!prompt||!this.llm.enabled)return false;
      const solved=await this.llm.complete({system:'Solve this AI-agent verification challenge. Return only the final answer requested by the challenge, with no explanation or markdown.',user:prompt,maxTokens:400,task:'general',maxEmptyRetries:1});if(!solved.ok||!String(solved.text||'').trim())return false;
      const submitRes=await fetch('https://task-force.app/api/agent/verify/submit',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({challengeId,answer:String(solved.text).trim().slice(0,2000)}),signal:AbortSignal.timeout(12000)});const submitted=await safeJson(submitRes);if(!submitRes.ok){this.event('taskforce_verification_failed',{stage:'submit',status:submitRes.status,error:publicError(submitted)});return false;}
      credential.verified=true;credential.verifiedAt=new Date().toISOString();this.saveTaskForceCredential(credential);this.event('taskforce_verified',{agentId:credential.agentId});return true;
    }catch(error){this.event('taskforce_verification_failed',{error:safeError(error)});return false;}
  }

  async pollTaskForce(credential){return hardenedPollTaskForce.call(this,credential,this.pollTaskForceCore);}

  async pollTaskForceCore(credential){
    const headers=taskForceHeaders(credential.apiKey,'AutonomOS-GlobalHunter/2.0');
    try{
      const r=await fetch('https://task-force.app/api/agent/tasks?status=ACTIVE&limit=100',{headers,signal:AbortSignal.timeout(15000)});const data=await safeJson(r);if(!r.ok){this.event('taskforce_tasks_failed',{status:r.status,error:publicError(data)});return{open:0,applied:0};}
      const rows=arrayFrom(data,['tasks','items','data']);let open=0,applied=0;const maxApply=Math.max(1,Math.min(50,Number(this.env.AUTONOMOS_TASKFORCE_MAX_APPLY_PER_CYCLE||12)));
      for(const raw of rows){const task=this.normalizeTaskForceTask(raw);if(!task)continue;open++;const capability=classifyOpportunity(task,this.capabilityContext());const key=task.externalId;this.state.taskforce.tasks[key]={...task,capability:{skill:capability.skill,executable:capability.executable,missingTools:capability.missingTools||[]},observedAt:new Date().toISOString()};if(applied>=maxApply||!credential.verified||!capability.executable||Number(task.budgetUsd||0)<minimumJobPayoutUsd(this.env))continue;if(this.state.taskforce.applications[key])continue;const result=await this.applyTaskForce(task,capability,credential);if(result.ok)applied++;}
      this.persist();this.event('taskforce_heartbeat',{connected:true,verified:Boolean(credential.verified),openTasks:open,applied});return{open,applied};
    }catch(error){this.event('taskforce_tasks_failed',{error:safeError(error)});return{open:0,applied:0};}
  }

  normalizeTaskForceTask(raw){if(raw?.isTest||raw?.test||raw?.demo||/\b(?:demo task|test listing|commissioning probe|action testing)\b/i.test(String(raw?.title||'')))return null;const id=String(raw?.id||raw?.taskId||'').trim();if(!id)return null;const title=String(raw?.title||raw?.name||'TaskForce task').trim();const description=[raw?.description,raw?.requirements].filter(Boolean).join('\n\nRequirements:\n').slice(0,10000);const budget=Number(raw?.totalBudget??raw?.budget??raw?.amount??raw?.reward??0);return{source:'taskforce',externalId:id,title,description,category:String(raw?.category||'other').toLowerCase(),budgetUsd:budget,currency:'USDC',network:'solana',escrowed:true,status:String(raw?.status||'ACTIVE').toLowerCase(),url:`https://task-force.app/tasks/${id}`,skills:Array.isArray(raw?.skillsRequired)?raw.skillsRequired:[]};}

  async applyTaskForce(task,capability,credential){
    const intent=this.actionJournal.begin('taskforce',task.externalId,'apply');
    if(!intent.ok)return{ok:intent.status==='confirmed',uncertain:intent.status!=='confirmed'};
    this.state.taskforce.applications[task.externalId]={status:'application_uncertain',at:new Date().toISOString(),intentId:intent.id};this.persist();
    const message=`AutonomOS can complete this ${capability.skill||'digital'} task with tool-backed execution and verification. We will follow the stated requirements and submit evidence-backed work.`.slice(0,900);
    try{const r=await fetch(`https://task-force.app/api/agent/tasks/${encodeURIComponent(task.externalId)}/apply`,{method:'POST',headers:{'content-type':'application/json',...taskForceHeaders(credential.apiKey,'AutonomOS-GlobalHunter/2.0')},body:JSON.stringify({message}),signal:AbortSignal.timeout(12000)});const data=await safeJson(r);if(!r.ok){this.state.taskforce.applications[task.externalId]={status:'apply_failed',at:new Date().toISOString(),error:`http_${r.status}:${publicError(data)}`.slice(0,240),failure:classifyFailure(r.status)};this.actionJournal.finish(intent.id,r.status>=500||r.status===408?'uncertain':'definite_failure',{httpStatus:r.status});if(r.status>=500||r.status===408)this.state.taskforce.applications[task.externalId].status='application_uncertain';this.persist();this.event('taskforce_apply_failed',{taskId:task.externalId,status:r.status,error:publicError(data)});return{ok:false};}const app=data?.application||data?.data||data;if(!app?.id){this.actionJournal.finish(intent.id,'uncertain',{httpStatus:r.status});return{ok:false,uncertain:true};}this.actionJournal.finish(intent.id,'confirmed',{externalId:String(app.id)});this.state.taskforce.applications[task.externalId]={applicationId:String(app?.id||''),status:String(app?.status||'PENDING'),title:task.title,budgetUsd:task.budgetUsd,skill:capability.skill,appliedAt:new Date().toISOString()};this.persist();this.event('taskforce_applied',{taskId:task.externalId,applicationId:String(app?.id||''),title:task.title,budgetUsd:task.budgetUsd,skill:capability.skill});return{ok:true};}catch(error){this.actionJournal.finish(intent.id,'uncertain');this.event('taskforce_apply_failed',{taskId:task.externalId,error:safeError(error)});return{ok:false};}
  }

  async pollTaskForceNotifications(credential){return pollTaskForceNotificationsRecovered.call(this,credential);}

  capabilityContext(){return unifiedCapabilityContext(this.env,{llm:this.llm});}
  saveTaskForceCredential(credential){const secrets=this.read(this.secretFile,{});secrets.taskforce=credential;this.writeSecret(this.secretFile,secrets);}
  archiveLead(id,reason,row={}){if(!id)return;this.state.ignored[id]={id,reason,source:row.source||'',title:String(row.title||'').slice(0,180),url:String(row.url||''),archivedAt:new Date().toISOString()};delete this.state.leads[id];if(Object.keys(this.state.ignored).length>10000){const oldest=Object.entries(this.state.ignored).sort((a,b)=>Date.parse(a[1].archivedAt||0)-Date.parse(b[1].archivedAt||0));for(const [key] of oldest.slice(0,1000))delete this.state.ignored[key];}}
  pruneLeads(){const cutoff=Date.now()-14*24*60*60_000;for(const [key,row] of Object.entries(this.state.leads)){if(Date.parse(String(row.lastSeenAt||row.firstSeenAt||0))<cutoff)this.archiveLead(key,'stale_14_days',row);}const rows=Object.entries(this.state.leads).sort((a,b)=>Date.parse(b[1].firstSeenAt||0)-Date.parse(a[1].firstSeenAt||0));for(const [key,row] of rows.slice(5000))this.archiveLead(key,'feed_capacity_archive',row);}
  event(type,detail={}){const row={at:new Date().toISOString(),type,...detail};this.state.events.unshift(row);if(this.state.events.length>500)this.state.events.length=500;this.persist();try{this.logger.info?.('[GlobalWorkHunter] '+JSON.stringify(row));}catch{}}
  persist(){try{const feed=Object.values(this.state.leads).sort((a,b)=>Date.parse(b.firstSeenAt||b.lastSeenAt||0)-Date.parse(a.firstSeenAt||a.lastSeenAt||0));fs.writeFileSync(this.stateFile+'.tmp',JSON.stringify(this.state,null,2),{mode:0o600});fs.renameSync(this.stateFile+'.tmp',this.stateFile);fs.writeFileSync(this.feedFile,JSON.stringify({generatedAt:new Date().toISOString(),count:feed.length,items:feed},null,2),{mode:0o600});fs.writeFileSync(this.archiveFile,JSON.stringify({generatedAt:new Date().toISOString(),count:Object.keys(this.state.ignored).length,items:Object.values(this.state.ignored).sort((a,b)=>Date.parse(b.archivedAt||0)-Date.parse(a.archivedAt||0))},null,2),{mode:0o600});}catch{}}
  read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return structuredClone(fallback);}}
  writeSecret(file,value){const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});try{fs.chmodSync(tmp,0o600);}catch{}fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}}
}

function categoryOf(text){for(const [id,re] of CATEGORY_RULES)if(re.test(text))return id;return'';}
function hash(value){return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,20);}
function countBy(rows,keyFn){const out={};for(const row of rows||[]){const key=String(keyFn(row)||'other');out[key]=(out[key]||0)+1;}return out;}
function arrayFrom(value,keys=[]){if(Array.isArray(value))return value;for(const key of keys){const v=value?.[key];if(Array.isArray(v))return v;}return[];}
function extractTaskId(link){const match=String(link||'').match(/\/tasks\/([^/?#]+)/);return match?.[1]||'';}
function safeError(error){return String(error?.message||error||'').slice(0,240);}
function publicError(value){if(typeof value==='string')return value.slice(0,240);return String(value?.error?.message||value?.error||value?.message||'').slice(0,240);}
async function safeJson(response){const raw=await response.text().catch(()=>'');try{return JSON.parse(raw);}catch{return{message:raw.slice(0,500)}}}

