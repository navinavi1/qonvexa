import fs from 'node:fs';
import path from 'node:path';

const ROOT=process.cwd();
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
const write=(p,s)=>{fs.mkdirSync(path.dirname(path.join(ROOT,p)),{recursive:true});fs.writeFileSync(path.join(ROOT,p),s)};
const exists=p=>fs.existsSync(path.join(ROOT,p));
const remove=p=>{if(exists(p))fs.rmSync(path.join(ROOT,p),{recursive:true,force:true});};
function edit(p,fn){const before=read(p);const after=fn(before);if(after===before)console.log('[cleanup] no-op',p);else{write(p,after);console.log('[cleanup] updated',p);}return after;}
function removeBetween(s,start,end,{keepEnd=true}={}){const a=s.indexOf(start);if(a<0)return s;const b=s.indexOf(end,a+start.length);if(b<0)throw new Error(`end marker not found for ${start}`);return s.slice(0,a)+s.slice(keepEnd?b:b+end.length);}
function findMatchingBrace(s,open){let depth=0,state='normal';for(let i=open;i<s.length;i++){const c=s[i],n=s[i+1];if(state==='line'){if(c==='\n')state='normal';continue;}if(state==='block'){if(c==='*'&&n==='/'){state='normal';i++;}continue;}if(state==='single'){if(c==='\\'){i++;continue;}if(c==="'")state='normal';continue;}if(state==='double'){if(c==='\\'){i++;continue;}if(c==='"')state='normal';continue;}if(state==='template'){if(c==='\\'){i++;continue;}if(c==='`')state='normal';continue;}if(c==='/'&&n==='/'){state='line';i++;continue;}if(c==='/'&&n==='*'){state='block';i++;continue;}if(c==="'"){state='single';continue;}if(c==='"'){state='double';continue;}if(c==='`'){state='template';continue;}if(c==='{')depth++;else if(c==='}'){depth--;if(depth===0)return i;}}throw new Error('unbalanced brace');}
function removeBlockAtMarker(s,marker){const start=s.indexOf(marker);if(start<0)return s;const open=s.indexOf('{',start);if(open<0)throw new Error(`open brace missing for ${marker}`);const close=findMatchingBrace(s,open);let end=close+1;while(/[ \t]/.test(s[end]||''))end++;if(s[end]===',')end++;if(s[end]==='\r')end++;if(s[end]==='\n')end++;return s.slice(0,start)+s.slice(end);}
function removeNamedFunction(s,name){const re=new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);const m=re.exec(s);if(!m)return s;const start=m.index;const open=s.indexOf('{',start);const close=findMatchingBrace(s,open);let end=close+1;while(/[ \t]/.test(s[end]||''))end++;if(s[end]==='\r')end++;if(s[end]==='\n')end++;return s.slice(0,start)+s.slice(end);}
function removeObjectMethod(s,name){const re=new RegExp(`^[ \\t]*(?:async\\s+)?${name}\\s*\\(`,'m');const m=re.exec(s);if(!m)return s;const start=m.index;const open=s.indexOf('{',start);const close=findMatchingBrace(s,open);let end=close+1;while(/[ \t]/.test(s[end]||''))end++;if(s[end]===',')end++;if(s[end]==='\r')end++;if(s[end]==='\n')end++;return s.slice(0,start)+s.slice(end);}
function stripCommentLinesWith(s,tokens){return s.split('\n').filter(line=>{const t=line.trim();return !(t.startsWith('//')||t.startsWith('*')||t.startsWith('/*'))||!tokens.some(x=>line.toLowerCase().includes(x));}).join('\n');}

const retired=['t2000','superteam','clawjobs','laborx','dework','bountycaster','questbook','moltjobs','virtuals-acp','olas-mech','nevermined','openserv'];
const retiredTokens=['t2000','superteam','clawjobs','laborx','dework','bountycaster','questbook','moltjobs','virtuals','olas','nevermined','openserv'];

for(const name of fs.readdirSync(ROOT)){
  if(/^(AUTONOMOS-(?:1\.0|2\.0|3\.0|4\.0|4\.1|7\.|CHANGED|DEPLOY|DYNAMIC)|PRODUCTION-|QONVEXA-(?:8\.|9\.|11\.|PRODUCTION|REDESIGN)|RENDER-7\.|SESSION-AUDIT|YOUR-ACTION|FINAL-LAUNCH|GITHUB-RENDER|LAUNCH-REPORT)/i.test(name))remove(name);
}

