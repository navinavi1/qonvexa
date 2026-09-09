import fs from 'node:fs';

// Repair pass runs AFTER the broad one-time cleanup. It only removes malformed tails
// left by old function-removal logic when a retired function had destructured/default
// parameters. Keep these repairs exact and structural rather than hiding features.

let p='src/autonomos/runtime.js';
let s=fs.readFileSync(p,'utf8');
s=s.replace(/\n\s*=\{\}\)\{\s*\n\s*const token=await t2000OAuth\.getAccessToken\(\{required\}\);[\s\S]*?\n\s*return token;\s*\n\s*\}/m,'\n');
s=s.replace(/^\s*await syncT2000Credential\([^\n]*\);?\s*$/gm,'');
fs.writeFileSync(p,s);

p='src/autonomos/connectors/index.js';
s=fs.readFileSync(p,'utf8');

// discoverConfiguredFeed(source,url,apiKey,limit,defaults={}) was retired with the
// watch-only markets. The legacy remover could leave its body beginning at "){".
s=s.replace(/\n\s*\)\{\s*\n\s*const endpoint=String\(url\|\|''\)\.trim\(\);[\s\S]*?\n\s*\}\s*\n(?=function extractDeliverableLink\()/m,'\n');

// verifySuperteamEligibility(opportunity,{credentials={}}={}) and
// superteamAction(...,{...}={}) have nested/default parameter braces. The legacy remover
// could delete only their signatures and leave executable tails. Remove both exact tails.
s=s.replace(/\n(?:\s*\/\/[^\n]*\n)*\s*=\{\}\)\{\s*\n\s*const key=String\(credentials\?\.superteam\?\.apiKey\|\|''\);[\s\S]*?\n\s*\}\s*\n(?=\s*=\{\}\)\{)/m,'\n');
s=s.replace(/\n\s*=\{\}\)\{\s*\n\s*const cred=credentials\?\.superteam;[\s\S]*?\n\s*\}\s*\n(?=function selectMcpArguments\()/m,'\n');

fs.writeFileSync(p,s);

console.log('[cleanup-repair] malformed tails from retired credential/feed/Superteam functions removed');
