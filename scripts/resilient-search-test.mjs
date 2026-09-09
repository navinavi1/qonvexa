import assert from 'node:assert/strict';
import { freeWebSearch } from '../src/autonomos/free-web-tool.js';

const original=globalThis.fetch;
try{
  let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    if(calls===1)return new Response('<a class="result__a" href="https://example.org/job">Paid translation project</a>',{status:200,headers:{'content-type':'text/html'}});
    return new Response('rate limited',{status:429,headers:{'content-type':'text/plain'}});
  };
  const first=await freeWebSearch('translation project',{AUTONOMOS_FREE_SEARCH_MIN_GAP_MS:'0'});
  assert.equal(first.ok,true);
  assert.equal(first.provider,'free_public_web');
  assert.equal(first.results.length,1);
  assert.equal(first.results[0].url,'https://example.org/job');
  const second=await freeWebSearch('translation project 2',{AUTONOMOS_FREE_SEARCH_MIN_GAP_MS:'0'});
  assert.equal(second.ok,false);
  assert.equal(calls,2);
}finally{
  globalThis.fetch=original;
}
console.log('RESILIENT SEARCH: PASS');
