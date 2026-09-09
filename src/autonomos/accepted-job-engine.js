import path from 'node:path';
import { TaskAgentRuntime } from './task-agent-runtime.js';
const teams=new Map();
import { orchestrateJob } from './orchestration.js';
import { registerAcceptedExecution, executeExternalOpportunity } from './job-executor.js';
import { executeCodingJob } from './coding-job.js';
import { isRetiredResource } from './retired-resources.js';
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
 const memory=workflowMemory(store,capability?.skill);
 const op={...opportunity,executionRetrySafe:capability?.mode==='deterministic',description:opportunity.description+(feedback?'\nClient feedback:\n'+feedback:'')};
 const execute=async(planned,options={})=>{
  onPhase(options.phaseRole?.startsWith('qa-repair')?'repairing':'executing',{phaseRole:options.phaseRole||'executor'});
  if(repository)return executeCodingJob({title:planned.title,description:planned.description+'\n'+(options.briefing||''),repoUrl:planned.repoUrl,ref:planned.ref},{env:executionEnv,llm,onCost:n=>budget.charge(n),signal:abortSignal,maxSpendUsd:budget.remaining}).catch(error=>{error.safeToRetry=true;throw error;});
  return executeExternalOpportunity(planned,capability,{...options,memoryContext:planned.__memoryContext||'',env:executionEnv,llm,budget,config,abortSignal});
 };
 let deliverable;try{deliverable=await orchestrateJob(op,{execute,llm,memory,taskAgents,env:executionEnv,store,jobId:op.jobId+':revision:'+revision,abortSignal,maxTaskAgents:repository?1:undefined,onEvent:(type,detail)=>{if(type==='job_planning_started')onPhase('planning',detail);if(type==='qa_evaluated'||type==='qa_repair_evaluated')onPhase('qa',detail);persistTeams();}});}finally{persistTeams();}
 const qa=deliverable.evidence?.qa;if(!qa?.ok)throw Error('accepted_work_qa_not_verified');
 const history=store.readNdjson('accepted-work-learning.ndjson',-1);
 if(!history.some(x=>x.jobId===op.jobId&&x.revision===revision))store.append('accepted-work-learning.ndjson',{at:new Date().toISOString(),jobId:op.jobId,source:op.source,revision,skill:capability?.skill,roles:[...new Set((deliverable.evidence?.plan?.steps||[]).map(x=>x.role))],tools:[...new Set((deliverable.evidence?.toolCalls||[]).filter(x=>x.ok&&!isRetiredResource(x.provider,'providers')&&!isRetiredResource(x.tool,'tools')).map(x=>x.tool))],repairAttempts:Number(deliverable.evidence?.qaRepairAttempts||0),qaScore:qa.score,costUsd:budget?.spent||0,outcome:'QA_PASSED_AWAITING_DELIVERY'});
 onPhase('delivery_ready',{qaScore:qa.score});return {deliverable,qa};
}

export async function runAcceptedJob(options){
 const scope=registerAcceptedExecution();
 const abortSignal=options.abortSignal?AbortSignal.any([options.abortSignal,scope.controller.signal]):scope.controller.signal;
 try{return await runAcceptedJobCore({...options,abortSignal});}finally{scope.release();}
}

export function workflowMemory(store,skill){return {async contextForOpportunity(){
 const rows=store.readNdjson('accepted-work-learning.ndjson',-1).filter(x=>!isRetiredMarket(x.source)&&x.skill===skill&&x.qaScore>=.72).slice(-5);
 const procedures=rows.map(x=>({skill:x.skill,roles:(x.roles||[]).filter(r=>['planner','research-worker','code-worker','automation-worker','content-worker','qa-evaluator'].includes(r)),tools:(x.tools||[]).filter(t=>!isRetiredResource(t,'tools')&&!isRetiredResource(t,'providers')&&/^[a-z_]{1,60}$/.test(t)),costUsd:x.costUsd,repairAttempts:x.repairAttempts,qaScore:x.qaScore}));
 return {context:procedures.length?'Previously QA-verified procedures; no client content or payment claims: '+JSON.stringify(procedures):'',hits:rows.map(x=>({key:x.jobId+':'+x.revision,metadata:{skill:x.skill,qaScore:x.qaScore}}))};
 }};}
