import crypto from 'node:crypto';

const TERMINAL_STATUSES=new Set(['graveyard','delivered','paid','settled','completed','expired','cancelled','rejected']);
const OWNED_STATUSES=new Set(['bid_submitted','claimed','executing','qa','delivered','paid','settled','completed']);
const SYSTEM_BLOCKED_STATUSES=new Set(['system_blocked','capability_hold','manual_attention']);
const POLICY_HOLD_STATUSES=new Set(['policy_hold','not_eligible']);

export class JobRegistry {
  constructor({store,maxRecords=12000}={}){
    if(!store)throw new Error('JobRegistry requires store');
    this.store=store;
    this.maxRecords=Math.max(1000,Number(maxRecords||12000));
    this.records=store.readJson('job-registry.json',{});
    // Tombstones are intentionally stored separately and are NEVER pruned with the
    // operational registry. They are keyed by marketplace + external job id, not by a
    // mutable content fingerprint, so changing a title/deadline cannot resurrect a dead job.
    this.tombstones=store.readJson('job-tombstones.json',{});
  }

  observe(opportunity,{legacyHandled=false}={}){
    const identity=jobIdentity(opportunity);
    const fingerprint=jobFingerprint(opportunity);
    const now=new Date().toISOString();
    const tombstone=this.tombstones[identity];
    if(tombstone){
      const row={...(this.records[identity]||baseRow(opportunity,identity,fingerprint,now)),fingerprint,version:Number(this.records[identity]?.version||1),status:'graveyard',terminal:true,failureOwner:tombstone.failureOwner||'market',reasonCode:tombstone.reasonCode||'permanent_tombstone',reason:tombstone.reason||'',closedAt:tombstone.closedAt||now,lastSeenAt:now,seenCount:Number(this.records[identity]?.seenCount||0)+1};
      this.records[identity]=row;this.persist();return {...row};
    }
    let row=this.records[identity];
    if(!row){
      row=baseRow(opportunity,identity,fingerprint,now);
      this.records[identity]=row;
      if(legacyHandled)this.markPermanent(opportunity,{owner:'legacy',reasonCode:'legacy_handled_before_v7',reason:'Migrated from the pre-v7 handled-opportunity blacklist.'});
      else this.persist();
      return this.get(opportunity);
    }
    if(row.fingerprint!==fingerprint){
      const previous={fingerprint:row.fingerprint,status:row.status,terminal:Boolean(row.terminal),reasonCode:row.reasonCode||'',closedAt:row.closedAt||row.lastSeenAt||''};
      // Only non-terminal/non-owned/non-system-blocked rows may become a new content
      // version. Permanent tombstones are already handled above. Claimed/system-blocked
      // jobs remain owned/blocked despite mutable marketplace metadata.
      if(!row.terminal&&!OWNED_STATUSES.has(String(row.status||''))&&!SYSTEM_BLOCKED_STATUSES.has(String(row.status||''))){
        row={...row,fingerprint,version:Number(row.version||1)+1,status:'new',failureOwner:'',reasonCode:'',reason:'',retryAfter:'',attempts:0,lastSeenAt:now,seenCount:Number(row.seenCount||0)+1,previousVersions:[...(row.previousVersions||[]).slice(-8),previous]};
      }else row={...row,lastSeenAt:now,seenCount:Number(row.seenCount||0)+1,previousVersions:[...(row.previousVersions||[]).slice(-8),previous]};
    }else row={...row,lastSeenAt:now,seenCount:Number(row.seenCount||0)+1};
    row=refreshMetadata(row,opportunity);
    this.records[identity]=row;this.persist();return {...row};
  }

  get(opportunityOrIdentity){
    const identity=typeof opportunityOrIdentity==='string'?opportunityOrIdentity:jobIdentity(opportunityOrIdentity);
    const row=this.records[identity];return row?{...row}:null;
  }

  blockReason(opportunity){
    const identity=typeof opportunity==='string'?opportunity:jobIdentity(opportunity);
    const tombstone=this.tombstones[identity];
    if(tombstone)return {blocked:true,status:'graveyard',reasonCode:tombstone.reasonCode||'permanent_tombstone',reason:tombstone.reason||'',failureOwner:tombstone.failureOwner||'market'};
    const row=this.get(identity);if(!row)return null;
    if(SYSTEM_BLOCKED_STATUSES.has(String(row.status||'')))return {blocked:true,status:'system_blocked',reasonCode:row.reasonCode||'system_blocked',reason:row.reason||'',failureOwner:'our_system'};
    if(row.terminal||OWNED_STATUSES.has(String(row.status||'')))return {blocked:true,status:row.status,reasonCode:row.reasonCode||`job_registry_${row.status}`,reason:row.reason||'',failureOwner:row.failureOwner||''};
    if(row.status==='retry'&&row.retryPhase==='execution')return {blocked:true,status:'retry_execution_owned',reasonCode:row.reasonCode||'execution_retry_owned',reason:row.reason||'',failureOwner:row.failureOwner||'our_system'};
    if(row.retryAfter&&Date.parse(row.retryAfter)>Date.now())return {blocked:true,status:'retry_wait',reasonCode:'retry_backoff',reason:`Retry after ${row.retryAfter}`,failureOwner:row.failureOwner||'transient'};
    return null;
  }

