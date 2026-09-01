const BLOCKED_TOOL = /(^|_)(DELETE|REMOVE|REVOKE|TRANSFER|SEND_MONEY|CREATE_PAYMENT|WITHDRAW|BUY|SELL|TRADE|SWAP|CLOSE_ACCOUNT|CHANGE_PASSWORD|RESET_PASSWORD|CREATE_API_KEY|ROTATE_SECRET|EXPORT_SECRET|PRIVATE_KEY|SEED_PHRASE)(_|$)/i;
const DEFAULT_DENY_TOOLKITS = new Set(['STRIPE','PAYPAL','COINBASE','BINANCE','BANKING','PLAID']);

export async function composioSearch({query='',toolkit='',limit=12}={},env=process.env,signal){
  const key=String(env.COMPOSIO_API_KEY||'').trim();if(!key)return{ok:false,error:'composio_api_key_missing'};
  const qs=new URLSearchParams({query:String(query||'').slice(0,300),include_deprecated:'false',toolkit_versions:'latest',limit:String(Math.max(1,Math.min(30,Number(limit||12))))});
  if(toolkit)qs.set('toolkit_slug',String(toolkit).toLowerCase());
  try{
    const response=await fetch(`https://backend.composio.dev/api/v3.1/tools?${qs}`,{headers:{'x-api-key':key,accept:'application/json'},signal:withTimeout(20000,signal)});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)return{ok:false,error:`composio_http_${response.status}`,detail:String(body?.error?.message||body?.message||'').slice(0,400)};
    const items=(Array.isArray(body?.items)?body.items:[]).filter(item=>isAllowed(item?.slug,item?.toolkit?.slug,env)).slice(0,20).map(item=>({slug:item.slug,name:item.name||'',description:String(item.description||item.human_description||'').slice(0,600),toolkit:item.toolkit?.slug||'',requiresAuth:item.no_auth===false,inputParameters:item.input_parameters||{}}));
    return{ok:true,items,nextCursor:body?.next_cursor||'',totalItems:Number(body?.total_items||items.length)};
  }catch(error){return{ok:false,error:signal?.aborted?'aborted_by_emergency_stop':String(error?.message||error).slice(0,300)}}
}

export async function composioExecute({toolSlug,arguments:args={},connectedAccountId='',userId=''}={},env=process.env,signal){
  const key=String(env.COMPOSIO_API_KEY||'').trim();
  if(!key)return{ok:false,error:'composio_api_key_missing'};
  const slug=String(toolSlug||'').trim().toUpperCase();
  if(!/^[A-Z0-9_]{3,160}$/.test(slug))return{ok:false,error:'invalid_composio_tool_slug'};
  const inferredToolkit=detectToolkit(slug,env);
  if(!isAllowed(slug,inferredToolkit,env))return{ok:false,error:'composio_tool_blocked_by_financial_destructive_or_allowlist_policy'};
  try{
    // Do not guess the toolkit from the tool slug when Composio can tell us exactly.
    // This matters for multi-part toolkit slugs such as NETLIFY_MCP.
    const toolkit=(await resolveToolToolkit(slug,key,signal))||inferredToolkit;
    if(!isAllowed(slug,toolkit,env))return{ok:false,error:'composio_tool_blocked_by_financial_destructive_or_allowlist_policy'};
    const accountMap=parseJson(env.AUTONOMOS_COMPOSIO_ACCOUNTS_JSON,{});
    let account=String(connectedAccountId||accountMap[toolkit]||accountMap[toolkit.toLowerCase()]||'');
    if(!account&&toolkit)account=await resolveConnectedAccountId(toolkit,key,signal);
    const response=await fetch(`https://backend.composio.dev/api/v3.1/tools/execute/${encodeURIComponent(slug)}`,{
      method:'POST',headers:{'content-type':'application/json','x-api-key':key},
      body:JSON.stringify({arguments:args||{},version:'latest',...(account?{connected_account_id:account}:{}),...(userId?{user_id:String(userId)}:{})}),
      signal:withTimeout(45000,signal)
    });
    const body=await response.json().catch(()=>({}));
    if(!response.ok||body?.successful===false)return{ok:false,error:`composio_http_${response.status}`,detail:String(body?.error?.message||body?.error||body?.message||'').slice(0,500),toolkit,needsConnectedAccount:response.status===401||response.status===403||response.status===422};
    return{ok:true,data:body?.data??body,logId:body?.log_id||body?.logId||'',toolkit};
  }catch(error){return{ok:false,error:signal?.aborted?'aborted_by_emergency_stop':String(error?.message||error).slice(0,300)}}
}

