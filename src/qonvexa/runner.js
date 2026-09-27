import { hash } from './security.js';
// The shipped HTTP API only exposes planning. Live adapters cannot enter this runner.
// This executor is for offline fixture validation and future reviewed allowlisted adapters.
export function definitionOfDone(service,receipts){return service.definitionOfDone.every(check=>receipts.some(r=>r.check===check&&r.status==='VERIFIED'&&r.evidence&&r.source==='adapter_readback'));}
export function planImplementation(q,service){return {owner:q.owner,quoteId:q.id,scopeHash:q.scopeHash,status:'DRY_RUN',steps:q.steps,approvalRequired:service.riskLevel!=='LOW',definitionOfDone:service.definitionOfDone,actions:service.requiredCapabilities,externalActionsPerformed:0,reason:'LIVE_EXECUTOR_NOT_IMPLEMENTED'};}
export function approve(store,plan,actor,scopeHash){if(scopeHash!==plan.scopeHash)throw new Error('SCOPE_MISMATCH');const row={id:plan.id,scopeHash,actor,approvedAt:Date.now()};store.put('approvals',row.id,row,plan.owner);store.event('approval_required',{orderId:plan.id,actor,reason:'APPROVAL_RECORDED'});return row;}
export async function runFixture(store,{plan,service,adapter,payment,approval,dryRun=true}){
  if(dryRun)return {...plan,status:'DRY_RUN',externalActionsPerformed:0};
  if(adapter.environment!=='fixture')throw new Error('LIVE_EXECUTOR_NOT_IMPLEMENTED');
  if(payment?.verified!==true||payment.scopeHash!==plan.scopeHash)throw new Error('VERIFIED_PAYMENT_REQUIRED');
  if(service.riskLevel!=='LOW'&&approval?.scopeHash!==plan.scopeHash)throw new Error('APPROVAL_REQUIRED');
  const journal=store.get('implementations',plan.id)||{...plan,status:'PREPARE',changes:[],receipts:[]};
  if(journal.status==='COMPLETED')return journal;
  store.event('implementation_started',{orderId:plan.id});
  try {
    journal.status='BACKUP';journal.snapshot=journal.snapshot||await adapter.snapshot();
    store.put('implementations',plan.id,journal,plan.owner);
    for(const action of plan.actions){
      if(!adapter.allowlist.includes(action))throw new Error('ACTION_NOT_ALLOWED');
      const id=hash(`${plan.id}:${plan.scopeHash}:${action}`);
      let change=journal.changes.find(c=>c.id===id);
      if(change?.status==='VERIFIED')continue;
      if(change?.status==='REQUESTED'){journal.status='MANUAL_REVIEW_REQUIRED';store.put('implementations',plan.id,journal,plan.owner);return journal;}
      change={id,action,status:'REQUESTED',before:await adapter.read(action)};journal.changes.push(change);
      store.put('implementations',plan.id,journal,plan.owner);
      const result=await adapter.apply(action,{idempotencyKey:id});
      if(result.status!=='APPLIED')throw new Error('AMBIGUOUS_RESULT');
      change.after=await adapter.read(action);change.status='APPLIED';
      if(!await adapter.verify(action,change.after))throw new Error('READBACK_FAILED');
      change.status='VERIFIED';store.put('implementations',plan.id,journal,plan.owner);
    }
    journal.status='QA';journal.receipts=await adapter.qa();
    if(!definitionOfDone(service,journal.receipts))throw new Error('QA_FAILED');
    journal.status='COMPLETED';store.event('qa_passed',{orderId:plan.id});
  }catch(e){
    store.event('qa_failed',{orderId:plan.id});journal.status='ROLLBACK_REQUIRED';
    store.put('implementations',plan.id,journal,plan.owner);store.event('rollback_started',{orderId:plan.id});
    try{
      for(const c of [...journal.changes].reverse()){
        if(c.status==='REQUESTED')throw new Error('AMBIGUOUS_WRITE_REQUIRES_RECONCILIATION');
        if(!['APPLIED','VERIFIED'].includes(c.status))continue;
        if(JSON.stringify(await adapter.read(c.action))!==JSON.stringify(c.after))throw new Error('CONCURRENT_CHANGE');
        await adapter.restore(c.action,c.before);c.status='ROLLED_BACK';
      }
      journal.status='RETRYABLE';store.event('rollback_completed',{orderId:plan.id});
    }catch{journal.status='MANUAL_REVIEW_REQUIRED';}
  }
  store.put('implementations',plan.id,journal,plan.owner);return journal;
}
