import crypto from 'node:crypto';
import { owned } from './security.js';
export function addKnowledge(store,owner,{question,answer,source,sourceUrl}){
 if(!['customer_website','customer_document','approved_faq','approved_pricing','approved_policy'].includes(source)||!question||!answer)throw new Error('INVALID_KNOWLEDGE');
 const row={id:crypto.randomUUID(),owner,question:String(question).slice(0,500),answer:String(answer).slice(0,3000),source,sourceUrl:String(sourceUrl||'').slice(0,1000),status:'REVIEW_REQUIRED',updatedAt:Date.now()};return store.put('knowledge',row.id,row,owner);
}
export function approveKnowledge(store,owner,id){const k=owned(store,'knowledge',id,owner);return store.put('knowledge',id,{...k,status:'APPROVED',approvedAt:Date.now()},owner);}
export function answerApproved(store,owner,question){const q=String(question).trim().toLowerCase();const item=store.list('knowledge',owner).find(k=>k.status==='APPROVED'&&k.question.trim().toLowerCase()===q);return item?{answer:item.answer,sourceId:item.id,status:'APPROVED_ANSWER'}:{answer:'Please contact the business for an approved answer.',status:'HUMAN_HANDOFF'};}
