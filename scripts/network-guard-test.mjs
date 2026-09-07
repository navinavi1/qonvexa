import assert from 'node:assert/strict';
import { installNetworkGuard } from '../src/autonomos/network-guard.js';

const original=globalThis.fetch;
let calls=0;
globalThis.fetch=async input=>{calls++;const url=String(input);if(url.includes('workprotocol.ai'))return new Response('{}',{status:429});return new Response('{}',{status:200});};

const env={AUTONOMOS_DISABLED_MARKETS:'t2000,clawlancer,agenthansa,superteam,skarnfall',AUTONOMOS_RATE_LIMIT_COOLDOWN_MS:'60000'};
installNetworkGuard({env,logger:{info(){},warn(){}}});
const disabled=await fetch('https://clawlancer.ai/api/jobs');
assert.equal(disabled.status,410);
assert.equal(calls,0,'disabled source must never reach network');
const first=await fetch('https://workprotocol.ai/api/jobs');
assert.equal(first.status,429);assert.equal(calls,1);
const second=await fetch('https://workprotocol.ai/api/jobs');
assert.equal(second.status,429);assert.equal(calls,1,'429 cooldown must suppress repeated network requests');

globalThis.fetch=original;
console.log('NETWORK GUARD: PASS');
