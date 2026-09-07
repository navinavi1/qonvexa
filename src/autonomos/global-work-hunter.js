import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tavilySearch } from './tavily-tool.js';
import { createLlmClient } from './llm.js';
import { classifyOpportunity } from './capabilities.js';

const GLOBAL_QUERIES = [
  'site:laborx.com/jobs translation freelance USDT USDC remote',
  'site:laborx.com/jobs writing copywriting proofreading editing crypto freelance',
  'site:laborx.com/jobs data entry research spreadsheet crypto freelance',
  'site:laborx.com/jobs python javascript api script automation freelance',
  'site:laborx.com/jobs QA testing website bug fix freelance crypto',
  'remote worldwide translation localization freelance paid USDT USDC',
  'remote copywriting content writing proofreading freelance paid crypto',
  'remote data entry web research spreadsheet freelance paid crypto',
  'remote python javascript script automation API freelance paid crypto',
  'AI agent work marketplace USDC API research writing development tasks',
  'crypto freelance marketplace writing translation code research USDT USDC',
  'worldwide remote micro freelance tasks translation writing coding crypto payment'
];

const CATEGORY_RULES = [
  ['translation', /\b(translation|translate|translator|localization|localisation|language)\b/i],
  ['copywriting', /\b(copywriting|copywriter|content writing|writer|writing|proofread|editing|rewrite|article|blog|seo)\b/i],
  ['data', /\b(data entry|spreadsheet|excel|csv|data cleanup|data cleaning|research|lead list|web research)\b/i],
  ['development', /\b(python|javascript|typescript|node\.?js|api|script|coding|developer|software|bug fix|frontend|backend|react)\b/i],
  ['automation', /\b(automation|workflow|integration|zapier|make\.com|n8n|crm|scraping|browser automation)\b/i],
  ['testing', /\b(qa|quality assurance|testing|test website|bug report|usability)\b/i]
];

const MONEY = /(?:\$\s?([0-9][0-9,]*(?:\.\d+)?)|([0-9][0-9,]*(?:\.\d+)?)\s?(USDT|USDC|DAI|USD|EUR|ETH|SOL))/i;
const CRYPTO = /\b(USDT|USDC|DAI|ETH|SOL|BTC|BNB|stablecoin|cryptocurrency|crypto payment|paid in crypto)\b/i;
const HUMAN_GATE = /\b(captcha|KYC|government ID|selfie verification|2FA|MFA|phone verification|human verification)\b/i;
const UNSAFE = /\b(malware|ransomware|phishing|credential theft|steal passwords?|fake reviews?|mass spam|spam campaign|weapons?|firearms?|explosives?|illegal drugs?|money laundering)\b/i;

export class GlobalWorkHunter {
  constructor({env=process.env,storageDir='',logger=console}={}){
    this.env=env;
    this.logger=logger;
    this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');
    fs.mkdirSync(this.root,{recursive:true});
    this.stateFile=path.join(this.root,'global-work-hunter.json');
    this.secretFile=path.join(this.root,'global-work-credentials.private.json');
    this.state=this.read(this.stateFile,{version:1,startedAt:'',lastScanAt:'',scans:0,queryCursor:0,leads:{},taskforce:{applications:{},tasks:{},events:[]},events:[]});
    this.timer=null;
    this.running=false;
    this.llm=createLlmClient(env);
  }

