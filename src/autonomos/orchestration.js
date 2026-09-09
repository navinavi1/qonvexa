import { SandboxSession } from './sandbox-session.js';
import { checkpointExecution } from './execution-checkpoint.js';
import { postgresPoolConfig } from './memory.js';
import { executionEvidenceSummary, executionFailureCodes } from './execution-diagnostics.js';
import crypto from 'node:crypto';
import { planJob } from './planner.js';
import { evaluateDeliverable } from './qa-engine.js';
import { withAgentTrace } from './langfuse-observability.js';
import { buildAcceptanceContract, buildPhaseAcceptanceContract, buildEvidencePack } from './acceptance-engine.js';

const SPECIALIST_TOOLS=Object.freeze({
  'research-worker':['web_search','web_scrape','browser_read'],
  'code-worker':['run_python','run_shell','open_pull_request','store_artifact','coderabbit_review','deploy_webhook'],
  'automation-worker':['app_tool_search','app_action','browser_read','browser_action','store_artifact'],
  'content-worker':['store_artifact']
});
const HANDOFF_ROLE_ORDER=Object.freeze(['research-worker','code-worker','automation-worker','content-worker']);

export function distinctExecutionRoles(plan){const present=new Set((plan?.steps||[]).map(s=>s?.role).filter(Boolean));return HANDOFF_ROLE_ORDER.filter(role=>present.has(role));}

export async function runHandoffChain(roles,opportunity,plan,{execute,taskAgents,jobId,onEvent}){
  let briefing='';const allToolCalls=[],phases=[];let totalPromptTokens=0,totalCompletionTokens=0,totalToolCostUsd=0,last=null;
  const jobContract=opportunity.acceptanceContract||buildAcceptanceContract(opportunity);
  for(const role of roles){
    taskAgents?.markJobPhase(jobId,'executing',{onlyRole:role});onEvent('specialist_handoff',{jobId,role,briefingChars:briefing.length});
    const toolFilter=SPECIALIST_TOOLS[role]||null;const phaseContract=buildPhaseAcceptanceContract(jobContract,role);
    const phaseOpportunity={...opportunity,acceptanceContract:phaseContract,__phaseRole:role,__jobAcceptanceContract:jobContract};
    const phaseResult=await execute(phaseOpportunity,{toolFilter,briefing,phaseRole:role});taskAgents?.markJobPhase(jobId,'done',{onlyRole:role});
    const calls=phaseResult?.evidence?.toolCalls||[];allToolCalls.push(...calls);totalPromptTokens+=Number(phaseResult?.evidence?.usage?.prompt_tokens||0);totalCompletionTokens+=Number(phaseResult?.evidence?.usage?.completion_tokens||0);totalToolCostUsd+=Number(phaseResult?.evidence?.toolCostUsd||0);
    phases.push({role,content:String(phaseResult?.content||'').slice(0,12000),hash:phaseResult?.hash||'',toolCalls:calls,qaGates:phaseResult?.evidence?.qaGates||null,acceptance:phaseResult?.evidence?.acceptance||null});
    briefing=`[${role} produced]\n${String(phaseResult?.content||'').slice(0,5000)}\n[tool evidence]\n${JSON.stringify(calls).slice(0,4000)}`;last=phaseResult;
  }
  const merged={...last,evidence:{...(last?.evidence||{}),usage:{prompt_tokens:totalPromptTokens,completion_tokens:totalCompletionTokens},toolCostUsd:totalToolCostUsd,toolCalls:allToolCalls,handoffRoles:roles,phases,acceptanceContract:jobContract}};
  merged.evidence.evidencePack=buildEvidencePack({jobId,opportunity:{...opportunity,acceptanceContract:jobContract},deliverable:merged,plan});return merged;
}

export async function orchestrateJob(opportunity,opts={}){
  const {env=process.env}=opts;const sandboxSession=new SandboxSession({env});const execute=(op,phaseOpts={})=>opts.execute(op,{...phaseOpts,sandboxSession});
  try{return await withAgentTrace('autonomos-paid-job',{source:opportunity?.source||'',externalId:opportunity?.externalId||'',title:String(opportunity?.title||'').slice(0,200)},()=>orchestrateJobCore(opportunity,{...opts,execute}),{env});}
  finally{await sandboxSession.close();}
}

