import { isRetiredMarket } from './retired-markets.js';
import {classifyFailure} from './job-registry.js';

// Only operational counters/codes go to provider logs. Job content, credentials,
// wallet addresses, callback signatures and provider response bodies stay out.
const code=value=>String(value||'unknown').split(/[:;\s]/)[0].replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)||'unknown';
const add=(counts,value)=>{const key=code(value);counts[key]=(counts[key]||0)+1;};
const FAILURE_CODES=['job_spend_limit','too_short','refusal_or_placeholder','llm_qa_unavailable','llm_qa_parse_failed','qa_refusal_or_apology_detected','qa_deliverable_echoes_task_not_completed','qa_required_format_mismatch','qa_failed','acceptance_contract_failed','required_execution_tools_unavailable','claimed_job_capability_no_longer_executable','tool_call_limit','timeout','competitive_auto_submit_disabled'];
export function executionFailureCodes(value){
  const message=String(value?.message||value||'').toLowerCase();
  const codes=FAILURE_CODES.filter(key=>message.includes(key));
  return codes.length?codes:[classifyFailure(message).reasonCode];
}
const TOOL_NAMES=new Set(['run_python','run_shell','web_search','web_scrape','browser_task','store_artifact','open_pull_request','app_tool_search','app_action','coderabbit_review','deploy_webhook']);
export function executionEvidenceSummary(deliverable={}){
  const calls=deliverable?.evidence?.toolCalls||[];
  const tools={},failures={};
  for(const call of calls){
    const name=TOOL_NAMES.has(call.tool)?call.tool:'other';
    const tally=tools[name]||{ok:0,failed:0};tally[call.ok?'ok':'failed']++;tools[name]=tally;
    if(!call.ok)for(const reason of executionFailureCodes(call.error))add(failures,reason);
  }
  return {contentChars:String(deliverable?.content||'').length,toolCount:calls.length,tools,failures};
}

function buildRevenueSourceDiagnostics(state={},marketRows=[],registryRows=[]){
  const bySource=new Map();
  const get=source=>{
    const id=code(source);
    if(!bySource.has(id))bySource.set(id,{source:id,discovered:0,sampled:0,executable:0,candidates:0,maxPayoutUsd:0,blockers:{},registryBlockers:{}});
    return bySource.get(id);
  };
  // Only current full-lifecycle/core earning rails are pre-seeded here. Other active
  // sources still appear automatically when they have live market rows or economics.
  const coreIds=[];
  for(const source of coreIds){
    const row=get(source);const health=state.connectorHealth?.[source]||{};const lifecycle=state.marketplaceLifecycle?.[source]||{};
    row.discovered=Math.max(row.discovered,Number(health.count||health.openCount||health.signals||0));
    row.healthy=health.ok===true;
    row.healthKnown=Object.keys(health).length>0;
    row.connected=Boolean(health.connected??health.configured??health.authenticated);
    row.claimReady=Boolean(health.claimReady);
    row.deliveryReady=Boolean(health.deliveryReady??health.deliveryQueueReady);
    if(health.error||health.reason)row.healthFailure=code(health.error||health.reason);
    if(Number(health.status)>=400)row.httpStatus=Number(health.status);
    row.workAutoReady=Boolean(lifecycle.workAutoReady);row.fullAutoReady=Boolean(lifecycle.fullAutoReady);row.cashoutState=code(lifecycle.cashoutState||'unknown');
  }
  for(const opportunity of Array.isArray(state.opportunityEconomics)?state.opportunityEconomics:[]){
    const row=get(opportunity.source);row.sampled++;
    if(opportunity.preflight?.ok)row.executable++;
    if(opportunity.candidacy?.isCandidate)row.candidates++;
    row.maxPayoutUsd=Math.max(row.maxPayoutUsd,Number(opportunity.budgetUsd||0));
    for(const reason of opportunity.candidacy?.reasons||[])add(row.blockers,reason);
  }
  // Registry details are intentionally reduced to source + reason counters. No external
  // job ids, titles, descriptions or marketplace payloads enter provider logs. This lets
  // us distinguish a stale preflight/auth hold from an old claimed/QA failure without
  // exposing customer work or credentials.
  for(const registry of registryRows||[]){
    if(!['system_blocked','capability_hold','manual_attention'].includes(String(registry?.status||'')))continue;
    const row=get(registry?.source||'unknown');
    add(row.registryBlockers,registry?.reasonCode||'system_blocked');
  }
  for(const market of marketRows){
    const row=get(market.source);row.discovered=Math.max(row.discovered,Number(market.signals||0));row.healthy=Boolean(market.healthy);row.healthKnown=true;row.authenticated=Boolean(market.authenticated);
    row.sampled+=Object.values(market.statuses||{}).reduce((n,v)=>n+Number(v||0),0);
    row.candidates+=Number(market.statuses?.eligible||0);
    for(const [reason,count] of Object.entries(market.blockers||{}))row.blockers[code(reason)]=(row.blockers[code(reason)]||0)+Number(count||0);
  }
  return [...bySource.values()].filter(row=>!isRetiredMarket(row)).sort((a,b)=>b.candidates-a.candidates||b.maxPayoutUsd-a.maxPayoutUsd||b.discovered-a.discovered||a.source.localeCompare(b.source));
}

