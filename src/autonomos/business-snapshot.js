import { receiptIdentity, isCryptoRevenue } from './financial-ledger.js';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalOpportunity, eligibility, priceOpportunity } from './canonical-opportunity.js';
import { classifyOpportunity } from './capabilities.js';
import { unifiedCapabilityContext } from './capability-registry.js';
import { isRetiredMarket } from './retired-markets.js';
import { retiredResources } from './retired-resources.js';
import { readNdjsonCached } from './ndjson-cache.js';
export function businessSnapshot(storageDir,env=process.env){
 const root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');
 const read=(name,f={})=>{try{return JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));}catch{return f;}};
 const hunter=read('global-work-hunter.json'),actions=read('global-lead-actioner.json').actions||{},tf=read('taskforce-worker.json'),agrenting=read('agrenting-worker.json');
 const counts={discovered:0,routable:0,eligible:0,applications:0,claimed:0,accepted:0,executing:0,qa:0,delivered:0,revisions:0,clientAccepted:0,payoutPending:0,paid:0},blockers={},sources={};
 let pendingPayoutUsd=0;
 const capabilityContext=unifiedCapabilityContext(env);
 const jobs=new Map(),add=(key,op,a)=>{if(!isRetiredMarket(op))jobs.set(op.marketplace+':'+op.externalId,{op,a});};
 for(const lead of Object.values(hunter.leads||{})){
  const a=actions[lead.id]||{},route=a.commentId?'GITHUB_APPLICATION':a.gmailMessageId?'DIRECT_CLIENT_EMAIL':a.applicationRoute||null;
  add('lead:'+lead.id,canonicalOpportunity({...lead,...(a.payout?{payoutUsd:a.payout.amountUsd}:{}),applicationRoute:route,competitive:true,estimatedWinProbability:a.estimatedWinProbability??lead.estimatedWinProbability,workType:route==='DIRECT_CLIENT_EMAIL'?'REAL_DIRECT_PAID_PROJECT':undefined}),{...a,ledgerJobId:(a.route==='github_issue_comment'?'github_':'email_')+lead.id,applied:!!(a.commentId||a.gmailMessageId||a.applicationId),delivered:!!((a.gmailDeliveryMessageId||a.deliveryUrl)&&a.submittedAt)});
 }
 for(const [id,t]of Object.entries(hunter.taskforce?.tasks||{})){
  if(t.demo||t.isTest||t.test||/commissioning probe|action testing/i.test(t.title||''))continue;
  const a=hunter.taskforce?.applications?.[id]||{},w=tf.tasks?.[id]||{};
  add('taskforce:'+id,canonicalOpportunity({...t,source:'taskforce',externalId:id,currency:'USDC',workType:'REAL_MARKET_JOB',applicationRoute:'API_APPLICATION',competitive:true,estimatedWinProbability:t.estimatedWinProbability}),{...a,...w,ledgerJobId:'taskforce_'+id,applied:!!a.applicationId,acceptedAt:w.acceptedAt||(['ACCEPTED','IN_PROGRESS','WORKING','ASSIGNED','AWARDED','SUBMISSION_REJECTED'].includes(a.status)?a.updatedAt||a.appliedAt:'')||'',delivered:!!w.submissionId});
 }
 for(const [id,h]of Object.entries(agrenting.hirings||{}))add('agrenting:'+id,canonicalOpportunity({...h,source:'agrenting',externalId:id,payoutUsd:h.price,currency:'USD',workType:'REAL_MARKET_JOB',claimRoute:'ASSIGNED',competitive:false}),{...h,ledgerJobId:'agrenting_'+id,acceptedAt:h.acceptedAt||h.startedAt,delivered:!!(h.submissionId&&h.submittedAt)});
 for(const [id,j]of Object.entries(read('native-market-jobs.json')))add('native:'+id,canonicalOpportunity(j.opportunity||{}),{...j,ledgerJobId:id});
 for(const {op,a}of jobs.values()){
  counts.discovered++;const source=sources[op.source]??={discovered:0,applications:0,accepted:0,delivered:0};source.discovered++;
  if(op.claimRoute||op.applicationRoute)counts.routable++;
  // Price the opportunity before judging it. Unpriced, every job failed on a missing
  // estimatedExecutionCost and this panel reported eligible:0 forever, with a blocker
  // that described the gap in our own data rather than anything about the job.
  const capability=classifyOpportunity({...op,budgetUsd:op.payoutUsd},capabilityContext);
  const priced=priceOpportunity(op,capability);
  const status=String(a.status||'').toLowerCase(),e=eligibility(priced,env);
  if(e.eligible&&!/archived|expired|rejected|closed|paid|settled/.test(status))counts.eligible++;
  for(const reason of e.reasons)blockers[reason]=(blockers[reason]||0)+1;
  if(a.applied){counts.applications++;source.applications++;}
  if(a.claimId)counts.claimed++;
  if(a.acceptedAt){counts.accepted++;source.accepted++;}
  if(/^(executing|executing_email|executing_github)$/.test(status))counts.executing++;
  if(status==='qa'||status==='verifying')counts.qa++;
  if(a.delivered){counts.delivered++;source.delivered++;}
  if(a.revisionRequestedAt||a.revisionId||a.lastRevisionId||status==='revision_requested')counts.revisions++;
  if(a.clientAcceptedAt||a.revenueRecordedAt)counts.clientAccepted++;
  if(a.delivered&&!a.paidAt&&!a.revenueRecordedAt){counts.payoutPending++;pendingPayoutUsd+=Math.max(0,Number(op.payoutUsd||0)-Number(a.receivedUsd||0));}
 }
 const ledger=readNdjsonCached(path.join(root,'ledger.ndjson'));
 const seen=new Set(),revenues=ledger.filter(x=>x.type==='revenue'&&!x.testnet&&['settled','paid','confirmed','released'].includes(x.status)&&Number(x.amountUsd)>0).filter(x=>{const id=receiptIdentity(x)||x.id;if(!id||seen.has(id))return false;seen.add(id);return true;});
 const totals=new Map();for(const r of revenues){const id=r.jobId||r.externalId;if(id)totals.set(id,(totals.get(id)||0)+Number(r.amountUsd));}
 const expected=new Map([...jobs.values()].map(({op,a})=>[a.ledgerJobId,op.payoutUsd]));

 // A job counts as paid when settled money arrived and nothing contradicts it. The old
 // predicate read `!expected.has(id) || expected>0 && total>=expected`, which silently
 // dropped the case where a job IS known but its expected payout is 0 — the posting never
 // stated a price, which is the hunter's common case, not an edge one. A fully paid job
 // then sat at paid:0 while grossRevenueUsd beside it showed the money, so two figures on
 // the same dashboard contradicted each other. An unknown price is not evidence of
 // underpayment; a known price that was not met still is.
 const paidEnough=(id,total)=>{
  const want=Number(expected.get(id)||0);
  if(!expected.has(id)||!(want>0))return true; // no price to fall short of
  return total>=want;
 };
 counts.paid=[...totals].filter(([id,total])=>paidEnough(id,total)).length;
 const gross=revenues.reduce((n,x)=>n+Number(x.amountUsd||0),0),cost=ledger.filter(x=>x.type==='cost').reduce((n,x)=>n+Number(x.amountUsd||0),0),fees=revenues.reduce((n,x)=>n+Number(x.feeUsd||0)+Number(x.networkFeeUsd||0),0);
 const workers=Object.values(read('execution-workforce.json')).map(x=>({...x,active:Boolean(x.active&&x.pid===process.pid&&Date.parse(x.updatedAt)>Date.now()-30*60*1000)}));
 const teamState=read('accepted-task-squads.json'),squads=teamState.pid===process.pid&&(Date.parse(teamState.updatedAt)>Date.now()-30*60000)?teamState.agents||[]:[];
 const money={pendingPayoutUsd,cryptoRevenueUsd:revenues.filter(isCryptoRevenue).reduce((n,r)=>n+Number(r.amountUsd||0),0),grossRevenueUsd:gross,costUsd:cost,feesUsd:fees,netProfitUsd:gross-cost-fees,costsAreEstimates:true};
 return{generatedAt:new Date().toISOString(),counts,blockers,money,sources,markets:Object.values(read('dynamic-market-registry.json')).filter(x=>!isRetiredMarket(x)),retired:retiredResources(),workforce:{squads,activeSquads:new Set(squads.filter(x=>x.status==='active').map(x=>x.jobId)).size,spawnedWorkers:squads.length,active:workers.filter(x=>x.active).length,completed:workers.filter(x=>x.executionOk).length,failed:workers.filter(x=>x.executionOk===false).length,workers},evidenceRule:'Current eligibility requires fresh jobs and known economics. Applications/delivery require external proof. Paid counts distinct jobs with finalized ledger evidence.'};
}
