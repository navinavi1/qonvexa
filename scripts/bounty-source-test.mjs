import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubSearchJson } from '../src/autonomos/github-transport.js';

// Two transports, two result shapes: githubRequest resolves to {ok,value,status} and has no
// .json(); fetch resolves to a Response with .json() and no .value. `r.value || await
// r.json()` covered both only while value was truthy, and died on "r.json is not a function"
// the moment an authenticated search came back empty. It shipped twice -- the bounty hunter
// and the market scout -- and failed silently in production on every query with no hits.
const here=path.dirname(fileURLToPath(import.meta.url));
const src=name=>fs.readFileSync(path.join(here,'..','src','autonomos',name),'utf8');
// Strip comments before matching: the first version of this test flagged its own fix,
// because the comment explaining the defect quotes the defective expression verbatim.
const code=text=>text.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/^\s*\/\/.*$/gm,' ');

let checks=0;
const ok=(c,l)=>{assert.ok(c,l);checks++;};
const eq=(a,b,l)=>{assert.deepEqual(a,b,l+' (got '+JSON.stringify(a)+')');checks++;};

// 1. The pattern is gone from every caller, not just the one that was reported.
for(const file of ['free-revenue-global-work-hunter.js','free-market-scout.js']){
  const body=code(src(file));
  ok(!/\.value\s*\|\|\s*await\s+\w+\.json\(\)/.test(body),file+' no longer conflates the two transports');
  ok(/githubSearchJson\(/.test(body),file+' uses the shared helper');
}

// 2. The helper reads each transport the way it actually resolves.
const asTransport={GITHUB_TOKEN:'ghp-x'};
const headers={get:()=>''};

// githubRequest sets `value: await response.json().catch(() => null)` on the token path, so
// an ok response whose body will not parse yields a null value. That is precisely the state
// the old expression fell through on, reaching for .json() on a plain object.
const unparsable=await githubSearchJson('https://api.github.com/search/issues?q=x',{env:asTransport,
  fetchImpl:async()=>({ok:true,status:200,headers,json:async()=>{throw new Error('unexpected end of JSON input');}})});
eq(unparsable,{},'an ok response with an unreadable body yields an empty object, not a crash');

const hits=await githubSearchJson('https://api.github.com/search/issues?q=x',{env:asTransport,
  fetchImpl:async()=>({ok:true,status:200,headers,json:async()=>({items:[{id:1}]})})});
eq(hits.items.length,1,'results come through the transport branch');

const noHits=await githubSearchJson('https://api.github.com/search/issues?q=x',{env:asTransport,
  fetchImpl:async()=>({ok:true,status:200,headers,json:async()=>({items:[]})})});
eq(noHits.items.length,0,'an empty result set stays an empty result set');

// 3. Without a token it goes through fetch and reads the Response.
const anon=await githubSearchJson('https://api.github.com/search/issues?q=x',{env:{},
  fetchImpl:async()=>({ok:true,status:200,json:async()=>({items:[{id:2}]})})});
eq(anon.items[0].id,2,'the unauthenticated branch reads the Response body');

// 4. A failure is an error, never silently an empty result set.
await assert.rejects(()=>githubSearchJson('https://api.github.com/search/issues?q=x',{env:{},
  fetchImpl:async()=>({ok:false,status:403,json:async()=>({})})}),/github_search_http_403/,'an HTTP failure throws');
checks++;
await assert.rejects(()=>githubSearchJson('https://api.github.com/search/issues?q=x',{env:asTransport,
  fetchImpl:async()=>({ok:false,status:422,headers,json:async()=>({})})}),/github_search_http_/,'a transport failure throws too');
checks++;

console.log('bounty-source-test OK ('+checks+' checks)');
