import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_QUERIES=[
  'ai agent marketplace bounty usdc',
  'autonomous agent paid tasks usdt api',
  'freelance bounty marketplace crypto api',
  'agent jobs marketplace escrow stablecoin'
];
const SIGNAL_WORK=/\b(job|jobs|task|tasks|bounty|bounties|gig|gigs|freelance|contract|marketplace|hire|hiring|paid work)\b/i;
const SIGNAL_PAYOUT=/\b(USDC|USDT|DAI|ETH|SOL|BTC|USD|EUR|escrow|payment|payout|reward|paid)\b/i;
const SIGNAL_AGENT=/\b(agent|agents|AI agent|autonomous|MCP|API[- ]first|agent-native)\b/i;
const SIGNAL_REGISTER=/\b(register|registration|sign up|signup|api key|oauth|\/register|agents?\/register)\b/i;
const HUMAN_GATE=/\b(captcha|kyc|government id|selfie|phone verification|sms verification|2fa|mfa)\b/i;

export class FreeMarketScout{
  constructor({env=process.env,storageDir='',logger=console}={}){
    this.env=env;this.logger=logger;this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');fs.mkdirSync(this.root,{recursive:true});
    this.file=path.join(this.root,'free-market-scout.json');this.state=read(this.file,{version:1,lastScanAt:'',scans:0,candidates:{},events:[]});this.timer=null;this.running=false;
  }
  start(){if(this.timer)return;const every=Math.max(60*60_000,Number(this.env.AUTONOMOS_FREE_MARKET_SCOUT_MS||6*60*60_000));setTimeout(()=>this.scan().catch(e=>this.event('scout_error',{error:safe(e)})),45_000).unref?.();this.timer=setInterval(()=>this.scan().catch(e=>this.event('scout_error',{error:safe(e)})),every);this.timer.unref?.();this.event('market_scout_started',{intervalMs:every,paidSearch:false});}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  async scan(){if(this.running)return;if(String(this.env.AUTONOMOS_FREE_MARKET_SCOUT_ENABLED||'true').toLowerCase()==='false')return;this.running=true;try{
    const queries=parseQueries(this.env.AUTONOMOS_FREE_MARKET_SCOUT_QUERIES_JSON)||DEFAULT_QUERIES;let seen=0,verified=0;
    for(const query of queries.slice(0,8)){
      const rows=await githubRepoSearch(query,this.env).catch(()=>[]);
      for(const repo of rows.slice(0,12)){
        const text=`${repo.name||''} ${repo.description||''} ${(repo.topics||[]).join(' ')}`;
        if(!SIGNAL_WORK.test(text)||!SIGNAL_AGENT.test(text))continue;
        const readme=await githubReadme(repo.full_name,this.env).catch(()=> '');
        const evidence=`${text}\n${readme}`.slice(0,30000);if(!SIGNAL_WORK.test(evidence)||!SIGNAL_PAYOUT.test(evidence))continue;
        const score=(SIGNAL_WORK.test(evidence)?2:0)+(SIGNAL_PAYOUT.test(evidence)?2:0)+(SIGNAL_AGENT.test(evidence)?2:0)+(SIGNAL_REGISTER.test(evidence)?2:0)+(repo.homepage?1:0)-(HUMAN_GATE.test(evidence)?3:0);
        const id=String(repo.full_name||repo.html_url||'');if(!id)continue;seen++;if(score>=6)verified++;
        const prior=this.state.candidates[id]||{};this.state.candidates[id]={...prior,id,name:String(repo.name||id),repoUrl:String(repo.html_url||''),homepage:String(repo.homepage||''),score,status:score>=6?'verified_candidate':'watch',workSignal:true,payoutSignal:SIGNAL_PAYOUT.test(evidence),registrationSignal:SIGNAL_REGISTER.test(evidence),humanGate:HUMAN_GATE.test(evidence),firstSeenAt:prior.firstSeenAt||new Date().toISOString(),lastSeenAt:new Date().toISOString(),evidence:String(evidence).replace(/\s+/g,' ').slice(0,1800)};
      }
    }
    this.state.scans=Number(this.state.scans||0)+1;this.state.lastScanAt=new Date().toISOString();this.persist();this.event('market_scout_completed',{seen,verified,total:Object.keys(this.state.candidates).length});
  }finally{this.running=false;}}
  snapshot(){return structuredClone(this.state);}
  event(type,detail={}){const row={at:new Date().toISOString(),type,...detail};this.state.events.unshift(row);if(this.state.events.length>200)this.state.events.length=200;this.persist();try{this.logger.info?.('[FreeMarketScout] '+JSON.stringify(row));}catch{}}
  persist(){const tmp=`${this.file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(this.state,null,2),{mode:0o600});fs.renameSync(tmp,this.file);}
}

async function githubRepoSearch(query,env){const headers={accept:'application/vnd.github+json','user-agent':'AutonomOS-FreeMarketScout/1.0'};const token=String(env.GITHUB_TOKEN||'').trim();if(token)headers.authorization=`Bearer ${token}`;const u=new URL('https://api.github.com/search/repositories');u.searchParams.set('q',query);u.searchParams.set('sort','updated');u.searchParams.set('order','desc');u.searchParams.set('per_page','20');const r=await fetch(u,{headers,signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error(`github_search_http_${r.status}`);const data=await r.json();return Array.isArray(data?.items)?data.items:[];}
async function githubReadme(fullName,env){if(!fullName)return'';const headers={accept:'application/vnd.github.raw+json','user-agent':'AutonomOS-FreeMarketScout/1.0'};const token=String(env.GITHUB_TOKEN||'').trim();if(token)headers.authorization=`Bearer ${token}`;const r=await fetch(`https://api.github.com/repos/${fullName}/readme`,{headers,signal:AbortSignal.timeout(12000)});if(!r.ok)return'';return String(await r.text()).slice(0,25000);}
function parseQueries(value){try{const x=JSON.parse(String(value||''));return Array.isArray(x)?x.map(String).filter(Boolean):null;}catch{return null;}}
function read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return structuredClone(fallback);}}
function safe(error){return String(error?.message||error||'').slice(0,240);}
