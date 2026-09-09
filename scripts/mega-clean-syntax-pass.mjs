import fs from 'node:fs';

const file='src/autonomos/runtime.js';
let s=fs.readFileSync(file,'utf8');

// The old competitive-recovery branch could already be partially removed by an earlier
// cleanup pass, leaving its trailing continue/brace orphaned immediately before the
// provider-neutral capability revalidation. Remove only that impossible fragment.
s=s.replace(/\n\s*manualAttention\+\+;continue;\s*\n\s*}\s*\n(\s*const currentCapability=revalidateClaimedCapability)/m,'\n$1');

fs.writeFileSync(file,s);
console.log('[mega-clean-syntax] transformed runtime recovery boundary repaired');
