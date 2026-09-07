const INSTALLED=Symbol.for('autonomos.networkGuard');

const SOURCE_HOSTS={
  t2000:['t2000.ai'],
  clawlancer:['clawlancer.ai','clawlancer.com'],
  agenthansa:['agenthansa.com','agenthansa.ai'],
  superteam:['superteam.fun','superteam.com'],
  skarnfall:['skarnfall.com'],
};

export function installNetworkGuard({env=process.env,logger=console}={}){
  if(globalThis[INSTALLED])return globalThis[INSTALLED];
  const original=globalThis.fetch?.bind(globalThis);
  if(typeof original!=='function')return{installed:false,reason:'fetch_unavailable'};
  const disabled=parseCsv(env.AUTONOMOS_DISABLED_MARKETS);
  const blockedHosts=new Set();
  for(const source of disabled)for(const host of SOURCE_HOSTS[source]||[])blockedHosts.add(host);
  const cooldowns=new Map();
  const workProtocolHost='workprotocol.ai';
  const default429Ms=Math.max(60_000,Number(env.AUTONOMOS_RATE_LIMIT_COOLDOWN_MS||15*60_000));

  globalThis.fetch=async function guardedFetch(input,init){
    const url=toUrl(input);
    const host=url?.hostname?.toLowerCase()||'';
    if(host&&matchesAny(host,blockedHosts)){
      return synthetic(410,{error:'source_disabled_by_owner',host});
    }
    const cooldown=findCooldown(host,cooldowns);
    if(cooldown&&cooldown.until>Date.now()){
      const seconds=Math.max(1,Math.ceil((cooldown.until-Date.now())/1000));
      return synthetic(429,{error:'endpoint_cooldown',reason:cooldown.reason,host},{'retry-after':String(seconds)});
    }
    const response=await original(input,init);
    // Only optional revenue endpoints are circuit-broken here. Core OpenAI/Gmail/search/
    // storage calls keep their own retry/fallback logic and are never globally blocked.
    if(host&&matchesHost(host,workProtocolHost)&&response.status===429){
      const retryHeader=Number(response.headers?.get?.('retry-after')||0);
      const cooldownMs=retryHeader>0?Math.min(60*60_000,retryHeader*1000):default429Ms;
      cooldowns.set(workProtocolHost,{until:Date.now()+cooldownMs,reason:'http_429'});
      try{logger.warn?.(`[NetworkGuard] WorkProtocol cooldown ${Math.ceil(cooldownMs/1000)}s after HTTP 429`);}catch{}
    }
    return response;
  };

  const state={installed:true,disabledSources:[...disabled],blockedHosts:[...blockedHosts],cooldowns};
  globalThis[INSTALLED]=state;
  try{logger.info?.('[NetworkGuard] '+JSON.stringify({installed:true,disabledSources:state.disabledSources,blockedHosts:state.blockedHosts,workProtocol429CooldownMs:default429Ms}));}catch{}
  return state;
}

function parseCsv(value){return new Set(String(value||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));}
function toUrl(input){try{return new URL(typeof input==='string'||input instanceof URL?input:input?.url||'');}catch{return null;}}
function matchesHost(host,needle){return host===needle||host.endsWith(`.${needle}`);}
function matchesAny(host,set){for(const needle of set)if(matchesHost(host,needle))return true;return false;}
function findCooldown(host,map){for(const [needle,row] of map)if(matchesHost(host,needle))return row;return null;}
function synthetic(status,body,headers={}){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});}