function isAllowed(slugValue,toolkitValue,env){
  const slug=String(slugValue||'').toUpperCase();const toolkit=String(toolkitValue||detectToolkit(slug,env)||'').toUpperCase();
  const extraDenied=new Set(csv(env.AUTONOMOS_COMPOSIO_DENY_TOOLKITS));
  if(DEFAULT_DENY_TOOLKITS.has(toolkit)||extraDenied.has(toolkit)||BLOCKED_TOOL.test(slug))return false;
  const allow=csv(env.AUTONOMOS_COMPOSIO_ALLOW_TOOLKITS);return !allow.length||allow.includes(toolkit);
}
function detectToolkit(slug,env){
  const upper=String(slug||'').toUpperCase();
  const known=[...csv(env.AUTONOMOS_COMPOSIO_ALLOW_TOOLKITS),...csv(env.AUTONOMOS_COMPOSIO_DENY_TOOLKITS),...DEFAULT_DENY_TOOLKITS].sort((a,b)=>b.length-a.length);
  const hit=known.find(x=>upper===x||upper.startsWith(`${x}_`));if(hit)return hit;
  const parts=upper.split('_');
  // Common two-word toolkit slugs must not collapse to GOOGLE or MICROSOFT.
  if(['GOOGLE','MICROSOFT'].includes(parts[0])&&parts[1])return `${parts[0]}_${parts[1]}`;
  return parts[0]||'';
}
function csv(v){return String(v||'').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean)}
function parseJson(value,fallback){try{return JSON.parse(String(value||''))}catch{return fallback}}
function withTimeout(ms,signal){return signal?AbortSignal.any([AbortSignal.timeout(ms),signal]):AbortSignal.timeout(ms)}


async function resolveToolToolkit(toolSlug,key,signal){
  try{
    const response=await fetch(`https://backend.composio.dev/api/v3.1/tools/${encodeURIComponent(toolSlug)}?toolkit_versions=latest`,{headers:{'x-api-key':key,accept:'application/json'},signal:withTimeout(12000,signal)});
    if(!response.ok)return'';
    const body=await response.json().catch(()=>({}));
    return String(body?.toolkit?.slug||'').trim().toUpperCase();
  }catch{return''}
}


async function resolveConnectedAccountId(toolkit,key,signal){
  const qs=new URLSearchParams();
  qs.append('toolkit_slugs',String(toolkit).toLowerCase());
  qs.append('statuses','ACTIVE');
  qs.set('limit','10');
  const response=await fetch(`https://backend.composio.dev/api/v3.1/connected_accounts?${qs}`,{headers:{'x-api-key':key,accept:'application/json'},signal:withTimeout(15000,signal)});
  if(!response.ok)return'';
  const body=await response.json().catch(()=>({}));
  const active=(Array.isArray(body?.items)?body.items:[]).filter(row=>String(row?.status||'').toUpperCase()==='ACTIVE'&&!row?.is_disabled);
  if(active.length===1)return String(active[0]?.id||'');
  // When multiple accounts are connected, force explicit owner mapping instead of
  // silently picking a potentially wrong Gmail/GitHub/Slack identity.
  return'';
}
