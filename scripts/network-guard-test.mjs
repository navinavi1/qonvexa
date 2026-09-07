import assert from 'node:assert/strict';
import { installNetworkGuard } from '../src/autonomos/network-guard.js';

const original=globalThis.fetch;
let calls=0;
globalThis.fetch=async input=>{
  calls++;const url=String(input);
  if(url.includes('workprotocol.ai'))return new Response('{}',{status:429});
  if(url.includes('api.tavily.com'))return new Response('{}',{status:402});
  return new Response('{}',{status:200});
};

const env={AUTONOMOS_DISABLED_MARKETS:'t2000,clawlancer,agenthansa,superteam,skarnfall',AUTONOMOS_RATE_LIMIT_COOLDOWN_MS:'60000',AUTONOMOS_TOOL_402_COOLDOWN_MS:'600000'};
const guard=installNetworkGuard({env,logger:{info(){},warn(){}}});
const disabled=await fetch('https://clawlancer.ai/api/jobs');
assert.equal(disabled.status,410);
assert.equal(calls,0,'disabled source must never reach network');
const first=await fetch('https://workprotocol.ai/api/jobs');
assert.equal(first.status,429);assert.equal(calls,1);
const second=await fetch('https://workprotocol.ai/api/jobs');
assert.equal(second.status,429);assert.equal(calls,1,'429 cooldown must suppress repeated network requests');
const tavilyFirst=await fetch('https://api.tavily.com/search');
assert.equal(tavilyFirst.status,402);assert.equal(calls,2);
const tavilySecond=await fetch('https://api.tavily.com/search');
assert.equal(tavilySecond.status,402);assert.equal(calls,2,'402 tool cooldown must suppress repeated billable/quota calls');
assert.equal(guard.toolHealth.get('tavily')?.status,'cooldown');

globalThis.fetch=original;
console.log('NETWORK GUARD: PASS');
