import assert from 'node:assert/strict';
import { TaskAgentRuntime, collapseWorkerSteps } from '../src/autonomos/task-agent-runtime.js';
import { orchestrateJob } from '../src/autonomos/orchestration.js';
import { createLlmClient } from '../src/autonomos/llm.js';

const events=[];
const workforce=new TaskAgentRuntime({env:{AUTONOMOS_MAX_TASK_AGENTS_PER_JOB:'4'},onEvent:(type,detail)=>events.push({type,detail})});
const plan={steps:[
  {id:'r1',role:'research-worker',action:'research'},
  {id:'c1',role:'code-worker',action:'write module'},
  {id:'c2',role:'code-worker',action:'write tests'},
  {id:'c3',role:'code-worker',action:'build'},
  {id:'a1',role:'automation-worker',action:'deploy'},
  {id:'q',role:'qa-evaluator',action:'review'}
]};
assert.deepEqual(collapseWorkerSteps(plan.steps,{}).map(x=>x.role),['research-worker','code-worker','automation-worker']);
const first=workforce.spawnForPlan({jobId:'job-1',opportunity:{title:'Build API'},plan,maxAgents:12});
assert.equal(first.length,3,'steps must collapse to unique specialist roles');
const again=workforce.spawnForPlan({jobId:'job-1',opportunity:{title:'Build API'},plan,maxAgents:12});
assert.equal(again.length,3,'same job must reuse its workforce');
assert.equal(workforce.summary().active,3,'duplicate spawn must not create duplicate workers');
workforce.retireJob('job-1',{ok:true});
assert.equal(workforce.summary().active,0,'finished job must have zero active workers');

// An execution error must never trigger a second execution through a graph fallback and
// must always retire the task team.
let executeCalls=0;
const failingWorkforce=new TaskAgentRuntime({env:{},onEvent:()=>{}});
await assert.rejects(()=>orchestrateJob({source:'test',externalId:'one',title:'Write code',description:'Do work'}, {
  jobId:'job-fail', env:{}, taskAgents:failingWorkforce,
  llm:{enabled:false},
  execute:async()=>{executeCalls++;throw new Error('simulated_execution_failure');},
  onEvent:()=>{}
}),/simulated_execution_failure/);
assert.equal(executeCalls,1,'failed execution must never be replayed by orchestration fallback');
assert.equal(failingWorkforce.summary().active,0,'failed job must retire all task agents');

// Reproduce the production symptom: an OpenAI-compatible endpoint returns HTTP 200 but
// no visible content on the first reasoning completion. The client must retry with a
// larger completion budget rather than surfacing llm_empty_response immediately.
const originalFetch=globalThis.fetch;
let calls=0;
globalThis.fetch=async(_url,init)=>{
  calls++;
  const body=JSON.parse(init.body);
  if(calls===1)return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:''}}],usage:{prompt_tokens:10,completion_tokens:100}}),{status:200,headers:{'content-type':'application/json'}});
  assert.ok(Number(body.max_completion_tokens||0)>=3200,'retry must increase completion budget');
  return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'usable result'}}],usage:{prompt_tokens:10,completion_tokens:20}}),{status:200,headers:{'content-type':'application/json'}});
};
try{
  const llm=createLlmClient({AUTONOMOS_LLM_BASE_URL:'https://example.test/v1',AUTONOMOS_LLM_API_KEY:'test',AUTONOMOS_LLM_MODEL:'gpt-5-mini'});
  const result=await llm.complete({messages:[{role:'user',content:'work'}],maxTokens:800});
  assert.equal(result.ok,true);
  assert.equal(result.text,'usable result');
  assert.equal(calls,2);
}finally{globalThis.fetch=originalFetch;}

console.log('AutonomOS workforce test PASS: bounded dynamic roles, no duplicate execution, guaranteed cleanup, empty-LLM recovery');
