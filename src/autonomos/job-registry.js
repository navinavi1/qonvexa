import crypto from 'node:crypto';

const TERMINAL_STATUSES=new Set(['graveyard','delivered','paid','settled','completed','expired','cancelled','rejected']);
const OWNED_STATUSES=new Set(['bid_submitted','claimed','executing','qa','delivered','paid','settled','completed']);

export class JobRegistry {
  constructor({store,maxRecords=12000}={}){
    if(!store)throw new Error('JobRegistry requires store');
    this.store=store;
    this.maxRecords=Math.max(1000,Number(maxRecords||12000));
    this.records=store.readJson('job-registry.json',{});
  }

  observe(opportunity,{legacyHandled=false}={}){
    const identity=jobIdentity(opportunity);
    const fingerprint=jobFingerprint(opportunity);
    const now=new Date().toISOString();
    let row=this.records[identity];
    if(!row){
      row={identity,source:String(opportunity?.source||''),externalId:String(opportunity?.externalId||''),fingerprint,version:1,status:'new',terminal:false,firstSeenAt:now,lastSeenAt:now,seenCount:1,title:String(opportunity?.title||'').slice(0,300),budgetUsd:Number(opportunity?.budgetUsd||0),currency:String(opportunity?.currency||''),claimMode:String(opportunity?.claimMode||''),deadline:String(opportunity?.deadline||''),url:String(opportunity?.url||'')};
      this.records[identity]=row;
      if(legacyHandled)this.markPermanent(opportunity,{owner:'legacy',reasonCode:'legacy_handled_before_v7',reason:'Migrated from the pre-v7 handled-opportunity blacklist.'});
      else this.persist();
      return this.get(opportunity);
    }
    if(row.fingerprint!==fingerprint){
      const previous={fingerprint:row.fingerprint,status:row.status,terminal:Boolean(row.terminal),reasonCode:row.reasonCode||'',closedAt:row.closedAt||row.lastSeenAt||''};
      row={...row,fingerprint,version:Number(row.version||1)+1,status:'new',terminal:false,failureOwner:'',reasonCode:'',reason:'',retryAfter:'',attempts:0,firstSeenAt:now,lastSeenAt:now,seenCount:1,title:String(opportunity?.title||'').slice(0,300),budgetUsd:Number(opportunity?.budgetUsd||0),currency:String(opportunity?.currency||''),claimMode:String(opportunity?.claimMode||''),deadline:String(opportunity?.deadline||''),url:String(opportunity?.url||''),previousVersions:[...(row.previousVersions||[]).slice(-4),previous]};
    }else{
      row={...row,lastSeenAt:now,seenCount:Number(row.seenCount||0)+1,title:String(opportunity?.title||row.title||'').slice(0,300),budgetUsd:Number(opportunity?.budgetUsd??row.budgetUsd??0),currency:String(opportunity?.currency||row.currency||''),claimMode:String(opportunity?.claimMode||row.claimMode||''),deadline:String(opportunity?.deadline||row.deadline||''),url:String(opportunity?.url||row.url||'')};
    }
    this.records[identity]=row;this.persist();return {...row};
  }

  get(opportunityOrIdentity){
    const identity=typeof opportunityOrIdentity==='string'?opportunityOrIdentity:jobIdentity(opportunityOrIdentity);
    const row=this.records[identity];return row?{...row}:null;
  }

  blockReason(opportunity){
    const row=this.get(opportunity);if(!row)return null;
    if(row.terminal||OWNED_STATUSES.has(String(row.status||''))||row.status==='manual_attention')return {blocked:true,status:row.status,reasonCode:row.reasonCode||`job_registry_${row.status}`,reason:row.reason||'',failureOwner:row.failureOwner||''};
    if(row.status==='retry'&&row.retryPhase==='execution')return {blocked:true,status:'retry_execution_owned',reasonCode:row.reasonCode||'execution_retry_owned',reason:row.reason||'',failureOwner:row.failureOwner||'our_system'};
    if(row.retryAfter&&Date.parse(row.retryAfter)>Date.now())return {blocked:true,status:'retry_wait',reasonCode:'retry_backoff',reason:`Retry after ${row.retryAfter}`,failureOwner:row.failureOwner||'transient'};
    return null;
  }

  setState(opportunity,status,detail={}){
    const identity=jobIdentity(opportunity);const now=new Date().toISOString();
    let row=this.records[identity]||this.observe(opportunity);
    row={...row,status:String(status||row.status||'new'),lastStateAt:now,lastSeenAt:row.lastSeenAt||now,...safeDetail(detail)};
    if(TERMINAL_STATUSES.has(row.status))row.terminal=true;
    this.records[identity]=row;this.persist();return {...row};
  }

  markPermanent(opportunity,{owner='market',reasonCode='permanent_rejection',reason=''}={}){
    const now=new Date().toISOString();
    const row=this.records[jobIdentity(opportunity)]||this.observe(opportunity);
    this.records[row.identity]={...row,status:'graveyard',terminal:true,failureOwner:String(owner||'market'),reasonCode:String(reasonCode||'permanent_rejection').slice(0,120),reason:String(reason||reasonCode||'').slice(0,500),retryAfter:'',closedAt:now,lastStateAt:now};
    this.persist();return {...this.records[row.identity]};
  }

