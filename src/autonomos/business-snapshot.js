import fs from 'node:fs';
import path from 'node:path';
import { canonicalOpportunity, eligibility } from './canonical-opportunity.js';
import { isRetiredMarket } from './retired-markets.js';
import { retiredResources } from './retired-resources.js';
export function businessSnapshot(storageDir,env=process.env){
 const root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');
 const read=(name,f={})=>{try{return JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));}catch{return f;}};
 const hunter=read('global-work-hunter.json'),actions=read('global-lead-actioner.json').actions||{},tf=read('taskforce-worker.json'),agrenting=read('agrenting-worker.json');
 const leadRows=Object.values(hunter.leads||{}).filter(x=>!isRetiredMarket(x));
 const counts={discovered:leadRows.length+Object.keys(hunter.taskforce?.tasks||{}).length,routable:0,eligible:0,applications:0,accepted:0,executing:0,qa:0,delivered:0,paid:0};const blockers={};
 for(const lead of leadRows){const a=actions[lead.id]||{};const route=a.commentId?'GITHUB_APPLICATION':a.gmailMessageId?'DIRECT_CLIENT_EMAIL':null;
  const op=canonicalOpportunity({...lead,...(a.payout?{payoutUsd:a.payout.amountUsd}:{}),applicationRoute:route,workType:route==='DIRECT_CLIENT_EMAIL'?'REAL_DIRECT_PAID_PROJECT':undefined});const e=eligibility(op,env);if(route)counts.routable++;if(e.eligible)counts.eligible++;
  for(const reason of e.reasons)blockers[reason]=(blockers[reason]||0)+1;
  if(a.commentId||a.gmailMessageId)counts.applications++;
  if(a.acceptedAt)counts.accepted++;
  if(['executing_email','executing_github'].includes(a.status))counts.executing++;
  if((a.gmailDeliveryMessageId||a.deliveryUrl)&&a.submittedAt)counts.delivered++;
 }
 for(const [id,a]of Object.entries(hunter.taskforce?.applications||{})){
  if(a.applicationId){counts.applications++;counts.routable++;}
  if(['ACCEPTED','IN_PROGRESS','WORKING','ASSIGNED','AWARDED','SUBMISSION_REJECTED'].includes(a.status))counts.accepted++;
  const t=tf.tasks?.[id]||{};if(t.status==='executing')counts.executing++;if(t.submissionId)counts.delivered++;
 }
 for(const h of Object.values(agrenting.hirings||{})){if(h.submittedAt)counts.delivered++;if(h.status==='executing')counts.executing++;}
 let ledger=[];try{ledger=fs.readFileSync(path.join(root,'ledger.ndjson'),'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch{}
 const revenues=ledger.filter(x=>x.type==='revenue'&&!x.testnet&&['settled','paid','confirmed','released'].includes(x.status)&&Number(x.amountUsd)>0);
 const seen=new Set();const paid=revenues.filter(x=>{const id=x.externalTransactionId||x.txId||x.id;if(!id||seen.has(id))return false;seen.add(id);return true;});counts.paid=paid.length;
 const gross=paid.reduce((n,x)=>n+Number(x.amountUsd||0),0),cost=ledger.filter(x=>x.type==='cost').reduce((n,x)=>n+Number(x.amountUsd||0),0),fees=paid.reduce((n,x)=>n+Number(x.feeUsd||0)+Number(x.networkFeeUsd||0),0);
 const workers=Object.values(read('execution-workforce.json')).map(x=>({...x,active:Boolean(x.active&&Date.parse(x.updatedAt)>Date.now()-30*60*1000)}));
 return{generatedAt:new Date().toISOString(),counts,blockers,money:{grossRevenueUsd:gross,costUsd:cost,feesUsd:fees,netProfitUsd:gross-cost-fees,costsAreEstimates:true},markets:Object.values(read('dynamic-market-registry.json')),retired:retiredResources(),workforce:{active:workers.filter(x=>x.active).length,workers},evidenceRule:'Applications and delivery require external IDs; revenue requires finalized ledger evidence.'};
}
