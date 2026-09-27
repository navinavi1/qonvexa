import crypto from 'node:crypto';
export function reserve(store,{jobId,leadId='',orderId='',provider,operation,estimatedUsd,cap,units=1,id=crypto.randomUUID()}) {
  if(!Number.isFinite(estimatedUsd)||estimatedUsd<0||!Number.isFinite(cap)||cap<0)throw new Error('INVALID_COST');
  return store.transaction(()=>{
    const old=store.get('costs',id);if(old)return old;
    const total=store.list('costs',jobId).reduce((s,x)=>s+(x.actualUsd??x.estimatedUsd),0);
    if(total+estimatedUsd>cap)throw new Error('COST_REVIEW_REQUIRED');
    return store.put('costs',id,{id,jobId,leadId,orderId,provider,operation,units,estimatedUsd,actualUsd:null,timestamp:new Date().toISOString()},jobId);
  });
}
export function settle(store,id,actualUsd){if(!Number.isFinite(actualUsd)||actualUsd<0)throw new Error('INVALID_COST');const c=store.get('costs',id);if(!c)throw new Error('COST_NOT_FOUND');return store.put('costs',id,{...c,actualUsd},c.jobId);}
