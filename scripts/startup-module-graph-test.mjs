import assert from 'node:assert/strict';
import fs from 'node:fs';

const startUrl=new URL('./start-autonomos.mjs',import.meta.url);
const source=fs.readFileSync(startUrl,'utf8');
const loaded=new Map();
async function load(specifier){
  if(!loaded.has(specifier))loaded.set(specifier,await import(new URL(specifier,startUrl)));
  return loaded.get(specifier);
}

// Import every relative dependency used by the production entrypoint without importing
// the entrypoint itself (which would start the HTTP service). This catches deleted files
// and broken transitive module graphs before Render reaches the update phase.
for(const match of source.matchAll(/^import\s+['"]([^'"]+)['"];?/gm)){
  const spec=match[1];
  if(spec.startsWith('.'))await load(spec);
}

// Named imports are validated explicitly because `node --check` cannot detect that an
// imported module exists but no longer exports the requested symbol.
for(const match of source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/gm)){
  const names=match[1].split(',').map(x=>x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
  const spec=match[2];
  if(!spec.startsWith('.'))continue;
  const mod=await load(spec);
  for(const name of names)assert.ok(name in mod,`${specifierLabel(spec)} is missing startup export ${name}`);
}

function specifierLabel(value){return String(value).replace(/^\.\.\//,'');}
console.log(`STARTUP MODULE GRAPH: PASS (${loaded.size} modules)`);
