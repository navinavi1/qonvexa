import { reserveResource, observeResourceResult, resourceAvailability } from './resource-control.js';
import { normalizeApp } from './capability-registry.js';
const BLOCKED_TOOL = /(^|_)(DELETE|REMOVE|REVOKE|TRANSFER|SEND_MONEY|CREATE_PAYMENT|WITHDRAW|BUY|SELL|TRADE|SWAP|CLOSE_ACCOUNT|SUBSCRIBE|UPGRADE|PURCHASE|RECHARGE|ENABLE_BILLING|CHANGE_PLAN|CHANGE_PASSWORD|RESET_PASSWORD|CREATE_API_KEY|ROTATE_SECRET|EXPORT_SECRET|PRIVATE_KEY|SEED_PHRASE)(_|$)/i;
const DEFAULT_DENY_TOOLKITS = new Set(['STRIPE','PAYPAL','COINBASE','BINANCE','BANKING','PLAID']);

async function composioSearchImpl({query='',toolkit='',limit=12}={},env=process.env,signal){
  const key=String(env.COMPOSIO_API_KEY||'').trim();if(!key)return{ok:false,error:'composio_api_key_missing'};
  const qs=new URLSearchParams({query:String(query||'').slice(0,300),include_deprecated:'false',toolkit_versions:'latest',limit:String(Math.max(1,Math.min(30,Number(limit||12))))});
  if(toolkit)qs.set('toolkit_slug',String(toolkit).toLowerCase());
  try{
    const response=await fetch(`https://backend.composio.dev/api/v3.1/tools?${qs}`,{headers:{'x-api-key':key,accept:'application/json'},signal:withTimeout(20000,signal)});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)return{ok:false,error:`composio_http_${response.status}`,detail:String(body?.error?.message||body?.message||'').slice(0,400)};
    const items=(Array.isArray(body?.items)?body.items:[]).filter(item=>isAllowed(item?.slug,item?.toolkit?.slug,env)).slice(0,20).map(item=>({slug:item.slug,name:item.name||'',description:String(item.description||item.human_description||'').slice(0,600),toolkit:item.toolkit?.slug||'',requiresAuth:item.no_auth===false,inputParameters:item.input_parameters||{},version:String(item.version||item.toolkit_version||item.toolkit?.version||'')}));
    return{ok:true,items,nextCursor:body?.next_cursor||'',totalItems:Number(body?.total_items||items.length)};
  }catch(error){return{ok:false,error:signal?.aborted?'aborted_by_emergency_stop':String(error?.message||error).slice(0,300)}}
}

