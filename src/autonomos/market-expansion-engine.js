import { NativeMarketAdapter } from './native-market-adapter.js';
import { DynamicMarketRegistry } from './dynamic-market-registry.js';
import { isRetiredMarket } from './retired-markets.js';
import fs from 'node:fs';
import path from 'node:path';

const HUMAN_GATE=/\b(captcha|kyc|government id|passport|selfie|phone verification|sms verification|2fa|mfa|identity verification)\b/i;
const MONEY=/\b(USD|EUR|USDC|USDT|DAI|ETH|SOL|BTC|payment|payout|reward|escrow|paid)\b/i;
const WORK=/\b(job|jobs|task|tasks|bounty|bounties|gig|gigs|contract|freelance|hire|hiring|work)\b/i;
const REGISTER=/\b(register|registration|signup|sign up|create agent|agent registration)\b/i;
const MAX_BODY=1_500_000;
const RECHECK_OK_MS=2*60*60_000;
const RECHECK_DRY_MS=24*60*60_000;

export class MarketExpansionEngine{
  constructor({env=process.env,storageDir='',logger=console}={}){
    this.env=env;this.logger=logger;this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');fs.mkdirSync(this.root,{recursive:true});
    this.registry=new DynamicMarketRegistry(this.root);this.file=path.join(this.root,'market-expansion.json');
    this.feedFile=path.join(this.root,'dynamic-market-feed.json');
    this.credentialsFile=path.join(this.root,'dynamic-market-credentials.private.json');
    this.scoutFile=path.join(this.root,'free-market-scout.json');
    this.state=readJson(this.file,{version:1,lastRunAt:'',runs:0,markets:{},events:[]});this.timer=null;this.running=false;
  }
  start(){if(this.timer)return;const every=Math.max(60*60_000,Number(this.env.AUTONOMOS_MARKET_EXPANSION_MS||2*60*60_000));setTimeout(()=>this.tick().catch(e=>this.event('market_expansion_error',{error:safe(e)})),90_000).unref?.();this.timer=setInterval(()=>this.tick().catch(e=>this.event('market_expansion_error',{error:safe(e)})),every);this.timer.unref?.();this.event('market_expansion_started',{intervalMs:every,autoRegister:enabled(this.env.AUTONOMOS_AUTO_REGISTER_MARKETS,'true'),paidSearch:false});}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  async tick(){if(this.running||!enabled(this.env.AUTONOMOS_MARKET_EXPANSION_ENABLED,'true'))return;this.running=true;try{
    const scout=readJson(this.scoutFile,{candidates:{}});const candidates=Object.values(scout.candidates||{}).filter(candidate=>!isRetiredMarket(candidate)).sort((a,b)=>Number(b.score||0)-Number(a.score||0));
    const credentials=readJson(this.credentialsFile,{});let checked=0,integrated=0,registered=0,jobs=0;const refreshed=new Set();const feed=[];
    for(const candidate of candidates.slice(0,Math.max(5,Math.min(40,Number(this.env.AUTONOMOS_MARKETS_PER_EXPANSION_CYCLE||20))))){
      if(Number(candidate.score||0)<5)continue;
      const id=String(candidate.id||candidate.homepage||candidate.repoUrl||'');if(!id)continue;const prior=this.state.markets[id]||{};
      const dueMs=prior.dryStreak>=3?RECHECK_DRY_MS:RECHECK_OK_MS;if(prior.lastCheckedAt&&Date.now()-Date.parse(prior.lastCheckedAt)<dueMs)continue;
      checked++;
      const seed=String(candidate.homepage||candidate.repoUrl||'');const analysis=await inspectMarket(seed,candidate,this.env).catch(e=>({ok:false,error:safe(e)}));
      const row={...prior,id,name:String(candidate.name||id),homepage:String(candidate.homepage||''),repoUrl:String(candidate.repoUrl||''),score:Number(candidate.score||0),lastCheckedAt:new Date().toISOString(),lastError:analysis.ok?'':String(analysis.error||'inspection_failed').slice(0,220)};
      if(!analysis.ok){this.registry.observe(id,{...row,lastError:row.lastError});row.failures=Number(prior.failures||0)+1;this.state.markets[id]=row;continue;}
      analysis.automationPermitted=candidate.automationPermitted===true||analysis.automationPermitted===true;row.analysis=analysis;row.host=analysis.host;row.openapiUrl=analysis.openapiUrl||'';row.humanGate=analysis.humanGate;row.payoutSignal=analysis.payoutSignal;row.registration=analysis.registration;row.jobs=analysis.jobs;row.claim=analysis.claim;row.delivery=analysis.delivery;
      row.status=analysis.humanGate?'human_gate':analysis.jobs?.path?(analysis.registration?.path?'integration_ready':'jobs_discovered'):'watch';
      let credential=credentials[id]||null;
      if(enabled(this.env.AUTONOMOS_AUTO_REGISTER_MARKETS,'true')&&analysis.automationPermitted===true&&!analysis.humanGate&&analysis.registration?.path&&!credential&&!prior.registrationIntent){
        row.registrationIntent={at:new Date().toISOString(),status:'intent'};this.state.markets[id]=row;this.persist();
        const reg=await tryRegister(analysis,candidate,this.env).catch(e=>({ok:false,error:safe(e)}));
        row.lastRegistrationAttemptAt=new Date().toISOString();row.registrationResult=reg.ok?'registered':String(reg.error||reg.reason||'not_registered').slice(0,180);
        row.registrationIntent.status=reg.ok?'confirmed':reg.definiteFailure?'definite_failure':'uncertain';
        if(reg.ok){credential=reg.credential||{};credentials[id]=credential;registered++;row.status='registered';writeSecretJson(this.credentialsFile,credentials);}
      }
      if(analysis.jobs?.path){
        const polled=await pollJobs(analysis,credential,this.env).catch(e=>({ok:false,error:safe(e),rows:[]}));
        row.lastJobsPollAt=new Date().toISOString();row.lastJobsCount=polled.rows?.length||0;row.lastJobsError=polled.ok?'':String(polled.error||'jobs_poll_failed').slice(0,180);
        if(polled.ok){refreshed.add(id);jobs+=polled.rows.length;row.dryStreak=polled.rows.length?0:Number(prior.dryStreak||0)+1;row.lastUsefulAt=polled.rows.length?new Date().toISOString():(prior.lastUsefulAt||'');for(const j of polled.rows)feed.push({...j,marketId:id,marketName:row.name,marketHost:analysis.host,registered:Boolean(credential)});if(polled.rows.length)integrated++;}
      }
      if(Number(row.dryStreak||0)>=3)row.status='cooldown_no_work';
      this.state.markets[id]=row;
      this.registry.observe(id,{id,name:row.name,homepage:row.homepage,humanGate:row.humanGate,automationPermitted:analysis.automationPermitted,lastError:row.lastError||row.lastJobsError||'',lastJobsCount:row.lastJobsCount||0,evidence:{...(this.registry.read()[id]?.evidence||{}),...(row.lastJobsCount>0?{jobs:{verified:true,url:row.homepage,verifiedAt:row.lastJobsPollAt}}:{})},blocker:credential?'claim_delivery_payout_not_verified':'authenticated_account_and_policy_required'});
    }
    writeSecretJson(this.credentialsFile,credentials);writeJson(this.feedFile,{generatedAt:new Date().toISOString(),rows:dedupeFeed([...(readJson(this.feedFile,{rows:[]}).rows||[]).filter(r=>!refreshed.has(r.marketId)&&!isRetiredMarket(r)&&Date.parse(r.observedAt||0)>Date.now()-48*60*60_000),...feed]).slice(0,1000)});
    this.state.runs=Number(this.state.runs||0)+1;this.state.lastRunAt=new Date().toISOString();this.persist();this.event('market_expansion_completed',{checked,integrated,registered,jobs,knownMarkets:Object.keys(this.state.markets).length});
  }finally{this.running=false;}}
  persist(){writeJson(this.file,this.state);}
  event(type,detail={}){const row={at:new Date().toISOString(),type,...detail};this.state.events.unshift(row);if(this.state.events.length>300)this.state.events.length=300;this.persist();try{this.logger.info?.('[MarketExpansion] '+JSON.stringify(row));}catch{}}
}