export function executionDiagnostics({config={},state={},registry=[],inFlight=[],newMarkets=[],capabilities={}}={}){
  const statuses={},failures={},recovery={},recoveryFailures={};
  for(const row of registry){add(statuses,row.status);if(row.reasonCode&&['system_blocked','retry','policy_hold'].includes(row.status))add(failures,row.reasonCode);}
  for(const row of inFlight){add(recovery,row.status);if(row.lastError)for(const reason of executionFailureCodes(row.lastError))add(recoveryFailures,reason);}
  const markets=newMarkets.map(({source,settings={},health={},jobs=[],canary})=>{
    const statuses={},blockers={},missingTools={};
    for(const row of jobs){
      add(statuses,row.status);
      if(['filtered','eligible'].includes(row.status))for(const reason of row.qualification?.reasons||[]){
        add(blockers,reason);
        if(String(reason).startsWith('skill_mismatch:'))for(const tool of String(reason).slice(15).split(','))add(missingTools,tool);
      }
      if(['system_blocked','retry','uncertain'].includes(row.status))add(blockers,row.reasonCode||classifyFailure(row.reason).reasonCode);
    }
    return {source:code(source),enabled:Boolean(settings.enabled),mode:code(settings.mode),walletConfirmed:Boolean(settings.walletConfirmed),
      authenticated:Boolean(health.authenticated),healthy:health.ok===true,signals:Number(health.count||0),
      minPayoutUsd:Number(settings.minPayoutUsd||0),competitiveAllowed:Boolean(settings.competitiveAllowed),
      canary:canary?code(canary.status):'none',statuses,blockers,missingTools};
  });
  const tools=Object.fromEntries(Object.entries(capabilities).filter(([key,value])=>typeof value==='boolean'&&/^(has|llm)/.test(key)));
  const revenueSources=buildRevenueSourceDiagnostics(state,markets,registry);
  return {enabled:Boolean(config.enabled),killSwitch:Boolean(config.killSwitch),autoClaimJobs:Boolean(config.autoClaimJobs),autoCompetitiveSubmissions:Boolean(config.autoCompetitiveSubmissions),
    zeroSpendMode:Boolean(config.zeroSpendMode),earnedFundsOnly:Boolean(config.earnedFundsOnly),allowExternalSpending:Boolean(config.allowExternalSpending),
    seedSpendBudgetUsd:Number(config.seedSpendBudgetUsd||0),availableSpendUsd:Number(state.earnedSpendBudgetUsd||0),
    maxPaidProcurementUsd:Number(config.maxPaidProcurementUsd||0),minJobPayoutUsd:Number(config.minJobPayoutUsd||0),
    readiness:code(state.earningReadiness?.code),blockers:state.marketFunnel?.blockers||{},registry:statuses,failures,recovery,recoveryFailures,tools,markets,revenueSources};
}

export function logExecutionEvent(logger,type,detail={}){
  if(!/^(?:runtime_|cycle_|fast_cycle_|job_(?:memory|planning|planned|graph_setup|execution|state_transition)|qa_(?:evaluated|repair_started|repair_evaluated)|market_job_|marketplace_(?:claimed|executing|submitted|paid|retry|system_blocked|uncertain|launch_deferred|poll_error)|trigger_|langgraph_checkpoint_unavailable)/.test(type))return;
  const row={at:new Date().toISOString(),type};
  for(const field of ['cycleId','jobId','source','provider','from','to'])if(detail[field])row[field]=code(detail[field]);
  for(const field of ['ms','opportunities','candidates','claimed','delivered','durableDispatched','attempt','attempts','recovered','retryCount','ok','score','steps']){
    if(typeof detail[field]==='number'||typeof detail[field]==='boolean')row[field]=detail[field];
  }
  if(detail.error||detail.reason){
    const failure=classifyFailure(detail.error||detail.reason);
    row.failureCode=failure.reasonCode;row.failureOwner=failure.owner;
    row.failureDetails=executionFailureCodes(detail.error||detail.reason);
    const http=String(detail.error||detail.reason).match(/(?:http[_ :]|status[= :]+)([45]\d\d)/i);
    if(http)row.httpStatus=Number(http[1]);
  }
  if(type.startsWith('qa_')){
    if(['deterministic','deterministic_verified','policy_fail_open','fail_closed','llm_evaluator'].includes(detail.mode))row.mode=detail.mode;
    if(Array.isArray(detail.reasons))row.failureDetails=[...new Set(detail.reasons.flatMap(executionFailureCodes))];
    if(detail.evidence){
      const count=value=>Number.isFinite(value)&&value>=0?Math.floor(value):0;
      const tools={},failures={};
      for(const [name,tally] of Object.entries(detail.evidence.tools||{}))if(TOOL_NAMES.has(name)||name==='other')tools[name]={ok:count(tally?.ok),failed:count(tally?.failed)};
      for(const [reason,value] of Object.entries(detail.evidence.failures||{}))for(const key of executionFailureCodes(reason))failures[key]=(failures[key]||0)+count(value);
      row.evidence={contentChars:count(detail.evidence.contentChars),toolCount:count(detail.evidence.toolCount),tools,failures};
    }
  }
  try{logger.info?.('[AutonomOS] '+JSON.stringify(row));}catch{}
}