write('src/autonomos/free-web-tool.js',`const sleep=ms=>new Promise(r=>setTimeout(r,ms));\nlet lastSearchAt=0;\nfunction cleanText(v=''){return String(v).replace(/<script[\\s\\S]*?<\\/script>/gi,' ').replace(/<style[\\s\\S]*?<\\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\\s+/g,' ').trim();}\nfunction decodeDuckUrl(href=''){try{const u=new URL(href,'https://html.duckduckgo.com');const raw=u.searchParams.get('uddg');return raw?decodeURIComponent(raw):u.href;}catch{return String(href||'');}}\nexport async function freeWebSearch(query,env=process.env,signal){const q=String(query||'').trim().slice(0,400);if(!q)return{ok:false,error:'empty_query'};const minGap=Math.max(1200,Number(env.AUTONOMOS_FREE_SEARCH_MIN_GAP_MS||2200));const wait=Math.max(0,lastSearchAt+minGap-Date.now());if(wait)await sleep(wait);lastSearchAt=Date.now();try{const r=await fetch('https://html.duckduckgo.com/html/?q='+encodeURIComponent(q),{headers:{'user-agent':'Mozilla/5.0 (compatible; AutonomOS/15.0; +https://qonvexa.co)'},signal:signal||AbortSignal.timeout(18000)});if(!r.ok)return{ok:false,error:'http_'+r.status,results:[]};const html=await r.text();const out=[];const re=/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>/gi;let m;while((m=re.exec(html))&&out.length<8){const url=decodeDuckUrl(m[1]);if(!/^https?:\\/\\//i.test(url))continue;out.push({title:cleanText(m[2]).slice(0,220),url,snippet:''});}return{ok:true,provider:'free_public_web',results:out};}catch(e){return{ok:false,error:String(e?.message||e).slice(0,180),results:[]};}}\nexport async function freeWebScrape(url,env=process.env,signal){const target=String(url||'').trim();if(!/^https?:\\/\\//i.test(target))return{ok:false,error:'invalid_url'};try{const r=await fetch(target,{headers:{'user-agent':'Mozilla/5.0 (compatible; AutonomOS/15.0; +https://qonvexa.co)'},redirect:'follow',signal:signal||AbortSignal.timeout(18000)});if(!r.ok)return{ok:false,error:'http_'+r.status};const body=await r.text();return{ok:true,url:r.url,content:cleanText(body).slice(0,12000)};}catch(e){return{ok:false,error:String(e?.message||e).slice(0,180)};}}\n`);

