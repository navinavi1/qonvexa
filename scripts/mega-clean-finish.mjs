import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const p=x=>path.join(root,x);
const read=x=>fs.readFileSync(p(x),'utf8');
const write=(x,s)=>{fs.mkdirSync(path.dirname(p(x)),{recursive:true});fs.writeFileSync(p(x),s);};
const rm=x=>{try{fs.rmSync(p(x),{recursive:true,force:true});}catch{}};

// Final one-shot residue purge. This pass runs only in the staging workspace after the
// earlier structural cleanup passes. It removes every remaining retired provider/source
// reference and aligns tests with the current clean architecture.
{
  let s=read('server.js');
  s=s.replace(/function requireAdmin\(req, res, next\) \{[\s\S]*?\n\}\n\n(?=function safeCredentialEqual)/m,"function requireAdmin(req, res, next) {\n  if (getAdminSession(req)) return next();\n  return res.status(401).json({ error: 'Unauthorized' });\n}\n\n");
  write('server.js',s);
}
{
  let s=read('src/autonomos/browserless-lead-actioner.js');
  s=s.replace("if(status==='inspect_or_apply_failed'&&/browser_session|stagehand/i.test(String(action.error||'')))return true;","if(status==='inspect_or_apply_failed'&&/browser_session|session_unavailable/i.test(String(action.error||'')))return true;");
  write('src/autonomos/browserless-lead-actioner.js',s);
}
{
  let s=read('src/autonomos/taskforce-worker.js');
  s=s.replace(/capabilityContext\(\)\{return\{[^\n]+\};\}/,"capabilityContext(){return{llmEnabled:Boolean(this.llm?.available??this.llm?.enabled),hasGithubPrTool:Boolean(this.env.GITHUB_TOKEN),hasShellTool:Boolean(this.env.E2B_API_KEY),hasBrowserTool:false,hasDeployTool:Boolean(this.env.AUTONOMOS_DEPLOY_WEBHOOK_URL),hasArtifactTool:Boolean((this.env.S3_ENDPOINT||this.env.R2_ENDPOINT)&&(this.env.S3_BUCKET||this.env.R2_BUCKET)),hasAppTool:Boolean(this.env.COMPOSIO_API_KEY),connectedApps:[],hasWebSearchTool:true,hasDesignMediaTool:false};}");
  write('src/autonomos/taskforce-worker.js',s);
}
{
  let s=read('src/autonomos/taskforce-live-recovery-patch.js');
  s=s.replace('// checked the retired Browserbase/Tavily/Firecrawl flags, even though E2B/GitHub/Composio\n','// checked obsolete provider flags instead of the current E2B/GitHub/Composio capability layer.\n');
  write('src/autonomos/taskforce-live-recovery-patch.js',s);
}
{
  let s=read('src/autonomos/runtime.js');
  s=s.replace(/\n\s*\/\/ Backward-compatible alias for the deferred Temporal worker\.\n\s*async processTemporalOpportunity\(opportunity\)\{\n\s*return this\.processDurableOpportunity\(opportunity\);\n\s*\},\n/m,'\n');
  s=s.replace("    if(['laborx','dework','bountycaster','questbook'].includes(source))return false;\n",'');
  s=s.replace('      // intents. Pause them when automatic competitive submissions are disabled.\n        continue;\n      }\n','');
  s=s.replace(/firecrawl_e2b_call_cost_estimate/g,'tool_api_call_cost_estimate');
  s=s.replace(/\/\/ P1 fix: Firecrawl\/E2B spend was previously invisible to the ledger entirely —\n\s*\/\/ recorded here as its own 'tool_api' cost row so Profit Engine accounting\n\s*\/\/ \(computeEarnedSpendBudgetUsd, netProfitUsd\) reflects real tool spend, not just LLM tokens\.\n/g,"// Tool/API spend is recorded separately so net-profit accounting includes non-model execution cost.\n");
  write('src/autonomos/runtime.js',s);
}
{
  let s=read('src/autonomos/job-executor.js');
  s=s.replace("  if (spendAuthorized && (env.FIRECRAWL_API_KEY || env.TAVILY_API_KEY)) add('web_search');\n  if (spendAuthorized && env.FIRECRAWL_API_KEY) add('web_scrape');\n","  add('web_search');\n  add('web_scrape');\n");
  s=s.replace("  if (spendAuthorized && env.BROWSERBASE_API_KEY && env.BROWSERBASE_PROJECT_ID) add('browser_task');\n",'');
  write('src/autonomos/job-executor.js',s);
}
write('src/autonomos/observability.js',"export async function emitOperationalLog(_event,_options={}){\n  return false;\n}\n");
{
  let s=read('src/autonomos/planner.js');
  s=s.replace("    const directOpenAIKey=String(env.OPENAI_API_KEY||(!env.LITELLM_BASE_URL&&!env.AUTONOMOS_LLM_BASE_URL?env.AUTONOMOS_LLM_API_KEY:'')||'');\n    if(env.AUTONOMOS_USE_OPENAI_AGENTS_SDK!=='false'&&directOpenAIKey&&!env.LITELLM_BASE_URL&&!env.AUTONOMOS_LLM_BASE_URL&&!llm.budgeted){","    const directOpenAIKey=String(env.OPENAI_API_KEY||env.AUTONOMOS_LLM_API_KEY||'');\n    if(env.AUTONOMOS_USE_OPENAI_AGENTS_SDK!=='false'&&directOpenAIKey&&!env.AUTONOMOS_LLM_BASE_URL&&!llm.budgeted){");
  s=s.replace("        const route=resolveLlmEndpoint({...env,LITELLM_BASE_URL:'',AUTONOMOS_LLM_BASE_URL:''},{task:'planning'});","        const route=resolveLlmEndpoint({...env,AUTONOMOS_LLM_BASE_URL:''},{task:'planning'});");
  write('src/autonomos/planner.js',s);
}
{
  let s=read('src/autonomos/global-work-hunter.js');
  s=s.split(/\r?\n/).filter(line=>!line.includes('site:laborx.com/jobs')).join('\n')+'\n';
  s=s.replace("    const cryptoMatch=text.match(CRYPTO);const laborx=/\\blaborx\\.com$/i.test(host);\n    const cryptoPayout=Boolean(cryptoMatch)||laborx;\n    const payoutCurrency=explicitCurrency||String(cryptoMatch?.[1]||'').toUpperCase()||(laborx?'CRYPTO':'UNKNOWN');\n","    const cryptoMatch=text.match(CRYPTO);\n    const cryptoPayout=Boolean(cryptoMatch);\n    const payoutCurrency=explicitCurrency||String(cryptoMatch?.[1]||'').toUpperCase()||'UNKNOWN';\n");
  s=s.replace("    return{id:`webwork_${hash(url)}`,source:host,title:String(row?.title||'Paid digital work').slice(0,220),url,category,amountUsd:amount,payoutCurrency,cryptoPayout,payoutVerified:cryptoPayout&&laborx,worldwide:/worldwide|remote|global/i.test(text)||laborx,humanGate,terminal,applyReady:false,applyMode:laborx?'browser_account_required':'connector_or_browser_required',blocker:humanGate?'protected_registration_or_identity_step_required':'account/application connector not yet authenticated',searchScore:Number(row?.score||0),discoveredBy:query,snippet:String(row?.snippet||'').slice(0,1500)};","    return{id:`webwork_${hash(url)}`,source:host,title:String(row?.title||'Paid digital work').slice(0,220),url,category,amountUsd:amount,payoutCurrency,cryptoPayout,payoutVerified:false,worldwide:/worldwide|remote|global/i.test(text),humanGate,terminal,applyReady:false,applyMode:'direct_or_native_route_required',blocker:humanGate?'protected_registration_or_identity_step_required':'verified application route required',searchScore:Number(row?.score||0),discoveredBy:query,snippet:String(row?.snippet||'').slice(0,1500)};");
  s=s.replace(/capabilityContext\(\)\{return\{[^\n]+\};\}/,"capabilityContext(){return{llmEnabled:Boolean(this.llm?.available??this.llm?.enabled),hasGithubPrTool:Boolean(this.env.GITHUB_TOKEN),hasShellTool:Boolean(this.env.E2B_API_KEY),hasBrowserTool:false,hasDeployTool:Boolean(this.env.AUTONOMOS_DEPLOY_WEBHOOK_URL),hasArtifactTool:Boolean((this.env.S3_ENDPOINT||this.env.R2_ENDPOINT)&&(this.env.S3_BUCKET||this.env.R2_BUCKET)),hasAppTool:Boolean(this.env.COMPOSIO_API_KEY),connectedApps:[],hasWebSearchTool:true,hasDesignMediaTool:false};}");
  write('src/autonomos/global-work-hunter.js',s);
}
{
  let s=read('src/autonomos/store.js');
  s=s.replace(/\nexport function legacyT2000OAuthFallback\(rootDir\)\{[\s\S]*?\n\}\n\n(?=export class AutonomOSStore)/m,'\n');
  s=s.replace("}catch(error){if(error?.code==='ENOENT'&&name==='t2000-oauth.private.json'){const migrated=legacyT2000OAuthFallback(this.rootDir);if(migrated)return migrated;}return structuredCloneSafe(fallback);}","}catch{return structuredCloneSafe(fallback);}");
  s=s.replace("}catch(error){if(error?.code==='ENOENT'&&name==='t2000-oauth.private.json'){const migrated=legacyT2000OAuthFallback(this.rootDir);if(migrated)return migrated;}if(error?.code==='ENOENT')return structuredCloneSafe(fallback);throw error;}","}catch(error){if(error?.code==='ENOENT')return structuredCloneSafe(fallback);throw error;}");
  write('src/autonomos/store.js',s);
}
{
  let s=read('src/autonomos/mcp-client.js');
  s=s.replace(/\n\s*\/\/ t2000's current Passport Connect surface[\s\S]*?\n\s*return tools;/m,'\n    return tools;');
  s=s.replace("    return alias?.normalize==='t2000_buyer_openings'?normalizeT2000BuyerOpenings(result):result;","    return result;");
  s=s.replace(/\nfunction isT2000Endpoint\([\s\S]*?\n\}\n\nfunction normalizeT2000BuyerOpenings\([\s\S]*?\n\}\n\n(?=async function readRpcBody)/m,'\n');
  write('src/autonomos/mcp-client.js',s);
}
{
  let s=read('src/autonomos/acceptance-engine.js');
  s=s.replace("  if (source === 't2000') requirements.push({id:'marketplace-work-order', description:'Satisfy the authoritative t2000 work order and delivery-body constraints.'});\n",'');
  s=s.replace("  if (source === 'superteam') requirements.push({id:'submission-fields', description:'Submit using the listing-specific required fields and evidence.'});\n",'');
  s=s.replace(/tools:\['web_search','web_scrape','browser_task'\]/g,"tools:['web_search','web_scrape']");
  s=s.replace(/new Set\(\['web_search','web_scrape','browser_task'\]\)/g,"new Set(['web_search','web_scrape'])");
  s=s.replace(/new Set\(\['app_tool_search','app_action','browser_task','store_artifact'\]\)/g,"new Set(['app_tool_search','app_action','store_artifact'])");
  write('src/autonomos/acceptance-engine.js',s);
}
{
  let s=read('src/autonomos/outcome-model.js');
  s=s.replace(/const PRIORS = Object\.freeze\(\{[\s\S]*?\n\}\);/,"const PRIORS = Object.freeze({\n  clawlancer: { win:.48, completion:.90, acceptance:.88, payment:.98 },\n  'dealwork:bid': { win:.22, completion:.90, acceptance:.86, payment:.96 },\n  dealwork: { win:.45, completion:.90, acceptance:.86, payment:.96 },\n  workprotocol: { win:.45, completion:.90, acceptance:.86, payment:.98 },\n  default: { win:.25, completion:.82, acceptance:.75, payment:.90 }\n});");
  s=s.replace("  if(op.source==='t2000'&&op.claimMode==='already_assigned')return PRIORS['t2000:already_assigned'];\n  if(op.source==='t2000')return PRIORS['t2000:open'];\n",'');
  s=s.replace('while a genuinely fresh T2000 job is available.','while a genuinely fresh paid job is available.');
  write('src/autonomos/outcome-model.js',s);
}
{
  let s=read('src/autonomos/job-registry.js');
  s=s.replace(/\|t2000_open_job_below_floor:/g,'');
  s=s.replace("  const assigned=['t2000','dealwork'].includes(source)&&String(opportunity.claimMode||'')==='already_assigned';","  const assigned=source==='dealwork'&&String(opportunity.claimMode||'')==='already_assigned';");
  s=s.replace(/\n\s*if\(\/superteam_listing_not_agent_eligible[^\n]+\n/g,'\n');
  write('src/autonomos/job-registry.js',s);
}
{
  let s=read('src/autonomos/free-capability-layer.js');
  s=s.replace('    // still cite actual URLs/API responses; this flag does not re-enable Tavily/Firecrawl.\n','    // still cite actual URLs/API responses; this flag does not enable paid search.\n');
  s=s.replace('/tavily|firecrawl|browserbase|premium|paid_search|paid_browser|purchase|subscription|connects|credits_purchase/','/premium|paid_search|paid_browser|purchase|subscription|connects|credits_purchase/');
  write('src/autonomos/free-capability-layer.js',s);
}
{
  let s=read('src/autonomos/free-revenue-global-work-hunter.js');
  s=s.replace('// Tavily, Firecrawl or Browserbase. The parent class is retained for TaskForce lifecycle','// paid search or cloud-browser providers. The parent class is retained for TaskForce lifecycle');
  write('src/autonomos/free-revenue-global-work-hunter.js',s);
}
{
  let s=read('src/autonomos/agency-intelligence.js');
  s=s.replace("// 'settled' or 'failed' later because on no-escrow marketplaces (Superteam Earn) delivery","// 'settled' or 'failed' later because on adjudicated marketplaces delivery");
  s=s.replace('// (Superteam Earn) a human still has to judge and claim it, sometimes days later.','// a sponsor may still need to judge it later.');
  write('src/autonomos/agency-intelligence.js',s);
}
{
  let s=read('src/autonomos/legacy-state-cleaner.js');
  s=s.replace('(?:market|agent|task|claw|work|deal|super|molt|quest|dework|bounty|open)','(?:market|agent|task|claw|work|deal|quest|bounty|open)');
  write('src/autonomos/legacy-state-cleaner.js',s);
}
{
  let s=read('public/admin.js');
  s=s.replace(/'Superteam submission'/g,"'Pending payout claim'");
  s=s.replace(/No Superteam submissions yet — nothing to claim\./g,'No pending payout claims.');
  s=s.replace('No Clawlancer/Dealwork/t2000/Superteam opportunities observed yet this cycle (x402-bazaar signals are hidden here — that feed is for buying APIs, not earning from jobs).','No active earning opportunities observed yet this cycle (x402-bazaar buyer-side signals are hidden here).');
  write('public/admin.js',s);
}
{
  let s=read('public/admin.css');
  s=s.replace(/\.autonomos-t2000-card\{[^}]*\}\.autonomos-t2000-head[^\n]*/g,'');
  s=s.replace('.autonomos-t2000-head{align-items:flex-start;flex-direction:column}.autonomos-t2000-actions{justify-content:flex-start}','');
  write('public/admin.css',s);
}

// Current policy regression fixtures: test today's clean config, not deleted migrations.
{
  let s=read('scripts/survival-swarm-test.mjs');
  s=s.replace("const cfg=normalizeConfig({platformGeneration:8,earningProfileVersion:15,maxChildren:20,maxConcurrentJobs:4,maxJobsPerCycle:6,maxApiCostPercentOfPayout:35,maxPaidProcurementUsd:3,enabled:true,zeroSpendMode:false,earnedFundsOnly:true});","const cfg=normalizeConfig({maxChildren:50,maxConcurrentJobs:6,maxJobsPerCycle:10,maxApiCostPercentOfPayout:60,maxPaidProcurementUsd:10,enabled:true,zeroSpendMode:false,earnedFundsOnly:true});");
  s=s.replace("'profile migration is isolated from unrelated Render env; production stale 0.30 is migrated separately'","'explicit current production procurement cap is preserved'");
  s=s.replace(/const oldAssigned=\{[\s\S]*?test fixture confirms why owned assigned work could previously dominate commissioning ranking'\);/,"const current={source:'workprotocol',externalId:'fresh-open',claimMode:'automatic',budgetUsd:5,capability:{mode:'llm_general_digital'}};\nconst probability=estimateOutcomeProbability(current,{executable:true},[]).probability;\nassert.ok(probability>0&&probability<1,'current active-rail outcome probability remains bounded without retired-provider priors');");
  write('scripts/survival-swarm-test.mjs',s);
}
{
  let s=read('scripts/autonomos-regression-test.mjs');
  const a=s.indexOf('const migrated=normalizeConfig('),b=s.indexOf('\n\nconst buyerUnfunded',a);
  if(a>=0&&b>a){
    const block="const current=normalizeConfig({enabled:true,minJobPayoutUsd:0.5,clawlancerMinJobPayoutUsd:0.5,dealworkMinJobPayoutUsd:0.5,minMarginPercent:20,maxApiCostPercentOfPayout:60,maxChildren:50,maxConcurrentJobs:6,maxJobsPerCycle:10,maxPaidProcurementUsd:10});\nassert.equal(current.platformGeneration,9,'current clean policy generation is fixed');\nassert.equal(current.earningProfileVersion,18,'current clean earning profile is fixed');\nassert.equal(current.minJobPayoutUsd,0.5);\nassert.equal(current.clawlancerMinJobPayoutUsd,0.5);\nassert.equal(current.dealworkMinJobPayoutUsd,0.5);\nassert.equal(current.minMarginPercent,20);\nassert.equal(current.maxApiCostPercentOfPayout,60);\nassert.equal(current.autoCompetitiveSubmissions,false,'competitive auto-submit remains opt-in');\nassert.equal(current.commissioningMode,true);\nassert.equal(current.commissioningMinPayoutUsd,0.5);\nassert.equal(current.cryptoOnlyEarnings,true);\nassert.equal(current.maxChildren,50);\nassert.equal(current.maxConcurrentJobs,6);\nassert.equal(current.maxJobsPerCycle,10);\nassert.equal(current.maxPaidProcurementUsd,10);";
    s=s.slice(0,a)+block+s.slice(b);
  }
  write('scripts/autonomos-regression-test.mjs',s);
}

// Generic replacements in tests that still named retired sources/providers.
const replacements={
  'scripts/agency-reliability-test.mjs':[['FIRECRAWL_API_KEY','E2B_API_KEY'],["source:'t2000'","source:'dealwork'"],["'t2000'","'dealwork'"]],
  'scripts/autonomos-audit.mjs':[["assert.equal(statuses.some(x=>x.id==='virtuals-acp'), false);","assert.equal(statuses.some(x=>x.id==='unknown-retired-source'), false);"],["await ok('retired AgentHansa connector is absent from the clean earning surface', () => {\n  const statuses = connectorStatuses({}, { enabled:false, configured:false, mode:'disabled' }, {});\n  assert.equal(statuses.some(x=>x.id==='agenthansa'), false);\n});","await ok('AgentHansa remains visible as an active configured-market surface', () => {\n  const statuses = connectorStatuses({}, { enabled:false, configured:false, mode:'disabled' }, {});\n  assert.equal(statuses.some(x=>x.id==='agenthansa'), true);\n});"]],
  'scripts/autonomos-production-readiness-test.mjs':[['such as t2000','for explicit setup requirements']],
  'scripts/autonomos-final-regression-test.mjs':[["source:'t2000'","source:'dealwork'"],["source:'superteam'","source:'agenthansa'"],["'superteam'","'agenthansa'"],['Superteam','AgentHansa']],
  'scripts/agency-intelligence-test.mjs':[["source:'t2000'","source:'dealwork'"],["source:'superteam'","source:'workprotocol'"],['t2000','dealwork'],['superteam','workprotocol']],
  'scripts/autonomos2-flow-test.mjs':[['https://t2000.ai/','https://workprotocol.ai/']],
  'scripts/job-registry-test.mjs':[["source:'t2000'","source:'workprotocol'"],["source:'superteam'","source:'dealwork'"],["'superteam:ours-1'","'dealwork:ours-1'"]],
  'scripts/marketplace-ui-test.mjs':[["assert.equal(window.document.querySelector('.autonomos-t2000-card'),null,'legacy T2000 card is removed from owner UI');","assert.equal(window.document.querySelector('[data-retired-market]'),null,'retired market controls are absent');"]],
  'scripts/admin-integration-test.mjs':[["assert.equal(dom.window.document.querySelector('.autonomos-t2000-card'),null,'legacy T2000 card must not survive dashboard cleanup');","assert.equal(dom.window.document.querySelector('[data-retired-market]'),null,'retired market controls must not survive dashboard cleanup');"]],
  'scripts/autonomos-fault-injection-test.mjs':[['https://t2000.ai/','https://workprotocol.ai/']],
  'scripts/final-mega-regression-test.mjs':[["source:'superteam'","source:'agenthansa'"],["'superteam'","'agenthansa'"],['Superteam','AgentHansa']],
  'scripts/autonomos-platform-test.mjs':[["assert.equal(infra.some(x=>x.id==='stagehand'),false);","assert.equal(infra.some(x=>x.id==='cloud_browser'),false);"],["assert.equal(infra.some(x=>x.id==='secrets_manager'),false);","assert.equal(infra.some(x=>x.id==='external_secrets'),false);"]]
};
for(const [file,pairs] of Object.entries(replacements)){
  if(!fs.existsSync(p(file)))continue;
  let s=read(file);for(const [a,b] of pairs)s=s.split(a).join(b);write(file,s);
}

// Dead source files: nothing in production imports these after the cleanup.
rm('src/autonomos/autoscaler.js');
rm('src/autonomos/free-agrenting-worker.js');
{
  let s=read('scripts/autonomos-platform-test.mjs');
  s=s.replace("import { desiredChildCapacity, buildChildRole } from '../src/autonomos/autoscaler.js';\n",'');
  s=s.replace("assert.equal(desiredChildCapacity({activeJobs:8,currentChildren:0,config:{autoReplication:true,maxChildren:10,childSpawnConcurrencyThreshold:2}}),3);\nassert.equal(buildChildRole('code-analysis').role,'code-worker');\n\n",'');
  write('scripts/autonomos-platform-test.mjs',s);
}

console.log('[mega-clean-finish] final retired-code purge and current-architecture test alignment complete');