  setState(opportunity,status,detail={}){
    const identity=typeof opportunity==='string'?opportunity:jobIdentity(opportunity);const now=new Date().toISOString();
    let row=this.records[identity]||this.observe(opportunity);
    row={...row,status:String(status||row.status||'new'),lastStateAt:now,lastSeenAt:row.lastSeenAt||now,...safeDetail(detail)};
    if(TERMINAL_STATUSES.has(row.status))row.terminal=true;
    this.records[identity]=row;this.persist();return {...row};
  }

  markPermanent(opportunity,{owner='market',reasonCode='permanent_rejection',reason=''}={}){
    const identity=typeof opportunity==='string'?opportunity:jobIdentity(opportunity);const now=new Date().toISOString();
    const existing=this.records[identity]||(typeof opportunity==='string'?{identity,source:identity.split(':')[0],externalId:identity.slice(identity.indexOf(':')+1),firstSeenAt:now,lastSeenAt:now,seenCount:1}:this.observe(opportunity));
    const tombstone={identity,source:existing.source||'',externalId:existing.externalId||'',failureOwner:String(owner||'market'),reasonCode:String(reasonCode||'permanent_rejection').slice(0,120),reason:String(reason||reasonCode||'').slice(0,500),closedAt:now};
    this.tombstones[identity]=tombstone;this.store.writeJson('job-tombstones.json',this.tombstones);
    this.records[identity]={...existing,status:'graveyard',terminal:true,...tombstone,retryAfter:'',lastStateAt:now};
    this.persist();return {...this.records[identity]};
  }


  markPolicyHold(opportunity,{reasonCode='policy_hold',reason='',owner='policy'}={}){
    const identity=jobIdentity(opportunity);const row=this.records[identity]||this.observe(opportunity);const now=new Date().toISOString();
    this.records[identity]={...row,status:'policy_hold',terminal:false,failureOwner:String(owner||'policy'),reasonCode:String(reasonCode).slice(0,120),reason:String(reason).slice(0,500),retryAfter:'',lastStateAt:now};
    this.persist();return {...this.records[identity]};
  }

  rescueOverbroadPolicyTombstones(){
    let rescued=0;const now=new Date().toISOString();
    for(const [identity,tomb] of Object.entries(this.tombstones)){
      if(String(tomb?.failureOwner||'')!=='policy')continue;
      const reason=String(tomb?.reason||'');
      const keepPermanent=/demo_or_test_opportunity|status_not_open:(?:closed|expired|cancelled|canceled|removed|rejected|filled|completed)\b/i.test(reason);
      const wasOverbroad=/budget_below_|_job_below_floor:|t2000_open_job_below_floor:|economics_blocked:|not_escrowed_and_escrow_required|status_not_open:/i.test(reason);
      if(!wasOverbroad||keepPermanent)continue;
      delete this.tombstones[identity];
      const row=this.records[identity]||{identity,source:tomb.source||identity.split(':')[0],externalId:tomb.externalId||identity.slice(identity.indexOf(':')+1),firstSeenAt:now,lastSeenAt:now,seenCount:1};
      this.records[identity]={...row,status:'policy_hold',terminal:false,failureOwner:'policy',reasonCode:'rescued_from_overbroad_graveyard',reason:`Re-evaluate after v7.2 policy fix: ${reason}`.slice(0,500),closedAt:'',retryAfter:'',lastStateAt:now};
      rescued++;
    }
    if(rescued){this.store.writeJson('job-tombstones.json',this.tombstones);this.persist();}
    return {ok:true,rescued};
  }

  markSystemBlocked(opportunity,{reasonCode='system_blocked',reason='',attempts=1,capabilityVersion=''}={}){
    const identity=jobIdentity(opportunity);const row=this.records[identity]||this.observe(opportunity);const now=new Date().toISOString();
    this.records[identity]={...row,status:'system_blocked',terminal:false,failureOwner:'our_system',reasonCode:String(reasonCode).slice(0,120),reason:String(reason).slice(0,500),attempts:Number(attempts||1),retryAfter:'',capabilityVersion:String(capabilityVersion||''),lastStateAt:now};
    this.persist();return {...this.records[identity]};
  }

