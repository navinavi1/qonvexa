import { recoverFreeCapability } from './free-tool-recovery.js';
import { refreshCapabilities, unifiedCapabilityContext } from './capability-registry.js';
import fs from 'node:fs';
import path from 'node:path';
import { e2bRunShell } from './tools.js';

const CORE_AI_SKILLS=Object.freeze({
  advanced_reasoning:{level:'core',workflow:'llm_plan_reason_verify',requires:['llm'],description:'Decompose ambiguous work, compare approaches, reason through constraints, verify assumptions, and produce an executable plan.'},
  software_engineering:{level:'expert',workflow:'llm_code_test_repair',requires:['llm','sandbox_shell'],description:'Implement, debug, refactor, test, review, and repair software with repository-aware QA.'},
  data_analysis:{level:'expert',workflow:'llm_python_analysis',requires:['llm','sandbox_shell'],description:'Clean, transform, analyze, summarize, and validate structured or semi-structured data using Python and reproducible checks.'},
  deep_research:{level:'expert',workflow:'research_source_compare_synthesize',requires:['llm','web_search'],description:'Research across multiple public sources, compare evidence, extract facts, detect conflicts, and synthesize concise findings.'},
  document_intelligence:{level:'expert',workflow:'llm_document_extract_transform_qa',requires:['llm','artifact_storage'],description:'Read, summarize, structure, transform, and create professional documents and deliverables with QA.'},
  multilingual_translation:{level:'expert',workflow:'llm_translate_localize_qa',requires:['llm'],description:'Translate and localize while preserving meaning, formatting, terminology, tone, and domain context.'},
  proposal_and_client_comms:{level:'expert',workflow:'llm_job_fit_proposal_reply',requires:['llm','connected_app_gateway'],description:'Analyze a job, identify fit, draft concise tailored proposals, clarify requirements, and maintain professional client communication.'},
  workflow_automation:{level:'expert',workflow:'plan_tool_execute_verify',requires:['llm','connected_app_gateway'],description:'Turn goals into multi-step workflows across connected apps, execute safe actions, and verify completion.'},
  qa_and_critique:{level:'expert',workflow:'independent_qa_repair',requires:['llm'],description:'Independently inspect outputs against acceptance criteria, find defects, request bounded repairs, and reject weak deliverables.'},
  agent_orchestration:{level:'expert',workflow:'planner_specialist_qa_handoff',requires:['llm'],description:'Spawn job-specific specialist roles, coordinate handoffs, consolidate outputs, and retire temporary agents when work is complete.'},
  memory_and_learning:{level:'expert',workflow:'outcome_memory_strategy_update',requires:['llm','artifact_storage'],description:'Store reusable lessons from completed work, failures, market outcomes, and verified workflows, then adapt future strategy.'},
  market_discovery:{level:'expert',workflow:'global_market_expand_rank',requires:['llm','web_search'],description:'Discover new work markets, APIs, job channels, and public application paths; rank them by live work, payout, and automation readiness.'},
  payout_route_intelligence:{level:'expert',workflow:'fiat_crypto_route_plan_only',requires:['llm'],description:'Plan compliant payout and fiat-to-crypto routes without initiating transfers, trades, or signing wallet transactions.'}
});

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
import { readJson, writeJson } from './util.js';
ff=bool(shutil.which('ffmpeg') or shutil.which('convert') or shutil.which('magick'))
pil=bool(importlib.util.find_spec('PIL'))
print('ffmpeg_or_imagemagick',ff); print('pillow',pil)
sys.exit(0 if ff or pil else 2)
PY`},
  deploy:{workflow:'composio_vercel_netlify',probe:null},artifact_storage:{workflow:'r2_or_google_drive',probe:null},sandbox_shell:{workflow:'e2b_shell',probe:'node --version && python --version'},github_pr:{workflow:'github_contents_pr',probe:null},connected_app_gateway:{workflow:'composio_free_apps',probe:null}
});

export class AdaptiveSkillAcquirer{
  constructor({env=process.env,storageDir='',logger=console}={}){this.env=env;this.logger=logger;this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');fs.mkdirSync(this.root,{recursive:true});this.file=path.join(this.root,'skill-acquisition.json');this.libraryFile=path.join(this.root,'adaptive-skill-library.json');this.timer=null;this.running=false;}
  start(){if(this.timer)return;const every=Math.max(60_000,Math.min(5*60_000,Number(this.env.AUTONOMOS_SKILL_ACQUIRER_MS||60_000)));setTimeout(()=>this.tick().catch(e=>this.log('skill_acquirer_error',{error:safe(e)})),5_000).unref?.();this.timer=setInterval(()=>this.tick().catch(e=>this.log('skill_acquirer_error',{error:safe(e)})),every);this.timer.unref?.();this.log('skill_acquirer_started',{intervalMs:every,mode:'free_sandbox_only',coreAiSkills:Object.keys(CORE_AI_SKILLS).length});}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  async tick(){if(this.running||!enabled(this.env.AUTONOMOS_SKILL_ACQUISITION_MODE,'true'))return;this.running=true;try{
    await refreshCapabilities(this.env);const caps=unifiedCapabilityContext(this.env);const gaps=this.collectGaps().filter(gap=>gap!=='browser'||!caps.hasBrowserTool);if(!caps.hasBrowserTool&&!gaps.includes('browser'))gaps.unshift('browser');const state=readJson(this.file,{workflows:{},events:[]});let tested=0;
    const checked=gap=>Date.parse(state.workflows[gap]?.lastTestAt||0)||0;gaps.sort((a,b)=>(a==='browser'?-1:b==='browser'?1:checked(a)-checked(b)));
    for(const gap of gaps.slice(0,Math.max(1,Math.min(4,Number(this.env.AUTONOMOS_SKILL_TESTS_PER_CYCLE||2))))){const key=normalizeGap(gap),plan=ACQUIRABLE[key]||fallbackPlan(key);if(!plan)continue;const prior=state.workflows[key]||{};if(prior.verified&&Date.now()-Date.parse(prior.verifiedAt||0)<5*60_000)continue;
      tested++;const verification=await recoverFreeCapability(key,this.env);
      state.workflows[key]={gap:key,workflow:plan.workflow,verified:Boolean(verification.ok),verifiedAt:verification.ok?new Date().toISOString():'',lastTestAt:new Date().toISOString(),lastError:verification.ok?'':String(verification.error||verification.reason||'probe_failed').slice(0,240),proof:verification.ok?String(verification.details||verification.stdout||verification.result||verification.reason||'verified').slice(0,600):'',policy:'free_or_hard_capped_only',sandboxOnly:true};this.log(verification.ok?'skill_workflow_verified':'skill_workflow_probe_failed',{gap:key,workflow:plan.workflow,error:state.workflows[key].lastError,proof:verification.ok?state.workflows[key].proof:''});
    }
    state.updatedAt=new Date().toISOString();state.gapsObserved=gaps;state.events=[{at:new Date().toISOString(),gaps:gaps.length,tested,verified:Object.values(state.workflows).filter(x=>x.verified).length},...(state.events||[])].slice(0,100);writeJson(this.file,state);this.mergeLibrary(state);
  }finally{this.running=false;}}
  collectGaps(){const out=[];for(const file of ['global-lead-actioner.json','taskforce-worker.json','agrenting-worker.json','agrenting-live-worker.json','state.json','job-registry.json'])collectMissing(readJson(path.join(this.root,file),{}),out);const runtime=readJson(path.join(this.root,'runtime-state.json'),{});collectMissing(runtime,out);return[...new Set(out.map(normalizeGap).filter(Boolean))].filter(x=>!/^human_identity|physical_world|signed_onchain|external_procurement/.test(x));}
  mergeLibrary(state){const lib=readJson(this.libraryFile,{skills:{},history:[]});lib.coreAiSkills={...(lib.coreAiSkills||{}),...CORE_AI_SKILLS};lib.acquiredWorkflows={...(lib.acquiredWorkflows||{}),...state.workflows};lib.policy={...(lib.policy||{}),ownerControl:true,freeOrHardCappedOnly:true,noAutonomousFinancialTransfers:true,noPrivateKeyUse:true,qaRequired:true};lib.history=[{at:new Date().toISOString(),type:'skill_acquisition_refresh',verified:Object.values(state.workflows).filter(x=>x.verified).length,coreAiSkills:Object.keys(CORE_AI_SKILLS).length},...(lib.history||[])].slice(0,100);writeJson(this.libraryFile,lib);}
  log(type,detail={}){try{this.logger.info?.('[SkillAcquirer] '+JSON.stringify({at:new Date().toISOString(),type,...detail}));}catch{}}
}
function collectMissing(value,out){if(!value||typeof value!=='object')return;if(Array.isArray(value)){for(const x of value)collectMissing(x,out);return;}for(const [k,v] of Object.entries(value)){if(k==='missingTools'&&Array.isArray(v))for(const x of v)out.push(String(x));if(k==='missingTools'&&v&&typeof v==='object'&&!Array.isArray(v))for(const x of Object.keys(v))out.push(String(x));collectMissing(v,out);}}
function normalizeGap(v){return String(v||'').toLowerCase().trim();}
function fallbackPlan(key){if(!key)return null;if(key.startsWith('connected_app:'))return ACQUIRABLE.connected_app_gateway;if(/browser/.test(key))return ACQUIRABLE.browser;if(/search|research/.test(key))return ACQUIRABLE.web_search;if(/design|media|image|video|audio/.test(key))return ACQUIRABLE.design_media_tool;if(/deploy/.test(key))return ACQUIRABLE.deploy;if(/artifact|file/.test(key))return ACQUIRABLE.artifact_storage;if(/shell|sandbox/.test(key))return ACQUIRABLE.sandbox_shell;if(/github|pull_request|\bpr\b/.test(key))return ACQUIRABLE.github_pr;if(/app|gmail|sheet|drive|slack|notion/.test(key))return ACQUIRABLE.connected_app_gateway;return null;}


function enabled(v,f='false'){return !/^(0|false|no|off)$/i.test(String(v??f));}
function safe(error){return String(error?.message||error||'').slice(0,240);}
