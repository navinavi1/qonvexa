import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const write=(p,s)=>{const full=path.join(root,p);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,s);};
const remove=p=>{try{fs.rmSync(path.join(root,p),{recursive:true,force:true});}catch{}};
const replace=(p,from,to)=>{let s=read(p);const before=s;if(from instanceof RegExp)s=s.replace(from,to);else s=s.split(from).join(to);if(s!==before)write(p,s);return s!==before;};
const stripLines=(p,re)=>{let s=read(p);s=s.split(/\r?\n/).filter(line=>!re.test(line)).join('\n')+'\n';write(p,s);};

// 1) Delete retired adapters, providers and workers completely.
for(const p of [
  'src/autonomos/tavily-tool.js',
  'src/autonomos/auth0.js',
  'src/autonomos/secret-provider.js',
  'src/autonomos/temporal-client.js',
  'src/autonomos/temporal',
  'scripts/autonomos-temporal-worker.mjs'
]) remove(p);

// 2) Keep WorkProtocol self-registration without the retired external-secret bundle.
write('src/autonomos/workprotocol-bootstrap.js',`import fs from 'node:fs';\nimport path from 'node:path';\n\nconst ORIGIN='https://workprotocol.ai';\nconst FILE='workprotocol-bootstrap.private.json';\n\nexport async function hydrateWorkProtocolRegistration(env=process.env,{logger=console,fetchFn=fetch}={}){\n  if(String(env.WORKPROTOCOL_API_KEY||'').trim()&&String(env.WORKPROTOCOL_AGENT_ID||'').trim())return{ok:true,configured:true,source:'environment',loaded:false};\n  const ownerWallet=String(env.AUTONOMOS_OWNER_WALLET||'').trim();\n  if(!/^0x[a-fA-F0-9]{40}$/.test(ownerWallet))return{ok:false,configured:false,reason:'workprotocol_owner_wallet_missing_or_invalid',loaded:false};\n  const storageDir=path.resolve(String(env.STORAGE_DIR||'data'));\n  const privateDir=path.join(storageDir,'autonomos');\n  const credentialFile=path.join(privateDir,FILE);\n  try{\n    const saved=readPrivateJson(credentialFile);\n    if(saved?.apiKey&&saved?.agentId){\n      if(saved.walletAddress&&String(saved.walletAddress).toLowerCase()!==ownerWallet.toLowerCase()){\n        logger.warn?.('WorkProtocol saved wallet differs from current owner wallet; credential not activated.');\n        return{ok:false,configured:false,reason:'workprotocol_saved_wallet_mismatch',loaded:false};\n      }\n      env.WORKPROTOCOL_API_KEY=String(saved.apiKey);\n      env.WORKPROTOCOL_AGENT_ID=String(saved.agentId);\n      return{ok:true,configured:true,source:'persistent_disk',loaded:true};\n    }\n  }catch(error){logger.warn?.('WorkProtocol credential read failed: '+String(error?.message||error).slice(0,180));}\n  try{\n    const response=await fetchFn(ORIGIN+'/api/agents/register',{method:'POST',headers:{'content-type':'application/json',accept:'application/json','user-agent':'AutonomOS/15.0'},body:JSON.stringify({name:String(env.AUTONOMOS_AGENT_NAME||'AutonomOS').slice(0,80),description:'Autonomous digital-services worker for code, data, research and verified deliverables.',walletAddress:ownerWallet,capabilities:{categories:['code','data','research','content'],languages:['typescript','javascript','python'],maxJobValue:1000},pricing:{minimumJobValue:Math.max(0.5,Number(env.AUTONOMOS_MIN_JOB_PAYOUT_USD||0.5)),acceptedCurrencies:['USDC']}}),signal:AbortSignal.timeout(15000)});\n    const body=await response.json().catch(()=>({}));\n    const agent=body?.agent||body?.data?.agent||body?.data||body;\n    const apiKey=String(agent?.apiKey||agent?.api_key||body?.apiKey||'').trim();\n    const agentId=String(agent?.id||agent?.agentId||agent?.agent_id||body?.agentId||'').trim();\n    if(!response.ok||!apiKey||!agentId){const reason='workprotocol_registration_'+(response.ok?'invalid_response':'http_'+response.status);logger.warn?.(reason+': '+String(body?.error||body?.message||'').slice(0,160));return{ok:false,configured:false,reason,loaded:false};}\n    fs.mkdirSync(privateDir,{recursive:true});writePrivateJson(credentialFile,{apiKey,agentId,walletAddress:ownerWallet,createdAt:new Date().toISOString(),source:'auto_registration'});\n    env.WORKPROTOCOL_API_KEY=apiKey;env.WORKPROTOCOL_AGENT_ID=agentId;\n    return{ok:true,configured:true,source:'auto_registration',registered:true,loaded:true};\n  }catch(error){const reason='workprotocol_registration_failed:'+String(error?.message||error).slice(0,180);logger.warn?.(reason);return{ok:false,configured:false,reason,loaded:false};}\n}\nfunction readPrivateJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error?.code==='ENOENT')return null;throw error;}}\nfunction writePrivateJson(file,value){const tmp=file+'.'+process.pid+'.'+Date.now()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});try{fs.chmodSync(tmp,0o600);}catch{}fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}}\n`);