  releaseSystemBlocked(opportunity,{capabilityVersion=''}={}){
    const identity=jobIdentity(opportunity);const row=this.records[identity];
    if(!row||!SYSTEM_BLOCKED_STATUSES.has(String(row.status||'')))return {ok:true,released:false};
    const nextVersion=String(capabilityVersion||'');
    if(!nextVersion||nextVersion===String(row.capabilityVersion||''))return {ok:true,released:false};
    this.records[identity]={...row,status:'new',failureOwner:'',reasonCode:'capability_version_changed',reason:'Execution capability changed; job released for a fresh preflight.',attempts:0,retryAfter:'',capabilityVersion:nextVersion,lastStateAt:new Date().toISOString()};
    this.persist();return {ok:true,released:true};
  }

  markRetry(opportunity,{owner='transient',reasonCode='retry_pending',reason='',attempts=1,retryAfter='',phase='claim'}={}){
    const row=this.records[jobIdentity(opportunity)]||this.observe(opportunity);
    this.records[row.identity]={...row,status:'retry',terminal:false,failureOwner:String(owner),reasonCode:String(reasonCode).slice(0,120),reason:String(reason).slice(0,500),attempts:Number(attempts||1),retryAfter:String(retryAfter||''),retryPhase:String(phase||'claim'),lastStateAt:new Date().toISOString()};
    this.persist();return {...this.records[row.identity]};
  }

  releaseTransientRetries(){
    let released=0;const now=new Date().toISOString();
    for(const [identity,row] of Object.entries(this.records)){
      if(row?.status!=='retry'||row?.failureOwner!=='transient'||row?.terminal)continue;
      this.records[identity]=row.retryPhase==='execution'?{...row,retryAfter:'',reasonCode:'operator_retry_transient_execution',reason:'Transient execution retry released by operator.',lastStateAt:now}:{...row,status:'new',retryAfter:'',retryPhase:'',reasonCode:'operator_retry_transient_claim',reason:'Transient claim retry released by operator.',lastStateAt:now};released++;
    }
    if(released)this.persist();return {ok:true,released};
  }

  summary(){
    const rows=Object.values(this.records),count=pred=>rows.filter(pred).length;
    return {total:rows.length,new:count(x=>x.status==='new'),ready:count(x=>x.status==='ready'),proposal:count(x=>x.status==='proposal'),working:count(x=>['bid_submitted','claimed','executing','qa'].includes(x.status)),retry:count(x=>x.status==='retry'),policyHold:count(x=>POLICY_HOLD_STATUSES.has(x.status)),systemBlocked:count(x=>SYSTEM_BLOCKED_STATUSES.has(x.status)),graveyard:Object.keys(this.tombstones).length,delivered:count(x=>x.status==='delivered'),paid:count(x=>['paid','settled','completed'].includes(x.status)),updatedAt:new Date().toISOString()};
  }

  queues({limit=80}={}){
    const rows=Object.values(this.records).sort((a,b)=>Date.parse(b.lastStateAt||b.lastSeenAt||0)-Date.parse(a.lastStateAt||a.lastSeenAt||0));
    const take=statuses=>rows.filter(x=>statuses.includes(x.status)).slice(0,limit).map(x=>({...x}));
    return {new:take(['new','ready']),proposal:take(['proposal']),working:take(['bid_submitted','claimed','executing','qa']),retry:take(['retry']),policyHold:take(['policy_hold','not_eligible']),systemBlocked:take(['system_blocked','capability_hold','manual_attention']),delivered:take(['delivered']),paid:take(['paid','settled','completed']),graveyard:take(['graveyard'])};
  }

  migrateLegacy({handledKeys=[],jobs=[]}={}){
    let tombstoned=0,systemBlocked=0;
    for(const key of handledKeys||[]){
      const identity=String(key||'');if(!identity.includes(':')||this.tombstones[identity])continue;
      const latest=(jobs||[]).filter(j=>`${j.source}:${j.externalId}`===identity).sort((a,b)=>Date.parse(b.at||b.startedAt||0)-Date.parse(a.at||a.startedAt||0))[0];
      if(!latest)continue;
      const latestStatus=String(latest.status||'').toLowerCase();
      if(['delivered','paid','settled','completed','bid_submitted','claimed'].includes(latestStatus)){
        this.markPermanent(legacyOpportunity(latest),{owner:'completed',reasonCode:`legacy_${latestStatus}_job`,reason:`Legacy job already reached ${latestStatus}; it must never be claimed again.`});tombstoned++;continue;
      }
      const failure=classifyFailure(latest.error||latest.reason||latest.status||'',{phase:'execution'});
      if(failure.owner==='our_system'){
        const op=legacyOpportunity(latest);this.observe(op);this.markSystemBlocked(op,{reasonCode:failure.reasonCode,reason:latest.error||latest.reason||latest.status||'legacy system failure'});systemBlocked++;
      }else{
        this.markPermanent(legacyOpportunity(latest),{owner:failure.owner||'legacy',reasonCode:failure.reasonCode||'legacy_handled',reason:latest.error||latest.reason||latest.status||'Legacy handled job'});tombstoned++;
      }
    }
    return {ok:true,tombstoned,systemBlocked};
  }