async function orchestrateJobCore(opportunity,{llm,execute,memory=null,taskAgents=null,jobId='',env=process.env,abortSignal=null,onEvent=()=>{},maxTaskAgents=null,store=null}={}){
  const checkpoint=checkpointExecution(store,jobId);const rawExecute=execute;execute=(op,opts={})=>checkpoint(`execute:${opts.phaseRole||'single'}`,()=>rawExecute(op,opts),{retrySafe:opportunity.executionKind==='repository'||opportunity.executionRetrySafe===true});
  onEvent('job_memory_started',{jobId});const memoryPack=memory?.contextForOpportunity?await memory.contextForOpportunity(opportunity,{limit:Number(env.AUTONOMOS_MEMORY_RECALL_LIMIT||5)}).catch(()=>({context:'',hits:[]})):{context:'',hits:[]};
  if(memoryPack.hits?.length)onEvent('memory_recalled',{count:memoryPack.hits.length,keys:memoryPack.hits.map(x=>x.key).slice(0,8)});
  onEvent('job_planning_started',{jobId});const plan=await checkpoint('plan',async()=>{try{return await planJob(opportunity,{llm,env,abortSignal,memoryContext:memoryPack.context});}catch(error){error.safeToRetry=true;throw error;}},{retrySafe:true});
  onEvent('job_planned',{source:plan.source,steps:plan.steps?.length||0});const spawned=taskAgents?.spawnForPlan({jobId,opportunity,plan,maxAgents:maxTaskAgents})||[];if(spawned.length)onEvent('task_team_ready',{jobId,count:spawned.length,roles:spawned.map(x=>x.role)});const handoffRoles=distinctExecutionRoles(plan).slice(0,Math.max(1,Number(maxTaskAgents||8)));
  let ok=false;try{
    onEvent('job_graph_setup_started',{jobId});const runner=await buildGraphRunner({llm,execute,memoryPack,taskAgents,jobId,env,abortSignal,onEvent,handoffRoles}).catch(error=>{onEvent('langgraph_unavailable',{error:String(error?.message||error).slice(0,180)});return null;});
    onEvent('job_execution_started',{jobId});const result=await checkpoint('verified-result',()=>runner?runner(opportunity,plan):runSequential(opportunity,plan,{llm,execute,memoryPack,taskAgents,jobId,env,abortSignal,onEvent,handoffRoles}),{retrySafe:true});ok=true;return result;
  }finally{taskAgents?.retireJob(jobId,{ok,error:ok?'':'job_execution_failed'});}
}

async function buildGraphRunner({llm,execute,memoryPack,taskAgents,jobId,env,abortSignal,onEvent,handoffRoles}){
  const {StateGraph,Annotation,START,END}=await import('@langchain/langgraph');let checkpointer;
  if(env.DATABASE_URL){try{const {PostgresSaver}=await import('@langchain/langgraph-checkpoint-postgres');const {Pool}=await import('pg');checkpointer=new PostgresSaver(new Pool(postgresPoolConfig(env)),undefined,{schema:env.AUTONOMOS_LANGGRAPH_SCHEMA||'public'});await checkpointer.setup();}catch(error){await checkpointer?.end?.().catch(()=>{});checkpointer=undefined;onEvent('langgraph_checkpoint_unavailable',{error:String(error?.message||error).slice(0,160)});}}
  const State=Annotation.Root({opportunity:Annotation(),plan:Annotation(),deliverable:Annotation(),qa:Annotation()});
  const graph=new StateGraph(State)
    .addNode('executor',async state=>{if(abortSignal?.aborted)throw new Error('job_cancelled_by_emergency_stop');const deliverable=handoffRoles.length>=2?await runHandoffChain(handoffRoles,{...state.opportunity,__memoryContext:memoryPack.context},state.plan,{execute,taskAgents,jobId,onEvent}):await execute({...state.opportunity,__plan:state.plan,__memoryContext:memoryPack.context});return{deliverable};})
    .addNode('qa',async state=>{taskAgents?.markJobPhase(jobId,'qa');const {qa,deliverable}=await reviewWithRepair(state.opportunity,state.deliverable,{llm,abortSignal,env,execute,onEvent});return{qa,deliverable:attachEvidence(deliverable,state.plan,qa,memoryPack.hits,state.opportunity,jobId)};})
    .addEdge(START,'executor').addEdge('executor','qa').addEdge('qa',END).compile(checkpointer?{checkpointer}:undefined);
  return async(opportunity,plan)=>{const threadId=`autonomos-${opportunity.source||'market'}-${opportunity.externalId||crypto.randomUUID()}`;try{const result=await graph.invoke({opportunity,plan},{configurable:{thread_id:threadId}});onEvent('langgraph_completed',{threadId,persistentCheckpointing:Boolean(checkpointer),handoffRoles});return result.deliverable;}finally{await checkpointer?.end?.().catch(()=>{});}};
}

