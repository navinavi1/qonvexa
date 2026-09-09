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

// Remove both Superteam-only execution/recovery scenarios. Generic queue, recovery,
// checkpoint, budget and concurrency tests remain and still protect the active rails.
p='scripts/execution-queue-test.mjs';
s=fs.readFileSync(p,'utf8');
s=s.replace("import {verifySuperteamEligibility,claimMarketplaceJob} from '../src/autonomos/connectors/index.js';\n",'');
s=s.replace("import {classifyFailure} from '../src/autonomos/job-registry.js';\n",'');
s=s.replace(/\n\s*await test\('Superteam checks the current agent permission and deadline before claiming',[\s\S]*?\n\s*\}\);/m,'');
s=s.replace(/\n\s*await test\('Old competitive intents respect disabled autopost and revalidate before recovery',[\s\S]*?\n\s*\}\);/m,'');
fs.writeFileSync(p,s);

console.log('[cleanup-repair] retired function tails/connectors removed and audits/regressions aligned to clean architecture');
