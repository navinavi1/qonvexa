import fs from 'node:fs';
import path from 'node:path';
import { e2bRunShell } from './tools.js';

const ACQUIRABLE=Object.freeze({
  web_search:{workflow:'e2b_public_research',probe:`node - <<'NODE'
const urls=['https://api.github.com','https://api.stackexchange.com/2.3/info?site=stackoverflow','https://en.wikipedia.org/api/rest_v1/page/summary/Open_source'];
let ok=0;
for(const u of urls){try{const r=await fetch(u,{headers:{'user-agent':'AutonomOS-SkillProbe/1.0'}});console.log(u,r.status);if(r.ok)ok++;}catch(e){console.log(u,'ERR',String(e.message||e).slice(0,80));}}
if(!ok)process.exit(2);
NODE`},
  browser:{workflow:'e2b_playwright_browser',probe:`node - <<'NODE'
const {execFileSync}=require('node:child_process');
let ok=false;
for(const cmd of ['chromium','chromium-browser','google-chrome','google-chrome-stable']){try{execFileSync(cmd,['--version'],{stdio:'ignore'});console.log('browser',cmd);ok=true;break;}catch{}}
try{require.resolve('playwright');console.log('playwright package present');ok=true;}catch{}
try{require.resolve('puppeteer');console.log('puppeteer package present');ok=true;}catch{}
if(!ok)process.exit(2);
NODE`},
  design_media_tool:{workflow:'e2b_open_source_media',probe:`python - <<'PY'
import shutil,importlib.util,sys
ff=bool(shutil.which('ffmpeg') or shutil.which('convert') or shutil.which('magick'))
pil=bool(importlib.util.find_spec('PIL'))
print('ffmpeg_or_imagemagick',ff); print('pillow',pil)
sys.exit(0 if ff or pil else 2)
PY`},
  deploy:{workflow:'composio_vercel_netlify',probe:null},artifact_storage:{workflow:'r2_or_google_drive',probe:null},sandbox_shell:{workflow:'e2b_shell',probe:'node --version && python --version'},github_pr:{workflow:'github_contents_pr',probe:null},connected_app_gateway:{workflow:'composio_free_apps',probe:null}
});

