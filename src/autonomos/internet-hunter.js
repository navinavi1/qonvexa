import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { freeWebSearch } from './free-web-tool.js';

const DEFAULT_QUERIES=[
  'AI agent marketplace paid tasks API USDC USDT bounty',
  'autonomous agent jobs crypto escrow API skill.md',
  'AI agents freelance bounty marketplace stablecoin API',
  'agent-native task marketplace USDC escrow register agent',
  'machine-to-machine jobs bounty USDT USDC AI agent',
  'AI agent task hall paid work MCP REST API bounty'
];
const CRYPTO=/\b(USDC|USDT|DAI|ETH|SOL|stablecoin|crypto|on[- ]chain)\b/i;
const WORK=/\b(job|jobs|task|tasks|bounty|bounties|gig|gigs|work|marketplace|task hall)\b/i;
const AGENT_NATIVE=/\b(agent|agents|AI agent|MCP|skill\.md|API[- ]first|agent-native)\b/i;
const HUMAN_ONLY=/\b(captcha|2fa|mfa|KYC|required human verification|verify ownership via (?:twitter|github))\b/i;
const NON_CONVERTIBLE=/\b(points?|credits?|xp|reputation only|non-transferable)\b/i;
const REGISTER_HINT=/\b(register|registration|sign up|signup|POST\s+\/api\/[^\s]*agents?\/register)\b/i;

const seedPlatforms=[
  {id:'agentlancer',name:'AgentLancer',url:'https://agentlancer.io/',payout:'USDT/USDC seller payout with staged escrow',payoutVerified:true,agentNative:true,registration:'documented_api_key_signup',autoRegistration:true,autoWork:true,reason:'nickname-first API signup; service publishing and event polling are documented'},
  {id:'claw-work',name:'Claw Work',url:'https://claw-work.com/',payout:'USDC/USDT shown on public task board',payoutVerified:true,agentNative:true,registration:'human_ownership_claim_required',autoRegistration:false,autoWork:false,reason:'ownership claim via GitHub/Twitter must be completed before autonomous acceptance'},
  {id:'skarnfall',name:'Skarnfall',url:'https://skarnfall.com/',payout:'direct P2P payments',payoutVerified:false,agentNative:true,registration:'documented_api',autoRegistration:true,autoWork:false,reason:'currency/network destination must be verified before bidding'},
  {id:'seekclaw',name:'SeekClaw',url:'https://seekclaw.com/',payout:'CLAW Credits',payoutVerified:false,agentNative:true,registration:'autonomous_did',autoRegistration:true,autoWork:false,reason:'credits are not admitted until a verified convertible payout route exists'},
  {id:'a2afans',name:'A2A Fans',url:'https://a2afans.com/',payout:'RMB/AGT',payoutVerified:false,agentNative:true,registration:'account_agent_credentials',autoRegistration:false,autoWork:false,reason:'requires existing account credentials and no approved crypto/convertible owner route is configured'}
];

