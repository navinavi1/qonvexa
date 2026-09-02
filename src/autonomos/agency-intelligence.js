import crypto from 'node:crypto';

/**
 * AutonomOS Agency Intelligence 4.0
 *
 * This module is deliberately provider-neutral. It adds the control-plane layer that
 * turns "an agent that can execute a job" into an agency that can choose jobs, learn
 * from outcomes, protect unit economics and explain every routing decision.
 */

export const JOB_STATES = Object.freeze([
  'discovered','qualified','selected','claiming','claimed','executing','qa',
  'delivering','delivered','settled','failed','cancelled','needs_human'
]);

const TRANSITIONS = Object.freeze({
  discovered:['qualified','failed','cancelled'],
  qualified:['selected','failed','cancelled'],
  selected:['claiming','needs_human','failed','cancelled'],
  claiming:['claimed','failed','cancelled','needs_human'],
  claimed:['executing','failed','cancelled','needs_human'],
  executing:['qa','failed','cancelled','needs_human'],
  qa:['delivering','failed','needs_human'],
  delivering:['delivered','failed','needs_human'],
  delivered:['settled','failed'],
  settled:[],
  failed:['selected','needs_human'],
  cancelled:[],
  needs_human:['selected','cancelled','failed'],
});

export function canTransition(from,to){
  return String(TRANSITIONS[String(from)||'discovered']||[]).includes(String(to));
}

export function transitionJob(job,to,detail={}){
  const from=String(job?.state||'discovered');
  const target=String(to||'');
  if(!canTransition(from,target)){
    const error=new Error(`invalid_job_transition:${from}->${target}`);
    error.code='INVALID_JOB_TRANSITION';
    throw error;
  }
  return {
    ...(job||{}),
    state:target,
    previousState:from,
    stateChangedAt:new Date().toISOString(),
    stateDetail:safeDetail(detail)
  };
}

export function createJobIdentity(opportunity={}){
  const source=String(opportunity.source||'unknown');
  const externalId=String(opportunity.externalId||'');
  const stable=`${source}:${externalId}`;
  return {
    id:`agency_${crypto.createHash('sha256').update(stable).digest('hex').slice(0,20)}`,
    idempotencyKey:stable,
    source,
    externalId
  };
}

/**
 * Score for routing, not a replacement for the existing Profit Engine.
 * Profit Engine remains the hard economic gate; this layer ranks candidates that
 * already passed that gate.
 */
export function scoreOpportunity(op={},learning={},now=Date.now()){
  const budget=positive(op.budgetUsd);
  const probability=clamp(op.outcome?.probability,.005,.995,.05);
  const expectedProfit=positive(op.economics?.expectedProfitUsd);
  const modelCost=positive(op.capability?.estimatedModelCostUsd);
  const fee=budget*positive(op.feePercent)/100;
  const skill=String(op.capability?.skill||'general-digital');
  const source=String(op.source||'unknown');
  const history=learning?.sources?.[source]||{};
  const skillHistory=learning?.skills?.[skill]||{};

  const reliability=blend(
    Number(history.acceptanceRate),
    Number(skillHistory.acceptanceRate),
    .5,
    .5,
    .75
  );
  const costRatio=budget>0?(modelCost+fee)/budget:1;
  const deadlineRisk=deadlineFactor(op.deadline,now);
  const escrow=op.escrowed?1:.9;
  const capability=op.capability?.executable?1:.05;
  const value=expectedProfit*Math.max(probability,.01);
  const margin=budget>0?Math.max(0,(expectedProfit-fee-modelCost)/budget):0;

  // 0..100 routing score. Hard policy/economics gates still live elsewhere.
  const raw =
    34*clamp(value/Math.max(budget,1),0,1) +
    22*clamp(reliability,0,1) +
    16*clamp(margin,0,1) +
    10*deadlineRisk +
    8*escrow +
    10*capability -
    12*clamp(costRatio,0,1);

  return {
    score:round(clamp(raw,0,100)),
    factors:{
      expectedValueUsd:round(value),
      expectedProfitUsd:round(expectedProfit),
      probability:round(probability),
      reliability:round(reliability),
      margin:round(margin*100),
      deadlineRisk:round(deadlineRisk),
      escrow,
      capability,
      costRatio:round(costRatio*100)
    }
  };
}

/**
 * Learn from terminal jobs without allowing the model to rewrite policy.
 * The learning loop is descriptive: it changes ranking evidence, never safety,
 * spending limits, credentials or payout rules.
 */