// 3) Server: session-only admin auth, WorkProtocol bootstrap only, no retired durable endpoint.
{
  let s=read('server.js');
  s=s.replace("import { verifyAuth0Bearer } from './src/autonomos/auth0.js';\n",'');
  s=s.replace("import { hydrateExternalSecrets } from './src/autonomos/secret-provider.js';\n\nawait hydrateExternalSecrets(process.env,{logger:console});\n", "import { hydrateWorkProtocolRegistration } from './src/autonomos/workprotocol-bootstrap.js';\n\nawait hydrateWorkProtocolRegistration(process.env,{logger:console});\n");
  s=s.replace(/\napp\.post\('\/api\/internal\/autonomos\/temporal\/execute',[\s\S]*?\n\}\);\n\n(?=function stableJsonForSignature)/m,'\n');
  s=s.replace(/function requireAdmin\(req, res, next\) \{[\s\S]*?\n\}\n\n(?=function requireSameSiteMutation)/m,"function requireAdmin(req, res, next) {\n  if (getAdminSession(req)) return next();\n  return res.status(401).json({ error: 'Unauthorized' });\n}\n\n");
  write('server.js',s);
}

// 4) Worldwide discovery: free public search directly, no compatibility shim.
{
  let s=read('src/autonomos/global-work-hunter.js');
  s=s.replace("import { tavilySearch } from './tavily-tool.js';","import { freeWebSearch } from './free-web-tool.js';");
  s=s.replace(/await tavilySearch\(([^,]+),this\.env\)/g,'await freeWebSearch($1,this.env)');
  write('src/autonomos/global-work-hunter.js',s);
}

// 5) Direct model routing only; no retired gateway fields.
write('src/autonomos/llm-router.js',`export function resolveLlmEndpoint(env=process.env,{task='general'}={}){\n  const explicit=String(env.AUTONOMOS_LLM_BASE_URL||'').replace(/\\\/$/,'');\n  const openaiKey=String(env.OPENAI_API_KEY||'');\n  const baseUrl=explicit||(openaiKey?'https://api.openai.com/v1':'');\n  const modelMap=parse(env.AUTONOMOS_MODEL_ROUTING_JSON,{});\n  return{baseUrl,apiKey:String(env.AUTONOMOS_LLM_API_KEY||openaiKey||''),model:String(modelMap[task]||env.AUTONOMOS_LLM_MODEL||'gpt-5-mini'),gateway:baseUrl?'openai_compatible':'none'};\n}\nfunction parse(v,f){try{return JSON.parse(String(v||''))}catch{return f}}\n`);
{
  let s=read('src/autonomos/memory.js');
  s=s.replace(/function resolveEmbeddingEndpoint\(env\)\{[\s\S]*?\n\}/m,`function resolveEmbeddingEndpoint(env){\n  const direct=String(env.AUTONOMOS_LLM_BASE_URL||'').replace(/\\\/$/,'');\n  const openai=String(env.OPENAI_API_KEY||'')?String(env.OPENAI_BASE_URL||'https://api.openai.com/v1').replace(/\\\/$/,''):'';\n  return{baseUrl:direct||openai,apiKey:String(env.AUTONOMOS_LLM_API_KEY||env.OPENAI_API_KEY||''),model:String(env.AUTONOMOS_EMBEDDING_MODEL||'text-embedding-3-small')};\n}`);
  write('src/autonomos/memory.js',s);
}