async function composioExecuteImpl({toolSlug,arguments:args={},connectedAccountId='',userId='',toolVersion=''}={},env=process.env,signal){
  const key=String(env.COMPOSIO_API_KEY||'').trim();
  if(!key)return{ok:false,error:'composio_api_key_missing'};
  const slug=String(toolSlug||'').trim().toUpperCase();
  if(!/^[A-Z0-9_]{3,160}$/.test(slug))return{ok:false,error:'invalid_composio_tool_slug'};
  const inferredToolkit=detectToolkit(slug,env);
  if(!isAllowed(slug,inferredToolkit,env))return{ok:false,error:'composio_tool_blocked_by_financial_destructive_or_allowlist_policy'};
  try{
    const info=await resolveToolInfo(slug,key,signal);
    const toolkit=info.toolkit||inferredToolkit;
    if(!isAllowed(slug,toolkit,env))return{ok:false,error:'composio_tool_blocked_by_financial_destructive_or_allowlist_policy'};
    const normalizedToolkit=normalizeApp(toolkit);
    if(['canva','figma'].includes(normalizedToolkit)&&/(?:GENERATE|AI_|MAGIC|PREMIUM|PURCHASE|SUBSCRIBE)/i.test(slug))return{ok:false,error:'paid_media_operation_requires_verified_free_allowance',replacementRequired:true,alternatives:['e2b_open_source_media']};
    {const allowance=await reserveResource(normalizedToolkit==='gmail'&&/(?:FETCH|GET|LIST|SEARCH)/.test(slug)?'gmail_read':normalizedToolkit,1,env);if(!allowance.ok)return{...allowance,alternatives:normalizedToolkit==='canva'||normalizedToolkit==='figma'?['e2b_open_source_media']:['existing_connected_apps','open_source_recipe']};}
    const version=validVersion(toolVersion)||validVersion(info.version)||await resolveCatalogVersion(slug,toolkit,key,signal);
    const accountMap=parseJson(env.AUTONOMOS_COMPOSIO_ACCOUNTS_JSON,{});
    let account=String(connectedAccountId||accountMap[toolkit]||accountMap[toolkit.toLowerCase()]||'');
    if(!account&&toolkit)account=await resolveConnectedAccountId(toolkit,key,signal);
    if(slug==='GMAIL_SEND_EMAIL'&&args._autonomos_thread_id){
      const mail=extractGmailSendFields(args);
      if(!mail||!account||!/^[a-zA-Z0-9_-]{1,200}$/.test(String(args._autonomos_thread_id))||!/^<[^<>\r\n]{1,500}>$/.test(String(args._autonomos_in_reply_to||'')))return{ok:false,error:'gmail_reply_metadata_invalid'};
      return gmailProxySend({key,account,mail:{...mail,threadId:args._autonomos_thread_id,inReplyTo:args._autonomos_in_reply_to},signal});
    }
    const payload={arguments:args||{},...(version?{version}:{}),...(account?{connected_account_id:account}:{}),...(userId?{user_id:String(userId)}:{})};
    const response=await fetch(`https://backend.composio.dev/api/v3.1/tools/execute/${encodeURIComponent(slug)}`,{
      method:'POST',headers:{'content-type':'application/json','x-api-key':key},
      body:JSON.stringify(payload),
      signal:withTimeout(45000,signal)
    });
    const body=await response.json().catch(()=>({}));
    if(response.ok&&body?.successful!==false)return{ok:true,data:body?.data??body,logId:body?.log_id||body?.logId||'',toolkit,toolVersion:version||''};

    // A synchronous HTTP 400 is input validation and happens before Gmail can send.
    // Only in that safe case do we use Composio's authenticated Gmail proxy fallback.
    if(slug==='GMAIL_SEND_EMAIL'&&response.status===400&&account){
      const mail=extractGmailSendFields(args);
      if(mail){
        const proxied=await gmailProxySend({key,account,mail,signal});
        if(proxied.ok)return{ok:true,data:proxied.data,logId:proxied.logId||'',toolkit:'GMAIL',toolVersion:version||'',fallback:'gmail_proxy'};
        return{ok:false,error:proxied.error,detail:proxied.detail||'',toolkit:'GMAIL',toolVersion:version||'',needsConnectedAccount:proxied.needsConnectedAccount};
      }
    }

    return observeResourceResult(normalizedToolkit,{ok:false,error:`composio_http_${response.status}`,detail:String(body?.error?.message||body?.error||body?.message||'').slice(0,500),toolkit,toolVersion:version||'',needsConnectedAccount:response.status===401||response.status===403||response.status===422},env);
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
  if(['GOOGLE','MICROSOFT'].includes(parts[0])&&parts[1])return `${parts[0]}_${parts[1]}`;
  return parts[0]||'';
}
function csv(v){return String(v||'').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean)}
function parseJson(value,fallback){try{return JSON.parse(String(value||''))}catch{return fallback}}
function withTimeout(ms,signal){return signal?AbortSignal.any([AbortSignal.timeout(ms),signal]):AbortSignal.timeout(ms)}
function validVersion(value){const v=String(value||'').trim();return /^\d{8}_\d{2}$/.test(v)?v:'';}

async function resolveToolInfo(toolSlug,key,signal){
  try{
    const response=await fetch(`https://backend.composio.dev/api/v3.1/tools/${encodeURIComponent(toolSlug)}?toolkit_versions=latest`,{headers:{'x-api-key':key,accept:'application/json'},signal:withTimeout(12000,signal)});
    if(!response.ok)return{toolkit:'',version:''};
    const body=await response.json().catch(()=>({}));
    return{toolkit:String(body?.toolkit?.slug||'').trim().toUpperCase(),version:validVersion(body?.version||body?.toolkit?.version||body?.toolkit_version)};
  }catch{return{toolkit:'',version:''}}
}