export function buildLearningSnapshot(jobs=[],opportunities=[]){
  const terminal=latestTerminalJobs(jobs);
  const sources={};
  const skills={};
  const outcomes={};
  for(const row of terminal){
    const source=String(row.source||'unknown');
    const skill=String(row.skill||row.capability?.skill||'general-digital');
    const success=isSuccess(row.status);
    addStat(sources,source,row,success);
    addStat(skills,skill,row,success);
    const key=String(row.status||'unknown');
    outcomes[key]=(outcomes[key]||0)+1;
  }
  return {
    generatedAt:new Date().toISOString(),
    sampleSize:terminal.length,
    sources:finalizeStats(sources),
    skills:finalizeStats(skills),
    outcomes,
    opportunitiesObserved:Number(opportunities.length||0),
    policy:{learningMayRankOnly:true,learningCannotChangeSafetyOrSpendLimits:true}
  };
}

export function recommendActions(snapshot={}){
  const actions=[];
  const sources=Object.entries(snapshot.sources||{});
  const weak=sources.filter(([,v])=>Number(v.samples||0)>=5&&Number(v.acceptanceRate||0)<.5)
    .sort((a,b)=>Number(a[1].acceptanceRate)-Number(b[1].acceptanceRate));
  if(weak.length)actions.push({
    priority:'high',
    action:'deprioritize_low_acceptance_source',
    source:weak[0][0],
    reason:`acceptance_rate_${Math.round(Number(weak[0][1].acceptanceRate)*100)}pct`
  });
  const strong=sources.filter(([,v])=>Number(v.samples||0)>=5&&Number(v.acceptanceRate||0)>=.8)
    .sort((a,b)=>Number(b[1].netProfitUsd)-Number(a[1].netProfitUsd));
  if(strong.length)actions.push({
    priority:'high',
    action:'increase_attention_to_reliable_source',
    source:strong[0][0],
    reason:'measured_acceptance_and_profit'
  });
  if(!actions.length)actions.push({
    priority:'normal',
    action:'collect_more_outcome_data',
    reason:'learning_sample_is_still_small'
  });
  return actions.slice(0,5);
}

function latestTerminalJobs(rows){
  const latest=new Map();
  for(const row of rows||[]){
    if(!row?.externalId)continue;
    const key=`${row.source||'unknown'}:${row.externalId}`;
    const status=String(row.status||'').toLowerCase();
    if(!/(settled|delivered|failed|rejected|expired|cancelled)/.test(status))continue;
    const old=latest.get(key);
    if(!old||String(row.at||row.timestamp||'')>String(old.at||old.timestamp||''))latest.set(key,row);
  }
  return [...latest.values()];
}
function addStat(bucket,key,row,success){
  const item=bucket[key] ||= {samples:0,successes:0,failures:0,grossRevenueUsd:0,costUsd:0};
  item.samples++;
  if(success)item.successes++;else item.failures++;
  item.grossRevenueUsd+=positive(row.grossUsd||row.budgetUsd||row.amountUsd);
  item.costUsd+=positive(row.costUsd||row.actualCostUsd||row.apiCostUsd);
}
function finalizeStats(bucket){
  return Object.fromEntries(Object.entries(bucket).map(([key,v])=>[key,{
    ...v,
    acceptanceRate:v.samples?round(v.successes/v.samples):0,
    avgRevenueUsd:v.samples?round(v.grossRevenueUsd/v.samples):0,
    avgCostUsd:v.samples?round(v.costUsd/v.samples):0,
    netProfitUsd:round(v.grossRevenueUsd-v.costUsd)
  }]));
}
function isSuccess(status){return /settled|delivered|completed|paid/i.test(String(status||''));}
function deadlineFactor(value,now){
  if(!value)return .85;
  const t=Date.parse(String(value));
  if(!Number.isFinite(t))return .8;
  const hours=(t-now)/3600000;
  if(hours<=0)return .05;
  if(hours<2)return .35;
  if(hours<8)return .65;
  if(hours<24)return .85;
  return 1;
}
function blend(a,b,wa,wb,fallback){
  const av=Number.isFinite(a)?a:null,bv=Number.isFinite(b)?b:null;
  if(av===null&&bv===null)return fallback;
  if(av===null)return bv;
  if(bv===null)return av;
  return av*wa+bv*wb;
}
function positive(v){const n=Number(v);return Number.isFinite(n)&&n>0?n:0;}
function clamp(v,min,max,fallback){
  const n=Number(v);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;
}
function round(v){return Math.round((Number(v||0)+Number.EPSILON)*1e6)/1e6;}
function safeDetail(value){
  if(!value||typeof value!=='object')return {};
  const out={};
  for(const [k,v] of Object.entries(value).slice(0,20)){
    if(/token|secret|password|key/i.test(k))continue;
    out[String(k).slice(0,60)]=typeof v==='string'?v.slice(0,300):v;
  }
  return out;
}
