import { isRetiredResource } from './retired-resources.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Provider billing caps and our usage caps are different facts. Never infer a free
// plan, unused trial credits, or permission to buy from the presence of an API key.
export const OWNER_CAPPED_PROVIDERS = Object.freeze(['openai','e2b','composio','trigger']);
const DIRECT_FREE = new Set(['public_http','github','local_artifact','canva','figma','duckduckgo','gmail','gmail_read','browser_read','google_drive','google_sheets','google_calendar','slack','notion']);
// A slice of the daily allowance that ONLY earning-path calls may draw from.
//
// The whole allowance used to be one pool, and polling drank it dry: discovery scans every
// 30s and the PR monitor every 60s together consume ~4300 GitHub calls a day against a
// 4000 cap, so by the time a bounty was worth applying to there was nothing left. Measured
// in production: github 4000/4000 used, hasGithubPrTool false, the one lane where automated
// work is permitted and paid shut down until the next UTC midnight — and the capability
// probe that would re-enable it also needs quota, so it could not recover on its own.
//
// Losing discovery for a few hours costs a delay. Losing delivery loses money already spent
// on the model and the sandbox, so the reserve protects the second at the expense of the
// first. Applies per provider; a provider with no entry behaves exactly as before.
const EARNING_RESERVE = { github: 0.25 };
const DEFAULT_LIMITS = {public_http:2000,github:4000,local_artifact:128*1024*1024,canva:50,figma:100,duckduckgo:2000,gmail:200,gmail_read:5000,browser_read:100,google_drive:1000,google_sheets:1000,google_calendar:500,slack:500,notion:500};
const listeners = new Set();
const volatile = new Map();

export function onResourceUnavailable(fn){listeners.add(fn);return()=>listeners.delete(fn);}
export function resourceRoot(env=process.env){return path.resolve(env.STORAGE_DIR||'data','autonomos');}
export function readResourceState(env=process.env){try{return JSON.parse(fs.readFileSync(path.join(resourceRoot(env),'resource-usage.json'),'utf8'));}catch{return volatile.get(resourceRoot(env))||{resources:{},events:[]};}}
function mutate(env,fn){
  const root=resourceRoot(env);fs.mkdirSync(root,{recursive:true});const lock=path.join(root,'resource-usage.lock');let fd;
  try{fd=fs.openSync(lock,'wx');fs.writeSync(fd,String(process.pid));}catch{try{const age=Date.now()-fs.statSync(lock).mtimeMs;if(age>30_000)fs.unlinkSync(lock);}catch{}throw new Error('resource_reservation_busy');}
  try{const state=readResourceState(env);const result=fn(state);state.updatedAt=new Date().toISOString();const file=path.join(root,'resource-usage.json');const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});fs.renameSync(tmp,file);volatile.set(root,state);return result;}
  finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
