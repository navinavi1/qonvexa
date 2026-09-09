import fs from 'node:fs';

// Repair pass runs AFTER the broad one-time cleanup. It only removes malformed tails
// left by old function-removal logic when a retired function had destructured/default
// parameters, and updates audits that explicitly asserted the retired architecture.

let p='src/autonomos/runtime.js';
let s=fs.readFileSync(p,'utf8');
s=s.replace(/\n\s*=\{\}\)\{\s*\n\s*const token=await t2000OAuth\.getAccessToken\(\{required\}\);[\s\S]*?\n\s*return token;\s*\n\s*\}/m,'\n');
s=s.replace(/^\s*await syncT2000Credential\([^\n]*\);?\s*$/gm,'');
fs.writeFileSync(p,s);

p='src/autonomos/connectors/index.js';
s=fs.readFileSync(p,'utf8');
s=s.replace(/\n\s*\)\{\s*\n\s*const endpoint=String\(url\|\|''\)\.trim\(\);[\s\S]*?\n\s*\}\s*\n(?=function extractDeliverableLink\()/m,'\n');
s=s.replace(/\n(?:\s*\/\/[^\n]*\n)*\s*=\{\}\)\{\s*\n\s*const key=String\(credentials\?\.superteam\?\.apiKey\|\|''\);[\s\S]*?\n\s*\}\s*\n(?=\s*=\{\}\)\{)/m,'\n');
s=s.replace(/\n\s*=\{\}\)\{\s*\n\s*const cred=credentials\?\.superteam;[\s\S]*?\n\s*\}\s*\n(?=function selectMcpArguments\()/m,'\n');
s=s.replace(/\n\s*\)\{\s*\n\s*(?:\/\/[^\n]*\n\s*)*const explicit=\[[\s\S]*?\n\s*return 0;\s*\n\s*\}\s*\n(?=function containsArrayByKey\()/m,'\n');
s=s.replace(/^\s*\{\s*id:'firecrawl'[^\n]*\n/gm,'');
fs.writeFileSync(p,s);

p='scripts/autonomos-audit.mjs';
s=fs.readFileSync(p,'utf8');
s=s.replace("  assert.equal(statuses.find(x=>x.id==='virtuals-acp').status, 'needs_credentials');","  assert.equal(statuses.some(x=>x.id==='virtuals-acp'), false);");
s=s.replace(/await ok\('P0: runTool refuses to spend when policy disallows it, without calling the API',[\s\S]*?\n\}\);\n\n(?=await ok\('P1: capability engine)/m,`await ok('free public web search has zero paid-tool cost', () => {\n  assert.equal(TOOL_COST_ESTIMATES_USD.web_search, 0);\n  assert.equal(TOOL_COST_ESTIMATES_USD.web_scrape, 0);\n});\n\n`);
s=s.replace(/await ok\('Firecrawl and E2B are visible connector\/tool health entries',[\s\S]*?\n\}\);\n\n(?=await ok\('GitHub PR tool)/m,`await ok('retired Firecrawl connector is absent and E2B remains visible', () => {\n  const statuses = connectorStatuses({}, { enabled:false, configured:false, mode:'disabled' }, {});\n  assert.equal(statuses.some(x=>x.id==='firecrawl'), false);\n  assert.ok(statuses.some(x=>x.id==='e2b'));\n});\n\n`);
s=s.replace(/await ok\('Superteam Earn is a visible connector and is exempt from the escrow requirement by design \(no escrow exists on that platform\)',[\s\S]*?\n\}\);\n(?=await ok\('Dealwork bid-mode)/m,`await ok('retired Superteam connector is absent from the clean earning surface', () => {\n  const statuses = connectorStatuses({}, { enabled:false, configured:false, mode:'disabled' }, {});\n  assert.equal(statuses.some(x=>x.id==='superteam'), false);\n});\n`);
s=s.replace(/Firecrawl\/E2B/g,'external-tool');
fs.writeFileSync(p,s);

p='scripts/autonomos-regression-test.mjs';
s=fs.readFileSync(p,'utf8');
s=s.replace(/assert\.match\(runtimeSource,\/return \\\['clawlancer','t2000','dealwork','workprotocol','superteam'\\\]\\\.includes\\\(source\\\)\/,'auto-claim allowlist must exclude ClawJobs and MoltJobs until their full lifecycle exists'\);/,"assert.match(runtimeSource,/return \\['clawlancer','dealwork','workprotocol'\\]\\.includes\\(source\\)/,'auto-claim allowlist must contain only current full-lifecycle rails');");
s=s.replace(/\s*assert\.match\(runtimeSource,\/clawjobs:[^\n]+\n/,'\n  assert.doesNotMatch(runtimeSource,/clawjobs:\\{discover:/i,\'retired ClawJobs lifecycle must be absent\');\n');
s=s.replace(/\s*assert\.match\(runtimeSource,\/moltjobs:[^\n]+\n/,'\n  assert.doesNotMatch(runtimeSource,/moltjobs:\\{discover:/i,\'retired MoltJobs lifecycle must be absent\');\n');
s=s.replace(/assert\.match\(runtimeSource,\/const fastSources=config\\\.cryptoOnlyEarnings\\\?\\\['clawlancer','t2000','workprotocol'\\\]\/,'Crypto-only mode excludes new fiat contracts'\);/,"assert.match(runtimeSource,/const fastSources=config\\.cryptoOnlyEarnings\\?\\['clawlancer','workprotocol'\\]/,'Crypto-only mode uses only current crypto-native rails');");
fs.writeFileSync(p,s);

p='scripts/final-mega-regression-test.mjs';
s=fs.readFileSync(p,'utf8');
s=s.replace(/\/\/ Connector contract: a short, recognized Superteam live feed is complete;[\s\S]*?\n\}\n\n(?=\/\/|const |function |await |console\.|$)/m,'');
fs.writeFileSync(p,s);

p='scripts/marketplace-hardening-test.mjs';
s=fs.readFileSync(p,'utf8');
s=s.replace('import { firecrawlSearch } from "../src/autonomos/tools.js";','import { freeWebSearch } from "../src/autonomos/free-web-tool.js";');
s=s.replace(/const originalFetch = globalThis\.fetch;[\s\S]*?console\.log\("PASS Firecrawl v2 web envelope and schema drift"\);/m,`const originalFetch = globalThis.fetch;\ntry {\n  globalThis.fetch = async () => new Response('<a class="result__a" href="https://example.org">Research</a>', {status:200,headers:{'content-type':'text/html'}});\n  const r = await freeWebSearch('query', { AUTONOMOS_FREE_SEARCH_MIN_GAP_MS:'0' });\n  assert(r.ok);\n  assert.equal(r.provider,'free_public_web');\n  assert.equal(r.results[0].url,'https://example.org/');\n  globalThis.fetch = async () => new Response('rate limited',{status:429});\n  assert.equal((await freeWebSearch('query-2',{AUTONOMOS_FREE_SEARCH_MIN_GAP_MS:'0'})).ok,false);\n} finally {\n  globalThis.fetch = originalFetch;\n}\nconsole.log('PASS free public web search envelope and HTTP failure handling');`);
fs.writeFileSync(p,s);

p='scripts/execution-queue-test.mjs';
s=fs.readFileSync(p,'utf8');
s=s.replace("import {verifySuperteamEligibility,claimMarketplaceJob} from '../src/autonomos/connectors/index.js';\n",'');
s=s.replace("import {classifyFailure} from '../src/autonomos/job-registry.js';\n",'');
s=s.replace(/\n\s*await test\('Superteam checks the current agent permission and deadline before claiming',[\s\S]*?\n\s*\}\);/m,'');
s=s.replace(/\n\s*await test\('Old competitive intents respect disabled autopost and revalidate before recovery',[\s\S]*?\n\s*\}\);/m,'');
fs.writeFileSync(p,s);

p='scripts/marketplace-ui-test.mjs';
s=fs.readFileSync(p,'utf8');
s=s.replace(/,\n\s*\{id:'legacy1',source:'t2000'[^\n]+\}/,'');
s=s.replace(/\nassert\(!feed\.textContent\.includes\('Old T2000 noise'\),'obsolete source rows must be filtered from the live feed'\);/,'');
fs.writeFileSync(p,s);

// Platform assertions must describe the intentionally small current stack: no Stagehand,
// no AWS secrets-manager adapter, no cloud-browser tool. Shell remains the free browser
// fallback, and Dealwork is the generic marketplace-managed payout example.
p='scripts/autonomos-platform-test.mjs';
s=fs.readFileSync(p,'utf8');
s=s.replace("const infra=infrastructureStatus({DATABASE_URL:'postgresql://x',REDIS_URL:'redis://x',NATS_URL:'nats://x',OPENAI_API_KEY:'x',AUTONOMOS_AWS_SECRET_ID:'secret/autonomos'});","const infra=infrastructureStatus({DATABASE_URL:'postgresql://x',REDIS_URL:'redis://x',OPENAI_API_KEY:'x'});");
s=s.replace("assert.ok(infra.some(x=>x.id==='stagehand'&&!x.configured));","assert.equal(infra.some(x=>x.id==='stagehand'),false);");
s=s.replace("assert.equal(infra.find(x=>x.id==='secrets_manager').configured,true);","assert.equal(infra.some(x=>x.id==='secrets_manager'),false);");
s=s.replace("assert.equal(selectPayoutRoute({currency:'USDC',marketplace:'t2000',supportedMethods:['marketplace'],amountUsd:5},env).rail,'marketplace_managed','marketplace wallet must not be mislabeled as direct owner payout');","assert.equal(selectPayoutRoute({currency:'USDC',marketplace:'dealwork',supportedMethods:['marketplace'],amountUsd:5},env).rail,'marketplace_managed','marketplace balance must not be mislabeled as direct owner payout');");
s=s.replace("assert.ok(TOOL_SCHEMAS.some(x=>x.function.name==='browser_task'));","assert.equal(TOOL_SCHEMAS.some(x=>x.function.name==='browser_task'),false);");
fs.writeFileSync(p,s);

// Workforce coverage must not require deleted marketplace connectors. Keep the generic
// MCP, economics, settlement, orchestration and workforce invariants, but use only active
// source labels and remove the retired Superteam submission-payload scenario.
p='scripts/autonomos-workforce-test.mjs';
s=fs.readFileSync(p,'utf8');
s=s.replace("import { deliverMarketplaceJob } from '../src/autonomos/connectors/index.js';\n",'');
s=s.replace(/\/\/ The MCP 2025-06-18 spec requires the MCP-Protocol-Version header on every HTTP[\s\S]*?assert\.equal\(new McpHttpClient\(\{url:'https:\/\/mcp\.t2000\.ai\/mcp'\}\)\.headers\(\)\['mcp-protocol-version'\],'2025-06-18','every request must carry the negotiated protocol version header'\);/m,"// Every MCP request must carry the negotiated protocol version header.\nassert.equal(new McpHttpClient({url:'https://mcp.example.test/mcp'}).headers()['mcp-protocol-version'],'2025-06-18','every request must carry the negotiated protocol version header');");
s=s.replace(/\/\/ Same class of bug as the learning fix in agency-intelligence\.js,[\s\S]*?\n\}\n\n\/\/ Per superteam\.fun\/earn\/agents,[\s\S]*?\n\}\n\n(?=\/\/ Each candidate's cost)/m,`// Submitted-but-unsettled work must remain pending in outcome history.\n{\n  const rows=[\n    {source:'dealwork',id:'a',status:'settled'},\n    {source:'dealwork',id:'b',status:'delivered'},\n    {source:'dealwork',id:'c',status:'delivered'},\n  ];\n  const result=estimateOutcomeProbability({source:'dealwork',budgetUsd:500},{executable:true,missingTools:[]},rows);\n  assert.equal(result.history.samples,1,'only the confirmed settlement counts as a sample');\n  assert.equal(result.history.pending,2,'unconfirmed deliveries must be tracked separately, not folded into successes');\n}\n\n`);
s=s.replace(/source:'t2000'/g,"source:'workprotocol'");
s=s.replace(/source:'superteam'/g,"source:'dealwork'");
s=s.replace(/\['t2000'/g,"['workprotocol'");
s=s.replace(/source:\s*'t2000'/g,"source:'workprotocol'");
s=s.replace(/source:\s*'superteam'/g,"source:'dealwork'");
s=s.replace(/ledger:\[\{type:'revenue',source:'t2000'/g,"ledger:[{type:'revenue',source:'workprotocol'");
s=s.replace(/'t2000:job-77'/g,"'workprotocol:job-77'");
s=s.replace(/settlementLedgerId\('t2000'/g,"settlementLedgerId('workprotocol'");
s=s.replace(/\/\/ Marketplace 'paid' is not the same as 'money reached the owner wallet'\.[\s\S]*?\n\}\n\n(?=\/\/ Reproduce the production symptom)/m,`// Marketplace settlement truth must distinguish direct owner-wallet payouts from\n// marketplace balances that still require withdrawal.\n{\n  const owner='0x1111111111111111111111111111111111111111';\n  const direct=settlementPayoutTruth({source:'clawlancer',payoutAddress:owner},{ownerWallet:owner,credentials:{clawlancer:{walletAddress:owner}}});\n  assert.equal(direct.ownerWalletReached,true,'Clawlancer direct payout to the configured owner address must be recognized as owner-wallet paid');\n  assert.equal(direct.withdrawalRequired,false);\n  const managed=settlementPayoutTruth({source:'dealwork',payoutAddress:''},{ownerWallet:owner});\n  assert.equal(managed.fundsLocation,'dealwork_marketplace_balance');\n  assert.equal(managed.ownerWalletReached,false,'Dealwork marketplace balance must not be mislabeled as owner-wallet paid');\n  assert.equal(managed.withdrawalRequired,true,'Dealwork settlement remains withdrawal-pending until cashout');\n  const wp=settlementPayoutTruth({source:'workprotocol',payoutAddress:''},{ownerWallet:owner});\n  assert.equal(wp.fundsLocation,'workprotocol_registered_wallet');\n  assert.equal(wp.verified,false,'without an authoritative registered wallet address WorkProtocol payout location must stay explicitly unverified');\n  const wpDirect=settlementPayoutTruth({source:'workprotocol',payoutAddress:owner},{ownerWallet:owner});\n  assert.equal(wpDirect.fundsLocation,'owner_wallet');\n  assert.equal(wpDirect.ownerWalletReached,true);\n  assert.equal(wpDirect.withdrawalRequired,false);\n}\n\n`);
s=s.replace(/before first crypto payment commissioning must run one job at a time/g,'before first confirmed payment commissioning must run one job at a time');
s=s.replace(/higher-value crypto candidate/g,'higher-value active-rail candidate');
s=s.replace(/after a real crypto settlement normal concurrency may resume/g,'after a real settlement normal concurrency may resume');
fs.writeFileSync(p,s);

console.log('[cleanup-repair] retired function tails/connectors removed and audits/regressions aligned to clean architecture');