// 6) Core marketplace connectors: remove retired competitive-market bootstrap and obsolete tool comments.
{
  let s=read('src/autonomos/connectors/index.js');
  s=s.replace(/\n\s*\/\/ is a single POST returning an apiKey \+ a claimCode\.[\s\S]*?\n\s*return health;/m,'\n  return health;');
  s=s.replace(/^\s*\/\/.*(?:Firecrawl|Browserbase|Stagehand).*\n/gmi,'');
  s=s.replace(/^\s*\/\/.*(?:one or both tool keys|billable call).*\n/gmi,'');
  write('src/autonomos/connectors/index.js',s);
}

// 7) Runtime: one durable provider, only current sources, free-search capability truth.
{
  let s=read('src/autonomos/runtime.js');
  s=s.replace("import { dispatchPaidOpportunity, temporalEnabled } from './temporal-client.js';\n",'');
  s=s.replace(/Trigger\.dev\/Temporal/g,'Trigger.dev');
  s=s.replace(/\}\s*else if\(temporalEnabled\(env\)\)\{[\s\S]*?event\('temporal_dispatch_fallback',[\s\S]*?\}\s*\n\s*return processMarketplaceOpportunity\(opportunity\);/m,"}\n        return processMarketplaceOpportunity(opportunity);");
  s=s.replace(/const claimed=processed\.filter\(x=>x\?\.claimed\)\.length,delivered=processed\.filter\(x=>x\?\.delivered\)\.length,triggerDispatched=processed\.filter\(x=>x\?\.provider==='trigger'\)\.length,temporalDispatched=processed\.filter\(x=>x\?\.provider==='temporal'\)\.length,durableDispatched=triggerDispatched\+temporalDispatched;/,"const claimed=processed.filter(x=>x?.claimed).length,delivered=processed.filter(x=>x?.delivered).length,triggerDispatched=processed.filter(x=>x?.provider==='trigger').length,durableDispatched=triggerDispatched;");
  s=s.replace(/,temporalDispatched/g,'');
  s=s.replace(/\|\|\(id==='t2000'&&def\.configured\)/g,'');
  s=s.replace(/\['t2000','clawlancer','workprotocol'\]/g,"['clawlancer','workprotocol']");
  s=s.replace(/new Set\(\['t2000','clawlancer','workprotocol'\]\)/g,"new Set(['clawlancer','workprotocol'])");
  s=s.replace(/\$\{op\.source==='t2000'\?'\\n\\n\[t2000 delivery constraint\][\s\S]*?:''\}/g,'');
  s=s.replace(/\n\s*if\(op\.source==='superteam'&&!config\.autoCompetitiveSubmissions\)reasons\.push\('competitive_auto_submit_disabled'\);/g,'');
  s=s.replace(/&&op\.source!=='superteam'/g,'');
  s=s.replace(/\n\s*if\(op\?\.source==='superteam'\)return Number\(config\.superteamMinJobPayoutUsd\?\?0\.5\);/g,'');
  s=s.replace(/if \(op\.source !== 'superteam'\) \{\n([\s\S]*?)\n\s*\}/g,'$1');
  s=s.replace(/\n\s*if\(op\.source==='superteam'&&!config\.autoCompetitiveSubmissions\)\{[\s\S]*?\n\s*\}\n/g,'\n');
  s=s.replace(/firecrawl_e2b_call_cost_estimate/g,'tool_api_call_cost_estimate');
  s=s.replace(/\/\/ P1 fix: Firecrawl\/E2B spend was previously invisible to the ledger entirely —\n\s*\/\/ recorded here as its own 'tool_api' cost row so Profit Engine accounting\n\s*\/\/ \(computeEarnedSpendBudgetUsd, netProfitUsd\) reflects real tool spend, not just LLM tokens\.\n/g,"// Tool/API spend is recorded separately so net-profit accounting includes non-model execution cost.\n");
  s=s.replace(/const rows=await mapLimit\(candidates,Number\(config\.commissioningMode&&!fastCommissioningProved\?1:config\.maxConcurrentJobs\|\|4\),async op=>\{const leaseId=crypto\.randomUUID\(\);const durableOp=\{\.\.\.op,__dispatchLeaseId:leaseId\};if\(triggerEnabled\(env\)\)\{([\s\S]*?)\}else if\(temporalEnabled\(env\)\)\{[\s\S]*?\}return processMarketplaceOpportunity\(op\);\}\);/m,(m,triggerBody)=>`const rows=await mapLimit(candidates,Number(config.commissioningMode&&!fastCommissioningProved?1:config.maxConcurrentJobs||4),async op=>{const leaseId=crypto.randomUUID();const durableOp={...op,__dispatchLeaseId:leaseId};if(triggerEnabled(env)){${triggerBody}}return processMarketplaceOpportunity(op);});`);
  s=s.replace(/return\{ok:true,found:normalized\.length,processed:rows\.filter\(x=>!x\?\.durable\)\.length,durableDispatched:rows\.filter\(x=>x\?\.durable\)\.length,triggerDispatched:rows\.filter\(x=>x\?\.provider==='trigger'\)\.length,temporalDispatched:rows\.filter\(x=>x\?\.provider==='temporal'\)\.length\};/,"return{ok:true,found:normalized.length,processed:rows.filter(x=>!x?.durable).length,durableDispatched:rows.filter(x=>x?.durable).length,triggerDispatched:rows.filter(x=>x?.provider==='trigger').length};");
  s=s.replace(/function capabilityContext\(\)\{return\{[^\n]+\};\}/,`function capabilityContext(){return{llmEnabled:Boolean(llm.available??llm.enabled),hasGithubPrTool:Boolean(env.GITHUB_TOKEN),hasShellTool:Boolean(env.E2B_API_KEY),hasBrowserTool:false,hasDeployTool:Boolean(env.AUTONOMOS_DEPLOY_WEBHOOK_URL),hasArtifactTool:artifactStore.configured(),hasAppTool:Boolean(env.COMPOSIO_API_KEY),connectedApps:connectedApps(),hasWebSearchTool:true,hasDesignMediaTool:false};}`);
  s=s.replace(/function capabilityVersion\(\)\{[\s\S]*?\n\s*\}/m,`function capabilityVersion(){\n    return crypto.createHash('sha256').update(JSON.stringify({rules:'16',credentialVersion:crypto.createHash('sha256').update(JSON.stringify(Object.entries(env).filter(([k])=>/API_KEY|TOKEN|AGENT_ID/.test(k)))).digest('hex'),model:llm.model||'',e2b:Boolean(env.E2B_API_KEY),composio:Boolean(env.COMPOSIO_API_KEY),connectedApps:connectedApps().sort(),github:Boolean(env.GITHUB_TOKEN),artifact:artifactStore.configured(),designMedia:Boolean(env.CANVA_API_KEY||env.FIGMA_ACCESS_TOKEN||env.FIGMA_API_KEY)})).digest('hex').slice(0,16);\n  }`);
  write('src/autonomos/runtime.js',s);
}

// 8) Persisted-state cleanup is generic: active sources survive; unknown marketplace state is purged.
write('src/autonomos/legacy-state-cleaner.js',`import fs from 'node:fs';import path from 'node:path';\nconst ACTIVE_MARKETS=new Set(['dealwork','clawlancer','workprotocol','agenthansa','taskbounty','x402-bazaar','agrenting']);\nconst GLOBAL_PREFIXES=['webwork_','jobicy_','remoteok_','weworkremotely_','remotive_','taskforce_'];\nfunction readJson(p,f={}){try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return f}}\nfunction writeJson(p,v){fs.writeFileSync(p,JSON.stringify(v,null,2))}\nfunction sourceOf(row,key=''){return String(row?.source||row?.op?.source||key.split(':')[0]||'').toLowerCase()}\nfunction keep(source,key=''){if(!source)return true;if(ACTIVE_MARKETS.has(source))return true;if(GLOBAL_PREFIXES.some(p=>String(key).startsWith(p)))return true;return !/^(?:market|agent|task|claw|work|deal|super|molt|quest|dework|bounty|open)/.test(source);}\nexport function cleanLegacyState({storageDir=process.env.STORAGE_DIR,logger=console}={}){const root=path.join(storageDir||'data','autonomos');if(!fs.existsSync(root))return{ok:true,skipped:true};const summary={registry:0,inFlight:0,credentials:0};for(const [name,key] of [['job-registry.json','registry'],['in-flight-jobs.json','inFlight']]){const file=path.join(root,name),rows=readJson(file,{});for(const [k,v] of Object.entries(rows))if(!keep(sourceOf(v,k),k)){delete rows[k];summary[key]++;}writeJson(file,rows);}const cPath=path.join(root,'credentials.private.json'),cred=readJson(cPath,{});for(const k of Object.keys(cred))if(!ACTIVE_MARKETS.has(String(k).toLowerCase())&&!['gmail','github'].includes(String(k).toLowerCase())){delete cred[k];summary.credentials++;}writeJson(cPath,cred);try{logger.info?.('[LegacyStateCleaner] '+JSON.stringify(summary));}catch{}return{ok:true,...summary};}\n`);

// 9) Package/runtime surface: remove retired dependencies and old worker script.
{
  const pkg=JSON.parse(read('package.json'));
  for(const key of ['@aws-sdk/client-secrets-manager','@opensearch-project/opensearch','@temporalio/client','@temporalio/worker','@temporalio/workflow'])delete pkg.dependencies[key];
  delete pkg.scripts['autonomos-temporal-worker'];
  write('package.json',JSON.stringify(pkg,null,2)+'\n');
}

// 10) Configuration/docs: remove retired knobs and stale comments without touching active secrets.
const retiredLine=/(?:TAVILY|FIRECRAWL|BROWSERBASE|STAGEHAND|TEMPORAL|OPENSEARCH|AUTH0|LITELLM|AWS_SECRET|SECRETS_MANAGER|NATS_URL|T2000|SUPERTEAM)/i;
for(const p of ['.env.example','.env.production.example','render.yaml'])stripLines(p,retiredLine);
for(const p of ['README.md','DEPLOY.md'])if(fs.existsSync(path.join(root,p)))stripLines(p,retiredLine);

// 11) Tests/audits: remove assertions whose only purpose was proving removed components were absent.
{
  let s=read('scripts/general-audit.mjs');
  s=s.replace(/^.*(?:Browserbase|Stagehand|Tavily|Firecrawl|T2000|Retired infrastructure|retired ).*\n/gmi,'');
  s=s.replace(/for\(const key of \[[^\]]*'BROWSERBASE_API_KEY'[\s\S]*?\n/g,'');
  s=s.replace(/for\(const id of \[[^\]]*'tavily'[\s\S]*?\n/g,'');
  write('scripts/general-audit.mjs',s);
}
for(const p of ['scripts/autonomos-audit.mjs','scripts/autonomos-regression-test.mjs','scripts/autonomos-final-regression-test.mjs','scripts/final-mega-regression-test.mjs','scripts/autonomos-workforce-test.mjs','scripts/autonomos-platform-test.mjs','scripts/earning-lifecycle-test.mjs','scripts/new-marketplaces-test.mjs','scripts/execution-queue-test.mjs','scripts/marketplace-ui-test.mjs']){
  if(!fs.existsSync(path.join(root,p)))continue;
  let s=read(p);
  // Remove isolated comments/log labels containing only retired names. Functional blocks are handled separately by test failures in staging.
  s=s.replace(/^\s*\/\/.*(?:T2000|Superteam|Tavily|Firecrawl|Browserbase|Stagehand|Temporal|OpenSearch|Auth0|LiteLLM).*\n/gmi,'');
  s=s.replace(/Firecrawl\/E2B/g,'external-tool');
  write(p,s);
}

console.log('[mega-clean] one-shot transform complete');