  start(){
    if(this.timer)return;
    const initial=Math.max(1500,Number(this.env.AUTONOMOS_GLOBAL_HUNTER_INITIAL_DELAY_MS||7000));
    const every=Math.max(60_000,Number(this.env.AUTONOMOS_GLOBAL_HUNTER_INTERVAL_MS||60_000));
    this.state.startedAt=this.state.startedAt||new Date().toISOString();
    this.persist();
    setTimeout(()=>this.cycle().catch(error=>this.event('cycle_error',{error:safeError(error)})),initial).unref?.();
    this.timer=setInterval(()=>this.cycle().catch(error=>this.event('cycle_error',{error:safeError(error)})),every);
    this.timer.unref?.();
    this.event('global_work_hunter_started',{intervalMs:every,scope:'worldwide',categories:CATEGORY_RULES.map(x=>x[0])});
  }

  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}

  async cycle(){
    if(this.running)return{ok:false,reason:'cycle_already_running'};
    if(String(this.env.AUTONOMOS_GLOBAL_HUNTER_ENABLED||'true').toLowerCase()==='false')return{ok:false,reason:'disabled'};
    this.running=true;
    const started=Date.now();
    try{
      const search=await this.searchWorldwide();
      const taskforce=await this.runTaskForce();
      this.state.scans=Number(this.state.scans||0)+1;
      this.state.lastScanAt=new Date().toISOString();
      this.state.lastScanMs=Date.now()-started;
      this.persist();
      const categories=countBy(Object.values(this.state.leads),x=>x.category||'other');
      this.event('global_scan_completed',{newLeads:search.newLeads,totalLeads:Object.keys(this.state.leads).length,taskforceOpen:taskforce.open||0,taskforceApplied:taskforce.applied||0,categories,ms:this.state.lastScanMs});
      return{ok:true,...search,taskforce};
    }finally{this.running=false;}
  }

  async searchWorldwide(){
    const perCycle=Math.max(2,Math.min(6,Number(this.env.AUTONOMOS_GLOBAL_QUERIES_PER_CYCLE||4)));
    let cursor=Number(this.state.queryCursor||0)%GLOBAL_QUERIES.length;
    let newLeads=0;
    for(let i=0;i<perCycle;i++){
      const query=GLOBAL_QUERIES[(cursor+i)%GLOBAL_QUERIES.length];
      const result=await tavilySearch(query,this.env);
      if(!result.ok){this.event('global_search_failed',{query,error:result.error||''});continue;}
      for(const row of result.results||[]){
        const lead=this.classifyWebLead(row,query);
        if(!lead)continue;
        const key=lead.id;
        const prev=this.state.leads[key];
        if(!prev)newLeads++;
        this.state.leads[key]={...prev,...lead,firstSeenAt:prev?.firstSeenAt||new Date().toISOString(),lastSeenAt:new Date().toISOString()};
      }
    }
    this.state.queryCursor=(cursor+perCycle)%GLOBAL_QUERIES.length;
    this.pruneLeads();
    this.persist();
    return{newLeads};
  }

  classifyWebLead(row,query){
    const url=String(row?.url||'').trim();
    if(!/^https?:\/\//i.test(url))return null;
    let host='';try{host=new URL(url).hostname.toLowerCase().replace(/^www\./,'');}catch{return null;}
    const text=`${row?.title||''} ${row?.snippet||''}`;
    if(UNSAFE.test(text))return null;
    const category=categoryOf(text);
    if(!category&&!/\b(job|freelance|gig|task|contract|bounty|work)\b/i.test(text))return null;
    const money=text.match(MONEY);
    const amount=money?Number(String(money[1]||money[2]||'0').replace(/,/g,'')):0;
    const explicitCurrency=String(money?.[3]||'').toUpperCase();
    const cryptoMatch=text.match(CRYPTO);
    const laborx=/\blaborx\.com$/i.test(host);
    const cryptoPayout=Boolean(cryptoMatch)||laborx;
    const payoutCurrency=explicitCurrency||String(cryptoMatch?.[1]||'').toUpperCase()||(laborx?'CRYPTO':'UNKNOWN');
    const humanGate=HUMAN_GATE.test(text);
    const applyMode=laborx?'browser_account_required':'connector_or_browser_required';
    return{
      id:`webwork_${hash(url)}`,
      source:host,
      title:String(row?.title||'Paid digital work').slice(0,220),
      url,
      category:category||'general-digital',
      amountUsd:amount,
      payoutCurrency,
      cryptoPayout,
      payoutVerified:cryptoPayout&&laborx,
      worldwide:/worldwide|remote|global/i.test(text)||laborx,
      humanGate,
      applyReady:false,
      applyMode,
      blocker:humanGate?'protected_registration_or_identity_step_required':'account/application connector not yet authenticated',
      searchScore:Number(row?.score||0),
      discoveredBy:query,
      snippet:String(row?.snippet||'').slice(0,1500)
    };
  }

  async runTaskForce(){
    const credential=await this.ensureTaskForceCredential();
    if(!credential?.apiKey)return{open:0,applied:0,reason:'registration_not_ready'};
    if(!credential.verified)await this.verifyTaskForceAgent(credential);
    const result=await this.pollTaskForce(credential);
    await this.pollTaskForceNotifications(credential).catch(error=>this.event('taskforce_notifications_failed',{error:safeError(error)}));
    return result;
  }

  async ensureTaskForceCredential(){
    const secrets=this.read(this.secretFile,{});
    let credential=secrets.taskforce||null;
    if(credential?.apiKey)return credential;
    try{
      const body={
        name:String(this.env.AUTONOMOS_AGENT_NAME||'AutonomOS').slice(0,100),
        capabilities:['translation','writing','research','data','development','testing','automation','browser']
      };
      const r=await fetch('https://task-force.app/api/agent/register',{method:'POST',headers:{'content-type':'application/json',accept:'application/json','user-agent':'AutonomOS-GlobalHunter/1.0'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
      const data=await safeJson(r);
      if(!r.ok){this.event('taskforce_registration_failed',{status:r.status,error:publicError(data)});return null;}
      const apiKey=String(data?.apiKey||data?.api_key||'');
      const agent=data?.agent||{};
      if(!apiKey){this.event('taskforce_registration_failed',{status:r.status,error:'missing_api_key'});return null;}
      credential={apiKey,agentId:String(agent?.id||data?.agentId||''),walletAddress:String(agent?.walletAddress||data?.walletAddress||''),status:String(agent?.status||''),verified:false,createdAt:new Date().toISOString()};
      secrets.taskforce=credential;this.writeSecret(this.secretFile,secrets);
      this.event('taskforce_registered',{agentId:credential.agentId,walletAddress:credential.walletAddress,status:credential.status});
      return credential;
    }catch(error){this.event('taskforce_registration_failed',{error:safeError(error)});return null;}
  }

  async verifyTaskForceAgent(credential){
    if(!credential?.apiKey||credential.verified)return Boolean(credential?.verified);
    const headers={accept:'application/json','x-api-key':credential.apiKey,authorization:`Bearer ${credential.apiKey}`,'user-agent':'AutonomOS-GlobalHunter/1.0'};
    try{
      const challengeRes=await fetch('https://task-force.app/api/agent/verify/challenge',{method:'POST',headers,signal:AbortSignal.timeout(12000)});
      const challenge=await safeJson(challengeRes);
      if(!challengeRes.ok){
        if(challengeRes.status===409||/already verified/i.test(publicError(challenge))){credential.verified=true;this.saveTaskForceCredential(credential);return true;}
        this.event('taskforce_verification_failed',{stage:'challenge',status:challengeRes.status,error:publicError(challenge)});return false;
      }
      const challengeId=String(challenge?.challengeId||challenge?.id||'');
      const prompt=String(challenge?.prompt||challenge?.question||'').trim();
      if(!challengeId||!prompt||!this.llm.enabled){this.event('taskforce_verification_failed',{stage:'challenge_shape',hasId:Boolean(challengeId),hasPrompt:Boolean(prompt),llmEnabled:this.llm.enabled});return false;}
      const solved=await this.llm.complete({system:'Solve this AI-agent verification challenge. Return only the final answer requested by the challenge, with no explanation or markdown.',user:prompt,maxTokens:400,task:'general',maxEmptyRetries:1});
      if(!solved.ok||!String(solved.text||'').trim()){this.event('taskforce_verification_failed',{stage:'solve',error:solved.reason||'empty_answer'});return false;}
      const submitRes=await fetch('https://task-force.app/api/agent/verify/submit',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({challengeId,answer:String(solved.text).trim().slice(0,2000)}),signal:AbortSignal.timeout(12000)});
      const submitted=await safeJson(submitRes);
      if(!submitRes.ok){this.event('taskforce_verification_failed',{stage:'submit',status:submitRes.status,error:publicError(submitted)});return false;}
      credential.verified=true;credential.verifiedAt=new Date().toISOString();this.saveTaskForceCredential(credential);
      this.event('taskforce_verified',{agentId:credential.agentId});
      return true;
    }catch(error){this.event('taskforce_verification_failed',{error:safeError(error)});return false;}
  }

  async pollTaskForce(credential){
    const headers={accept:'application/json','x-api-key':credential.apiKey,'user-agent':'AutonomOS-GlobalHunter/1.0'};
    try{
      const r=await fetch('https://task-force.app/api/agent/tasks?status=ACTIVE&limit=100',{headers,signal:AbortSignal.timeout(15000)});
      const data=await safeJson(r);
      if(!r.ok){this.event('taskforce_tasks_failed',{status:r.status,error:publicError(data)});return{open:0,applied:0};}
      const rows=arrayFrom(data,['tasks','items','data']);
      let open=0,applied=0;
      const maxApply=Math.max(1,Math.min(10,Number(this.env.AUTONOMOS_TASKFORCE_MAX_APPLY_PER_CYCLE||4)));
      for(const raw of rows){
        const task=this.normalizeTaskForceTask(raw);if(!task)continue;open++;
        const capability=classifyOpportunity(task,this.capabilityContext());
        const key=task.externalId;
        this.state.taskforce.tasks[key]={...task,capability:{skill:capability.skill,executable:capability.executable,missingTools:capability.missingTools||[]},observedAt:new Date().toISOString()};
        if(applied>=maxApply||!credential.verified||!capability.executable||Number(task.budgetUsd||0)<0.5)continue;
        if(this.state.taskforce.applications[key])continue;
        const result=await this.applyTaskForce(task,capability,credential);
        if(result.ok)applied++;
      }
      this.persist();
      this.event('taskforce_heartbeat',{connected:true,verified:Boolean(credential.verified),openTasks:open,applied});
      return{open,applied};
    }catch(error){this.event('taskforce_tasks_failed',{error:safeError(error)});return{open:0,applied:0};}
  }

  normalizeTaskForceTask(raw){
    const id=String(raw?.id||raw?.taskId||'').trim();if(!id)return null;
    const title=String(raw?.title||raw?.name||'TaskForce task').trim();
    const description=[raw?.description,raw?.requirements].filter(Boolean).join('\n\nRequirements:\n').slice(0,10000);
    const budget=Number(raw?.totalBudget??raw?.budget??raw?.amount??raw?.reward??0);
    return{source:'taskforce',externalId:id,title,description,category:String(raw?.category||'other').toLowerCase(),budgetUsd:budget,currency:'USDC',network:'solana',escrowed:true,status:String(raw?.status||'ACTIVE').toLowerCase(),url:`https://task-force.app/tasks/${id}`,skills:Array.isArray(raw?.skillsRequired)?raw.skillsRequired:[]};
  }

  async applyTaskForce(task,capability,credential){
    const message=`AutonomOS can complete this ${capability.skill||'digital'} task with real tool-backed execution and verification. I will follow the stated requirements, produce the requested deliverable, and report evidence rather than claiming unperformed work.`.slice(0,900);
    try{
      const r=await fetch(`https://task-force.app/api/agent/tasks/${encodeURIComponent(task.externalId)}/apply`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json','x-api-key':credential.apiKey,'user-agent':'AutonomOS-GlobalHunter/1.0'},body:JSON.stringify({message}),signal:AbortSignal.timeout(12000)});
      const data=await safeJson(r);
      if(!r.ok){
        this.state.taskforce.applications[task.externalId]={status:'apply_failed',at:new Date().toISOString(),error:`http_${r.status}:${publicError(data)}`.slice(0,240)};this.persist();
        this.event('taskforce_apply_failed',{taskId:task.externalId,status:r.status,error:publicError(data)});return{ok:false};
      }
      const app=data?.application||data?.data||data;
      this.state.taskforce.applications[task.externalId]={applicationId:String(app?.id||''),status:String(app?.status||'PENDING'),title:task.title,budgetUsd:task.budgetUsd,skill:capability.skill,appliedAt:new Date().toISOString()};this.persist();
      this.event('taskforce_applied',{taskId:task.externalId,applicationId:String(app?.id||''),title:task.title,budgetUsd:task.budgetUsd,skill:capability.skill});
      return{ok:true};
    }catch(error){this.event('taskforce_apply_failed',{taskId:task.externalId,error:safeError(error)});return{ok:false};}
  }

  async pollTaskForceNotifications(credential){
    const headers={accept:'application/json','x-api-key':credential.apiKey,'user-agent':'AutonomOS-GlobalHunter/1.0'};
    const r=await fetch('https://task-force.app/api/agent/notifications?unreadOnly=true&limit=100',{headers,signal:AbortSignal.timeout(12000)});
    const data=await safeJson(r);if(!r.ok)return;
    const notifications=arrayFrom(data,['notifications','items','data']);
    const ids=[];
    for(const n of notifications){
      const id=String(n?.id||'');if(id)ids.push(id);
      const type=String(n?.type||'');
      const taskId=String(n?.taskId||extractTaskId(n?.link)||'');
      if(taskId&&this.state.taskforce.applications[taskId]){
        if(type==='APPLICATION_ACCEPTED')this.state.taskforce.applications[taskId].status='ACCEPTED';
        if(type==='APPLICATION_REJECTED')this.state.taskforce.applications[taskId].status='REJECTED';
        if(type==='SUBMISSION_APPROVED')this.state.taskforce.applications[taskId].status='PAID_OR_APPROVED';
        if(type==='SUBMISSION_REJECTED')this.state.taskforce.applications[taskId].status='SUBMISSION_REJECTED';
        this.state.taskforce.applications[taskId].updatedAt=new Date().toISOString();
      }
      this.state.taskforce.events.unshift({at:new Date().toISOString(),id,type,taskId,message:String(n?.message||'').slice(0,400)});
      this.event('taskforce_notification',{type,taskId,message:String(n?.message||'').slice(0,180)});
    }
    if(this.state.taskforce.events.length>300)this.state.taskforce.events.length=300;
    this.persist();
    if(ids.length){
      await fetch('https://task-force.app/api/agent/notifications/read',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({notificationIds:ids}),signal:AbortSignal.timeout(12000)}).catch(()=>{});
    }
  }

  capabilityContext(){
    return{
      llmEnabled:Boolean(this.llm?.enabled),
      hasGithubPrTool:Boolean(this.env.GITHUB_TOKEN),
      hasShellTool:Boolean(this.env.E2B_API_KEY),
      hasBrowserTool:Boolean(this.env.BROWSERBASE_API_KEY&&this.env.BROWSERBASE_PROJECT_ID),
      hasDeployTool:Boolean(this.env.AUTONOMOS_DEPLOY_WEBHOOK_URL),
      hasArtifactTool:Boolean((this.env.S3_ENDPOINT||this.env.R2_ENDPOINT)&&(this.env.S3_BUCKET||this.env.R2_BUCKET)),
      hasAppTool:Boolean(this.env.COMPOSIO_API_KEY),
      connectedApps:[],
      hasWebSearchTool:Boolean(this.env.FIRECRAWL_API_KEY||this.env.TAVILY_API_KEY),
      hasDesignMediaTool:false
    };
  }

  saveTaskForceCredential(credential){const secrets=this.read(this.secretFile,{});secrets.taskforce=credential;this.writeSecret(this.secretFile,secrets);}
  pruneLeads(){const cutoff=Date.now()-14*24*60*60_000;for(const [key,row] of Object.entries(this.state.leads)){if(Date.parse(String(row.lastSeenAt||row.firstSeenAt||0))<cutoff)delete this.state.leads[key];}const rows=Object.entries(this.state.leads).sort((a,b)=>Number(b[1].searchScore||0)-Number(a[1].searchScore||0));for(const [key] of rows.slice(1000))delete this.state.leads[key];}
  event(type,detail={}){const row={at:new Date().toISOString(),type,...detail};this.state.events.unshift(row);if(this.state.events.length>400)this.state.events.length=400;this.persist();try{this.logger.info?.('[GlobalWorkHunter] '+JSON.stringify(row));}catch{}}
  persist(){try{fs.writeFileSync(this.stateFile,JSON.stringify(this.state,null,2),{mode:0o600});}catch{}}
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