async function runSequential(opportunity,plan,{llm,execute,memoryPack,taskAgents,jobId,env,abortSignal,onEvent,handoffRoles}){
  if(abortSignal?.aborted)throw new Error('job_cancelled_by_emergency_stop');const deliverable=handoffRoles.length>=2?await runHandoffChain(handoffRoles,{...opportunity,__memoryContext:memoryPack.context},plan,{execute,taskAgents,jobId,onEvent}):await execute({...opportunity,__plan:plan,__memoryContext:memoryPack.context});taskAgents?.markJobPhase(jobId,'qa');const checked=await reviewWithRepair(opportunity,deliverable,{llm,abortSignal,env,execute,onEvent});return attachEvidence(checked.deliverable,plan,checked.qa,memoryPack.hits,opportunity,jobId);
}

export async function reviewWithRepair(opportunity,deliverable,{llm,abortSignal,env={},execute,onEvent=()=>{}}={}){
  let qa=await evaluateDeliverable(opportunity,deliverable,{llm,abortSignal,env});onEvent('qa_evaluated',{ok:qa.ok,score:qa.score,mode:qa.mode,reasons:qa.reasons.flatMap(executionFailureCodes),evidence:executionEvidenceSummary(deliverable)});
  const maxRepairs=Math.max(0,Math.min(5,Number(env.AUTONOMOS_QA_REPAIR_ATTEMPTS||3)));
  let repairs=0;
  while(!qa.ok&&repairs<maxRepairs&&!abortSignal?.aborted&&typeof execute==='function'){
    const prior=deliverable.evidence||{};
    // Never repeat a phase after an irreversible side effect. Such jobs go to durable
    // recovery/reconciliation, not a blind repair that might double-post/deploy/submit.
    const externalEffect=(prior.toolCalls||[]).some(t=>['open_pull_request','app_action','deploy_webhook','browser_task','browser_action'].includes(t.tool));
    if(externalEffect)break;
    repairs++;
    onEvent('qa_repair_started',{attempt:repairs,reasons:qa.reasons});
    const strategy=repairs===1?'Repair the existing result and re-run failed verification.':repairs===2?'Change strategy: inspect the prior tool failures, simplify the approach, and independently verify the required acceptance criteria.':'Final bounded recovery: produce the smallest complete verifiable deliverable that satisfies every explicit requirement; do not return a plan or placeholder.';
    const repaired=await execute(opportunity,{phaseRole:`qa-repair-${repairs}`,toolFilter:['run_python','run_shell','web_search','web_scrape','store_artifact','coderabbit_review'],briefing:`${strategy}\nQA found: ${qa.reasons.join('; ')}.\nPrevious output:\n${String(deliverable.content||'').slice(0,3200)}\nPrior evidence summary:\n${JSON.stringify(executionEvidenceSummary(deliverable)).slice(0,1800)}`});
    const next=repaired.evidence||{};
    deliverable={...repaired,evidence:{...next,toolCalls:[...(prior.toolCalls||[]),...(next.toolCalls||[])],toolCostUsd:Number(prior.toolCostUsd||0)+Number(next.toolCostUsd||0),usage:{prompt_tokens:Number(prior.usage?.prompt_tokens||0)+Number(next.usage?.prompt_tokens||0),completion_tokens:Number(prior.usage?.completion_tokens||0)+Number(next.usage?.completion_tokens||0)},qaRepairAttempts:repairs}};
    qa=await evaluateDeliverable(opportunity,deliverable,{llm,abortSignal,env});onEvent('qa_repair_evaluated',{attempt:repairs,ok:qa.ok,score:qa.score,mode:qa.mode,reasons:qa.reasons.flatMap(executionFailureCodes),evidence:executionEvidenceSummary(deliverable)});
  }
  if(!qa.ok)throw new Error(`qa_failed:${qa.reasons.join(',').slice(0,180)}`);return{qa,deliverable};
}

function attachEvidence(deliverable,plan,qa,memoryHits,opportunity,jobId){const merged={...deliverable,evidence:{...(deliverable.evidence||{}),plan,qa,memoryHits}};merged.evidence.evidencePack=buildEvidencePack({jobId,opportunity:{...opportunity,acceptanceContract:opportunity?.acceptanceContract||buildAcceptanceContract(opportunity)},deliverable:merged,plan,qa});return merged;}
