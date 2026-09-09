import fs from 'node:fs';
import path from 'node:path';
import { isRetiredMarket } from './retired-markets.js';
export const MARKET_STATES=Object.freeze(['DISCOVERED','INSPECTING','REGISTRATION_READY','REGISTERED','DISCOVER_READY','APPLICATION_READY','CLAIM_READY','DELIVERY_READY','PAYOUT_READY','FULL_AUTO_READY','OWNER_ACTION_REQUIRED','NO_REAL_WORK','PAID_ONLY','AUTOMATION_FORBIDDEN','BROKEN','RETIRED']);
const REQUIRED=['authentication','jobs','details','application','execution','delivery','status','payout'];
export function deriveMarketState(row={}){
 if(isRetiredMarket(row))return 'RETIRED';
 if(row.automationPermitted===false)return 'AUTOMATION_FORBIDDEN';
 if(row.paidSubscriptionRequired)return 'PAID_ONLY';
 if(row.humanGate)return 'OWNER_ACTION_REQUIRED';
 const evidence=row.evidence||{};
 const verified=k=>evidence[k]?.verified===true&&Boolean(evidence[k]?.externalId||evidence[k]?.url)&&Date.parse(evidence[k]?.verifiedAt||'')>Date.now()-7*86400000;
 if(REQUIRED.every(verified))return 'FULL_AUTO_READY';
 if(row.lastError)return 'BROKEN';
 if(verified('delivery'))return 'DELIVERY_READY';
 if(verified('application'))return 'APPLICATION_READY';
 if(verified('jobs'))return 'DISCOVER_READY';
 if(verified('authentication'))return 'REGISTERED';
 return 'DISCOVERED';
}
export class DynamicMarketRegistry {
 constructor(root){this.file=path.join(root,'dynamic-market-registry.json');fs.mkdirSync(root,{recursive:true});}
 read(){try{return JSON.parse(fs.readFileSync(this.file,'utf8'));}catch(e){if(e.code==='ENOENT')return{};throw e;}}
 observe(id,update){const rows=this.read(),row={...rows[id],...update,evidence:{...rows[id]?.evidence,...update.evidence},id,updatedAt:new Date().toISOString()};row.status=deriveMarketState(row);row.fullAutoReady=row.status==='FULL_AUTO_READY';rows[id]=row;const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(rows,null,2),{mode:0o600});fs.renameSync(tmp,this.file);return row;}
}
