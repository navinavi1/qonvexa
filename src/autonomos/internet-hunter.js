import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tavilySearch } from './tavily-tool.js';

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
    this.state=this.read(this.stateFile,{version:1,lastScanAt:'',scans:0,platforms:{},jobs:{},events:[]});
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
        const result=await tavilySearch(query,this.env);
        if(!result.ok){this.event('search_failed',{query,error:result.error||''});continue;}
        for(const row of result.results||[]){
          const lead=this.classifyLead(row,query);if(!lead)continue;
          this.upsertPlatform(lead,{source:'internet_search'});discovered++;
        }
      }
      await this.probeSkarnfall().catch(error=>this.event('probe_failed',{source:'skarnfall',error:String(error?.message||error).slice(0,220)}));
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
  async probeSkarnfall(){
    const base='https://skarnfall.com';
    let credential=this.read(this.secretFile,{}).skarnfall||null;
    if(!credential){
      const body={name:String(this.env.AUTONOMOS_AGENT_NAME||'AutonomOS').slice(0,48),skills:['research','data','writing','translation','automation','javascript','python','api-dev','debugging'],model:String(this.env.AUTONOMOS_LLM_MODEL||'gpt-5.6-sol').slice(0,80),email:String(this.env.AUTONOMOS_REGISTRATION_EMAIL||'').slice(0,320)};
      try{
        const response=await fetch(`${base}/api/v1/agents/register`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json','user-agent':'AutonomOS-InternetHunter/1.0'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
        const data=await response.json().catch(()=>({}));
        if(response.ok){
          const token=String(data?.apiKey||data?.api_key||data?.token||data?.agent?.apiKey||'');
          const agentId=String(data?.agentId||data?.agent_id||data?.id||data?.agent?.id||'');
          credential={agentId,apiKey:token,registeredAt:new Date().toISOString()};
          const all=this.read(this.secretFile,{});all.skarnfall=credential;this.writeSecret(this.secretFile,all);
          this.event('auto_registered',{source:'skarnfall',agentId,hasApiKey:Boolean(token)});
        }else this.event('registration_failed',{source:'skarnfall',status:response.status,error:String(data?.error||data?.message||'').slice(0,220)});
      }catch(error){this.event('registration_failed',{source:'skarnfall',error:String(error?.message||error).slice(0,220)});}
    }
    try{
      const headers={accept:'application/json','user-agent':'AutonomOS-InternetHunter/1.0',...(credential?.apiKey?{authorization:`Bearer ${credential.apiKey}`}:{})};
      const response=await fetch(`${base}/api/v1/tasks?sort=best_match`,{headers,signal:AbortSignal.timeout(15000)});
      const data=await response.json().catch(()=>({}));
      const rows=Array.isArray(data)?data:Array.isArray(data?.tasks)?data.tasks:Array.isArray(data?.data)?data.data:[];
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
    }catch(error){this.event('probe_failed',{source:'skarnfall',error:String(error?.message||error).slice(0,220)});}
  }
  async probeKnownPages(){
    for(const id of ['claw-work','seekclaw','a2afans']){
      const p=this.state.platforms[id];if(!p?.url)continue;
      try{const r=await fetch(p.url,{headers:{accept:'text/html','user-agent':'AutonomOS-InternetHunter/1.0'},signal:AbortSignal.timeout(12000)});const text=await r.text();this.upsertPlatform({...p,lastProbeOk:r.ok,lastProbeAt:new Date().toISOString(),pageCryptoEvidence:CRYPTO.test(text),pageWorkEvidence:WORK.test(text),pageHumanGate:HUMAN_ONLY.test(text)},{source:'live_probe'});}catch{}
    }
  }
  upsertPlatform(platform,{source=''}={}){
    if(!platform?.id)return;
    const prev=this.state.platforms[platform.id]||{};
    this.state.platforms[platform.id]={...prev,...platform,firstSeenAt:prev.firstSeenAt||new Date().toISOString(),lastSeenAt:new Date().toISOString(),source:source||prev.source||''};
    this.persist();
  }
  event(type,detail={}){const row={at:new Date().toISOString(),type,...detail};this.state.events.unshift(row);if(this.state.events.length>300)this.state.events.length=300;this.persist();try{this.logger.info?.('[InternetHunter] '+JSON.stringify(row));}catch{}}
  persist(){try{fs.writeFileSync(this.stateFile,JSON.stringify(this.state,null,2),{mode:0o600});}catch{}}
  read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return structuredClone(fallback);}}
  writeSecret(file,value){const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});try{fs.chmodSync(tmp,0o600);}catch{}fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}}
}
function hash(v){return crypto.createHash('sha256').update(String(v)).digest('hex').slice(0,18);}
function parseQueries(v){try{const x=JSON.parse(String(v||''));return Array.isArray(x)?x.map(String).filter(Boolean):null;}catch{return null;}}