function json(v,fallback){try{return JSON.parse(String(v||''));}catch{return fallback;}}
export function resourcePolicy(provider,env=process.env){
  const name=String(provider).toLowerCase();if(isRetiredResource(name,'providers')||isRetiredResource(name,'tools'))return{provider:name,allowed:false,reason:'DO_NOT_RESTORE',mode:'retired',limit:0};const custom=json(env.AUTONOMOS_FREE_RESOURCE_LIMITS_JSON,{})[name]||{};
  const owner=new Set([...OWNER_CAPPED_PROVIDERS,...String(env.AUTONOMOS_OWNER_CAPPED_PROVIDERS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)]);
  if(owner.has(name))return{provider:name,mode:'owner_capped',allowed:true,providerCapVerified:false,ownerAttested:true,limit:null};
  const direct=DIRECT_FREE.has(name);
  const verified=direct||(custom.verifiedZeroCost===true&&custom.paidOverageDisabled===true&&Boolean(custom.evidenceUrl)&&Number.isFinite(Number(custom.remainingUnits))&&Number(custom.remainingUnits)>=0&&Date.parse(custom.resetAt||'')>Date.now());
  const rawLimit=Number(direct?(custom.limit??DEFAULT_LIMITS[name]):custom.remainingUnits||0);const limit=Number.isFinite(rawLimit)?Math.max(0,rawLimit):0;
  return{provider:name,mode:direct?'direct_free':'verified_free_quota',allowed:verified,providerCapVerified:!direct&&verified,limit,period:name==='local_artifact'?'lifetime':custom.period||'day',resetAt:custom.resetAt||'',reason:verified?'':'free_quota_not_verified'};
}
// `purpose` is 'earning' (default, sees the whole allowance) or 'opportunistic' (discovery,
// search fallbacks — sees the allowance minus the reserve). Callers that do not say are
// treated as earning, so no provider's behaviour changes until a call site opts in.
export function resourceAvailability(provider,env=process.env,{purpose='earning'}={}){
  const policy=resourcePolicy(provider,env);const row=readResourceState(env).resources?.[provider]||{};
  const until=Date.parse(row.unavailableUntil||'');
  if(Number.isFinite(until)&&until>Date.now())return{...policy,allowed:false,reason:row.reason||'resource_limit_reached',retryAt:row.unavailableUntil};
  if(!policy.allowed)return policy;
  const period=periodKey(policy);const used=row.period===period?Number(row.used||0):0;
  const reserve=Number(EARNING_RESERVE[provider]||0);
  const ceiling=policy.limit!==null&&purpose==='opportunistic'&&reserve>0
    ? Math.floor(policy.limit*(1-reserve))
    : policy.limit;
  if(ceiling!==null&&used>=ceiling){
    // Distinct reason: the allowance is not gone, it is being held for work that earns.
    // Reporting this as free_resource_limit_reached would make a healthy reserve look like
    // an outage and send the lane into the same cooldown as a real exhaustion.
    const held=purpose==='opportunistic'&&used<policy.limit;
    return{...policy,allowed:false,reason:held?'earning_reserve_protected':'free_resource_limit_reached',retryAt:resetDate(policy),used,limit:ceiling};
  }
  return{...policy,used,limit:ceiling,remaining:ceiling===null?null:Math.max(0,ceiling-used)};
}
export async function reserveResource(provider,units=1,env=process.env,{purpose='earning'}={}){
  const n=Number(units);if(!Number.isFinite(n)||n<0)return{ok:false,error:'invalid_resource_units'};
  const ready=resourceAvailability(provider,env,{purpose});if(!ready.allowed){notify(provider,ready,env);return{ok:false,error:ready.reason,retryAt:ready.retryAt,resource:provider,replacementRequired:true};}
  if(ready.mode==='owner_capped')return{ok:true,resource:provider,mode:ready.mode};
  // Third-party free allowances are shared across all machines. A local estimate is
  // insufficient: an operator-provided remaining allowance requires a shared Redis cap.
  if(!DIRECT_FREE.has(provider)){
    if(!env.REDIS_URL)return{ok:false,error:'shared_free_quota_counter_unavailable',resource:provider,replacementRequired:true};
    const result=await reserveShared(provider,n,ready,env);if(!result.ok)return result;
  }
  try{const result=mutate(env,state=>{
    const row=state.resources[provider]||{};const period=periodKey(ready);const used=row.period===period?Number(row.used||0):0;
    if(used+n>ready.limit){state.resources[provider]={...row,period,used,reason:'free_resource_limit_reached',unavailableUntil:resetDate(ready)};return{ok:false,error:'free_resource_limit_reached',resource:provider,replacementRequired:true};}
    state.resources[provider]={...row,period,used:used+n,lastUseAt:new Date().toISOString()};return{ok:true,resource:provider,mode:ready.mode,remaining:ready.limit-used-n};
  });if(!result.ok)notify(provider,{reason:result.error},env);return result;}catch(error){return{ok:false,error:String(error.message),resource:provider,replacementRequired:true};}
}
const redisClients=new Map();
async function reserveShared(provider,units,policy,env){
  try{
    let pending=redisClients.get(env.REDIS_URL);
    if(!pending){pending=(async()=>{const{createClient}=await import('redis');const c=createClient({url:env.REDIS_URL,socket:{connectTimeout:5000,reconnectStrategy:false}});c.on('error',()=>{});await c.connect();return c;})();redisClients.set(env.REDIS_URL,pending);pending.catch(()=>redisClients.delete(env.REDIS_URL));}
    const client=await pending;const ttl=Math.max(1,Math.ceil((Date.parse(resetDate(policy))-Date.now())/1000));
    const value=await client.eval('local n=tonumber(redis.call("GET",KEYS[1]) or "0"); if n+tonumber(ARGV[1])>tonumber(ARGV[2]) then return -1 end; redis.call("INCRBYFLOAT",KEYS[1],ARGV[1]); redis.call("EXPIRE",KEYS[1],ARGV[3]); return 1',{keys:[`autonomos:free-quota:${provider}:${periodKey(policy)}`],arguments:[String(units),String(policy.limit),String(ttl)]});
    if(Number(value)<0){markResourceUnavailable(provider,'free_resource_limit_reached',env,resetDate(policy));return{ok:false,error:'free_resource_limit_reached',resource:provider,replacementRequired:true};}
    return{ok:true};
  }catch{return{ok:false,error:'shared_free_quota_counter_unavailable',resource:provider,replacementRequired:true};}
}
export function markResourceUnavailable(provider,reason,env=process.env,retryAt=''){
  const unavailableUntil=retryAt||new Date(Date.now()+15*60_000).toISOString();
  try{mutate(env,state=>{state.resources[provider]={...(state.resources[provider]||{}),reason:String(reason).slice(0,200),unavailableUntil};state.events=[{at:new Date().toISOString(),provider,reason:String(reason).slice(0,200),unavailableUntil},...(state.events||[])].slice(0,100);});}catch{}
  notify(provider,{reason,unavailableUntil},env);
}
export function observeResourceResult(provider,result,env=process.env){
  const message=[result?.error,result?.reason,result?.message,result?.detail].filter(Boolean).join(' ');
  if(/(?:quota|credit|billing|payment.required|insufficient.balance|resource.limit|http_402|status.?402)/i.test(message))markResourceUnavailable(provider,message,env);
  else if(/(?:http_429|rate.limit|too.many.requests)/i.test(message))markResourceUnavailable(provider,message,env,new Date(Date.now()+60_000).toISOString());
  return result;
}
const notified=new Map();
function notify(provider,detail,env){const key=resourceRoot(env)+':'+provider+':'+detail.reason;if(Date.now()-(notified.get(key)||0)<60_000)return;notified.set(key,Date.now());if(notified.size>1000)notified.delete(notified.keys().next().value);for(const fn of listeners){try{fn({provider,...detail,root:resourceRoot(env)});}catch{}}}
function periodKey(p){if(p.period==='lifetime')return'lifetime';if(p.resetAt)return`allowance:${p.resetAt}`;return new Date().toISOString().slice(0,p.period==='month'?7:10);}
function resetDate(p){if(p.resetAt&&Date.parse(p.resetAt)>Date.now())return p.resetAt;if(p.period==='lifetime')return'9999-01-01T00:00:00.000Z';const now=new Date();return(p.period==='month'?new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)):new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1))).toISOString();}
export function resourceSnapshot(env=process.env){const extra=Object.keys(json(env.AUTONOMOS_FREE_RESOURCE_LIMITS_JSON,{}));return[...new Set([...OWNER_CAPPED_PROVIDERS,...DIRECT_FREE,'r2','coderabbit','langfuse','vercel','netlify','canva','figma',...extra])].map(x=>resourceAvailability(x,env));}
