import fs from 'node:fs';

const p='src/autonomos/runtime.js';
let s=fs.readFileSync(p,'utf8');

// The legacy syncT2000Credential function uses destructured/default parameters. The old
// one-time remover mistook the parameter brace for the function body and could leave the
// tail "={}){ ... }" behind. Remove that exact orphan safely after the main transform.
s=s.replace(/\n\s*=\{\}\)\{\s*\n\s*const token=await t2000OAuth\.getAccessToken\(\{required\}\);[\s\S]*?\n\s*return token;\s*\n\s*\}/m,'\n');

// Remove any remaining one-line T2000 credential sync calls that are now meaningless.
s=s.replace(/^\s*await syncT2000Credential\([^\n]*\);?\s*$/gm,'');

fs.writeFileSync(p,s);
console.log('[cleanup-repair] orphaned retired credential function removed');
