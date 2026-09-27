import fs from 'node:fs';
import { hash,token } from './security.js';
const policies=JSON.parse(fs.readFileSync(new URL('../../config/qonvexa/country-policies.json',import.meta.url)));
export function suppress(store,email){const id=hash(email.trim().toLowerCase());store.put('suppression',id,{id,at:Date.now()});}
export function compliance(store,c){
 const p=policies[c.country],reasons=[];
 if(!p?.eligible)reasons.push('COUNTRY_UNSUPPORTED');
 if(p?.legalTypes&&!p.legalTypes.includes(c.legalType))reasons.push('LEGAL_TYPE_UNSUPPORTED');
 if(c.optOut||c.suppressed||store.get('suppression',hash(String(c.email||'').trim().toLowerCase())))reasons.push('SUPPRESSED');
 if(c.lastContactAt)reasons.push('ALREADY_CONTACTED_REVIEW_REQUIRED');
 for(const field of p?.requires||[])if(!c[field])reasons.push(`MISSING:${field}`);
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email||''))reasons.push('INVALID_EMAIL');
 return {status:reasons.length?'FAIL':'PASS',reasons,policyVersion:1,legalCertification:false};
}
export function opportunity(candidate,findings,decision){const strong=findings.filter(f=>f.confidence==='HIGH');const score=Math.min(100,strong.length*15+(['dental','med_spa','hvac','roofing'].includes(candidate.niche)?15:0)+(candidate.email?10:0)+(candidate.commercialConversion?15:0));return {score,fit:decision.status==='PASS'&&strong.length&&candidate.commercialConversion?'CANDIDATE':'NOT_A_GOOD_FIT',reasons:decision.reasons};}
export function draft(store,c,report,auditUrl,cfg){
 const decision=compliance(store,c);const strong=report.findings.filter(f=>f.confidence==='HIGH').slice(0,3);
 if(decision.status!=='PASS'||!strong.length)throw new Error('OUTREACH_NOT_ELIGIBLE');
 const today=new Date().toISOString().slice(0,10);
 return store.transaction(()=>{
   if(store.list('drafts').filter(d=>d.date===today).length>=cfg.dailyDrafts)throw new Error('DAILY_CAP');
   const id=hash(`${c.email.toLowerCase()}:${auditUrl}`),old=store.get('drafts',id);if(old)return old;
   const row={id,date:today,status:'DRY_RUN',recipient:c.email,subject:'Website observations for your business',body:`Commercial service introduction from ${c.senderIdentity}.\n\n${strong.map(f=>`${f.title}: ${f.evidence[0].observation}`).join('\n')}\n\nReview your observations: ${auditUrl}\nNo revenue or ranking result is guaranteed.\n${c.postalAddress}\nOpt out: ${c.unsubscribe}`,auditUrl,compliance:decision,trackingPixel:false,sent:false};
   store.put('drafts',id,row);return row;
 });
}

export function issueOptOut(store,email){const key=token(),id=hash(key);store.put('optouts',id,{id,emailHash:hash(email.trim().toLowerCase())});return key;}
export function redeemOptOut(store,key){const row=store.get('optouts',hash(String(key)));if(!row)throw new Error('INVALID_OPT_OUT');store.put('suppression',row.emailHash,{id:row.emailHash,at:Date.now()});return {suppressed:true};}
