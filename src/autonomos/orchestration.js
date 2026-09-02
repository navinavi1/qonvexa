import crypto from 'node:crypto';
import { planJob } from './planner.js';
import { evaluateDeliverable } from './qa-engine.js';
import { withAgentTrace } from './langfuse-observability.js';

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

  let ok=false;
  try{
    const runner=await buildGraphRunner({llm,execute,memoryPack,taskAgents,jobId,env,abortSignal,onEvent}).catch(error=>{
      onEvent('langgraph_unavailable',{error:String(error?.message||error).slice(0,180)});
      return null;
    });
    const result=runner
      ? await runner(opportunity,plan)
      : await runSequential(opportunity,plan,{llm,execute,memoryPack,taskAgents,jobId,env,abortSignal,onEvent});
    ok=true;
    return result;
  }finally{
    // Guaranteed lifecycle closure for success, QA failure, LLM failure, tool failure,
    // cancellation, and graph errors. No task worker survives a finished job.
    taskAgents?.retireJob(jobId,{ok,error:ok?'':'job_execution_failed'});
  }
}

async function buildGraphRunner({llm,execute,memoryPack,taskAgents,jobId,env,abortSignal,onEvent}){
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
      taskAgents?.markJobPhase(jobId,'executing');
      const deliverable=await execute({...state.opportunity,__plan:state.plan,__memoryContext:memoryPack.context});
      return{deliverable};
    })
    .addNode('qa',async state=>{
      taskAgents?.markJobPhase(jobId,'qa');
      const qa=await evaluateDeliverable(state.opportunity,state.deliverable,{llm,abortSignal,env});
      onEvent('qa_evaluated',{ok:qa.ok,score:qa.score,mode:qa.mode});
      if(!qa.ok)throw new Error(`qa_failed:${qa.reasons.join(',').slice(0,180)}`);
      return{qa,deliverable:attachEvidence(state.deliverable,state.plan,qa,memoryPack.hits)};
    })
    .addEdge(START,'executor').addEdge('executor','qa').addEdge('qa',END)
    .compile(checkpointer?{checkpointer}:undefined);
  return async(opportunity,plan)=>{
    const threadId=`autonomos-${opportunity.source||'market'}-${opportunity.externalId||crypto.randomUUID()}`;
    const result=await graph.invoke({opportunity,plan},{configurable:{thread_id:threadId}});
    onEvent('langgraph_completed',{threadId,persistentCheckpointing:Boolean(checkpointer)});
    return result.deliverable;
  };
}

async function runSequential(opportunity,plan,{llm,execute,memoryPack,taskAgents,jobId,env,abortSignal,onEvent}){
  if(abortSignal?.aborted)throw new Error('job_cancelled_by_emergency_stop');
  taskAgents?.markJobPhase(jobId,'executing');
  const deliverable=await execute({...opportunity,__plan:plan,__memoryContext:memoryPack.context});
  taskAgents?.markJobPhase(jobId,'qa');
  const qa=await evaluateDeliverable(opportunity,deliverable,{llm,abortSignal,env});
  onEvent('qa_evaluated',{ok:qa.ok,score:qa.score,mode:qa.mode});
  if(!qa.ok)throw new Error(`qa_failed:${qa.reasons.join(',').slice(0,180)}`);
  return attachEvidence(deliverable,plan,qa,memoryPack.hits);
}

function attachEvidence(deliverable,plan,qa,memoryHits){
  return {...deliverable,evidence:{...(deliverable.evidence||{}),plan,qa,memoryHits}};
}
