import { audit } from './audit.js';
import { crawl } from './scanner.js';
import { reserve } from './costs.js';
export async function tick(store,cfg,{scan=crawl}={}){
 const job=store.claim(cfg);if(!job)return false;
 try{
   if(!['free_audit','paid_audit'].includes(job.type))throw new Error('UNSUPPORTED_JOB');
   if(!cfg.scannerEnabled)throw new Error('PUBLIC_FETCH_DISABLED');
   const paid=job.type==='paid_audit',cap=paid?cfg.auditCap:cfg.freeCap;
   // Reserve the worst bounded worker duration, not an invented actual provider bill.
   const maxSeconds=((paid?cfg.paidPages:cfg.freePages)+2)*(cfg.maxRedirects+1)*cfg.timeoutMs*2/1000;
   reserve(store,{id:`${job.id}:${job.attempt}`,jobId:job.id,provider:'worker',operation:job.type,estimatedUsd:maxSeconds*cfg.workerUsdPerSecond,cap});
   store.event('audit_started',{jobId:job.id,auditId:job.payload.auditId});
   const observations=await scan(job.payload.url,cfg,{paid});
   const report=audit(observations,cfg);
   store.transaction(()=>{
     const current=store.job(job.id);
     if(current.status!=='RUNNING'||current.leaseToken!==job.leaseToken)throw new Error('LEASE_LOST');
     const a=store.get('audits',job.payload.auditId);
     if(!a)throw new Error('AUDIT_NOT_FOUND');
     store.put('audits',a.id,{...a,report,status:'AUDIT_READY',updatedAt:Date.now()},a.owner);
     store.finish(job,{auditId:a.id});store.event('audit_completed',{jobId:job.id,auditId:a.id});
   });
 }catch(e){
   const code=['PUBLIC_FETCH_DISABLED','UNSUPPORTED_JOB','COST_REVIEW_REQUIRED','UNSAFE_URL','UNSAFE_DNS','CROSS_ORIGIN_REDIRECT','CONTENT_TYPE_BLOCKED','BYTE_LIMIT','REDIRECT_LIMIT'].includes(e.message)?e.message:'SCAN_FAILED';
   store.transaction(()=>{
     if(!store.fail(job,code,cfg,false))return; // Superseded worker must not overwrite a newer result.
     const a=store.get('audits',job.payload.auditId);if(a)store.put('audits',a.id,{...a,status:'REQUIRES_REVIEW',failureCode:code},a.owner);
   });
 }
 return true;
}
