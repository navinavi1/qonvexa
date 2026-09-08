import assert from 'node:assert/strict';
import { tavilySearch } from '../src/autonomos/tavily-tool.js';

const original=globalThis.fetch;const calls=[];
globalThis.fetch=async (url)=>{
  calls.push(String(url));
  if(String(url).includes('tavily.com'))return new Response(JSON.stringify({error:'rate limited'}),{status:429,headers:{'content-type':'application/json'}});
  if(String(url).includes('firecrawl.dev'))return new Response(JSON.stringify({success:true,data:[{title:'Paid translation project',url:'https://example.com/job',description:'Freelance translation project $100'}]}),{status:200,headers:{'content-type':'application/json'}});
  throw new Error('unexpected_url');
};
// This regression covers the explicit paid-provider fallback path only. Production keeps
// AUTONOMOS_ZERO_PAID_SEARCH=true and therefore never reaches Tavily or Firecrawl.
const result=await tavilySearch('translation project',{TAVILY_API_KEY:'tv-test',FIRECRAWL_API_KEY:'fc-test',AUTONOMOS_FREE_WEB_SEARCH_ENABLED:'false',AUTONOMOS_ZERO_PAID_SEARCH:'false'});
assert.equal(result.ok,true);assert.equal(result.provider,'firecrawl');assert.equal(result.results.length,1);assert.match(result.fallbackFrom,/tavily_http_429/);assert.equal(calls.length,2);
globalThis.fetch=original;
console.log('RESILIENT SEARCH: PASS');