  markRetry(opportunity,{owner='transient',reasonCode='retry_pending',reason='',attempts=1,retryAfter='',phase='claim'}={}){
    const row=this.records[jobIdentity(opportunity)]||this.observe(opportunity);
    this.records[row.identity]={...row,status:'retry',terminal:false,failureOwner:String(owner),reasonCode:String(reasonCode).slice(0,120),reason:String(reason).slice(0,500),attempts:Number(attempts||1),retryAfter:String(retryAfter||''),retryPhase:String(phase||'claim'),lastStateAt:new Date().toISOString()};
    this.persist();return {...this.records[row.identity]};
  }

  summary(){
    const rows=Object.values(this.records);
    const count=(pred)=>rows.filter(pred).length;
    return {total:rows.length,new:count(x=>x.status==='new'),ready:count(x=>x.status==='ready'),proposal:count(x=>x.status==='proposal'),working:count(x=>['claimed','executing','qa','bid_submitted'].includes(x.status)),retry:count(x=>['retry','manual_attention'].includes(x.status)),graveyard:count(x=>x.status==='graveyard'),delivered:count(x=>x.status==='delivered'),paid:count(x=>['paid','settled','completed'].includes(x.status)),updatedAt:new Date().toISOString()};
  }

  releaseTransientRetries(){
    let released=0;
    const now=new Date().toISOString();
    for(const [identity,row] of Object.entries(this.records)){
      if(row?.status!=='retry'||row?.failureOwner!=='transient'||row?.terminal)continue;
      this.records[identity]=row.retryPhase==='execution'
        ? {...row,retryAfter:'',reasonCode:'operator_retry_transient_execution',reason:'Transient execution retry released by operator.',lastStateAt:now}
        : {...row,status:'new',retryAfter:'',retryPhase:'',reasonCode:'operator_retry_transient_claim',reason:'Transient claim retry released by operator.',lastStateAt:now};
      released++;
    }
    if(released)this.persist();
    return {ok:true,released};
  }

  queues({limit=80}={}){
    const rows=Object.values(this.records).sort((a,b)=>Date.parse(b.lastStateAt||b.lastSeenAt||0)-Date.parse(a.lastStateAt||a.lastSeenAt||0));
    const take=statuses=>rows.filter(x=>statuses.includes(x.status)).slice(0,limit).map(x=>({...x}));
    return {new:take(['new','ready']),proposal:take(['proposal']),working:take(['bid_submitted','claimed','executing','qa']),retry:take(['retry','manual_attention']),delivered:take(['delivered']),paid:take(['paid','settled','completed']),graveyard:take(['graveyard'])};
  }

  persist(){
    const entries=Object.entries(this.records);
    if(entries.length>this.maxRecords){
      entries.sort((a,b)=>Date.parse(b[1].lastSeenAt||0)-Date.parse(a[1].lastSeenAt||0));
      this.records=Object.fromEntries(entries.slice(0,this.maxRecords));
    }
    this.store.writeJson('job-registry.json',this.records);
  }
}

export function jobIdentity(opportunity={}){return `${String(opportunity.source||'unknown')}:${String(opportunity.externalId||'')}`;}
export function jobFingerprint(opportunity={}){
  const stable=[opportunity.source,opportunity.externalId,opportunity.title,opportunity.description,Number(opportunity.budgetUsd||0).toFixed(6),opportunity.currency,opportunity.deadline,opportunity.claimMode].map(v=>String(v??'').trim()).join('\u241f');
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0,24);
}

export function classifyFailure(errorLike,{phase='execution'}={}){
  const text=String(errorLike?.message||errorLike||'').toLowerCase();
  if(/already[_ -]?claimed|already[_ -]?assigned|job[_ -]?taken|no longer available|not[_ -]?available|expired|closed|cancelled|listing[_ -]?removed|not[_ -]?found|http_404|http_410|http_409/.test(text))return {owner:'market',permanent:true,reasonCode:'market_job_no_longer_available'};
  if(/api[_ -]?key[_ -]?missing|unauthorized|forbidden|http_401|http_403/.test(text))return {owner:'our_system',permanent:false,reasonCode:'connector_credentials_or_auth_failure'};
  if(/budget_below_|job_below_floor|demo_or_test|economics_blocked:non_positive_profit|not_escrowed_and_escrow_required/.test(text))return {owner:'policy',permanent:true,reasonCode:'policy_rejected_job_version'};
  if(/delivery_failed:http_(404|409|410)/.test(text))return {owner:'market',permanent:true,reasonCode:'market_delivery_target_closed'};
  if(/delivery_failed:http_(400|401|403|422)/.test(text))return {owner:'our_system',permanent:false,reasonCode:'delivery_payload_or_auth_failure'};
  if(/timeout|timed out|econnreset|econnrefused|enotfound|fetch failed|network|http_429|http_5\d\d|temporar/.test(text))return {owner:'transient',permanent:false,reasonCode:'transient_market_or_network_failure'};
  if(/qa_|llm_|acceptance_contract|evidence_missing|looks_like_plan|tool_|missing_tool|work_order_unavailable/.test(text))return {owner:'our_system',permanent:false,reasonCode:'execution_or_capability_failure'};
  return {owner:phase==='claim'?'market':'our_system',permanent:false,reasonCode:phase==='claim'?'unclassified_claim_failure':'unclassified_execution_failure'};
}

function safeDetail(detail){
  const out={};for(const [key,value] of Object.entries(detail||{})){if(/secret|token|password|private/i.test(key))continue;out[key]=typeof value==='string'?value.slice(0,500):value;}return out;
}