async function inspectMarket(seed,candidate,env){
  const url=normalizeSeed(seed);if(!url)return{ok:false,error:'invalid_seed'};const host=new URL(url).hostname.toLowerCase();if(!publicHost(host))return{ok:false,error:'unsafe_or_private_host'};
  const page=await getText(url).catch(()=>({ok:false,text:'',url}));const evidence=`${candidate?.evidence||''}\n${page.text||''}`.slice(0,50000);const links=extractLinks(page.text||'',page.url||url);
  const specs=[];for(const link of links)if(/openapi|swagger|api-docs|spec\.json/i.test(link))specs.push(link);
  for(const suffix of ['/openapi.json','/swagger.json','/api/openapi.json','/api/docs/openapi.json'])specs.push(new URL(suffix,`https://${host}`).toString());
  let spec=null,openapiUrl='';for(const specUrl of [...new Set(specs)].slice(0,8)){if(new URL(specUrl).hostname.toLowerCase()!==host)continue;const r=await getJson(specUrl).catch(()=>null);if(r&&r.paths&&typeof r.paths==='object'){spec=r;openapiUrl=specUrl;break;}}
  const out={ok:true,host,openapiUrl,baseUrl:'https://'+host,automationPermitted:false,humanGate:HUMAN_GATE.test(evidence.replace(/(?:no|without)\s+(?:kyc|captcha|identity verification)/gi,'')),payoutSignal:MONEY.test(evidence),registration:null,jobs:null,details:null,applications:null,submissions:null,claim:null,delivery:null};
  if(!spec)return out;
  out.securitySchemes=spec.components?.securitySchemes||{};out.automationPermitted=spec.info?.['x-automation-permitted']===true;out.applicationCostUsd=spec.info?.['x-application-cost-usd']===0?0:null;
  const paths=Object.entries(spec.paths||{});
  for(const [p,ops] of paths){for(const [method,op] of Object.entries(ops||{})){if(!/^(get|post|put|patch)$/i.test(method))continue;const text=`${p} ${op?.operationId||''} ${op?.summary||''} ${op?.description||''}`;
    if(!out.registration&&/post/i.test(method)&&REGISTER.test(text)&&/agent|provider|worker|seller/i.test(text))out.registration=operation(p,method,op,spec);
    if(!out.details&&method==='get'&&/\{(?:id|job_id|jobId|task_id|taskId)\}/.test(p)&&/jobs?|tasks?/i.test(p)&&!/applications|submissions|payments/.test(p))out.details=operation(p,method,op,spec);
    if(!out.applications&&method==='get'&&/applications|bids|claims/i.test(p))out.applications=operation(p,method,op,spec);
    if(!out.submissions&&method==='get'&&/submissions|results|deliveries/i.test(p))out.submissions=operation(p,method,op,spec);
    if(!out.jobs&&/get/i.test(method)&&WORK.test(text)&&!p.includes('{')&&!/history|mine|my jobs|applications/i.test(text))out.jobs=operation(p,method,op,spec);
    if(!out.claim&&/post/i.test(method)&&/claim|accept|apply|take job|bid/i.test(text))out.claim=operation(p,method,op,spec);
    if(!out.delivery&&/post|put|patch/i.test(method)&&/submit|deliver|complete|finish|result/i.test(text))out.delivery=operation(p,method,op,spec);
  }}
  const specText=JSON.stringify(spec).slice(0,100000);out.humanGate=out.humanGate||HUMAN_GATE.test(specText);out.payoutSignal=out.payoutSignal||MONEY.test(specText);return out;
}
function operation(pathname,method,op,spec){return{path:pathname,method:String(method).toUpperCase(),kind:/bid|apply|application/i.test(op.operationId||pathname)?'competitive':'direct',security:Array.isArray(op?.security)?op.security:(spec.security||null),requestSchema:resolveRequestSchema(op,spec)};}
function resolveRequestSchema(op,spec){const schema=op?.requestBody?.content?.['application/json']?.schema;if(!schema)return null;if(schema.$ref)return resolveRef(schema.$ref,spec);return schema;}
function resolveRef(ref,spec){if(!String(ref).startsWith('#/'))return null;let cur=spec;for(const part of String(ref).slice(2).split('/'))cur=cur?.[part];return cur&&typeof cur==='object'?cur:null;}
async function tryRegister(analysis,candidate,env){
  const op=analysis.registration;if(!op?.path||op.method!=='POST')return{ok:false,reason:'registration_not_post'};
  if(Array.isArray(op.security)&&op.security.length>0)return{ok:false,reason:'registration_requires_existing_auth'};
  const schema=op.requestSchema||{};const required=Array.isArray(schema.required)?schema.required:[];const properties=schema.properties||{};const body={};const safeValues={name:'AutonomOS',agent_name:'AutonomOS',display_name:'AutonomOS',description:'Autonomous AI digital-services agency',wallet_address:String(env.AUTONOMOS_OWNER_WALLET||''),walletAddress:String(env.AUTONOMOS_OWNER_WALLET||''),website:String(env.SITE_URL||env.RENDER_EXTERNAL_URL||'https://qonvexa.co'),base_price:30,basePrice:30};
  for(const key of Object.keys(properties)){if(Object.prototype.hasOwnProperty.call(safeValues,key)&&safeValues[key]!=='' )body[key]=safeValues[key];}
  for(const key of required)if(!(key in body))return{ok:false,reason:`required_field_not_safely_available:${key}`};
  const endpoint=new URL(op.path,`https://${analysis.host}`).toString();if(new URL(endpoint).hostname.toLowerCase()!==analysis.host)return{ok:false,reason:'cross_host_registration_blocked'};
  const r=await fetch(endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json',accept:'application/json','user-agent':'AutonomOS-MarketExpansion/1.0'},body:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});const data=await safeJson(r);if(!r.ok)return{ok:false,definiteFailure:r.status>=400&&r.status<500,error:`http_${r.status}:${publicError(data)}`};
  if(!Object.keys(extractCredential(data)).length)return{ok:false,error:'registration_external_identity_missing'};return{ok:true,credential:extractCredential(data),public:{id:String(data?.id||data?.agent_id||data?.agentId||'')}};
}
function extractCredential(data){const out={};for(const [k,v] of Object.entries(data&&typeof data==='object'?data:{})){if(/^(id|agent_id|agentId|token|api_key|apiKey|access_token|accessToken|secret)$/i.test(k)&&['string','number'].includes(typeof v))out[k]=String(v);}return out;}
async function pollJobs(analysis,credential,env){
  const op=analysis.jobs;if(!op?.path||op.method!=='GET')return{ok:false,error:'jobs_get_not_found',rows:[]};const endpoint=new URL(op.path,`https://${analysis.host}`);if(endpoint.hostname.toLowerCase()!==analysis.host)return{ok:false,error:'cross_host_jobs_blocked',rows:[]};
  const adapter=new NativeMarketAdapter({id:analysis.host,analysis,credential,root:path.join(env.STORAGE_DIR||'data','autonomos'),env});const r=await adapter.request(op);const data=r.data;if(!r.ok)return{ok:false,error:`http_${r.status}`,rows:[]};const arr=findArray(data);const rows=[];
  for(const item of arr.slice(0,200)){const title=pick(item,['title','name','job_title','jobTitle','task','summary']);const url=pick(item,['url','apply_url','applyUrl','job_url','jobUrl'])||endpoint.toString();const amount=Number(pick(item,['budget','amount','reward','price','payout','budgetUsd'])||0);const currency=String(pick(item,['currency','token','asset'])||'UNKNOWN');const desc=String(pick(item,['description','details','body','content'])||'');if(!title||(!amount&&!MONEY.test(desc)))continue;rows.push({externalId:String(item.id||item.taskId||item.jobId||''),observedAt:new Date().toISOString(),payout:amount,currency,amountUsd:['USD','USDC','USDT','DAI'].includes(currency.toUpperCase())?amount:null,title:String(title).slice(0,240),url:String(url),score:1,snippet:`${desc} ${amount?`${amount} ${currency}`:''}`.slice(0,6000)});}
  return{ok:true,rows};
}
function findArray(data){if(Array.isArray(data))return data;if(!data||typeof data!=='object')return[];for(const key of ['jobs','tasks','bounties','gigs','items','results','data']){if(Array.isArray(data[key]))return data[key];if(data[key]&&typeof data[key]==='object'){const x=findArray(data[key]);if(x.length)return x;}}return[];}
function pick(obj,keys){for(const k of keys)if(obj?.[k]!==undefined&&obj?.[k]!==null)return obj[k];return'';}
function normalizeSeed(seed){try{const u=new URL(/^https?:\/\//i.test(String(seed))?String(seed):`https://${String(seed)}`);return publicHost(u.hostname)?u.toString():'';}catch{return'';}}
function publicHost(host){const h=String(host||'').toLowerCase();return Boolean(h)&&h!=='localhost'&&!/^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)&&!h.endsWith('.local');}
async function getText(url){const r=await fetch(url,{redirect:'follow',headers:{accept:'text/html,text/plain,application/json;q=0.8','user-agent':'AutonomOS-MarketExpansion/1.0'},signal:AbortSignal.timeout(15_000)});if(!r.ok)throw new Error(`http_${r.status}`);const len=Number(r.headers.get('content-length')||0);if(len>MAX_BODY)throw new Error('page_too_large');return{ok:true,text:(await r.text()).slice(0,MAX_BODY),url:String(r.url||url)};}
async function getJson(url){const r=await fetch(url,{redirect:'follow',headers:{accept:'application/json','user-agent':'AutonomOS-MarketExpansion/1.0'},signal:AbortSignal.timeout(12_000)});if(!r.ok)return null;const len=Number(r.headers.get('content-length')||0);if(len>MAX_BODY)return null;return r.json().catch(()=>null);}
function extractLinks(text,base){const out=[];for(const m of String(text||'').matchAll(/href=["']([^"']+)["']/gi)){try{out.push(new URL(m[1],base).toString());}catch{}}return out;}
async function safeJson(r){try{return await r.json();}catch{return{};}}
function publicError(data){return String(data?.error?.message||data?.error||data?.message||data?.detail||'').slice(0,220);}
function dedupeFeed(rows){const m=new Map();for(const r of rows){const k=`${r.marketId}:${r.url}:${r.title}`;if(!m.has(k))m.set(k,r);}return[...m.values()];}
function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return structuredClone(fallback);}}
function writeJson(file,value){const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);}
function writeSecretJson(file,value){const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);}
function enabled(v,f='false'){return !/^(0|false|no|off)$/i.test(String(v??f));}
function safe(error){return String(error?.message||error||'').slice(0,240);}

