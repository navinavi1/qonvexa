import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_QUERIES=[
  'ai agent marketplace bounty usdc','autonomous agent paid tasks usdt api','freelance bounty marketplace crypto api','agent jobs marketplace escrow stablecoin'
];

// Verified-live seeds are market metadata, never credentials. They make the scout expand beyond
// whichever GitHub repositories happen to rank for generic searches. Account/OAuth requirements
// are recorded explicitly; this catalog never bypasses CAPTCHA, KYC or identity verification.
const VERIFIED_LIVE_MARKETS=Object.freeze([
  {id:'freelancer.com',name:'Freelancer.com',homepage:'https://www.freelancer.com/jobs/',apiDocs:'https://developers.freelancer.com/',score:10,apiMode:'official',entryMode:'oauth_required',payout:'fiat',evidence:'Live global freelance projects; official production API; bids/projects require an authenticated Freelancer account/OAuth.'},
  {id:'guru.com',name:'Guru',homepage:'https://www.guru.com/d/jobs/',score:8,apiMode:'no_confirmed_freelance_api',entryMode:'web_account',payout:'fiat',evidence:'Live freelance jobs and SafePay; no official Guru.com freelance worker API confirmed.'},
  {id:'workana.com',name:'Workana',homepage:'https://www.workana.com/work/freelancers',score:8,apiMode:'no_confirmed_public_worker_api',entryMode:'web_account',payout:'fiat',evidence:'Large live freelance project marketplace with protected payments; no public worker bidding API confirmed.'},
  {id:'contra.com',name:'Contra',homepage:'https://contra.com/features/find-freelance-jobs',score:8,apiMode:'no_confirmed_public_worker_api',entryMode:'web_account',payout:'fiat',evidence:'Current remote freelance opportunities across engineering, design, marketing, media and more; application is account/web based.'},
  {id:'peopleperhour.com',name:'PeoplePerHour',homepage:'https://www.peopleperhour.com/freelance-jobs',score:8,apiMode:'no_confirmed_public_worker_api',entryMode:'web_account',payout:'fiat',evidence:'Current remote freelance jobs including pre-funded work; no public worker API confirmed.'},
  {id:'truelancer.com',name:'Truelancer',homepage:'https://www.truelancer.com/freelance-jobs',score:8,apiMode:'no_confirmed_public_worker_api',entryMode:'web_account',payout:'fiat',evidence:'Current freelance fixed-price/hourly jobs; no public worker bidding API confirmed.'},
  {id:'opire.dev',name:'Opire',homepage:'https://app.opire.dev/home',apiDocs:'https://docs.opire.dev/overview/commands',score:10,apiMode:'github_commands',entryMode:'github_native',payout:'fiat_stripe',evidence:'Hundreds of rewarded GitHub issues. /try and /claim can run through GitHub when the Opire bot is installed. Stripe is required to receive payout.'},
  {id:'algora.io',name:'Algora',homepage:'https://algora.io/',apiDocs:'https://api.docs.algora.io/',score:10,apiMode:'official',entryMode:'github_or_account',payout:'fiat',evidence:'Open-source GitHub bounties; official API covers bounties, claims, tasks, solvers, issues and pull requests.'},
  {id:'issuehunt.io',name:'IssueHunt',homepage:'https://oss.issuehunt.io/issues',score:9,apiMode:'github_workflow_no_confirmed_public_worker_api',entryMode:'github_oauth_account',payout:'fiat',evidence:'Live funded open-source issues; sign in with GitHub, solve issue, submit PR, receive funded reward after acceptance.'},
  {id:'boss.dev',name:'BOSS',homepage:'https://www.boss.dev/issues/open',score:9,apiMode:'github_app_no_confirmed_public_worker_api',entryMode:'github_oauth_account',payout:'fiat_multi_currency',evidence:'Live GitHub issue bounties with explicit amounts; GitHub-native workflow and GitHub login/app integration.'}
]);

const SIGNAL_WORK=/\b(job|jobs|task|tasks|bounty|bounties|gig|gigs|freelance|contract|marketplace|hire|hiring|paid work)\b/i;
const SIGNAL_PAYOUT=/\b(USDC|USDT|DAI|ETH|SOL|BTC|USD|EUR|escrow|payment|payout|reward|paid)\b/i;
const SIGNAL_AGENT=/\b(agent|agents|AI agent|autonomous|MCP|API[- ]first|agent-native)\b/i;
const SIGNAL_REGISTER=/\b(register|registration|sign up|signup|api key|oauth|\/register|agents?\/register)\b/i;
const HUMAN_GATE=/\b(captcha|kyc|government id|selfie|phone verification|sms verification|2fa|mfa)\b/i;

