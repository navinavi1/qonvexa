import crypto from 'node:crypto';
import { planJob } from './planner.js';
import { evaluateDeliverable } from './qa-engine.js';
import { withAgentTrace } from './langfuse-observability.js';

export async function orchestrateJob(opportunity,opts={}){
  const {env=process.env}=opts;
  return withAgentTrace('autonomos-paid-job',{source:opportunity?.source||'',externalId:opportunity?.externalId||'',title:String(opportunity?.title||'').slice(0,200)},()=>orchestrateJobCore(opportunity,opts),{env});
}

async function orchestrateJobCore(opportunity,{llm,execute,memory=null,taskAgents=null,jobId='',env=process.env,abortSignal=null,onEvent=()=>{}}={}){
  const memoryPack=memory?.contextForOpportunity?await memory.contextForOpportunity(opportunity,{limit:Number(env.AUTONOMOS_MEMORY_RECALL_LIMIT||5)}).catch(()=>({context:'',hits:[]})):{context:'',hits:[]};
  if(memoryPack.hits?.length)onEvent('memory_recalled',{count:memoryPack.hits.length,keys:memoryPack.hits.map(x=>x.key).slice(0,8)});
  try{
    const {StateGraph,Annotation,START,END}=await import('@langchain/langgraph');
    let checkpointer;
    if(env.DATABASE_URL){
      try{const {PostgresSaver}=await import('@langchain/langgraph-checkpoint-postgres');checkpointer=PostgresSaver.fromConnString(env.DATABASE_URL,{schema:env.AUTONOMOS_LANGGRAPH_SCHEMA||'public'});await checkpointer.setup();}catch(error){onEvent('langgraph_checkpoint_unavailable',{error:String(error?.message||error).slice(0,160)});}
    }
    const State=Annotation.Root({opportunity:Annotation(),plan:Annotation(),deliverable:Annotation(),qa:Annotation()});
    const graph=new StateGraph(State)
      .addNode('planner',async state=>{const plan=await planJob(state.opportunity,{llm,env,abortSignal,memoryContext:memoryPack.context});onEvent('job_planned',{source:plan.source,steps:plan.steps?.length||0});if(taskAgents){const spawned=taskAgents.spawnForPlan({jobId,opportunity:state.opportunity,plan});onEvent('task_team_created',{jobId,count:spawned.length,roles:spawned.map(x=>x.role)});}return{plan};})
      .addNode('executor',async state=>{if(abortSignal?.aborted)throw new Error('job_cancelled_by_emergency_stop');taskAgents?.markJobPhase(jobId,'executing');const deliverable=await execute({...state.opportunity,__plan:state.plan,__memoryContext:memoryPack.context});return{deliverable};})
      .addNode('qa',async state=>{taskAgents?.markJobPhase(jobId,'qa');const qa=await evaluateDeliverable(state.opportunity,state.deliverable,{llm,abortSignal,env});onEvent('qa_evaluated',{ok:qa.ok,score:qa.score,mode:qa.mode});if(!qa.ok)throw new Error(`qa_failed:${qa.reasons.join(',').slice(0,180)}`);return{qa,deliverable:{...state.deliverable,evidence:{...(state.deliverable.evidence||{}),plan:state.plan,qa,memoryHits:memoryPack.hits}}};})
      .addEdge(START,'planner').addEdge('planner','executor').addEdge('executor','qa').addEdge('qa',END)
      .compile(checkpointer?{checkpointer}:undefined);
    const threadId=`autonomos-${opportunity.source||'market'}-${opportunity.externalId||crypto.randomUUID()}`;
    const result=await graph.invoke({opportunity},{configurable:{thread_id:threadId}});
    onEvent('langgraph_completed',{threadId,persistentCheckpointing:Boolean(checkpointer)});
    taskAgents?.retireJob(jobId,{ok:true});
    return result.deliverable;
  }catch(error){
    if(/^qa_failed:|job_cancelled_by_emergency_stop/.test(String(error?.message||''))){taskAgents?.retireJob(jobId,{ok:false,error:String(error?.message||error)});throw error;}
    onEvent('langgraph_fallback',{error:String(error?.message||error).slice(0,180)});
    const plan=await planJob(opportunity,{llm,env,abortSignal,memoryContext:memoryPack.context});onEvent('job_planned',{source:plan.source,steps:plan.steps?.length||0});if(taskAgents){const spawned=taskAgents.spawnForPlan({jobId,opportunity,plan});onEvent('task_team_created',{jobId,count:spawned.length,roles:spawned.map(x=>x.role)});taskAgents.markJobPhase(jobId,'executing');}
    const deliverable=await execute({...opportunity,__plan:plan,__memoryContext:memoryPack.context});
    const qa=await evaluateDeliverable(opportunity,deliverable,{llm,abortSignal,env});onEvent('qa_evaluated',{ok:qa.ok,score:qa.score,mode:qa.mode});
    if(!qa.ok){const error=new Error(`qa_failed:${qa.reasons.join(',').slice(0,180)}`);taskAgents?.retireJob(jobId,{ok:false,error:error.message});throw error;}
    taskAgents?.retireJob(jobId,{ok:true});
    return {...deliverable,evidence:{...(deliverable.evidence||{}),plan,qa,memoryHits:memoryPack.hits}};
  }
}