export class InternetHunter {
  constructor({env=process.env,storageDir='',logger=console}={}){
    this.env=env;this.logger=logger;
    this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');
    fs.mkdirSync(this.root,{recursive:true});
    this.stateFile=path.join(this.root,'internet-hunter.json');
    this.secretFile=path.join(this.root,'internet-market-credentials.private.json');
    this.timer=null;this.running=false;
    this.state=this.read(this.stateFile,{version:2,lastScanAt:'',scans:0,platforms:{},jobs:{},events:[]});
    for(const p of seedPlatforms)this.upsertPlatform(p,{source:'seed'});
  }
  start(){
    if(this.timer)return;
    const initial=Math.max(1000,Number(this.env.AUTONOMOS_INTERNET_HUNTER_INITIAL_DELAY_MS||5000));
    const every=Math.max(60_000,Number(this.env.AUTONOMOS_INTERNET_HUNTER_INTERVAL_MS||10*60_000));
    setTimeout(()=>this.scan().catch(()=>{}),initial).unref?.();
    this.timer=setInterval(()=>this.scan().catch(()=>{}),every);this.timer.unref?.();
    this.event('hunter_started',{intervalMs:every});
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  snapshot(){return structuredClone(this.state);}
  async scan(){
    if(this.running)return{ok:false,reason:'scan_already_running'};
    if(this.env.AUTONOMOS_INTERNET_HUNTER_ENABLED==='false')return{ok:false,reason:'disabled'};
    this.running=true;
    const started=Date.now();
    try{
      const queries=parseQueries(this.env.AUTONOMOS_INTERNET_HUNTER_QUERIES_JSON)||DEFAULT_QUERIES;
      let discovered=0;
      for(const query of queries.slice(0,12)){
        const result=await freeWebSearch(query,this.env);
        if(!result.ok){this.event('search_failed',{query,error:result.error||''});continue;}
        for(const row of result.results||[]){
          const lead=this.classifyLead(row,query);if(!lead)continue;
          this.upsertPlatform(lead,{source:'internet_search'});discovered++;
        }
      }
      // Prefer verified self-onboarding markets first. A failed market never blocks the rest.
      await this.probeAgentLancer().catch(error=>this.event('probe_failed',{source:'agentlancer',error:safeError(error)}));
      await this.probeSkarnfall().catch(error=>this.event('probe_failed',{source:'skarnfall',error:safeError(error)}));
      await this.probeKnownPages().catch(()=>{});
      this.state.lastScanAt=new Date().toISOString();this.state.scans=Number(this.state.scans||0)+1;
      this.state.lastScanMs=Date.now()-started;this.state.lastDiscovered=discovered;
      this.persist();this.event('scan_completed',{discovered,platforms:Object.keys(this.state.platforms).length,jobs:Object.keys(this.state.jobs).length,ms:this.state.lastScanMs});
      return{ok:true,discovered,platforms:Object.keys(this.state.platforms).length,jobs:Object.keys(this.state.jobs).length};
    }finally{this.running=false;}
  }
  classifyLead(row,query){
    const url=String(row?.url||'');if(!/^https?:\/\//i.test(url))return null;
    const text=`${row?.title||''} ${row?.snippet||''}`;
    if(!WORK.test(text)||!AGENT_NATIVE.test(text))return null;
    let host='';try{host=new URL(url).hostname.toLowerCase().replace(/^www\./,'');}catch{return null;}
    const payoutVerified=CRYPTO.test(text)&&!NON_CONVERTIBLE.test(text);
    const human=HUMAN_ONLY.test(text);
    return{id:`web-${hash(host)}`,name:String(row?.title||host).slice(0,120),host,url,agentNative:true,payout:String((text.match(CRYPTO)||[])[0]||'unknown'),payoutVerified,registration:REGISTER_HINT.test(text)?(human?'human_verification_required':'registration_detected'):'unknown',autoRegistration:REGISTER_HINT.test(text)&&!human,autoWork:false,reason:payoutVerified?'connector lifecycle still needs verified claim+delivery API/browser flow':'payout route not verified',searchScore:Number(row?.score||0),discoveredBy:query};
  }

  async probeAgentLancer(){
    const base='https://agentlancer.io';
    const secrets=this.read(this.secretFile,{});
    let credential=secrets.agentlancer||null;
    if(!credential?.apiKey){
      credential=await this.registerAgentLancer(base);
      if(credential?.apiKey){secrets.agentlancer=credential;this.writeSecret(this.secretFile,secrets);}
    }
    if(!credential?.apiKey){
      this.upsertPlatform({...seedPlatforms.find(x=>x.id==='agentlancer'),connected:false,lastProbeOk:false,lastProbeAt:new Date().toISOString(),reason:'autonomous signup did not return an API key yet'},{source:'live_probe'});
      return;
    }
    const headers={accept:'application/json','x-api-key':credential.apiKey,'user-agent':'AutonomOS-InternetHunter/2.0'};
    // Verify identity before creating any public supply.
    const meRes=await fetch(`${base}/api/agent/me`,{headers,signal:AbortSignal.timeout(12000)});
    const me=await safeJson(meRes);
    if(!meRes.ok){this.event('agentlancer_auth_failed',{status:meRes.status,error:publicError(me)});return;}
    credential.agentId=String(me?.id||me?.agent?.id||credential.agentId||'');
    credential.nickname=String(me?.nickname||me?.agent?.nickname||credential.nickname||'');

    if(!credential.serviceId){
      const serviceBody={
        title:'AutonomOS Rapid Research + Data Sprint',
        description:'Public-web research, structured data cleanup, comparison tables, concise decision briefs, and lightweight API/automation diagnostics completed by an autonomous worker with source/tool evidence.',
        request_method:'Send one bounded question, public URLs/data, desired output format, and acceptance criteria. No private credentials or identity-required actions.',
        buyer_input:'Public URLs, non-secret text/CSV/JSON, target question, and acceptance criteria.',
        deliverable:'Source-backed Markdown brief and/or cleaned structured data with explicit assumptions, verification notes, and durable artifact link when a file is requested.',
        deliverable_format:'Markdown, CSV, JSON, or small code/report artifact as agreed.',
        deliverable_contents:'Result, sources/evidence, assumptions, verification checklist, and any generated artifact URL.',
        acceptance_criteria:'Complete when the requested bounded output is delivered, factual claims are source-backed where required, and requested data/code checks pass.',
        turnaround:'1 day after complete public inputs are supplied.',
        pilot_price:'25 USDT/USDC fixed pilot; larger scope is quoted separately before work starts.',
        revision_policy:'One correction pass for factual or acceptance-criteria misses; scope expansion requires a new quote.',
        limitations:'Public/authorized data only. No CAPTCHA/2FA bypass, impersonation, private credentials, guaranteed revenue, or prohibited actions.',
        promotion_consent:true,
        price_from:25,
        delivery_days:1,
        tags:'research,data,automation,qa,api'
      };
      const r=await fetch(`${base}/api/agent/services`,{method:'POST',headers:{...headers,'content-type':'application/json','idempotency-key':'autonomos-first-service-v1'},body:JSON.stringify(serviceBody),signal:AbortSignal.timeout(15000)});
      const data=await safeJson(r);
      if(r.ok){
        credential.serviceId=String(data?.id||data?.service_id||data?.service?.id||'');credential.servicePublishedAt=new Date().toISOString();secrets.agentlancer=credential;this.writeSecret(this.secretFile,secrets);
        this.event('service_published',{source:'agentlancer',serviceId:credential.serviceId,title:serviceBody.title,priceFrom:25,currency:'USDT/USDC'});
      }else this.event('service_publish_failed',{source:'agentlancer',status:r.status,error:publicError(data)});
    }

    // One public discovery post only; never spam on every heartbeat.
    if(credential.serviceId&&!credential.communityPostAt){
      const post={intent:'service',body:'AutonomOS is available for a 25 USDT/USDC public-web research + data sprint: source-backed brief, cleanup/comparison, verification checklist, and artifact when requested. 1-day target for bounded scopes.',related_service_id:numericOrString(credential.serviceId)};
      const r=await fetch(`${base}/api/community/posts`,{method:'POST',headers:{...headers,'content-type':'application/json','idempotency-key':'autonomos-community-service-v1'},body:JSON.stringify(post),signal:AbortSignal.timeout(12000)});
      const data=await safeJson(r);
      if(r.ok){credential.communityPostAt=new Date().toISOString();credential.communityPostId=String(data?.id||data?.post?.id||'');secrets.agentlancer=credential;this.writeSecret(this.secretFile,secrets);this.event('service_discovery_posted',{source:'agentlancer',serviceId:credential.serviceId,postId:credential.communityPostId});}
      else this.event('community_post_failed',{source:'agentlancer',status:r.status,error:publicError(data)});
    }

    const [jobsRes,eventsRes]=await Promise.all([
      fetch(`${base}/api/agent/jobs`,{headers,signal:AbortSignal.timeout(12000)}),
      fetch(`${base}/api/agent/events?since_id=${encodeURIComponent(String(credential.lastEventId||0))}`,{headers,signal:AbortSignal.timeout(12000)})
    ]);
    const jobsData=await safeJson(jobsRes),eventsData=await safeJson(eventsRes);
    const rows=arrayFrom(jobsData,['jobs','items','data']);
    let realOpen=0;
    for(const raw of rows){
      const id=String(raw?.id||raw?.job_id||'');if(!id)continue;
      const status=String(raw?.status||'open').toLowerCase();
      const synthetic=Boolean(raw?.synthetic||raw?.is_synthetic||raw?.seeded||raw?.backfill)||/synthetic|seed|demo|sample/i.test(String(raw?.source||raw?.kind||''));
      if(synthetic||!['open','posted','available'].includes(status))continue;
      const budget=Number(raw?.budget??raw?.amount??raw?.price??raw?.pay??0);
      const currency=String(raw?.currency||raw?.payout_currency||raw?.payment_currency||'USDT').toUpperCase();
      if(!['USDT','USDC'].includes(currency)||budget<=0)continue;
      realOpen++;
      this.state.jobs[`agentlancer:${id}`]={source:'agentlancer',externalId:id,title:String(raw?.title||'AgentLancer job').slice(0,200),description:String(raw?.detail||raw?.description||raw?.scope||'').slice(0,7000),amount:budget,currency,status,url:`${base}/jobs`,payoutVerified:true,claimReady:true,claimMode:'proposal',reason:'real open AgentLancer demand; proposal schema/lifecycle must be satisfied before execution',observedAt:new Date().toISOString(),rawSummary:{category:String(raw?.category||''),days:Number(raw?.days||raw?.delivery_days||0)}};
    }
    const events=arrayFrom(eventsData,['events','items','data']);
    const maxEvent=events.map(x=>Number(x?.id||x?.event_id||0)).filter(Number.isFinite).reduce((a,b)=>Math.max(a,b),Number(credential.lastEventId||0));
    if(maxEvent>Number(credential.lastEventId||0)){credential.lastEventId=maxEvent;secrets.agentlancer=credential;this.writeSecret(this.secretFile,secrets);}
    this.upsertPlatform({...seedPlatforms.find(x=>x.id==='agentlancer'),connected:true,agentId:credential.agentId||'',nickname:credential.nickname||'',servicePublished:Boolean(credential.serviceId),serviceId:credential.serviceId||'',lastProbeOk:jobsRes.ok&&eventsRes.ok,lastTaskCount:rows.length,realOpenJobs:realOpen,lastEventCount:events.length,lastProbeAt:new Date().toISOString()},{source:'live_probe'});
    this.event('agentlancer_heartbeat',{connected:true,servicePublished:Boolean(credential.serviceId),realOpenJobs:realOpen,events:events.length});
  }

  async registerAgentLancer(base){
    const suffix=hash(String(this.env.AUTONOMOS_OWNER_WALLET||this.env.AUTONOMOS_REGISTRATION_EMAIL||'autonomos')).slice(0,8);
    const initialNickname=String(this.env.AUTONOMOS_AGENTLANCER_NICKNAME||`autonomos-${suffix}`).toLowerCase().replace(/[^a-z0-9_-]/g,'-').slice(0,40);
    let nickname=initialNickname;
    for(let attempt=0;attempt<3;attempt++){
      try{
        const body={name:String(this.env.AUTONOMOS_AGENT_NAME||'AutonomOS').slice(0,64),nickname,category:'research'};
        const r=await fetch(`${base}/api/agent/signup`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json','user-agent':'AutonomOS-InternetHunter/2.0'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
        const data=await safeJson(r);
        if(r.ok){
          const apiKey=String(data?.apiKey||data?.api_key||data?.key||data?.agent_api_key||data?.agent?.api_key||'');
          const agentId=String(data?.agentId||data?.agent_id||data?.id||data?.agent?.id||'');
          if(!apiKey){this.event('registration_failed',{source:'agentlancer',status:r.status,error:'signup_response_missing_api_key'});return null;}
          const value={apiKey,agentId,nickname:String(data?.nickname||data?.agent?.nickname||nickname),registeredAt:new Date().toISOString(),source:'autonomous_api_signup'};
          this.event('auto_registered',{source:'agentlancer',agentId:value.agentId,nickname:value.nickname,hasApiKey:true});return value;
        }
        const suggestions=data?.suggestions||data?.available_suggestions||data?.available||[];
        if(r.status===409&&Array.isArray(suggestions)&&suggestions.length){nickname=String(suggestions[0]).slice(0,40);continue;}
        if(r.status===409){nickname=`${initialNickname}-${crypto.randomBytes(2).toString('hex')}`.slice(0,40);continue;}
        this.event('registration_failed',{source:'agentlancer',status:r.status,error:publicError(data)});return null;
      }catch(error){this.event('registration_failed',{source:'agentlancer',error:safeError(error)});return null;}
    }
    return null;
  }

  async probeSkarnfall(){
    const base='https://skarnfall.com';
    let credential=this.read(this.secretFile,{}).skarnfall||null;
    if(!credential){
      const body={name:String(this.env.AUTONOMOS_AGENT_NAME||'AutonomOS').slice(0,48),skills:['research','data','writing','translation','automation','javascript','python','api-dev','debugging'],model:String(this.env.AUTONOMOS_LLM_MODEL||'gpt-5.6-sol').slice(0,80),email:String(this.env.AUTONOMOS_REGISTRATION_EMAIL||'').slice(0,320)};
      try{
        const response=await fetch(`${base}/api/v1/agents/register`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json','user-agent':'AutonomOS-InternetHunter/2.0'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
        const data=await safeJson(response);
        if(response.ok){
          const token=String(data?.apiKey||data?.api_key||data?.token||data?.agent?.apiKey||'');
          const agentId=String(data?.agentId||data?.agent_id||data?.id||data?.agent?.id||'');
          credential={agentId,apiKey:token,registeredAt:new Date().toISOString()};
          const all=this.read(this.secretFile,{});all.skarnfall=credential;this.writeSecret(this.secretFile,all);
          this.event('auto_registered',{source:'skarnfall',agentId,hasApiKey:Boolean(token)});
        }else this.event('registration_failed',{source:'skarnfall',status:response.status,error:publicError(data)});
      }catch(error){this.event('registration_failed',{source:'skarnfall',error:safeError(error)});}
    }
    try{
      const headers={accept:'application/json','user-agent':'AutonomOS-InternetHunter/2.0',...(credential?.apiKey?{authorization:`Bearer ${credential.apiKey}`}:{})};
      const response=await fetch(`${base}/api/v1/tasks?sort=best_match`,{headers,signal:AbortSignal.timeout(15000)});
      const data=await safeJson(response);
      const rows=arrayFrom(data,['tasks','items','data']);
      const platform=this.state.platforms.skarnfall||seedPlatforms.find(x=>x.id==='skarnfall');
      this.upsertPlatform({...platform,connected:Boolean(credential),lastProbeOk:response.ok,lastTaskCount:rows.length,lastProbeAt:new Date().toISOString()},{source:'live_probe'});
      for(const raw of rows){
        const id=String(raw?.id||raw?.taskId||'');if(!id)continue;
        const currency=String(raw?.currency||raw?.compensationCurrency||raw?.payment?.currency||'').toUpperCase();
        const amount=Number(raw?.amount??raw?.compensationAmount??raw?.reward??raw?.budget??0);
        const network=String(raw?.network||raw?.payment?.network||'').toLowerCase();
        const payoutVerified=['USDC','USDT','DAI','ETH','SOL'].includes(currency)&&Boolean(network);
        this.state.jobs[`skarnfall:${id}`]={source:'skarnfall',externalId:id,title:String(raw?.title||raw?.name||'Skarnfall task').slice(0,200),description:String(raw?.description||raw?.brief||'').slice(0,5000),amount,currency,network,status:String(raw?.status||'open'),url:raw?.url||`${base}/tasks/${id}`,payoutVerified,claimReady:false,reason:payoutVerified?'bid API needs authenticated lifecycle verification before autonomous submission':'currency/network payout not verified',observedAt:new Date().toISOString()};
      }
    }catch(error){this.event('probe_failed',{source:'skarnfall',error:safeError(error)});}
  }
  async probeKnownPages(){
    for(const id of ['claw-work','seekclaw','a2afans']){
      const p=this.state.platforms[id];if(!p?.url)continue;
      try{const r=await fetch(p.url,{headers:{accept:'text/html','user-agent':'AutonomOS-InternetHunter/2.0'},signal:AbortSignal.timeout(12000)});const text=await r.text();this.upsertPlatform({...p,lastProbeOk:r.ok,lastProbeAt:new Date().toISOString(),pageCryptoEvidence:CRYPTO.test(text),pageWorkEvidence:WORK.test(text),pageHumanGate:HUMAN_ONLY.test(text)},{source:'live_probe'});}catch{}
    }
  }
  upsertPlatform(platform,{source=''}={}){
    if(!platform?.id)return;
    const prev=this.state.platforms[platform.id]||{};
    this.state.platforms[platform.id]={...prev,...platform,firstSeenAt:prev.firstSeenAt||new Date().toISOString(),lastSeenAt:new Date().toISOString(),source:source||prev.source||''};
    this.persist();
  }
  event(type,detail={}){const row={at:new Date().toISOString(),type,...detail};this.state.events.unshift(row);if(this.state.events.length>500)this.state.events.length=500;this.persist();try{this.logger.info?.('[InternetHunter] '+JSON.stringify(row));}catch{}}
  persist(){try{fs.writeFileSync(this.stateFile,JSON.stringify(this.state,null,2),{mode:0o600});}catch{}}
  read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return structuredClone(fallback);}}
  writeSecret(file,value){const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});try{fs.chmodSync(tmp,0o600);}catch{}fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}}
}
function hash(v){return crypto.createHash('sha256').update(String(v)).digest('hex').slice(0,18);}
function parseQueries(v){try{const x=JSON.parse(String(v||''));return Array.isArray(x)?x.map(String).filter(Boolean):null;}catch{return null;}}
async function safeJson(response){try{return await response.json();}catch{return{};}}
function arrayFrom(value,keys=[]){if(Array.isArray(value))return value;for(const key of keys){if(Array.isArray(value?.[key]))return value[key];}return[];}
function publicError(value){const v=value?.error?.message||value?.error||value?.message||value?.detail||'';if(typeof v==='string')return v.slice(0,220);try{return JSON.stringify(v).slice(0,220);}catch{return'unknown_error';}}
function safeError(error){return String(error?.message||error||'unknown_error').slice(0,220);}
function numericOrString(value){const n=Number(value);return Number.isFinite(n)&&String(n)===String(value)?n:value;}
