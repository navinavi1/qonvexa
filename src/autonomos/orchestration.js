import crypto from 'node:crypto';
import { planJob } from './planner.js';
import { evaluateDeliverable } from './qa-engine.js';
import { withAgentTrace } from './langfuse-observability.js';
import { buildAcceptanceContract, buildPhaseAcceptanceContract, buildEvidencePack } from './acceptance-engine.js';

// Which tools each specialist role is scoped to during a real handoff. A research
// specialist never gets run_python; a build specialist never gets web_search. This is
// what makes it a genuine handoff rather than one call that happens to have every tool
// available regardless of which role the plan actually named for that part of the work.
const SPECIALIST_TOOLS = Object.freeze({
  'research-worker': ['web_search','web_scrape','browser_task'],
  'code-worker': ['run_python','run_shell','open_pull_request','store_artifact','coderabbit_review','deploy_webhook'],
  'automation-worker': ['app_tool_search','app_action','browser_task','store_artifact'],
  'content-worker': ['store_artifact']
});
const HANDOFF_ROLE_ORDER = Object.freeze(['research-worker','code-worker','automation-worker','content-worker']);

// The roles a plan actually names, in a fixed handoff order (research before building,
// since a build specialist benefits from research findings; the reverse rarely does).
// 'planner'/'qa-evaluator'/'job-router' are pipeline stages, not execution specialists.
export function distinctExecutionRoles(plan){
  const present=new Set((plan?.steps||[]).map(s=>s?.role).filter(Boolean));
  return HANDOFF_ROLE_ORDER.filter(role=>present.has(role));
}

// Run each specialist phase in sequence, each scoped to its own tools, each handed the
// previous specialist's actual output as briefing. Combines every phase's tool-call
// evidence into one deliverable so QA sees the complete real journey, not just the last
// phase — and reports the LAST phase's written content as the final answer, since later
// specialists are expected to build on (not just append to) earlier ones.
export async function runHandoffChain(roles,opportunity,plan,{execute,taskAgents,jobId,onEvent}){
  let briefing='';
  const allToolCalls=[];
  const phases=[];
  let totalPromptTokens=0,totalCompletionTokens=0,totalToolCostUsd=0;
  let last=null;
  const jobContract=opportunity.acceptanceContract||buildAcceptanceContract(opportunity);
  for(const role of roles){
    taskAgents?.markJobPhase(jobId,'executing',{onlyRole:role});
    onEvent('specialist_handoff',{jobId,role,briefingChars:briefing.length});
    const toolFilter=SPECIALIST_TOOLS[role]||null;
    const phaseContract=buildPhaseAcceptanceContract(jobContract,role);
    const phaseOpportunity={...opportunity,acceptanceContract:phaseContract,__phaseRole:role,__jobAcceptanceContract:jobContract};
    const phaseResult=await execute(phaseOpportunity,{toolFilter,briefing,phaseRole:role});
    taskAgents?.markJobPhase(jobId,'done',{onlyRole:role});
    const calls=phaseResult?.evidence?.toolCalls||[];
    allToolCalls.push(...calls);
    totalPromptTokens+=Number(phaseResult?.evidence?.usage?.prompt_tokens||0);
    totalCompletionTokens+=Number(phaseResult?.evidence?.usage?.completion_tokens||0);
    totalToolCostUsd+=Number(phaseResult?.evidence?.toolCostUsd||0);
    phases.push({role,content:String(phaseResult?.content||'').slice(0,12000),hash:phaseResult?.hash||'',toolCalls:calls,qaGates:phaseResult?.evidence?.qaGates||null,acceptance:phaseResult?.evidence?.acceptance||null});
    briefing=`[${role} produced]\n${String(phaseResult?.content||'').slice(0,5000)}\n[tool evidence]\n${JSON.stringify(calls).slice(0,4000)}`;
    last=phaseResult;
  }
  const merged={...last,evidence:{...(last?.evidence||{}),usage:{prompt_tokens:totalPromptTokens,completion_tokens:totalCompletionTokens},toolCostUsd:totalToolCostUsd,toolCalls:allToolCalls,handoffRoles:roles,phases,acceptanceContract:jobContract}};
  merged.evidence.evidencePack=buildEvidencePack({jobId,opportunity:{...opportunity,acceptanceContract:jobContract},deliverable:merged,plan});
  return merged;
}

export async function orchestrateJob(opportunity,opts={}){
  const {env=process.env}=opts;
  return withAgentTrace('autonomos-paid-job',{source:opportunity?.source||'',externalId:opportunity?.externalId||'',title:String(opportunity?.title||'').slice(0,200)},()=>orchestrateJobCore(opportunity,opts),{env});
}

