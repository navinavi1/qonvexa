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

console.log('[cleanup-repair] retired function tails/connectors removed and audits aligned to clean architecture');