export class AdaptiveSkillAcquirer{
  constructor({env=process.env,storageDir='',logger=console}={}){this.env=env;this.logger=logger;this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');fs.mkdirSync(this.root,{recursive:true});this.file=path.join(this.root,'skill-acquisition.json');this.libraryFile=path.join(this.root,'adaptive-skill-library.json');this.timer=null;this.running=false;}
  start(){if(this.timer)return;const every=Math.max(15*60_000,Number(this.env.AUTONOMOS_SKILL_ACQUIRER_MS||60*60_000));setTimeout(()=>this.tick().catch(e=>this.log('skill_acquirer_error',{error:safe(e)})),45_000).unref?.();this.timer=setInterval(()=>this.tick().catch(e=>this.log('skill_acquirer_error',{error:safe(e)})),every);this.timer.unref?.();this.log('skill_acquirer_started',{intervalMs:every,mode:'free_sandbox_only'});}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  async tick(){if(this.running||!enabled(this.env.AUTONOMOS_SKILL_ACQUISITION_MODE,'true'))return;this.running=true;try{
    const gaps=this.collectGaps(),state=readJson(this.file,{workflows:{},events:[]});let tested=0;
    for(const gap of gaps.slice(0,Math.max(1,Math.min(4,Number(this.env.AUTONOMOS_SKILL_TESTS_PER_CYCLE||2))))){const key=normalizeGap(gap),plan=ACQUIRABLE[key]||fallbackPlan(key);if(!plan)continue;const prior=state.workflows[key]||{};if(prior.verified&&Date.now()-Date.parse(prior.verifiedAt||0)<7*24*60*60_000)continue;
      let verification={ok:false,reason:'no_safe_probe_available'};
      if(plan.probe&&this.env.E2B_API_KEY){tested++;verification=await e2bRunShell({command:plan.probe},this.env);}
      else if(key==='deploy')verification={ok:Boolean(this.env.COMPOSIO_API_KEY),reason:this.env.COMPOSIO_API_KEY?'composio_connected':'composio_missing'};
      else if(key==='artifact_storage')verification={ok:Boolean(((this.env.S3_ENDPOINT||this.env.R2_ENDPOINT)&&(this.env.S3_BUCKET||this.env.R2_BUCKET))||this.env.COMPOSIO_API_KEY),reason:'existing_artifact_or_drive_route'};
      else if(key==='github_pr')verification={ok:Boolean(this.env.GITHUB_TOKEN),reason:'github_token_present'};
      else if(key==='connected_app_gateway')verification={ok:Boolean(this.env.COMPOSIO_API_KEY),reason:'composio_connected'};
      state.workflows[key]={gap:key,workflow:plan.workflow,verified:Boolean(verification.ok),verifiedAt:verification.ok?new Date().toISOString():'',lastTestAt:new Date().toISOString(),lastError:verification.ok?'':String(verification.error||verification.reason||'probe_failed').slice(0,240),proof:verification.ok?String(verification.stdout||verification.result||verification.reason||'verified').slice(0,600):'',policy:'free_or_hard_capped_only',sandboxOnly:true};this.log(verification.ok?'skill_workflow_verified':'skill_workflow_probe_failed',{gap:key,workflow:plan.workflow,error:state.workflows[key].lastError});
    }
    state.updatedAt=new Date().toISOString();state.gapsObserved=gaps;state.events=[{at:new Date().toISOString(),gaps:gaps.length,tested,verified:Object.values(state.workflows).filter(x=>x.verified).length},...(state.events||[])].slice(0,100);writeJson(this.file,state);this.mergeLibrary(state);
  }finally{this.running=false;}}
  collectGaps(){const out=[];for(const file of ['global-lead-actioner.json','taskforce-worker.json','agrenting-worker.json','agrenting-live-worker.json'])collectMissing(readJson(path.join(this.root,file),{}),out);const runtime=readJson(path.join(this.root,'runtime-state.json'),{});collectMissing(runtime,out);return[...new Set(out.map(normalizeGap).filter(Boolean))].filter(x=>!/^human_identity|physical_world|signed_onchain|external_procurement/.test(x));}
  mergeLibrary(state){const lib=readJson(this.libraryFile,{skills:{},history:[]});lib.acquiredWorkflows={...(lib.acquiredWorkflows||{}),...state.workflows};lib.history=[{at:new Date().toISOString(),type:'skill_acquisition_refresh',verified:Object.values(state.workflows).filter(x=>x.verified).length},...(lib.history||[])].slice(0,100);writeJson(this.libraryFile,lib);}
  log(type,detail={}){try{this.logger.info?.('[SkillAcquirer] '+JSON.stringify({at:new Date().toISOString(),type,...detail}));}catch{}}
}
function collectMissing(value,out){if(!value||typeof value!=='object')return;if(Array.isArray(value)){for(const x of value)collectMissing(x,out);return;}for(const [k,v] of Object.entries(value)){if(k==='missingTools'&&Array.isArray(v))for(const x of v)out.push(String(x));if(k==='missingTools'&&v&&typeof v==='object'&&!Array.isArray(v))for(const x of Object.keys(v))out.push(String(x));collectMissing(v,out);}}
function normalizeGap(v){return String(v||'').toLowerCase().trim().replace(/^connected_app:.+$/,'connected_app_gateway');}
function fallbackPlan(key){if(!key)return null;if(/browser/.test(key))return ACQUIRABLE.browser;if(/search|research/.test(key))return ACQUIRABLE.web_search;if(/design|media|image|video|audio/.test(key))return ACQUIRABLE.design_media_tool;if(/deploy/.test(key))return ACQUIRABLE.deploy;if(/artifact|file/.test(key))return ACQUIRABLE.artifact_storage;if(/shell|sandbox/.test(key))return ACQUIRABLE.sandbox_shell;if(/github|pull_request|\bpr\b/.test(key))return ACQUIRABLE.github_pr;if(/app|gmail|sheet|drive|slack|notion/.test(key))return ACQUIRABLE.connected_app_gateway;return null;}
function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return structuredClone(fallback);}}
function writeJson(file,value){const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);}
function enabled(v,f='false'){return !/^(0|false|no|off)$/i.test(String(v??f));}
function safe(error){return String(error?.message||error||'').slice(0,240);}