export class FreeMarketScout{
  constructor({env=process.env,storageDir='',logger=console}={}){
    this.env=env;this.logger=logger;this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');fs.mkdirSync(this.root,{recursive:true});
    this.file=path.join(this.root,'free-market-scout.json');this.state=read(this.file,{version:2,lastScanAt:'',scans:0,candidates:{},events:[]});this.timer=null;this.running=false;
  }
  start(){if(this.timer)return;this.seedVerifiedMarkets();const every=Math.max(60*60_000,Number(this.env.AUTONOMOS_FREE_MARKET_SCOUT_MS||6*60*60_000));setTimeout(()=>this.scan().catch(e=>this.event('scout_error',{error:safe(e)})),45_000).unref?.();this.timer=setInterval(()=>this.scan().catch(e=>this.event('scout_error',{error:safe(e)})),every);this.timer.unref?.();this.event('market_scout_started',{intervalMs:every,paidSearch:false,verifiedLiveSeeds:VERIFIED_LIVE_MARKETS.length});}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  seedVerifiedMarkets(){const at=new Date().toISOString();for(const seed of VERIFIED_LIVE_MARKETS){const prior=this.state.candidates[seed.id]||{};this.state.candidates[seed.id]={...prior,...seed,status:'verified_live_seed',workSignal:true,payoutSignal:true,registrationSignal:/oauth|github|account|register/i.test(seed.entryMode),humanGate:/kyc/i.test(seed.entryMode),firstSeenAt:prior.firstSeenAt||at,lastSeenAt:at,source:'verified_live_catalog'};}this.persist();}
  async scan(){if(this.running)return;if(String(this.env.AUTONOMOS_FREE_MARKET_SCOUT_ENABLED||'true').toLowerCase()==='false')return;this.running=true;try{
    this.seedVerifiedMarkets();const queries=parseQueries(this.env.AUTONOMOS_FREE_MARKET_SCOUT_QUERIES_JSON)||DEFAULT_QUERIES;let seen=VERIFIED_LIVE_MARKETS.length,verified=VERIFIED_LIVE_MARKETS.length;
    for(const query of queries.slice(0,8)){
      const rows=await githubRepoSearch(query,this.env).catch(()=>[]);
      for(const repo of rows.slice(0,12)){
        const text=`${repo.name||''} ${repo.description||''} ${(repo.topics||[]).join(' ')}`;if(!SIGNAL_WORK.test(text)||!SIGNAL_AGENT.test(text))continue;
        const readme=await githubReadme(repo.full_name,this.env).catch(()=> '');const evidence=`${text}\n${readme}`.slice(0,30000);if(!SIGNAL_WORK.test(evidence)||!SIGNAL_PAYOUT.test(evidence))continue;
        const score=(SIGNAL_WORK.test(evidence)?2:0)+(SIGNAL_PAYOUT.test(evidence)?2:0)+(SIGNAL_AGENT.test(evidence)?2:0)+(SIGNAL_REGISTER.test(evidence)?2:0)+(repo.homepage?1:0)-(HUMAN_GATE.test(evidence)?3:0);
        const id=String(repo.full_name||repo.html_url||'');if(!id)continue;seen++;if(score>=6)verified++;const prior=this.state.candidates[id]||{};
        this.state.candidates[id]={...prior,id,name:String(repo.name||id),repoUrl:String(repo.html_url||''),homepage:String(repo.homepage||''),score,status:score>=6?'verified_candidate':'watch',workSignal:true,payoutSignal:SIGNAL_PAYOUT.test(evidence),registrationSignal:SIGNAL_REGISTER.test(evidence),humanGate:HUMAN_GATE.test(evidence),firstSeenAt:prior.firstSeenAt||new Date().toISOString(),lastSeenAt:new Date().toISOString(),evidence:String(evidence).replace(/\s+/g,' ').slice(0,1800),source:'github_discovery'};
      }
    }
    this.state.scans=Number(this.state.scans||0)+1;this.state.lastScanAt=new Date().toISOString();this.persist();this.event('market_scout_completed',{seen,verified,total:Object.keys(this.state.candidates).length,verifiedLiveSeeds:VERIFIED_LIVE_MARKETS.length});
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
