export async function probeRuntimeEmailChannel({env=process.env,logger=console}={}){
  const key=String(env.COMPOSIO_API_KEY||'').trim();
  if(!key){const result={ok:false,ready:false,reason:'composio_api_key_missing'};log(logger,result);return result;}
  const qs=new URLSearchParams();qs.append('toolkit_slugs','gmail');qs.append('statuses','ACTIVE');qs.set('limit','10');
  try{
    const response=await fetch(`https://backend.composio.dev/api/v3.1/connected_accounts?${qs}`,{headers:{'x-api-key':key,accept:'application/json'},signal:AbortSignal.timeout(15_000)});
    const body=await response.json().catch(()=>({}));
    if(!response.ok){const result={ok:false,ready:false,status:response.status,reason:`composio_http_${response.status}`};log(logger,result);return result;}
    const active=(Array.isArray(body?.items)?body.items:[]).filter(row=>String(row?.status||'').toUpperCase()==='ACTIVE'&&!row?.is_disabled);
    if(active.length!==1){const result={ok:true,ready:false,activeAccounts:active.length,reason:active.length===0?'gmail_not_connected':'multiple_gmail_accounts_require_explicit_mapping'};log(logger,result);return result;}

    const accountId=String(active[0]?.id||'');
    const [details,requirements]=await Promise.all([
      getAccountDetails(accountId,key),
      getSendRequirements(key)
    ]);
    if(!details.ok){const result={ok:false,ready:false,activeAccounts:1,reason:details.reason};log(logger,result);return result;}
    if(!requirements.ok){const result={ok:false,ready:false,activeAccounts:1,reason:requirements.reason};log(logger,result);return result;}

    const requested=[...new Set([...(details.requestedScopes||[]),...(details.requestedUserScopes||[])].map(normalizeScope).filter(Boolean))];
    const required=[...new Set((requirements.requiredScopes||[]).map(normalizeScope).filter(Boolean))];
    const missing=required.filter(scope=>!scopeSatisfied(scope,requested));
    const sendAuthorized=required.length>0&&missing.length===0;
    const result={
      ok:true,
      ready:sendAuthorized,
      activeAccounts:1,
      sendAuthorized,
      requiredScopes:required,
      requestedScopeCount:requested.length,
      missingScopes:missing,
      reason:sendAuthorized?'gmail_connected_send_authorized':'gmail_connected_missing_send_scope'
    };
    log(logger,result);return result;
  }catch(error){const result={ok:false,ready:false,reason:String(error?.message||error).slice(0,160)};log(logger,result);return result;}
}

async function getAccountDetails(accountId,key){
  if(!accountId)return{ok:false,reason:'gmail_connected_account_id_missing'};
  try{
    const response=await fetch(`https://backend.composio.dev/api/v3.1/connected_accounts/${encodeURIComponent(accountId)}`,{headers:{'x-api-key':key,accept:'application/json'},signal:AbortSignal.timeout(12_000)});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)return{ok:false,reason:`gmail_account_details_http_${response.status}`};
    return{ok:true,requestedScopes:array(body?.requested_scopes),requestedUserScopes:array(body?.requested_user_scopes)};
  }catch(error){return{ok:false,reason:`gmail_account_details_${String(error?.name||'network').toLowerCase()}`};}
}

async function getSendRequirements(key){
  try{
    const response=await fetch('https://backend.composio.dev/api/v3.1/tools/scopes/required',{
      method:'POST',headers:{'x-api-key':key,accept:'application/json','content-type':'application/json'},
      body:JSON.stringify({tools:['GMAIL_SEND_EMAIL'],version:'latest'}),signal:AbortSignal.timeout(12_000)
    });
    const body=await response.json().catch(()=>({}));
    if(!response.ok)return{ok:false,reason:`gmail_scope_requirements_http_${response.status}`};
    const required=array(body?.scopes_required);
    if(!required.length)return{ok:false,reason:'gmail_send_scope_requirements_empty'};
    return{ok:true,requiredScopes:required};
  }catch(error){return{ok:false,reason:`gmail_scope_requirements_${String(error?.name||'network').toLowerCase()}`};}
}

function array(value){return Array.isArray(value)?value.map(String):[];}
function normalizeScope(value){return String(value||'').trim();}
function scopeSatisfied(required,requested){
  if(requested.includes(required))return true;
  // Gmail modify is a documented superset of read/send operations; gmail.mail.google.com
  // is full mailbox access. Treat either as satisfying a narrower Gmail scope.
  if(/^https:\/\/www\.googleapis\.com\/auth\/gmail\./i.test(required)){
    return requested.some(scope=>/\/auth\/gmail\.(?:modify|mail\.google\.com)$/i.test(scope)||scope==='https://mail.google.com/');
  }
  return false;
}
function log(logger,result){try{logger.info?.('[EmailChannelProbe] '+JSON.stringify(result));}catch{}}