async function resolveCatalogVersion(toolSlug,toolkit,key,signal){
  try{
    const qs=new URLSearchParams({query:toolSlug,include_deprecated:'false',toolkit_versions:'latest',limit:'10'});
    if(toolkit)qs.set('toolkit_slug',String(toolkit).toLowerCase());
    const response=await fetch(`https://backend.composio.dev/api/v3.1/tools?${qs}`,{headers:{'x-api-key':key,accept:'application/json'},signal:withTimeout(12000,signal)});
    if(!response.ok)return'';
    const body=await response.json().catch(()=>({}));
    const item=(Array.isArray(body?.items)?body.items:[]).find(row=>String(row?.slug||'').toUpperCase()===toolSlug);
    return validVersion(item?.version||item?.toolkit_version||item?.toolkit?.version);
  }catch{return'';}
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
  return'';
}

function extractGmailSendFields(args){
  const value=args&&typeof args==='object'?args:{};
  const recipient=String(value.recipient_email||value.to_email||value.email_address||'').trim();
  const to=Array.isArray(value.to)?String(value.to[0]||'').trim():String(value.to||recipient).trim();
  const subject=String(value.subject||'').replace(/[\r\n]+/g,' ').trim().slice(0,500);
  const body=String(value.body||value.message_body||value.body_text||value.plain_text||value.content||value.message||value.text||'');
  const cleanTo=String(to||recipient).replace(/[\r\n]+/g,'').trim();
  if(!/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(cleanTo)||!subject||!body)return null;
  return{to:cleanTo,subject,body};
}

async function gmailProxySend({key,account,mail,signal}){
  const raw=buildRawGmailMessage(mail);
  try{
    const response=await fetch('https://backend.composio.dev/api/v3.1/tools/execute/proxy',{
      method:'POST',headers:{'content-type':'application/json','x-api-key':key,accept:'application/json'},
      body:JSON.stringify({connected_account_id:account,endpoint:'/gmail/v1/users/me/messages/send',method:'POST',body:{raw,...(mail.threadId?{threadId:mail.threadId}:{})}}),
      signal:withTimeout(45000,signal)
    });
    const body=await response.json().catch(()=>({}));
    if(!response.ok){
      const detail=String(body?.error?.message||body?.error||body?.message||body?.data?.error?.message||'').slice(0,500);
      return{ok:false,error:`composio_gmail_proxy_http_${response.status}`,detail,needsConnectedAccount:response.status===401||response.status===403||/scope|auth|credential|permission/i.test(detail)};
    }
    const upstreamStatus=Number(body?.status||200);
    if(upstreamStatus>=400){
      const detail=String(body?.data?.error?.message||body?.data?.message||body?.message||'').slice(0,500);
      return{ok:false,error:`gmail_upstream_http_${upstreamStatus}`,detail,needsConnectedAccount:upstreamStatus===401||upstreamStatus===403||/scope|auth|credential|permission/i.test(detail)};
    }
    const data=body?.data??body;
    const wrappers=[data,data?.response_data,data?.responseData,data?.data,data?.response,data?.body];
    const gmail=wrappers.find(row=>row&&typeof row==='object'&&String(row.id||row.message?.id||''));
    const gmailId=String(gmail?.id||gmail?.message?.id||'');
    if(!gmailId)return{ok:false,error:'composio_gmail_proxy_malformed_success',detail:`proxy_status_${upstreamStatus}`,needsConnectedAccount:false};
    return{ok:true,data:gmail,logId:body?.log_id||body?.logId||''};
  }catch(error){return{ok:false,error:signal?.aborted?'aborted_by_emergency_stop':String(error?.message||error).slice(0,300),detail:'',needsConnectedAccount:false};}
}

function buildRawGmailMessage({to,subject,body,inReplyTo}){
  const encodedSubject=/^[\x20-\x7E]*$/.test(subject)?subject:`=?UTF-8?B?${Buffer.from(subject,'utf8').toString('base64')}?=`;
  const message=[
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    ...(inReplyTo?[`In-Reply-To: ${inReplyTo}`,`References: ${inReplyTo}`]:[]),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    String(body||'')
  ].join('\r\n');
  return Buffer.from(message,'utf8').toString('base64url');
}

export async function composioSearch(args,env=process.env,signal){const cap=await reserveResource('composio',1,env);if(!cap.ok)return cap;return observeResourceResult('composio',await composioSearchImpl(args,env,signal),env);}
export async function composioExecute(args,env=process.env,signal){const cap=await reserveResource('composio',1,env);if(!cap.ok)return cap;return observeResourceResult('composio',await composioExecuteImpl(args,env,signal),env);}
