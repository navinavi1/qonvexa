const PRIORS = Object.freeze({
  't2000:already_assigned': { win:1, completion:.94, acceptance:.92, payment:.99 },
  't2000:open': { win:.40, completion:.92, acceptance:.90, payment:.99 },
  clawlancer: { win:.48, completion:.90, acceptance:.88, payment:.98 },
  'dealwork:bid': { win:.22, completion:.90, acceptance:.86, payment:.96 },
  dealwork: { win:.45, completion:.90, acceptance:.86, payment:.96 },
  superteam: { win:.10, completion:.90, acceptance:.35, payment:.96 },
  default: { win:.25, completion:.82, acceptance:.75, payment:.90 }
});

/** Estimate probability of paid revenue. Marketplace prior is blended with local history,
 * while per-job ownership history is kept separate so an old already-claimed recovery job
 * can never outrank a fresh opportunity in the commissioning lane. */
export function estimateOutcomeProbability(opportunity={}, capability={}, jobRows=[]) {
  const prior=priorFor(opportunity);
  const history=historicalSourceRate(String(opportunity.source||''),jobRows);
  const jobHistory=historicalJobState(opportunity,jobRows);
  const readiness=capability.executable?1:0.05;
  const toolingPenalty=Array.isArray(capability.missingTools)&&capability.missingTools.length?0.25:1;
  const escrowBoost=opportunity.escrowed?1:0.94;
  const localOutcome=history.samples?((history.successes+12*prior.acceptance)/(history.samples+12)):prior.acceptance;
  let probability=clamp(prior.win*prior.completion*localOutcome*prior.payment*readiness*toolingPenalty*escrowBoost,0.005,0.995);

  // `already_assigned` means a seller-side obligation, but old claimed/QA-failed records
  // also remain visible in that queue. Those obligations belong to durable recovery, not
  // fresh commissioning. State-machine/registry safety already blocks a duplicate claim;
  // this scheduler penalty ensures such a row cannot consume the single commissioning slot
  // while a genuinely fresh T2000 job is available.
  const ownedRecoveryOnly=String(opportunity.claimMode||'')==='already_assigned'&&jobHistory.everOwned;
  if(ownedRecoveryOnly)probability=0.005;

  return {
    probability:round6(probability),
    ownedRecoveryOnly,
    components:{win:prior.win,completion:prior.completion,acceptance:round6(localOutcome),payment:prior.payment,readiness:round6(readiness*toolingPenalty),escrowFactor:escrowBoost},
    history:{...history,currentJob:jobHistory}
  };
}

function priorFor(op={}) {
  if(op.source==='t2000'&&op.claimMode==='already_assigned')return PRIORS['t2000:already_assigned'];
  if(op.source==='t2000')return PRIORS['t2000:open'];
  if(op.source==='dealwork'&&op.claimMode==='bid')return PRIORS['dealwork:bid'];
  return PRIORS[op.source]||PRIORS.default;
}

function historicalJobState(op={},rows=[]){
  const source=String(op.source||''),externalId=String(op.externalId||op.id||'');
  const matched=[];
  for(const row of rows||[]){
    if(String(row?.source||'')!==source)continue;
    if(externalId&&String(row?.externalId||'')!==externalId)continue;
    matched.push(row);
  }
  const statuses=matched.map(row=>String(row?.status||'').toLowerCase()).filter(Boolean);
  const everOwned=statuses.some(status=>/^(?:claiming|claimed|executing|qa|execution_failed|manual_attention|delivered|settled|paid|completed)$/.test(status));
  const terminal=statuses.some(status=>/^(?:delivered|settled|paid|completed|rejected)$/.test(status));
  return{samples:matched.length,everOwned,terminal,lastStatus:statuses.at(-1)||''};
}

function historicalSourceRate(source,rows=[]) {
  const latest=new Map();
  for(const row of rows||[]){if(String(row?.source||'')!==source)continue;const key=String(row?.id||row?.externalId||'');if(!key)continue;latest.set(key,row);}
  let successes=0,failures=0,pending=0;
  for(const row of latest.values()){
    const status=String(row.status||'').toLowerCase();
    if(/paid|settled|completed/.test(status))successes++;
    else if(/execution_failed|delivery_failed|qa_failed|rejected/.test(status))failures++;
    else if(status==='delivered')pending++;
  }
  const samples=successes+failures;
  return{samples,successes,failures,pending,observedRate:samples?round6(successes/samples):null};
}
function clamp(v,min,max){return Math.min(max,Math.max(min,Number(v)||0));}
function round6(v){return Math.round((Number(v||0)+Number.EPSILON)*1e6)/1e6;}
