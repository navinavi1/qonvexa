import crypto from 'node:crypto';

function stableJson(value){if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;return JSON.stringify(value);}
export function triggerEnabled(env=process.env){return Boolean(String(env.TRIGGER_SECRET_KEY||'').trim());}

export async function dispatchTriggerPaidOpportunity(opportunity,env=process.env,signal){
  if(!triggerEnabled(env))return{ok:false,reason:'trigger_not_configured'};if(signal?.aborted)return{ok:false,reason:'aborted_by_emergency_stop'};
  const taskId=String(env.AUTONOMOS_TRIGGER_TASK_ID||'autonomos-paid-job').trim();const callbackUrl=String(env.SITE_URL||env.RENDER_EXTERNAL_URL||'').replace(/\/$/,'');if(!/^https:\/\//i.test(callbackUrl))return{ok:false,reason:'trigger_callback_url_missing'};
  const issuedAt=Date.now();const payloadText=`${issuedAt}.${stableJson(opportunity)}`;const signature=crypto.createHmac('sha256',String(env.TRIGGER_SECRET_KEY)).update(payloadText).digest('hex');
  const source=String(opportunity?.source||'market').trim().toLowerCase()||'market',externalId=String(opportunity?.externalId||opportunity?.id||'unknown').trim()||'unknown';
  const idempotencyKey=`autonomos_${crypto.createHash('sha256').update(`${source}\0${externalId}`).digest('hex')}`;
  try{
    const {tasks,configure,idempotencyKeys}=await import('@trigger.dev/sdk');configure({accessToken:String(env.TRIGGER_SECRET_KEY),...(env.TRIGGER_API_URL?{baseURL:String(env.TRIGGER_API_URL)}:{})});
    const scopedIdempotencyKey=typeof idempotencyKeys?.create==='function'?await idempotencyKeys.create(idempotencyKey,{scope:'global'}):idempotencyKey;
    // A Trigger callback should arrive in seconds/minutes. Six-hour dedupe stranded jobs
    // after a lost callback. Fifteen minutes still prevents duplicate dispatch storms while
    // allowing the registry's unique leaseId to self-heal. A delayed old callback is ignored
    // as stale before any marketplace claim.
    const idempotencyKeyTTL=String(env.AUTONOMOS_TRIGGER_IDEMPOTENCY_TTL||'15m');
    const handle=await tasks.trigger(taskId,{opportunity,callbackUrl,issuedAt,signature},{idempotencyKey:scopedIdempotencyKey,idempotencyKeyTTL,tags:[`source:${source}`.slice(0,128),`job:${externalId}`.slice(0,128)]});
    return{ok:true,runId:String(handle?.id||''),taskId,idempotencyKey};
  }catch(error){return{ok:false,reason:signal?.aborted?'aborted_by_emergency_stop':String(error?.message||error).slice(0,300)};}
}
