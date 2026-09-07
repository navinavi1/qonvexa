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
    const [details,requirements,apiProbe]=await Promise.all([
      getAccountDetails(accountId,key),
      getSendRequirements(key),
      probeGmailApi(accountId,key)
    ]);
    if(!details.ok){const result={ok:false,ready:false,activeAccounts:1,reason:details.reason};log(logger,result);return result;}
    if(!requirements.ok){const result={ok:false,ready:false,activeAccounts:1,reason:requirements.reason};log(logger,result);return result;}

    const requested=[...new Set([...(details.requestedScopes||[]),...(details.requestedUserScopes||[])].map(normalizeScope).filter(Boolean))];
    const required=[...new Set((requirements.requiredScopes||[]).map(normalizeScope).filter(Boolean))];
    const missing=required.filter(scope=>!scopeSatisfied(scope,requested));
    const scopesReady=required.length>0&&missing.length===0;
    const apiReady=apiProbe.ok&&apiProbe.status===200;
    const sendAuthorized=scopesReady&&apiReady;
    const reason=!scopesReady?'gmail_connected_missing_send_scope':!apiReady?`gmail_api_read_probe_${apiProbe.status||'failed'}`:'gmail_connected_send_authorized';
    const result={
      ok:true,
      ready:sendAuthorized,
      activeAccounts:1,
      sendAuthorized,
      composioManaged:details.composioManaged,
      authScheme:details.authScheme,
      requiredScopes:required,
      requestedScopeCount:requested.length,
      missingScopes:missing,
      gmailApiReadStatus:apiProbe.status||0,
      gmailApiReadReason:apiProbe.reason||'',
      reason
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
    return{
      ok:true,
      requestedScopes:array(body?.requested_scopes),
      requestedUserScopes:array(body?.requested_user_scopes),
      composioManaged:Boolean(body?.auth_config?.is_composio_managed),
      authScheme:String(body?.auth_config?.auth_scheme||body?.authScheme||body?.auth_scheme||'').toUpperCase()
    };
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

async function probeGmailApi(accountId,key){
  if(!accountId)return{ok:false,status:0,reason:'account_missing'};
  try{
    const response=await fetch('https://backend.composio.dev/api/v3.1/tools/execute/proxy',{
      method:'POST',headers:{'x-api-key':key,accept:'application/json','content-type':'application/json'},
      body:JSON.stringify({connected_account_id:accountId,endpoint:'/gmail/v1/users/me/profile',method:'GET'}),
      signal:AbortSignal.timeout(12_000)
    });
    const body=await response.json().catch(()=>({}));
    if(!response.ok)return{ok:false,status:response.status,reason:safeReason(body)||`proxy_http_${response.status}`};
    const upstream=Number(body?.status||200);
    return{ok:upstream>=200&&upstream<300,status:upstream,reason:upstream>=400?safeReason(body):''};
  }catch(error){return{ok:false,status:0,reason:String(error?.name||'network').toLowerCase()};}
}

function safeReason(body){
  const source=body?.data?.error||body?.error||body?.data||{};
  const status=String(source?.status||source?.code||body?.status_reason||'').trim();
  const message=String(source?.message||body?.message||'').toLowerCase();
  if(/insufficient.*scope|scope.*insufficient/.test(message))return'insufficient_scope';
  if(/gmail api has not been used|api.*disabled|accessnotconfigured/.test(message))return'gmail_api_disabled';
  if(/rate|quota/.test(message))return'rate_or_quota';
  if(/forbidden|permission|denied/.test(message))return'permission_denied';
  return status.replace(/[^a-z0-9_.-]/gi,'_').slice(0,80)||'';
}
function array(value){return Array.isArray(value)?value.map(String):[];}
function normalizeScope(value){return String(value||'').trim();}
function scopeSatisfied(required,requested){
  if(requested.includes(required))return true;
  if(/^https:\/\/www\.googleapis\.com\/auth\/gmail\./i.test(required)){
    return requested.some(scope=>scope==='https://mail.google.com/'||/\/auth\/gmail\.modify$/i.test(scope));
  }
  return false;
}
function log(logger,result){try{logger.info?.('[EmailChannelProbe] '+JSON.stringify(result));}catch{}}
