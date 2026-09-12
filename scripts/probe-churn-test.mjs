import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshCapabilities } from '../src/autonomos/capability-registry.js';
import { TOOL_COST_ESTIMATES_USD } from '../src/autonomos/tools.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'probe-churn-'));
let checks=0;
const eq=(a,b,label)=>{assert.deepEqual(a,b,label+' (got '+JSON.stringify(a)+')');checks++;};
const ok=(cond,label)=>{assert.ok(cond,label);checks++;};

const env=()=>({STORAGE_DIR:root,AUTONOMOS_STORAGE_DIR:root,COMPOSIO_API_KEY:'ck-test',E2B_API_KEY:'e2b-test',GITHUB_TOKEN:'ghp-test'});
let shellProbes=0, httpCalls=[];
const shellProbe=async()=>{shellProbes++;return{ok:true,stdout:'{"python":true,"node":true,"pillow":true,"ffmpeg":true}'};};
const fetchImpl=async(url)=>{
  httpCalls.push(String(url));
  if(String(url).includes('connected_accounts'))return{ok:true,status:200,json:async()=>({items:[{status:'ACTIVE',toolkit_slug:'gmail'}],next_cursor:''})};
  return{ok:true,status:200,json:async()=>({login:'bot'}),headers:{get:()=>''}};
};
const reset=()=>{shellProbes=0;httpCalls=[];};

// 1. A Composio gap must not boot an E2B sandbox.
reset();
await refreshCapabilities(env(),{force:true,only:'apps',fetchImpl,shellProbe});
eq(shellProbes,0,'apps-only refresh started no sandbox');
ok(httpCalls.some(u=>u.includes('connected_accounts')),'apps-only refresh did query Composio');
ok(!httpCalls.some(u=>u.includes('/user')),'apps-only refresh did not touch GitHub');

// 2. A GitHub gap must not boot an E2B sandbox either.
reset();
await refreshCapabilities(env(),{only:'github',fetchImpl,shellProbe});
eq(shellProbes,0,'github-only refresh started no sandbox');
ok(httpCalls.some(u=>u.includes('/user')),'github-only refresh did query GitHub');

// 3. The shell branch still probes when it is the one being asked for.
reset();
await refreshCapabilities(env(),{force:true,only:'shell',fetchImpl,shellProbe});
eq(shellProbes,1,'shell-only refresh did probe the sandbox');
ok(!httpCalls.some(u=>u.includes('connected_accounts')),'shell-only refresh did not touch Composio');

// 4. An unscoped refresh still covers everything, so nothing silently stops being verified.
reset();
await refreshCapabilities(env(),{force:true,fetchImpl,shellProbe});
eq(shellProbes,1,'unscoped refresh probes the sandbox once');
ok(httpCalls.some(u=>u.includes('connected_accounts'))&&httpCalls.some(u=>u.includes('/user')),'unscoped refresh covers apps and github');

// 5. A fresh proof is not re-probed: this is what turns 150 sandboxes a day back into 4.
reset();
await refreshCapabilities(env(),{only:'shell',fetchImpl,shellProbe});
eq(shellProbes,0,'a still-fresh shell proof is reused instead of re-probed');

// 6. Tool prices must stay near the invoice. $0.09 over 699 sandboxes is $0.000129 each;
//    the old $0.03 was ~230x that and starved the earned-spend gate.
const measuredPerSandbox=0.09/699;
ok(TOOL_COST_ESTIMATES_USD.run_shell<0.003,'run_shell is no longer priced like a rounding error the gate cannot afford');
ok(TOOL_COST_ESTIMATES_USD.run_shell>=measuredPerSandbox,'run_shell still has headroom over the measured cost');
ok(TOOL_COST_ESTIMATES_USD.run_shell<=measuredPerSandbox*10,'run_shell headroom stays within 10x of measured');
eq(TOOL_COST_ESTIMATES_USD.run_python,TOOL_COST_ESTIMATES_USD.run_shell,'python and shell share one sandbox price');
ok(TOOL_COST_ESTIMATES_USD.app_action<=0.0003,'Composio priced at its published per-call rate');
ok(TOOL_COST_ESTIMATES_USD.web_search===0&&TOOL_COST_ESTIMATES_USD.open_pull_request===0,'free tools stay free');

// 7. A $1 earned budget must now buy real work, not two shell calls.
const callsPerDollar=Math.floor(1/TOOL_COST_ESTIMATES_USD.run_shell);
ok(callsPerDollar>=2000,'one earned dollar buys at least 2000 shell calls, got '+callsPerDollar);

fs.rmSync(root,{recursive:true,force:true});
console.log('probe-churn-test OK ('+checks+' checks)');
