import fs from 'node:fs';
import path from 'node:path';
import { unifiedCapabilityContext, refreshCapabilities, recordCapabilityProof, readCapabilities } from './capability-registry.js';
import { resourceAvailability, onResourceUnavailable, resourceRoot } from './resource-control.js';

// Install only known open-source packages inside the existing isolated sandbox.
// Discovered web pages never become shell instructions, credentials or billing consent.
const RECIPES=Object.freeze({
  browser:{command:'node /home/user/autonomos-browser.cjs --network',proof:'verified_browser'},
  design_media_tool:{command:"python -m pip install --disable-pip-version-check --index-url https://pypi.org/simple 'Pillow>=11.3,<12' 'imageio-ffmpeg>=0.6,<0.7' && python - <<'PY'\nfrom PIL import Image\nimport imageio_ffmpeg,subprocess,os\nos.makedirs('/home/user/bin',exist_ok=True)\np='/home/user/bin/ffmpeg'\nif not os.path.exists(p): os.symlink(imageio_ffmpeg.get_ffmpeg_exe(),p)\nImage.new('RGB',(2,2)).save('/tmp/autonomos-probe.png')\nsubprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-version'],check=True,stdout=subprocess.DEVNULL)\nprint('verified_media')\nPY",proof:'verified_media'},
  document_generation:{command:"python -m pip install --disable-pip-version-check --index-url https://pypi.org/simple 'python-docx>=1.2,<2' 'python-pptx>=1.0,<2' 'openpyxl>=3.1,<4' 'pypdf>=6,<7' && python -c \"import docx,pptx,openpyxl,pypdf;print('verified_documents')\"",proof:'verified_documents'}
});
const inFlight=new Map();const sessionIds=new WeakMap();let nextSessionId=1;
export async function recoverFreeCapability(gap,env=process.env,{sandboxSession=null,signal=null}={}){
  const key=String(gap||'');if(sandboxSession&&!sessionIds.has(sandboxSession))sessionIds.set(sandboxSession,nextSessionId++);const id=resourceRoot(env)+':'+key+':'+(sandboxSession?sessionIds.get(sandboxSession):'probe');if(inFlight.has(id))return inFlight.get(id);
  const task=(async()=>{
    if(signal?.aborted)return{ok:false,error:'aborted_by_emergency_stop'};
    if(key.startsWith('connected_app:')||key==='connected_app_gateway'){await refreshCapabilities(env,{force:true});const c=unifiedCapabilityContext(env);return{ok:key.includes(':')?c.connectedApps.includes(key.split(':')[1]):c.hasAppTool,route:'verified_connected_account',reason:'account_access_required_if_absent'};}
    if(key==='web_search')return{ok:resourceAvailability('public_http',env).allowed||resourceAvailability('github',env).allowed,route:'public_search_with_fallback',alternatives:['github_public_search','wikipedia_public_api','public_rss']};
    if(key==='artifact_storage')return{ok:unifiedCapabilityContext(env).hasArtifactTool,route:'persistent_local_artifact',alternatives:['verified_r2','connected_google_drive']};
    if(key==='github_pr'||key==='sandbox_shell'){await refreshCapabilities(env);const c=unifiedCapabilityContext(env);return{ok:key==='github_pr'?c.hasGithubPrTool:c.hasShellTool,route:key==='github_pr'?'github_contents_pr':'e2b_shell'};}
    const recipe=RECIPES[key];if(!recipe)return discoverFreeReplacements(key,env,signal);
    if(!resourceAvailability('e2b',env).allowed)return{ok:false,error:'sandbox_resource_unavailable',gap:key,retryable:true};
    const {e2bRunShell}=await import('./tools.js');const result=await e2bRunShell({command:recipe.command,...(key==='browser'?{files:[{path:'autonomos-browser.cjs',content:fs.readFileSync(new URL('./browser-runtime.cjs',import.meta.url),'utf8')}]}:{})},{...env,AUTONOMOS_E2B_COMMAND_TIMEOUT_MS:'180000'},signal,sandboxSession);
    const ok=result.ok&&String(result.stdout).includes(recipe.proof);const name=key==='browser'?'browser':key==='design_media_tool'?'media':'documents';
    // Every job gets a new sandbox: this proof establishes a reproducible recipe,
    // while prepareExecutionTools installs/verifies it in the job's actual sandbox.
    recordCapabilityProof(name,ok,{recipe:key,requiresPerSessionInstall:true},env);
    return{ok,route:'open_source_in_existing_sandbox',recipe:key,proof:ok?recipe.proof:'',details:ok?String(result.stdout).slice(-1200):'',error:ok?'':[result.error,result.stderr,result.stdout].filter(Boolean).join('\n').slice(-1800)||'replacement_probe_failed'};
  })();inFlight.set(id,task);try{return await task;}finally{inFlight.delete(id);}
}
export async function prepareExecutionTools(opportunity,capability,env,options={}){
  const text=`${opportunity.title||''} ${opportunity.description||''}`;const needs=new Set(capability.missingTools||[]);
  for(const c of capability.requiredCapabilities||[])if(c==='browser')needs.add('browser');else if(c==='designMedia')needs.add('design_media_tool');
  if(capability.skill==='document-generation'||/\b(?:docx|pptx|xlsx)\b/i.test(text))needs.add('document_generation');
  const results=[];for(const gap of needs){if(RECIPES[gap])results.push({gap,...await recoverFreeCapability(gap,env,options)});}return results;
}
export function startResourceRecovery(env=process.env,logger=console){
  let pending=false;return onResourceUnavailable(event=>{if(event.root!==resourceRoot(env)||pending)return;pending=true;queueMicrotask(async()=>{try{const gaps=event.provider==='r2'?['artifact_storage']:event.provider==='composio'?['web_search','artifact_storage']:event.provider==='coderabbit'?[]:['web_search'];const results=[];for(const gap of gaps)results.push({gap,...await recoverFreeCapability(gap,env)});logger.info?.('[ResourceRecovery] '+JSON.stringify({provider:event.provider,reason:event.reason,alternatives:results,keepOtherJobsRunning:true}));}catch(error){logger.warn?.('[ResourceRecovery] '+String(error.message));}finally{pending=false;}});});
}
export function recoveryRecipes(){return Object.keys(RECIPES);}

async function discoverFreeReplacements(gap,env,signal){
  const file=path.join(resourceRoot(env),'free-replacement-candidates.json');let saved={};try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  const prior=saved[gap];if(prior&&Date.now()-Date.parse(prior.checkedAt||0)<60*60_000)return prior;
  const {freeWebSearch}=await import('./free-web-tool.js');
  const search=await freeWebSearch(`open source ${String(gap).replace(/[^a-zA-Z0-9 ]/g,' ')} tool MIT Apache github`,env,signal);
  const result={ok:false,error:'no_verified_free_replacement',gap,retryable:true,checkedAt:new Date().toISOString(),discoveryCompleted:Boolean(search.ok),candidates:(search.results||[]).slice(0,5).map(x=>({name:x.title,url:x.url,verificationRequired:true})),reason:'Candidate code, credentials, and zero-cost allowance must be verified before installation; existing verified recipes install automatically.'};
  saved[gap]=result;fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(saved),{mode:0o600});fs.renameSync(tmp,file);return result;
}