  persist(){
    const entries=Object.entries(this.records);
    if(entries.length>this.maxRecords){
      const removable=entries.filter(([,r])=>!r.terminal&&!OWNED_STATUSES.has(String(r.status||''))&&!SYSTEM_BLOCKED_STATUSES.has(String(r.status||''))).sort((a,b)=>Date.parse(a[1].lastSeenAt||0)-Date.parse(b[1].lastSeenAt||0));
      const drop=new Set(removable.slice(0,Math.max(0,entries.length-this.maxRecords)).map(([id])=>id));
      this.records=Object.fromEntries(entries.filter(([id])=>!drop.has(id)));
    }
    this.store.writeJson('job-registry.json',this.records);
  }
}

function baseRow(opportunity,identity,fingerprint,now){return refreshMetadata({identity,source:String(opportunity?.source||''),externalId:String(opportunity?.externalId||''),fingerprint,version:1,status:'new',terminal:false,firstSeenAt:now,lastSeenAt:now,seenCount:1},opportunity);}
function refreshMetadata(row,opportunity){return {...row,title:String(opportunity?.title||row.title||'').slice(0,300),budgetUsd:Number(opportunity?.budgetUsd??row.budgetUsd??0),currency:String(opportunity?.currency||row.currency||''),claimMode:String(opportunity?.claimMode||row.claimMode||''),deadline:String(opportunity?.deadline||row.deadline||''),url:String(opportunity?.url||row.url||'')};}
function legacyOpportunity(row={}){return {source:String(row.source||'unknown'),externalId:String(row.externalId||row.id||''),title:String(row.title||''),budgetUsd:Number(row.budgetUsd||0),currency:String(row.currency||''),claimMode:String(row.claimMode||''),deadline:String(row.deadline||''),description:String(row.description||'')};}
export function jobIdentity(opportunity={}){return `${String(opportunity.source||'unknown')}:${String(opportunity.externalId||'')}`;}
export function jobFingerprint(opportunity={}){const stable=[opportunity.source,opportunity.externalId,opportunity.title,opportunity.description,Number(opportunity.budgetUsd||0).toFixed(6),opportunity.currency,opportunity.deadline,opportunity.claimMode].map(v=>String(v??'').trim()).join('\u241f');return crypto.createHash('sha256').update(stable).digest('hex').slice(0,24);}
export function classifyFailure(errorLike,{phase='execution'}={}){
  const text=String(errorLike?.message||errorLike||'').toLowerCase();
  if(/already[_ -]?claimed|already[_ -]?assigned|job[_ -]?taken|no longer available|not[_ -]?available|expired|closed|cancelled|listing[_ -]?removed|not[_ -]?found|http_404|http_410|http_409/.test(text))return {owner:'market',permanent:true,reasonCode:'market_job_no_longer_available'};
  if(/api[_ -]?key[_ -]?missing|unauthorized|forbidden|http_401|http_403/.test(text))return {owner:'our_system',permanent:false,reasonCode:'connector_credentials_or_auth_failure'};
  if(/demo_or_test/.test(text))return {owner:'policy',permanent:true,reasonCode:'demo_or_test_listing'};
  if(/budget_below_|job_below_floor|economics_blocked:|not_escrowed_and_escrow_required/.test(text))return {owner:'policy',permanent:false,reasonCode:'policy_hold'};
  if(/delivery_failed:http_(404|409|410)/.test(text))return {owner:'market',permanent:true,reasonCode:'market_delivery_target_closed'};
  if(/delivery_failed:http_(400|401|403|422)/.test(text))return {owner:'our_system',permanent:false,reasonCode:'delivery_payload_or_auth_failure'};
  if(/timeout|timed out|econnreset|econnrefused|enotfound|fetch failed|network|http_429|http_5\d\d|temporar/.test(text))return {owner:'transient',permanent:false,reasonCode:'transient_market_or_network_failure'};
  if(/qa_|llm_|acceptance_contract|evidence_missing|looks_like_plan|tool_|missing_tool|work_order_unavailable|required_execution_tools_unavailable/.test(text))return {owner:'our_system',permanent:false,reasonCode:'execution_or_capability_failure'};
  return {owner:phase==='claim'?'market':'our_system',permanent:false,reasonCode:phase==='claim'?'unclassified_claim_failure':'unclassified_execution_failure'};
}
function safeDetail(detail){const out={};for(const [key,value] of Object.entries(detail||{})){if(/secret|token|password|private/i.test(key))continue;out[key]=typeof value==='string'?value.slice(0,500):value;}return out;}
