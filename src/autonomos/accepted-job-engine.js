import path from 'node:path';
import { TaskAgentRuntime } from './task-agent-runtime.js';
const teams=new Map();
import { orchestrateJob } from './orchestration.js';
import { registerAcceptedExecution, executeExternalOpportunity } from './job-executor.js';
import { executeCodingJob } from './coding-job.js';
import { isRetiredMarket } from './retired-markets.js';

// All provider lanes use the same planner, checkpoint and QA/repair engine.
// A repository task is an executor strategy; it does not own a second lifecycle.
async function runAcceptedJobCore({opportunity,capability,llm,budget,env=process.env,config,store,revision=0,maxRepairs=3,feedback='',onPhase=()=>{},abortSignal}){
 if(!opportunity.jobId||opportunity.claimMode!=='already_assigned')throw Error('accepted_job_required');
 if(isRetiredMarket(opportunity))throw Error('DO_NOT_RESTORE');
 const root=path.resolve(env.STORAGE_DIR||'data');let taskAgents=teams.get(root);if(!taskAgents){taskAgents=new TaskAgentRuntime({env});teams.set(root,taskAgents);}
 const persistTeams=()=>store.writeJson('accepted-task-squads.json',{pid:process.pid,updatedAt:new Date().toISOString(),agents:taskAgents.snapshot()});
 const repository=opportunity.executionKind==='repository';
 const executionEnv={...env,AUTONOMOS_QA_REPAIR_ATTEMPTS:String(Math.max(0,Math.min(4,maxRepairs-1)))};
 const op={...opportunity,description:opportunity.description+(feedback?'\nClient feedback:\n'+feedback:'')};
 const execute=async(planned,options={})=>{
  onPhase(options.phaseRole?.startsWith('qa-repair')?'repairing':'executing',{phaseRole:options.phaseRole||'executor'});
  if(repository)return executeCodingJob({title:planned.title,description:planned.description+'\n'+(options.briefing||''),repoUrl:planned.repoUrl,ref:planned.ref},{env:executionEnv,llm,onCost:n=>budget.charge(n),signal:abortSignal,maxSpendUsd:budget.remaining}).catch(error=>{error.safeToRetry=true;throw error;});
  return executeExternalOpportunity(planned,capability,{...options,env:executionEnv,llm,budget,config,abortSignal});
 };
 let deliverable;try{deliverable=await orchestrateJob(op,{execute,llm,taskAgents,env:executionEnv,store,jobId:op.jobId+':revision:'+revision,abortSignal,maxTaskAgents:repository?1:undefined,onEvent:(type,detail)=>{if(type==='job_planning_started')onPhase('planning',detail);if(type==='qa_evaluated'||type==='qa_repair_evaluated')onPhase('qa',detail);persistTeams();}});}finally{persistTeams();}
 const qa=deliverable.evidence?.qa;if(!qa?.ok)throw Error('accepted_work_qa_not_verified');
 const history=store.readNdjson('accepted-work-learning.ndjson',-1);
 if(!history.some(x=>x.jobId===op.jobId&&x.revision===revision))store.append('accepted-work-learning.ndjson',{at:new Date().toISOString(),jobId:op.jobId,source:op.source,revision,skill:capability?.skill,qaScore:qa.score,costUsd:budget?.spent||0,outcome:'QA_PASSED_AWAITING_DELIVERY'});
 onPhase('delivery_ready',{qaScore:qa.score});return {deliverable,qa};
}

export async function runAcceptedJob(options){
 const scope=registerAcceptedExecution();
 const abortSignal=options.abortSignal?AbortSignal.any([options.abortSignal,scope.controller.signal]):scope.controller.signal;
 try{return await runAcceptedJobCore({...options,abortSignal});}finally{scope.release();}
}