async function orchestrateJobCore(opportunity,{llm,execute,memory=null,taskAgents=null,jobId='',env=process.env,abortSignal=null,onEvent=()=>{},maxTaskAgents=null}={}){
  const memoryPack=memory?.contextForOpportunity?await memory.contextForOpportunity(opportunity,{limit:Number(env.AUTONOMOS_MEMORY_RECALL_LIMIT||5)}).catch(()=>({context:'',hits:[]})):{context:'',hits:[]};
  if(memoryPack.hits?.length)onEvent('memory_recalled',{count:memoryPack.hits.length,keys:memoryPack.hits.map(x=>x.key).slice(0,8)});

  // Plan exactly once. The old implementation planned/spawned once in LangGraph and then
  // again in its catch fallback, which could leave 2x worker leases after an execution
  // failure. Planning is now outside the graph so graph infrastructure fallback is safe.
  const plan=await planJob(opportunity,{llm,env,abortSignal,memoryContext:memoryPack.context});
  onEvent('job_planned',{source:plan.source,steps:plan.steps?.length||0});
  const spawned=taskAgents?.spawnForPlan({jobId,opportunity,plan,maxAgents:maxTaskAgents})||[];
  if(spawned.length)onEvent('task_team_ready',{jobId,count:spawned.length,roles:spawned.map(x=>x.role)});
  const handoffRoles=distinctExecutionRoles(plan);

  let ok=false;
  try{
    const runner=await buildGraphRunner({llm,execute,memoryPack,taskAgents,jobId,env,abortSignal,onEvent,handoffRoles}).catch(error=>{
      onEvent('langgraph_unavailable',{error:String(error?.message||error).slice(0,180)});
      return null;
    });
    const result=runner
      ? await runner(opportunity,plan)
      : await runSequential(opportunity,plan,{llm,execute,memoryPack,taskAgents,jobId,env,abortSignal,onEvent,handoffRoles});
    ok=true;
    return result;
  }finally{
    // Guaranteed lifecycle closure for success, QA failure, LLM failure, tool failure,
    // cancellation, and graph errors. No task worker survives a finished job.
    taskAgents?.retireJob(jobId,{ok,error:ok?'':'job_execution_failed'});
  }
}

async function buildGraphRunner({llm,execute,memoryPack,taskAgents,jobId,env,abortSignal,onEvent,handoffRoles}){
  const {StateGraph,Annotation,START,END}=await import('@langchain/langgraph');
  let checkpointer;
  if(env.DATABASE_URL){
    try{
      const {PostgresSaver}=await import('@langchain/langgraph-checkpoint-postgres');
      checkpointer=PostgresSaver.fromConnString(env.DATABASE_URL,{schema:env.AUTONOMOS_LANGGRAPH_SCHEMA||'public'});
      await checkpointer.setup();
    }catch(error){onEvent('langgraph_checkpoint_unavailable',{error:String(error?.message||error).slice(0,160)});}
  }
  const State=Annotation.Root({opportunity:Annotation(),plan:Annotation(),deliverable:Annotation(),qa:Annotation()});
  const graph=new StateGraph(State)
    .addNode('executor',async state=>{
      if(abortSignal?.aborted)throw new Error('job_cancelled_by_emergency_stop');
      const deliverable=handoffRoles.length>=2
        ? await runHandoffChain(handoffRoles,{...state.opportunity,__memoryContext:memoryPack.context},state.plan,{execute,taskAgents,jobId,onEvent})
        : await execute({...state.opportunity,__plan:state.plan,__memoryContext:memoryPack.context});
      return{deliverable};
    })
    .addNode('qa',async state=>{
      taskAgents?.markJobPhase(jobId,'qa');
      const qa=await evaluateDeliverable(state.opportunity,state.deliverable,{llm,abortSignal,env});
      onEvent('qa_evaluated',{ok:qa.ok,score:qa.score,mode:qa.mode});
      if(!qa.ok)throw new Error(`qa_failed:${qa.reasons.join(',').slice(0,180)}`);
      return{qa,deliverable:attachEvidence(state.deliverable,state.plan,qa,memoryPack.hits,state.opportunity,jobId)};
    })
    .addEdge(START,'executor').addEdge('executor','qa').addEdge('qa',END)
    .compile(checkpointer?{checkpointer}:undefined);
  return async(opportunity,plan)=>{
    const threadId=`autonomos-${opportunity.source||'market'}-${opportunity.externalId||crypto.randomUUID()}`;
    const result=await graph.invoke({opportunity,plan},{configurable:{thread_id:threadId}});
    onEvent('langgraph_completed',{threadId,persistentCheckpointing:Boolean(checkpointer),handoffRoles});
    return result.deliverable;
  };
}

async function runSequential(opportunity,plan,{llm,execute,memoryPack,taskAgents,jobId,env,abortSignal,onEvent,handoffRoles}){
  if(abortSignal?.aborted)throw new Error('job_cancelled_by_emergency_stop');
  const deliverable=handoffRoles.length>=2
    ? await runHandoffChain(handoffRoles,{...opportunity,__memoryContext:memoryPack.context},plan,{execute,taskAgents,jobId,onEvent})
    : await execute({...opportunity,__plan:plan,__memoryContext:memoryPack.context});
  taskAgents?.markJobPhase(jobId,'qa');
  const qa=await evaluateDeliverable(opportunity,deliverable,{llm,abortSignal,env});
  onEvent('qa_evaluated',{ok:qa.ok,score:qa.score,mode:qa.mode});
  if(!qa.ok)throw new Error(`qa_failed:${qa.reasons.join(',').slice(0,180)}`);
  return attachEvidence(deliverable,plan,qa,memoryPack.hits,opportunity,jobId);
}

function attachEvidence(deliverable,plan,qa,memoryHits,opportunity,jobId){
  const merged={...deliverable,evidence:{...(deliverable.evidence||{}),plan,qa,memoryHits}};
  merged.evidence.evidencePack=buildEvidencePack({jobId,opportunity:{...opportunity,acceptanceContract:opportunity?.acceptanceContract||buildAcceptanceContract(opportunity)},deliverable:merged,plan,qa});
  return merged;
}
