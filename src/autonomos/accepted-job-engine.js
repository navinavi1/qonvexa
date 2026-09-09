import { checkpointExecution } from './execution-checkpoint.js';
import { executeExternalOpportunity } from './job-executor.js';
import { evaluateDeliverable } from './qa-engine.js';
import { isRetiredMarket } from './retired-markets.js';

// Shared accepted-work lifecycle. Adapters own only acquisition, delivery and payment.
// Every completed expensive phase is durable before the next phase begins.
export async function runAcceptedJob({opportunity,capability,llm,budget,env=process.env,config,store,revision=0,maxRepairs=3,feedback='',onPhase=()=>{}}){
 if(!opportunity.jobId||opportunity.claimMode!=='already_assigned')throw Error('accepted_job_required');
 if(isRetiredMarket(opportunity))throw Error('DO_NOT_RESTORE');
 const checkpoint=checkpointExecution(store,opportunity.jobId+':revision:'+revision);
 let deliverable,qa,briefing=String(feedback||'');
 for(let attempt=0;attempt<Math.max(1,Math.min(5,maxRepairs));attempt++){
  onPhase('executing',{attempt:attempt+1});
  deliverable=await checkpoint('execute:'+attempt,()=>executeExternalOpportunity(opportunity,capability,{env,llm,budget,config,briefing}));
  onPhase('qa',{attempt:attempt+1});
  qa=await checkpoint('qa:'+attempt,()=>evaluateDeliverable(opportunity,deliverable,{env,llm}),{retrySafe:true});
  if(qa.ok){
   const learned={at:new Date().toISOString(),jobId:opportunity.jobId,source:opportunity.source,revision,skill:capability.skill,tools:(deliverable.evidence?.toolCalls||[]).map(t=>({name:t.tool,ok:t.ok})),qaScore:qa.score,costUsd:budget?.spent||0,outcome:'QA_PASSED_AWAITING_DELIVERY'};
   const history=store.readNdjson('accepted-work-learning.ndjson',-1);
   if(!history.some(x=>x.jobId===learned.jobId&&x.revision===revision))store.append('accepted-work-learning.ndjson',learned);
   onPhase('delivery_ready',{qaScore:qa.score});return {deliverable,qa};
  }
  briefing='Repair these acceptance failures: '+(qa.reasons||[]).join('; ')+'\nPrevious result:\n'+String(deliverable.content||'').slice(0,7000);
  onPhase('repairing',{attempt:attempt+1,reasons:qa.reasons});
 }
 return {deliverable,qa};
}
