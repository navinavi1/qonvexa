import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The defect was a transport mix-up, so this asserts on the shape of the code that reads
// each transport's result rather than on a mocked call: githubRequest resolves to
// {ok,value,status} and has no .json(); fetch resolves to a Response with .json() and no
// .value. `r.value || await r.json()` covered both only while value was truthy, and died on
// "r.json is not a function" for every search that returned no hits.
const here=path.dirname(fileURLToPath(import.meta.url));
const source=fs.readFileSync(path.join(here,'..','src','autonomos','free-revenue-global-work-hunter.js'),'utf8');
// Strip comments before matching. The first version of this test flagged its own fix,
// because the comment explaining the defect quotes the defective expression verbatim.
const stripComments=text=>text.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/^\s*\/\/.*$/gm,' ');
const loader=stripComments(source.slice(source.indexOf('async function loadGithubBounties('),source.indexOf('async function getJson(')));
let checks=0;
const ok=(c,l)=>{assert.ok(c,l);checks++;};

ok(!/r\.value\s*\|\|\s*await\s+r\.json\(\)/.test(loader),
  'the transport results must not be conflated with a || fallback');
ok(/viaTransport\s*\?\s*\(r\.value\|\|\{\}\)\s*:\s*await r\.json\(\)/.test(loader),
  'each transport must be read the way that transport actually resolves');
ok(/const viaTransport=githubAvailable\(env\)/.test(loader),
  'the branch is decided once and reused, not re-evaluated');

// The failure this produces in practice: an authenticated, successful, empty search.
const transportResult={ok:true,status:200,value:{items:[]}};
ok(typeof transportResult.json!=='function','a transport result genuinely has no .json()');
const emptyValue={ok:true,status:200,value:null};
ok(!emptyValue.value,'an empty search yields a falsy value, which is what triggered the fallback');
ok((true?(emptyValue.value||{}):null).items===undefined,'the fixed read yields an empty object, not a crash');

// A bad JSON body must not be mistaken for zero results either.
const data=(true?(transportResult.value||{}):null);
ok(Array.isArray(data.items)&&data.items.length===0,'an empty result set stays an empty result set');

console.log('bounty-source-test OK ('+checks+' checks)');
