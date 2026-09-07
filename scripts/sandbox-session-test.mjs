import assert from 'node:assert/strict';
import { SandboxSession } from '../src/autonomos/sandbox-session.js';

let creates=0,kills=0;
const sandbox={kill:async()=>{kills++;}};
const session=new SandboxSession({env:{AUTONOMOS_E2B_SESSION_TIMEOUT_MS:'60000'},create:async()=>{
  creates++;
  if(creates===1)throw new Error('transient sandbox create failure');
  return sandbox;
}});

await assert.rejects(()=>session.get(),/transient sandbox create failure/);
const recovered=await session.get();
assert.equal(recovered,sandbox,'second explicit tool attempt must receive a fresh sandbox');
assert.equal(creates,2,'failed creation promise must not poison the execution session');
assert.equal(await session.get(),sandbox,'successful sandbox must be reused within the execution');
assert.equal(creates,2,'successful sandbox must not be silently replaced');
await session.close();
assert.equal(kills,1,'successful sandbox must be killed exactly once');
await assert.rejects(()=>session.get(),/sandbox_session_closed/);

console.log('SANDBOX SESSION: 1/1 passed');
