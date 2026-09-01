import { task } from '@trigger.dev/sdk';

export const autonomosPaidJob = task({
  id:'autonomos-paid-job',
  retry:{ maxAttempts:5, minTimeoutInMs:15000, maxTimeoutInMs:300000, factor:2 },
  maxDuration:1800,
  run:async payload=>{
    const base=String(payload?.callbackUrl || '').replace(/\/$/, '');
    if(!/^https:\/\//i.test(base))throw new Error('autonomos_callback_url_missing');
    if(!payload?.signature||!payload?.issuedAt)throw new Error('autonomos_callback_signature_missing');
    const response=await fetch(`${base}/api/internal/autonomos/trigger/execute`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({opportunity:payload?.opportunity,issuedAt:payload.issuedAt,signature:payload.signature}),
      signal:AbortSignal.timeout(20*60_000)
    });
    const body=await response.json().catch(()=>({}));
    if(!response.ok||body?.ok===false)throw new Error(`autonomos_trigger_worker_http_${response.status}:${String(body?.error||body?.reason||'').slice(0,240)}`);
    return body;
  }
});
