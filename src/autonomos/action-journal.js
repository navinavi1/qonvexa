import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// Each external write is write-ahead logged. A crash after intent requires reconciliation,
// never blind replay. Atomic rename retains the previous complete version after a crash.
export class ActionJournal {
 constructor(root){this.file=path.join(root,'external-actions.json');fs.mkdirSync(root,{recursive:true});}
 read(){try{return JSON.parse(fs.readFileSync(this.file,'utf8'));}catch(e){if(e.code==='ENOENT')return{};throw e;}}
 write(rows){const tmp=this.file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(rows,null,2),{mode:0o600});fs.renameSync(tmp,this.file);}
 key(market,job,action){return crypto.createHash('sha256').update(JSON.stringify([market,job,action])).digest('hex');}
 begin(market,job,action){const id=this.key(market,job,action),rows=this.read(),prior=rows[id];if(prior&&prior.status!=='definite_failure')return{ok:false,id,...prior};rows[id]={market,job,action,status:'intent',at:new Date().toISOString(),attempts:Number(prior?.attempts||0)+1};this.write(rows);return{ok:true,id};}
 finish(id,status,proof={}){if(!['confirmed','uncertain','definite_failure'].includes(status))throw Error('invalid_action_status');if(status==='confirmed'&&!proof.externalId&&!proof.url)throw Error('external_proof_required');const rows=this.read();if(!rows[id])throw Error('missing_action_intent');rows[id]={...rows[id],status,proof,updatedAt:new Date().toISOString()};this.write(rows);return rows[id];}
}
export function classifyFailure(status,error=''){
 const n=Number(status),text=String(error||'');
 if(/captcha|\b2fa\b|\bkyc\b|human.verification/i.test(text))return {type:'HUMAN_GATE',retryable:false};
 if(n===429||n===403&&/rate.limit|abuse|secondary/i.test(text))return {type:'RATE_LIMIT',retryable:true};
 if(n===401||n===403||/authenticated.account.required|api.key.missing|credentials?.(?:required|missing)|unauthorized/i.test(text))return{type:'AUTH',retryable:false};
 if(n===402||/subscription.required|payment.required/i.test(text))return{type:'PAID_REQUIREMENT',retryable:false};
 if(n===404||n===410)return{type:'JOB_EXPIRED',retryable:false};
 if(n===422||/schema|required.field|unknown.field/i.test(text))return{type:'SCHEMA_DRIFT',retryable:false};
 if(/tool.missing|command.not.found/i.test(text))return{type:'TOOL_MISSING',retryable:true};
 if(/capability/i.test(text))return{type:'CAPABILITY_MISSING',retryable:true};
 if(n===502||n===503||/ENOTFOUND|ECONNREFUSED/i.test(text))return{type:'MARKET_DOWN',retryable:true};
 if(n>=500||n===408||!n)return{type:'TEMPORARY',retryable:true};
 return{type:'PERMANENT',retryable:false};
}
