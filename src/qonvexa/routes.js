import crypto from 'node:crypto';
import { closeAccess } from './retention.js';
import { Store } from './store.js';
import { config } from './config.js';
import { token,hash,bearer,owned } from './security.js';
import { normalizeURL } from './scanner.js';
import { catalog,serviceMatrix } from './catalog.js';
import { preview } from './audit.js';
import { quote,acceptQuote } from './preflight.js';
import { planImplementation,approve } from './runner.js';
import { publicConnection,disconnect } from './connections.js';
import { integrationStatus,trackingPlan } from './adapters/index.js';
import { draft,suppress,issueOptOut,redeemOptOut } from './outreach.js';
import { addKnowledge,approveKnowledge,answerApproved } from './knowledge.js';
export function installNext(app,{storageDir,requireAdmin,requireSameSiteMutation,rateLimit,priceCents,siteUrl,getPaidOrder,legacyLead}){
 const cfg=config(),store=new Store(storageDir);
 const wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(e=>{
   const known=['QUOTE_EXPIRED','PREFLIGHT_REQUIRED','INVALID_SCOPE','UNKNOWN_SERVICE','COST_REVIEW_REQUIRED','OUTREACH_NOT_ELIGIBLE','DAILY_CAP','INVALID_KNOWLEDGE','SCOPE_MISMATCH'];
   res.status(e.status||400).json({error:known.includes(e.message)?e.message:e.status===404?'NOT_FOUND':'REQUEST_REJECTED'});
 });
 const auth=(req,res,next)=>{
   const raw=bearer(req),session=raw&&store.get('sessions',hash(raw));
   if(!session||session.revoked||session.expiresAt<Date.now())return res.status(401).json({error:'Personal audit key required.'});
   req.owner=session.owner;res.setHeader('Cache-Control','no-store');next();
 };
 const limited=rateLimit({windowMs:900000,max:60});
 app.use('/api/next',(_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
 app.post('/api/next/opt-out',limited,wrap((req,res)=>res.json(redeemOptOut(store,req.body.token))));
 app.get('/api/next/config',(_req,res)=>res.json({priceCents,currency:'USD',auditEnabled:cfg.auditEnabled,scannerEnabled:cfg.scannerEnabled,implementationMode:'PLANNING_ONLY',integrations:integrationStatus}));
 app.post('/api/next/close-access',limited,auth,wrap((req,res)=>res.json(closeAccess(store,req.owner))));
 app.get('/api/next/catalog',(_req,res)=>res.json({services:catalog(),matrix:serviceMatrix}));
 function createAudit(lead,{paid=false,orderId}={}){
   const url=normalizeURL(lead.websiteUrl),key=token(),owner=hash(key),id=crypto.randomUUID();
   return store.transaction(()=>{
     const day=new Date().toISOString().slice(0,10);
     if(!paid&&store.list('audits').filter(a=>a.createdAt>=Date.parse(day)).length>=cfg.dailyScans)throw new Error('DAILY_CAP');
     const recent=store.list('audits').find(a=>a.url===url&&a.paid===paid&&a.report&&Date.parse(a.report.expiresAt)>Date.now());
     const domain=new URL(url).hostname,cooldown=store.get('domains',domain);
     const blocked=!recent&&!paid&&cooldown&&cooldown.until>Date.now();
     const a={id,owner,url,leadId:lead.id||'',orderId:orderId||'',emailHash:hash(String(lead.email||'').toLowerCase()),paid,createdAt:Date.now(),status:recent?'AUDIT_READY':cfg.scannerEnabled&&!blocked?'SCANNING':'REQUIRES_REVIEW',report:recent?.report||null};
     store.put('sessions',owner,{owner,expiresAt:Date.now()+cfg.retentionDays*86400000},owner);
     store.put('audits',id,a,owner);
     if(!recent&&cfg.scannerEnabled&&!blocked){
       a.jobId=store.enqueue(paid?'paid_audit':'free_audit',owner,{auditId:id,url}).id;
       store.put('audits',id,a,owner);store.put('domains',domain,{until:Date.now()+cfg.cacheMs});
     }else if(!recent){a.failureCode=blocked?'DOMAIN_COOLDOWN':'PUBLIC_FETCH_DISABLED';store.put('audits',id,a,owner);}
     return {auditId:id,accessKey:key,portalUrl:`/portal.html#${key}`,status:a.status};
   });
 }
 app.get('/api/next/portal',limited,auth,wrap((req,res)=>{
   const audits=store.list('audits',req.owner).map(a=>({id:a.id,url:a.url,status:a.status,paid:a.paid,reviewRequestedAt:a.reviewRequestedAt,failureCode:a.failureCode,jobId:a.jobId,report:a.report?(a.paid?a.report:preview(a.report)):null}));
   res.json({audits,quotes:store.list('quotes',req.owner),connections:store.list('connections',req.owner).map(publicConnection),implementations:store.list('implementations',req.owner),approvals:store.list('approvals',req.owner),knowledge:store.list('knowledge',req.owner),jobs:store.jobs(req.owner).map(j=>({id:j.id,type:j.type,status:j.status,progress:j.progress,attempt:j.attempt,lastError:j.lastError})),integrations:integrationStatus});
 }));
 app.post('/api/next/from-order',limited,wrap((req,res)=>{
   const raw=String(req.body?.orderToken||'');if(!/^[a-f0-9]{48}$/.test(raw))return res.status(401).json({error:'Invalid order token.'});
   const order=getPaidOrder(raw);
   if(!order)return res.status(403).json({error:'Verified payment required.'});
   const key=hash(`paid-portal:${raw}`),owner=hash(key);
   const prior=store.list('audits',owner)[0];
   if(prior){store.put('sessions',owner,{owner,expiresAt:Date.now()+cfg.retentionDays*86400000},owner);return res.json({portalUrl:`/portal.html#${key}`});}
   const created=createAudit({websiteUrl:order.websiteUrl,email:order.customerEmail,id:order.sourceLeadId},{paid:true,orderId:order.sessionId});
   store.transaction(()=>{
     const a=store.get('audits',created.auditId);store.remove('sessions',a.owner);a.owner=owner;store.put('audits',a.id,a,owner);
     if(a.jobId)store.db.prepare('UPDATE jobs SET owner=? WHERE id=?').run(owner,a.jobId);
     store.put('sessions',owner,{owner,expiresAt:Date.now()+cfg.retentionDays*86400000},owner);
   });
   res.json({portalUrl:`/portal.html#${key}`});
 }));
 app.post('/api/next/audits/:id/request-review',limited,auth,wrap((req,res)=>{
   const a=owned(store,'audits',req.params.id,req.owner);store.put('audits',a.id,{...a,reviewRequestedAt:Date.now()},req.owner);store.event('customer_review_requested',{auditId:a.id});res.json({status:'REVIEW_REQUESTED',message:'Your request is recorded for staff review. No work has been marked completed.'});
 }));
 app.post('/api/next/quotes/:id/request-review',limited,auth,wrap((req,res)=>{
   const q=owned(store,'quotes',req.params.id,req.owner);store.put('quotes',q.id,{...q,reviewRequestedAt:Date.now()},req.owner);store.event('customer_review_requested',{quoteId:q.id});res.json({status:'REVIEW_REQUESTED',message:'Your request is recorded for staff review. No implementation has been purchased.'});
 }));
 app.post('/api/next/quotes',limited,auth,wrap((req,res)=>{
   const a=owned(store,'audits',String(req.body.auditId||''),req.owner);
   if(!a.paid||!a.report)return res.status(403).json({error:'A paid audit is required.'});
   if (Date.parse(a.report.expiresAt) <= Date.now()) return res.status(409).json({error:'Audit observations expired. A new preflight/scan is required.'});
   if(!Array.isArray(req.body.findingIds)||req.body.findingIds.length>10)throw new Error('INVALID_SCOPE');
   const c=req.body.connectionId?owned(store,'connections',req.body.connectionId,req.owner):null;
   const q={id:crypto.randomUUID(),auditId:a.id,...quote({owner:req.owner,serviceId:req.body.serviceId,findingIds:req.body.findingIds,report:a.report,capability:c?.capabilities,cfg})};
   store.put('quotes',q.id,q,req.owner);store.event('quote_created',{quoteId:q.id});res.status(201).json(q);
 }));
 app.post('/api/next/quotes/:id/accept',limited,auth,wrap((req,res)=>{const q=owned(store,'quotes',req.params.id,req.owner);res.json(store.put('quotes',q.id,acceptQuote(q),req.owner));}));
 app.post('/api/next/quotes/:id/plan',limited,auth,wrap((req,res)=>{
   if (!cfg.implementations) return res.status(503).json({error:'Implementation planning disabled.'});
   const q=owned(store,'quotes',req.params.id,req.owner);if(q.validUntil<Date.now())throw new Error('QUOTE_EXPIRED');
   const p={id:`plan_${q.id}`,...planImplementation(q,catalog().find(s=>s.id===q.serviceId))};store.put('implementations',p.id,p,req.owner);res.json(p);
 }));
 app.post('/api/next/implementations/:id/approve',limited,auth,wrap((req,res)=>{const p=owned(store,'implementations',req.params.id,req.owner);res.json(approve(store,p,'client',req.body.scopeHash));}));
 app.post('/api/next/connections/:id/disconnect',limited,auth,wrap((req,res)=>res.json(disconnect(store,req.params.id,req.owner))));
 app.post('/api/next/connections',limited,auth,(_req,res)=>res.status(501).json({error:'Connection onboarding is not released. Do not submit credentials. Read probes and encrypted storage are implemented for local adapter testing only.'}));
 app.post('/api/next/knowledge',limited,auth,wrap((req,res)=>res.status(201).json(addKnowledge(store,req.owner,req.body))));
 app.post('/api/next/knowledge/:id/approve',limited,auth,wrap((req,res)=>res.json(approveKnowledge(store,req.owner,req.params.id))));
 app.delete('/api/next/knowledge/:id',limited,auth,wrap((req,res)=>{owned(store,'knowledge',req.params.id,req.owner);store.remove('knowledge',req.params.id);res.json({ok:true});}));
 app.post('/api/next/knowledge/answer',limited,auth,wrap((req,res)=>res.json(answerApproved(store,req.owner,req.body.question))));
 app.get('/api/next/audits/:id/tracking-plan',limited,auth,wrap((req,res)=>{const a=owned(store,'audits',req.params.id,req.owner);if(!a.paid||!a.report)return res.status(403).json({error:'Paid report required.'});res.json(trackingPlan(a.report));}));
 app.get('/api/admin/next',requireAdmin,wrap((_req,res)=>res.json({audits:store.list('audits').map(a=>({...a,emailHash:undefined})),quotes:store.list('quotes'),implementations:store.list('implementations'),connections:store.list('connections').map(publicConnection),approvals:store.list('approvals'),costs:store.list('costs'),events:store.list('events').slice(-100),jobs:store.jobs(),matrix:serviceMatrix})));
 app.post('/api/admin/next/legacy-link',requireAdmin,requireSameSiteMutation,wrap((req,res)=>{
   const lead=legacyLead(req.body.leadId);if(!lead)return res.status(404).json({error:'Lead not found.'});
   const result=createAudit(lead);res.json(result);
 }));
 app.post('/api/admin/next/quotes/:id/review',requireAdmin,requireSameSiteMutation,wrap((req,res)=>{
   const q=store.get('quotes',req.params.id);if(!q)return res.status(404).json({error:'Not found.'});
   // Admin cannot turn unverified execution into a sellable scope.
   const next={...q,status:'REQUIRES_REVIEW',reviewNote:String(req.body.note||'').slice(0,1000),checkoutAllowed:false};store.put('quotes',q.id,next,q.owner);store.event('quote_reviewed',{quoteId:q.id,actor:'admin'});res.json(next);
 }));
 app.post('/api/admin/next/outreach-draft',requireAdmin,requireSameSiteMutation,wrap((req,res)=>{
   if(!cfg.outreach)return res.status(503).json({error:'Outreach drafting disabled.'});
   const a=store.get('audits',req.body.auditId);if(!a?.report)throw new Error('INVALID_SCOPE');
   const candidate={...req.body.candidate};
   candidate.unsubscribe=`${siteUrl}/opt-out.html#${issueOptOut(store,String(candidate.email||''))}`;
   res.json(draft(store,candidate,a.report,String(req.body.auditUrl||''),cfg));
 }));
 app.post('/api/admin/next/suppress',requireAdmin,requireSameSiteMutation,wrap((req,res)=>{suppress(store,String(req.body.email||''));res.json({ok:true});}));
 return {store,cfg,createAudit,findMini(key,email){
   if(!/^[a-f0-9]{64}$/.test(key||''))return null;
   const session=store.get('sessions',hash(key));if(!session||session.expiresAt<Date.now()||session.revoked)return null;
   const a=store.list('audits',session.owner).find(a=>a.emailHash===hash(email.toLowerCase()));
   if (!a) return null;
   const lead=legacyLead(a.leadId);
   const legacy=lead?.miniAuditSummary ? {leadId:lead.id,websiteUrl:lead.websiteUrl,businessType:lead.businessType||'',title:lead.miniAuditTitle||'Your mini-audit',summary:lead.miniAuditSummary,findings:String(lead.miniAuditFindings||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(0,3),fullAuditPrepared:Boolean(lead.preparedAuditUrl),provenance:'staff_prepared_legacy',verification:'Not reverified by the new scanner'} : null;
   return {portalUrl:`/portal.html#${key}`,...(legacy?{miniAudit:legacy}:{})};
 }};
}
