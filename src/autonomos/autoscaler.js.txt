export function desiredChildCapacity({queueDepth=0,activeJobs=0,currentChildren=0,config={},estimatedCostPerChildUsd=0}={}){
  if(!config.autoReplication||Number(config.maxChildren||0)<=0)return 0;
  const threshold=Math.max(1,Number(config.childSpawnConcurrencyThreshold||2));
  const concurrency=Math.max(1,Number(config.maxConcurrentJobs||4));
  const pressure=Math.max(0,Number(queueDepth||0))+Math.max(0,Number(activeJobs||0));
  // Core workers already provide baseline capacity. Elastic children cover pressure beyond
  // one threshold unit and are capped both globally and by the actual concurrency ceiling.
  let desired=Math.max(0,Math.ceil(pressure/threshold)-1);
  desired=Math.min(desired,Number(config.maxChildren||0),Math.max(0,concurrency-1));
  if(config.zeroSpendMode&&estimatedCostPerChildUsd>0)desired=0;
  if(config.earnedFundsOnly&&Number(config.availableSpendUsd||0)<estimatedCostPerChildUsd)desired=Math.min(desired,currentChildren);
  return Math.round(desired);
}

export function buildChildRole(specialization,index=0){
  const key=String(specialization||'general-digital').toLowerCase();
  const role=/code|dev|github|software/.test(key)?'code-worker':/research|analysis|web/.test(key)?'research-worker':/content|writing|translation|document/.test(key)?'content-worker':/browser|qa|test/.test(key)?'qa-browser-worker':/automation|api|workflow|app|data/.test(key)?'automation-worker':'general-worker';
  return{role,name:`Elastic ${role} ${index+1}`,capabilityProfile:key};
}

export function groupQueueBySkill(opportunities=[]){
  const out={};for(const op of opportunities){const skill=String(op?.capability?.skill||'general-digital');out[skill]=(out[skill]||0)+1;}return out;
}
