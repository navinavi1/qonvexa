import { githubAvailable, githubRequest } from './github-transport.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resourceAvailability, resourceRoot, observeResourceResult, reserveResource } from './resource-control.js';

export function credentialFingerprint(env=process.env){return crypto.createHash('sha256').update(JSON.stringify(['OPENAI_API_KEY','AUTONOMOS_LLM_API_KEY','AUTONOMOS_LLM_BASE_URL','E2B_API_KEY','COMPOSIO_API_KEY','GITHUB_TOKEN','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','S3_ENDPOINT','R2_ENDPOINT','S3_BUCKET','R2_BUCKET','AUTONOMOS_DEPLOY_WEBHOOK_URL','AUTONOMOS_DEPLOY_WEBHOOK_TOKEN'].map(k=>[k,env[k]||'']))).digest('hex');}
export function readCapabilities(env=process.env){try{const state=JSON.parse(fs.readFileSync(path.join(resourceRoot(env),'verified-capabilities.json'),'utf8'));if(state.credentialFingerprint!==credentialFingerprint(env))return{};return state;}catch{return{};}}
export function saveCapabilities(state,env=process.env){const root=resourceRoot(env);fs.mkdirSync(root,{recursive:true});const file=path.join(root,'verified-capabilities.json');const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify({...state,credentialFingerprint:credentialFingerprint(env)}),{mode:0o600});fs.renameSync(tmp,file);}
function fresh(proof){return proof?.ok===true&&Date.parse(proof.expiresAt||'')>Date.now();}
// The no-llm branch below reads the SAME key names as llm-router.js
// (AUTONOMOS_LLM_API_KEY || OPENAI_API_KEY). It used to read OPENAI_API_KEY alone, so a
// deployment configured only with AUTONOMOS_LLM_API_KEY — which llm-router accepts and
// happily makes real model calls with — reported llmEnabled:false to every caller that
// passes no llm object. FreeRevenueLeadActioner is one of those, and it is the actioner the
// running fleet is built on, so every non-deterministic job was classified
// 'unsupported_without_llm' and never executed, with a working API key sitting in the
// environment. One variable name differing between two files, and nothing says so.
export function unifiedCapabilityContext(env=process.env,{llm=null}={}){
  const state=readCapabilities(env);const available=p=>resourceAvailability(p,env).allowed;
  const shell=Boolean(env.E2B_API_KEY)&&available('e2b')&&fresh(state.shell);
  const app=Boolean(env.COMPOSIO_API_KEY)&&available('composio')&&fresh(state.apps);
  const connected=app?(state.apps.connectedApps||[]).filter(name=>available(name)):[];
  const localArtifact=Boolean(env.STORAGE_DIR&&(env.SITE_URL||env.RENDER_EXTERNAL_URL||env.PUBLIC_URL))&&available('local_artifact');
  const deploy=Boolean(env.AUTONOMOS_DEPLOY_WEBHOOK_URL)&&fresh(state.deploy);
  return{registryVersion:1,llmEnabled:Boolean(llm?(llm.available??llm.enabled):(env.AUTONOMOS_LLM_API_KEY||env.OPENAI_API_KEY))&&available('openai'),hasGithubPrTool:githubAvailable(env)&&available('github')&&fresh(state.github),hasShellTool:shell,hasBrowserTool:shell&&fresh(state.browser),hasDesignMediaTool:shell&&fresh(state.media),hasAppTool:app,connectedApps:connected,hasDeployTool:deploy,hasArtifactTool:localArtifact||(available('r2')&&fresh(state.artifact)),hasWebSearchTool:available('public_http')||available('github'),verifiedAt:state.updatedAt||'',strictCapabilityProof:true};
}
const pending=new Map();
// `only` narrows the refresh to named branches ('apps' | 'github' | 'shell' | 'deploy').
// Without it a caller that needs one capability re-probes all of them, and the shell branch
// is not a cheap probe: it boots an E2B sandbox. free-tool-recovery.js asked for a forced
// refresh whenever a job lacked a connected app, so a Composio gap span up a sandbox every
// time -- 699 of them in one billing period, averaging seven seconds of vCPU each. Probing,
// not working. Scope the refresh to the branch whose proof the caller actually needs.
export async function refreshCapabilities(env=process.env,{force=false,fetchImpl=fetch,shellProbe=null,only=null}={}){
  const scope=only==null?null:new Set(Array.isArray(only)?only:[only]);
  const wanted=name=>!scope||scope.has(name);
  const key=resourceRoot(env)+'|'+(scope?[...scope].sort().join(','):'*');
  if(pending.has(key))return pending.get(key);
  const task=(async()=>{
    const state=readCapabilities(env);const proof=(ok,detail={})=>({ok,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+(ok?6*60*60_000:60_000)).toISOString(),...detail});
    const should=p=>force||!p||Date.parse(p.expiresAt||'')<=Date.now();
    if(wanted('apps')&&env.COMPOSIO_API_KEY&&resourceAvailability('composio',env).allowed&&should(state.apps)){
      try{let cursor='',accounts=[],pages=0;do{const qs=new URLSearchParams({statuses:'ACTIVE',limit:'100'});if(cursor)qs.set('cursor',cursor);const response=await fetchImpl('https://backend.composio.dev/api/v3.1/connected_accounts?'+qs,{headers:{'x-api-key':env.COMPOSIO_API_KEY,accept:'application/json'},signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('composio_http_'+response.status);const body=await response.json();accounts.push(...(body.items||[]));cursor=body.next_cursor||'';}while(cursor&&++pages<5);const apps=[...new Set(accounts.filter(a=>a.status==='ACTIVE'&&!a.is_disabled).map(a=>normalizeApp(a.toolkit?.slug||a.toolkit_slug||a.appName||a.appUniqueId||'')))].filter(Boolean);state.apps=proof(true,{connectedApps:apps,complete:!cursor});}
      catch(error){state.apps=proof(false,{reason:String(error.message)});observeResourceResult('composio',{error:String(error.message)},env);}
    }
    if(wanted('github')&&githubAvailable(env)&&resourceAvailability('github',env).allowed&&should(state.github)){
      try{const r=await githubRequest('/user',{env,fetchImpl});state.github=proof(r.ok&&Boolean(r.value?.login),{reason:r.ok?'authenticated_github_account':'github_http_'+r.status,login:r.value?.login||''});}
      catch(error){state.github=proof(false,{reason:String(error.message)});}
    }
    if(wanted('shell')&&env.E2B_API_KEY&&resourceAvailability('e2b',env).allowed&&should(state.shell)){
      try{const run=shellProbe||(await import('./tools.js')).e2bRunShell;const result=await run({command:"python - <<'PY'\nimport json,shutil,importlib.util\nprint(json.dumps({'python':True,'node':bool(shutil.which('node')),'pillow':bool(importlib.util.find_spec('PIL')),'ffmpeg':bool(shutil.which('ffmpeg'))}))\nPY"},env);state.shell=proof(result.ok,{reason:result.ok?'sandbox_execution_verified':String(result.error||'probe_failed')});if(result.ok){let info={};try{info=JSON.parse(result.stdout.trim().split('\n').at(-1));}catch{}state.media=proof(Boolean(info.pillow&&info.ffmpeg),{reason:'requires_pillow_and_ffmpeg',...info});}}
      catch(error){state.shell=proof(false,{reason:String(error.message)});}
    }
    // OPTIONS is a read-only protocol check, never a deployment POST. A response must
    // explicitly advertise POST; mere configuration is insufficient. Actual completion
    // still requires a successful deployWebhook result.
    if(wanted('deploy')&&/^https:\/\//i.test(String(env.AUTONOMOS_DEPLOY_WEBHOOK_URL||''))&&should(state.deploy)){
      try{const r=await fetchImpl(env.AUTONOMOS_DEPLOY_WEBHOOK_URL,{method:'OPTIONS',headers:env.AUTONOMOS_DEPLOY_WEBHOOK_TOKEN?{authorization:'Bearer '+env.AUTONOMOS_DEPLOY_WEBHOOK_TOKEN}:{},redirect:'error',signal:AbortSignal.timeout(8000)});state.deploy=proof((r.ok||r.status===405)&&/\bPOST\b/i.test(r.headers.get('allow')||r.headers.get('access-control-allow-methods')||''),{reason:'deployment_endpoint_post_support_probe',deploymentCompleted:false});}catch(error){state.deploy=proof(false,{reason:String(error.message)});}
    }
    const latest=readCapabilities(env);for(const [name,p] of Object.entries(latest)){if(p?.checkedAt&&Date.parse(p.checkedAt)>Date.parse(state[name]?.checkedAt||0))state[name]=p;}
    state.updatedAt=new Date().toISOString();saveCapabilities(state,env);return unifiedCapabilityContext(env);
  })();pending.set(key,task);try{return await task;}finally{pending.delete(key);}
}
export function recordCapabilityProof(name,ok,detail={},env=process.env){const state=readCapabilities(env);state[name]={ok:Boolean(ok),...detail,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+6*60*60_000).toISOString()};state.updatedAt=new Date().toISOString();saveCapabilities(state,env);}
export function normalizeApp(name){const n=String(name).toLowerCase().replace(/[- ]/g,'_');return({googledrive:'google_drive',googlesheets:'google_sheets',googlecalendar:'google_calendar'})[n]||n;}
