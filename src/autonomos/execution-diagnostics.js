import {classifyFailure} from './job-registry.js';

// Only operational counters/codes go to provider logs. Job content, credentials,
// wallet addresses, callback signatures and provider response bodies stay out.
const code=value=>String(value||'unknown').split(/[:;\s]/)[0].replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)||'unknown';
const add=(counts,value)=>{const key=code(value);counts[key]=(counts[key]||0)+1;};
export function executionDiagnostics({config={},state={},registry=[],inFlight=[],newMarkets=[],capabilities={}}={}){
  const statuses={},failures={},recovery={};
  for(const row of registry){add(statuses,row.status);if(row.reasonCode&&['system_blocked','retry','policy_hold'].includes(row.status))add(failures,row.reasonCode);}
  for(const row of inFlight)add(recovery,row.status);
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
  return {enabled:Boolean(config.enabled),killSwitch:Boolean(config.killSwitch),autoClaimJobs:Boolean(config.autoClaimJobs),autoCompetitiveSubmissions:Boolean(config.autoCompetitiveSubmissions),
    zeroSpendMode:Boolean(config.zeroSpendMode),earnedFundsOnly:Boolean(config.earnedFundsOnly),allowExternalSpending:Boolean(config.allowExternalSpending),
    seedSpendBudgetUsd:Number(config.seedSpendBudgetUsd||0),availableSpendUsd:Number(state.earnedSpendBudgetUsd||0),
    maxPaidProcurementUsd:Number(config.maxPaidProcurementUsd||0),minJobPayoutUsd:Number(config.minJobPayoutUsd||0),
    readiness:code(state.earningReadiness?.code),blockers:state.marketFunnel?.blockers||{},registry:statuses,failures,recovery,tools,markets};
}

export function logExecutionEvent(logger,type,detail={}){
  if(!/^(?:runtime_|cycle_|fast_cycle_|job_(?:memory|planning|planned|graph_setup|execution|state_transition)|qa_evaluated|market_job_|marketplace_(?:claimed|executing|submitted|paid|retry|system_blocked|uncertain|launch_deferred|poll_error)|trigger_|temporal_|langgraph_checkpoint_unavailable)/.test(type))return;
  const row={at:new Date().toISOString(),type};
  for(const field of ['cycleId','jobId','source','provider','from','to'])if(detail[field])row[field]=code(detail[field]);
  for(const field of ['ms','opportunities','candidates','claimed','delivered','durableDispatched','attempt','attempts','recovered','retryCount','ok','score','steps']){
    if(typeof detail[field]==='number'||typeof detail[field]==='boolean')row[field]=detail[field];
  }
  if(detail.error||detail.reason){
    const failure=classifyFailure(detail.error||detail.reason);
    row.failureCode=failure.reasonCode;row.failureOwner=failure.owner;
    const http=String(detail.error||detail.reason).match(/(?:http[_ :]|status[= :]+)([45]\d\d)/i);
    if(http)row.httpStatus=Number(http[1]);
  }
  try{logger.info?.('[AutonomOS] '+JSON.stringify(row));}catch{}
}
