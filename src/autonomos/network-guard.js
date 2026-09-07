const INSTALLED=Symbol.for('autonomos.networkGuard');

const SOURCE_HOSTS={
  t2000:['t2000.ai'],
  clawlancer:['clawlancer.ai','clawlancer.com'],
  agenthansa:['agenthansa.com','agenthansa.ai'],
  superteam:['superteam.fun','superteam.com'],
  skarnfall:['skarnfall.com'],
};

// These are OPTIONAL helper providers. A quota/paywall event must never freeze the whole
// Swarm: the affected tool is cooled down while other capabilities continue. OpenAI itself
// is deliberately excluded because the LLM router owns its provider/retry policy.
const OPTIONAL_TOOL_HOSTS=new Map([
  ['api.tavily.com','tavily'],
  ['api.firecrawl.dev','firecrawl'],
  ['backend.composio.dev','composio'],
  ['api.browserbase.com','browserbase'],
  ['api.e2b.dev','e2b'],
]);

export function installNetworkGuard({env=process.env,logger=console}={}){
  if(globalThis[INSTALLED])return globalThis[INSTALLED];
  const original=globalThis.fetch?.bind(globalThis);
  if(typeof original!=='function')return{installed:false,reason:'fetch_unavailable'};
  const disabled=parseCsv(env.AUTONOMOS_DISABLED_MARKETS);
  const blockedHosts=new Set();
  for(const source of disabled)for(const host of SOURCE_HOSTS[source]||[])blockedHosts.add(host);
  const cooldowns=new Map();
  const toolHealth=new Map();
  const workProtocolHost='workprotocol.ai';
  const default429Ms=Math.max(60_000,Number(env.AUTONOMOS_RATE_LIMIT_COOLDOWN_MS||15*60_000));
  const tool429Ms=Math.max(30_000,Number(env.AUTONOMOS_TOOL_429_COOLDOWN_MS||5*60_000));
  const tool402Ms=Math.max(10*60_000,Number(env.AUTONOMOS_TOOL_402_COOLDOWN_MS||6*60*60_000));

  globalThis.fetch=async function guardedFetch(input,init){
    const url=toUrl(input);
    const host=url?.hostname?.toLowerCase()||'';
    if(host&&matchesAny(host,blockedHosts))return synthetic(410,{error:'source_disabled_by_owner',host});

    const cooldown=findCooldown(host,cooldowns);
    if(cooldown&&cooldown.until>Date.now()){
      const seconds=Math.max(1,Math.ceil((cooldown.until-Date.now())/1000));
      return synthetic(cooldown.status||429,{error:'endpoint_cooldown',reason:cooldown.reason,provider:cooldown.provider||'',host},{'retry-after':String(seconds)});
    }

    const response=await original(input,init);

    if(host&&matchesHost(host,workProtocolHost)&&response.status===429){
      const retryHeader=Number(response.headers?.get?.('retry-after')||0);
      const cooldownMs=retryHeader>0?Math.min(60*60_000,retryHeader*1000):default429Ms;
      cooldowns.set(workProtocolHost,{until:Date.now()+cooldownMs,reason:'http_429',status:429,provider:'workprotocol'});
      try{logger.warn?.(`[NetworkGuard] WorkProtocol cooldown ${Math.ceil(cooldownMs/1000)}s after HTTP 429`);}catch{}
    }

    const optional=optionalToolForHost(host);
    if(optional){
      if(response.status===402||response.status===429){
        const retryHeader=Number(response.headers?.get?.('retry-after')||0);
        const base=response.status===402?tool402Ms:tool429Ms;
        const cooldownMs=retryHeader>0?Math.min(24*60*60_000,retryHeader*1000):base;
        const reason=response.status===402?'quota_or_subscription_required':'rate_limited';
        cooldowns.set(optional.host,{until:Date.now()+cooldownMs,reason,status:response.status,provider:optional.provider});
        toolHealth.set(optional.provider,{status:'cooldown',reason,httpStatus:response.status,until:new Date(Date.now()+cooldownMs).toISOString(),lastSeenAt:new Date().toISOString()});
        try{logger.warn?.(`[ToolWatchdog] ${optional.provider} ${reason}; cooldown ${Math.ceil(cooldownMs/1000)}s`);}catch{}
      }else if(response.ok){
        const prior=toolHealth.get(optional.provider);
        if(!prior||prior.status!=='healthy')toolHealth.set(optional.provider,{status:'healthy',reason:'request_ok',lastSeenAt:new Date().toISOString()});
      }
    }
    return response;
  };

  const state={installed:true,disabledSources:[...disabled],blockedHosts:[...blockedHosts],cooldowns,toolHealth};
  globalThis[INSTALLED]=state;
  try{logger.info?.('[NetworkGuard] '+JSON.stringify({installed:true,disabledSources:state.disabledSources,blockedHosts:state.blockedHosts,workProtocol429CooldownMs:default429Ms,optionalToolCircuitBreakers:[...OPTIONAL_TOOL_HOSTS.values()]}));}catch{}
  return state;
}

function optionalToolForHost(host){for(const [needle,provider] of OPTIONAL_TOOL_HOSTS)if(matchesHost(host,needle))return{host:needle,provider};return null;}
function parseCsv(value){return new Set(String(value||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));}
function toUrl(input){try{return new URL(typeof input==='string'||input instanceof URL?input:input?.url||'');}catch{return null;}}
function matchesHost(host,needle){return host===needle||host.endsWith(`.${needle}`);}
function matchesAny(host,set){for(const needle of set)if(matchesHost(host,needle))return true;return false;}
function findCooldown(host,map){for(const [needle,row] of map)if(matchesHost(host,needle))return row;return null;}
function synthetic(status,body,headers={}){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});}
