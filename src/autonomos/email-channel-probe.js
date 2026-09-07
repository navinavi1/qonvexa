export async function probeRuntimeEmailChannel({env=process.env,logger=console}={}){
  const key=String(env.COMPOSIO_API_KEY||'').trim();
  if(!key){const result={ok:false,ready:false,reason:'composio_api_key_missing'};log(logger,result);return result;}
  const qs=new URLSearchParams();qs.append('toolkit_slugs','gmail');qs.append('statuses','ACTIVE');qs.set('limit','10');
  try{
    const response=await fetch(`https://backend.composio.dev/api/v3.1/connected_accounts?${qs}`,{headers:{'x-api-key':key,accept:'application/json'},signal:AbortSignal.timeout(15_000)});
    const body=await response.json().catch(()=>({}));
    if(!response.ok){const result={ok:false,ready:false,status:response.status,reason:`composio_http_${response.status}`};log(logger,result);return result;}
    const active=(Array.isArray(body?.items)?body.items:[]).filter(row=>String(row?.status||'').toUpperCase()==='ACTIVE'&&!row?.is_disabled);
    const result={ok:true,ready:active.length===1,activeAccounts:active.length,reason:active.length===1?'gmail_connected':active.length===0?'gmail_not_connected':'multiple_gmail_accounts_require_explicit_mapping'};
    log(logger,result);return result;
  }catch(error){const result={ok:false,ready:false,reason:String(error?.message||error).slice(0,160)};log(logger,result);return result;}
}
function log(logger,result){try{logger.info?.('[EmailChannelProbe] '+JSON.stringify(result));}catch{}}