edit('src/autonomos/tools.js',s=>{
  s=s.replace("import { browserTask } from './browser-tool.js';\n",'');
  s=s.replace("import { tavilySearch } from './tavily-tool.js';\n","import { freeWebSearch, freeWebScrape } from './free-web-tool.js';\n");
  s=s.replace(/\s*web_search: Number\([^\n]+\),/,'\n  web_search: 0,');
  s=s.replace(/\s*web_scrape: Number\([^\n]+\),/,'\n  web_scrape: 0,');
  s=s.replace(/\s*browser_task: Number\([^\n]+\),/,'');
  s=s.replace(/\n\s*\{type:'function',function:\{name:'browser_task'[^\n]+\}\},?/,'');
  s=s.replace("  else if (name === 'browser_task') result = await browserTask(args, env, signal);\n",'');
  s=s.replace(/result = await tavilySearch\(([^;]+)\);/g,'result = await freeWebSearch($1);');
  s=s.replace("result = await firecrawlScrape(args?.url, env, signal);","result = await freeWebScrape(args?.url, env, signal);");
  s=s.replace("result = await firecrawlSearch(args?.query, env, signal);","result = await freeWebSearch(args?.query, env, signal);");
  const a=s.indexOf('export async function firecrawlSearch');const b=s.indexOf('export async function e2bRunPython');if(a>=0&&b>a)s=s.slice(0,a)+s.slice(b);
  return s;
});
edit('src/autonomos/search-first-lead-actioner.js',s=>s.replace("import { tavilySearch } from './tavily-tool.js';","import { freeWebSearch } from './free-web-tool.js';").replace(/tavilySearch\(/g,'freeWebSearch('));
remove('src/autonomos/browser-tool.js');remove('src/autonomos/tavily-tool.js');

write('src/autonomos/infrastructure.js',`import { ArtifactStore } from './artifact-store.js';\nconst COMPONENTS=[\n{id:'openai_agents',name:'OpenAI Agents SDK',keys:['OPENAI_API_KEY']},\n{id:'langgraph',name:'LangGraph checkpointing',keys:['DATABASE_URL']},\n{id:'memory',name:'Postgres + pgvector',keys:['DATABASE_URL']},\n{id:'redis',name:'Redis cache / locks',keys:['REDIS_URL']},\n{id:'redis_streams',name:'Redis Streams event bus',keys:['REDIS_URL']},\n{id:'triggerdev',name:'Trigger.dev durable jobs',keys:['TRIGGER_SECRET_KEY']},\n{id:'composio',name:'Composio app/tool gateway',keys:['COMPOSIO_API_KEY']},\n{id:'s3',name:'S3-compatible artifacts',keys:['S3_ENDPOINT','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY']},\n{id:'langfuse',name:'Langfuse tracing',keys:['LANGFUSE_PUBLIC_KEY','LANGFUSE_SECRET_KEY','LANGFUSE_BASE_URL'],optional:true},\n{id:'e2b',name:'E2B code execution',keys:['E2B_API_KEY']}\n];\nexport function infrastructureStatus(env=process.env){env=new ArtifactStore({env}).env;return COMPONENTS.map(component=>{const missing=component.keys.filter(k=>!String(env[k]||'').trim());const configured=missing.length===0;return{id:component.id,name:component.name,configured,optional:Boolean(component.optional),status:configured?'ready':component.optional?'optional_not_configured':'needs_configuration',missing};});}\nexport function infrastructureReady(id,env=process.env){return infrastructureStatus(env).find(x=>x.id===id)?.configured||false;}\n`);

edit('src/autonomos/runtime.js',s=>{
  s=s.replace("import { createT2000OAuth } from './t2000-oauth.js';\n",'');
  s=s.replace(/,\s*verifySuperteamEligibility\n?/, '\n');
  s=s.replace("  const sources=new Set(['t2000','clawlancer','workprotocol']);","  const sources=new Set(['clawlancer','workprotocol']);");
  s=removeBlockAtMarker(s,"  if(source==='t2000'){");
  s=s.replace(/\n\s*const t2000OAuth = createT2000OAuth\([^\n]+\);/,'');
  s=s.replace(/\n\s*t2000:\{\.\.\.t2000OAuth\.status\(\),[^\n]+\},/,'');
  s=s.replace(/'superteamMinJobPayoutUsd','t2000MinOpenJobPayoutUsd','t2000PriorityOpenJobPayoutUsd','t2000PremiumOpenJobPayoutUsd',?/g,'');
  s=s.replace(/\s*await syncT2000Credential\(\)\.catch\(\(\)=>\{\}\);/g,'');
  s=s.replace(/\s*await syncT2000Credential\(\{required:true\}\);/g,'');
  s=s.replace(/\s*updateT2000QualificationHealth\([^;]+\);/g,'');
  for(const name of ['t2000ClientMetadata','beginT2000Connect','finishT2000Connect','refreshT2000Jobs','disconnectT2000'])s=removeObjectMethod(s,name);
  for(const name of ['syncT2000Credential','updateT2000QualificationHealth'])s=removeNamedFunction(s,name);
  s=s.replace(/\['clawlancer','dealwork','t2000','workprotocol','moltjobs','superteam','clawjobs'\]/g,"['clawlancer','dealwork','workprotocol']");
  s=s.replace(/\['clawlancer','t2000','workprotocol'\]/g,"['clawlancer','workprotocol']");
  s=s.replace(/\['clawlancer','t2000','dealwork','workprotocol'\]/g,"['clawlancer','dealwork','workprotocol']");
  s=s.replace(/\['clawlancer','t2000','dealwork','workprotocol','superteam','clawjobs','moltjobs','agenthansa','taskbounty'\]/g,"['clawlancer','dealwork','workprotocol','agenthansa','taskbounty']");
  s=s.replace(/\['clawlancer','dealwork','t2000','workprotocol','moltjobs','superteam','clawjobs','laborx','dework','bountycaster','questbook'\]/g,"['clawlancer','dealwork','workprotocol']");
  s=s.replace(/return \['clawlancer','t2000','dealwork','workprotocol','superteam'\]\.includes\(source\);/g,"return ['clawlancer','dealwork','workprotocol'].includes(source);");
  s=s.replace(/\|\| \['t2000','clawlancer','workprotocol','moltjobs','superteam','clawjobs'\]\.includes\(String\(op\.source\|\|''\)\)/g,"|| ['clawlancer','workprotocol'].includes(String(op.source||''))");
  s=s.replace(/\s*t2000:\{[^\n]+\},?/g,'');
  s=s.replace(/\s*superteam:\{[^\n]+\},?/g,'');
  s=s.replace(/\s*clawjobs:\{[^\n]+\},?/g,'');
  s=s.replace(/\s*moltjobs:\{[^\n]+\},?/g,'');
  s=removeBlockAtMarker(s,"    }else if(id==='t2000'){");
  s=s.replace(/\s*else if\(id==='superteam'\)\{[^\n]+\}/g,'');
  s=s.replace(/\s*if\(op\?\.source==='t2000'\)return[^\n]+\n/g,'');
  s=s.replace("    return ['t2000','dealwork'].includes(String(op.source||''))&&String(op.claimMode||'')==='already_assigned';","    return String(op.source||'')==='dealwork'&&String(op.claimMode||'')==='already_assigned';");
  s=s.replace(/\n\s*let t2000TierBonus=0;[\s\S]*?return t2000TierBonus\+Number\(op\.economics\?\.expectedProfitUsd\|\|0\)\*Math\.max\(0\.05,Number\(op\.outcome\?\.probability\|\|0\.05\)\);/m,"\n    return Number(op.economics?.expectedProfitUsd||0)*Math.max(0.05,Number(op.outcome?.probability||0.05));");
  s=s.replace(/\(op\.source==='t2000'&&claim\.workOrderMissing\)\|\|/g,'');
  s=s.replace(/t2000_work_order_unavailable_refusing_blind_delivery/g,'work_order_unavailable_refusing_blind_delivery');
  s=s.replace(/\|t2000_open_job_below_floor/g,'');
  s=s.replace(/\['t2000','workprotocol','moltjobs'\]/g,"['workprotocol']");
  s=s.replace(/if\(source==='superteam'\)return\['human_crypto_claim'\];/g,'');
  s=s.replace(/if\(source==='clawjobs'\)return\[\];/g,'');
  s=removeBlockAtMarker(s,"      if(op.source==='superteam'){");
  s=stripCommentLinesWith(s,retiredTokens);
  return s;
});

edit('src/autonomos/connectors/index.js',s=>{
  s=s.replace("const T2000_DEFAULT_MCP_URL = 'https://mcp.t2000.ai/mcp';\n\n",'');
  for(const token of retired){const re=new RegExp(`^.*\\{ id:'${token.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')}'[^\\n]*\\n`,'m');s=s.replace(re,'');}
  for(const marker of ["    if (def.id === 'superteam') {","    if (def.id === 't2000') {","    if (def.id === 'moltjobs') {","    if (def.id === 'clawjobs') {"])s=removeBlockAtMarker(s,marker);
  s=s.replace(/\n\s*const feedEnv=\{laborx:[\s\S]*?\n\s*if\(feedEnv\)\{[\s\S]*?\n\s*\}/m,'');
  s=s.replace(/^\s*\['(?:t2000|moltjobs|superteam|clawjobs|laborx|dework|bountycaster|questbook)'[^\n]*\n/gm,'');
  s=s.replace(/^\s*if \(opportunity\.source==='(?:t2000|superteam)'\)[^\n]*\n/gm,'');
  const walletStart=s.indexOf('  const tToken=t2000Token(env,credentials);');if(walletStart>=0){const ret=s.indexOf('  return out;',walletStart);if(ret<0)throw new Error('wallet return not found');s=s.slice(0,walletStart)+s.slice(ret);}
  for(const name of ['discoverT2000','t2000Action','t2000Token','t2000Amount','discoverMoltJobs','discoverSuperteam','superteamAction','discoverClawJobs','discoverConfiguredFeed','verifySuperteamEligibility'])s=removeNamedFunction(s,name);
  const settle=s.indexOf('  // t2000 settlement sync');if(settle>=0){const ret=s.indexOf('  return {transactions:rows,health};',settle);if(ret<0)throw new Error('settlement return not found');s=s.slice(0,settle)+s.slice(ret);}
  s=stripCommentLinesWith(s,retiredTokens);
  return s;
});

edit('server.js',s=>{
  s=removeBetween(s,'// Public OAuth Client ID Metadata Document used by MCP authorization servers that',"app.use('/api/admin'", {keepEnd:true});
  s=removeBetween(s,"app.post('/api/admin/autonomos/t2000/connect'","app.get('/api/admin/autonomos/product-preview/:productId'",{keepEnd:true});
  return stripCommentLinesWith(s,retiredTokens);
});

edit('public/admin.html',s=>{
  s=s.replace(/\s*<link rel="stylesheet" href="marketplaces\.css">\s*/,'\n');
  s=s.replace(/\s*<section aria-label="AgentHansa and TaskBounty">[\s\S]*?<\/section>\s*/,'\n');
  s=s.replace(/\s*<section class="admin-panel autonomos-panel autonomos-t2000-card">[\s\S]*?<\/section>\s*/,'\n');
  s=s.replace(/\s*<script src="marketplaces\.js" defer><\/script>\s*/,'\n  <script src="marketplaces.js?v=clean15" defer></script>\n');
  return s;
});
edit('public/admin.js',s=>{
  const a=s.indexOf('  const t=a.t2000||{};');const b=s.indexOf("  const radar=el('#autonomos-market-radar');",a);if(a>=0&&b>a)s=s.slice(0,a)+s.slice(b);
  s=s.replace(/Object\.entries\(health\)\.map\(/g,"Object.entries(health).filter(([name])=>!['t2000','superteam','clawjobs','laborx','dework','bountycaster','questbook','moltjobs','virtuals-acp','olas-mech','nevermined','openserv','firecrawl'].includes(String(name))).map(");
  s=s.replace(/\['clawlancer','dealwork','t2000','superteam','clawjobs','laborx','dework','bountycaster','questbook'\]/g,"['clawlancer','dealwork','workprotocol','agenthansa','taskbounty']");
  const c=s.indexOf("el('#autonomos-t2000-connect')?.addEventListener");const d=s.indexOf("el('#autonomos-config-form')?.addEventListener",c);if(c>=0&&d>c)s=s.slice(0,c)+s.slice(d);
  s=s.replace(/,'superteamMinJobPayoutUsd','t2000MinOpenJobPayoutUsd','t2000PriorityOpenJobPayoutUsd','t2000PremiumOpenJobPayoutUsd'/g,'');
  s=s.replace(/const params=new URLSearchParams\(location\.search\);const tResult=[^;]+;const tStatus=[^;]+;[\s\S]*?if\(tResult\)history\.replaceState\([^\n]+\n/g,'');
  return stripCommentLinesWith(s,retiredTokens);
});
remove('public/marketplaces.css');
edit('public/marketplaces.js',s=>{
  s=s.replace(/const LEGACY_SOURCES=new Set\([^\n]+\);/,"const LEGACY_SOURCES=new Set([]);");
  s=s.replace(/function isLegacy\(row\)\{[^\n]+\}/,"function isLegacy(){return false;}");
  s=s.replace(/\s*document\.querySelector\('\.autonomos-t2000-card'\)\?\.remove\(\);/g,'');
  return stripCommentLinesWith(s,retiredTokens);
});

edit('package.json',s=>{
  const p=JSON.parse(s);delete p.dependencies['@browserbasehq/stagehand'];
  for(const k of Object.keys(p.scripts||{}))if(/t2000|network-guard/i.test(k))delete p.scripts[k];
  for(const [k,v] of Object.entries(p.scripts||{}))p.scripts[k]=String(v).replace(/\s*&&\s*npm run (?:t2000-(?:oauth|legacy-token|connector)-test|network-guard-test)/g,'');
  if(p.scripts?.check)p.scripts.check=p.scripts.check.replace(/\s*&&\s*node --check src\/autonomos\/(?:network-guard|source-quarantine)\.js/g,'').replace(/\s*&&\s*node --check src\/autonomos\/tavily-tool\.js/g,'');
  return JSON.stringify(p,null,2)+'\n';
});
for(const f of ['scripts/t2000-connector-test.mjs','scripts/t2000-legacy-token-test.mjs','scripts/t2000-oauth-test.mjs','src/autonomos/t2000-oauth.js'])remove(f);

const obsoleteEnv=/^(T2000_|SUPERTEAM_|CLAWJOBS_|LABORX_|DEWORK_|BOUNTYCASTER_|QUESTBOOK_|MOLTJOBS_|VIRTUALS_ACP_|OLAS_MECH_|NVM_|OPENSERV_|FIRECRAWL_|TAVILY_|BROWSERBASE_|OPENSEARCH_|AUTH0_|AUTONOMOS_AWS_SECRET_ID$|AWS_REGION$)/;
for(const file of ['.env.example','.env.production.example'])if(exists(file))edit(file,s=>s.split('\n').filter(line=>!obsoleteEnv.test(line.trim().split('=')[0]||'')).join('\n'));
edit('render.yaml',s=>{const lines=s.split('\n'),out=[];for(let i=0;i<lines.length;i++){const m=lines[i].match(/^\s*- key:\s*([A-Z0-9_]+)/);if(m&&obsoleteEnv.test(m[1])){while(i+1<lines.length&&!/^\s*- key:/.test(lines[i+1])&&!/^\S/.test(lines[i+1]))i++;continue;}out.push(lines[i]);}return out.join('\n');});

write('src/autonomos/legacy-state-cleaner.js',`import fs from 'node:fs';import path from 'node:path';\nconst ACTIVE_MARKETS=new Set(['dealwork','clawlancer','workprotocol','agenthansa','taskbounty','x402-bazaar','agrenting']);\nconst GENERIC_GLOBAL_PREFIXES=['webwork_','jobicy_','remoteok_','weworkremotely_','remotive_','taskforce_'];\nfunction readJson(p,f={}){try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return f}}function writeJson(p,v){fs.writeFileSync(p,JSON.stringify(v,null,2))}function sourceOf(row,key=''){return String(row?.source||row?.op?.source||key.split(':')[0]||'').toLowerCase()}function shouldKeepSource(s,key=''){if(!s)return true;if(ACTIVE_MARKETS.has(s))return true;if(GENERIC_GLOBAL_PREFIXES.some(p=>String(key).startsWith(p)))return true;return !/^(?:market|agent|task|claw|work|deal|super|molt|olas|virtual|quest|labor|dework|bounty|open)/.test(s);}\nexport function cleanLegacyState({storageDir=process.env.STORAGE_DIR,logger=console}={}){const root=path.join(storageDir||'data','autonomos');if(!fs.existsSync(root))return{ok:true,skipped:true};const summary={registry:0,inFlight:0,credentials:0};const registryPath=path.join(root,'job-registry.json'),registry=readJson(registryPath,{});for(const [k,v] of Object.entries(registry))if(!shouldKeepSource(sourceOf(v,k),k)){delete registry[k];summary.registry++;}writeJson(registryPath,registry);const inPath=path.join(root,'in-flight-jobs.json'),inflight=readJson(inPath,{});for(const [k,v] of Object.entries(inflight))if(!shouldKeepSource(sourceOf(v,k),k)){delete inflight[k];summary.inFlight++;}writeJson(inPath,inflight);const cPath=path.join(root,'credentials.private.json'),cred=readJson(cPath,{});for(const k of Object.keys(cred))if(!ACTIVE_MARKETS.has(String(k).toLowerCase())&&!['gmail','github'].includes(String(k).toLowerCase())){delete cred[k];summary.credentials++;}writeJson(cPath,cred);try{logger.info?.('[LegacyStateCleaner] '+JSON.stringify(summary));}catch{}return{ok:true,...summary};}\n`);

console.log('[cleanup] mega cleanup transform complete');
