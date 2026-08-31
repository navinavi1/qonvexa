export async function executePaidOpportunity(payload){
  const base=String(process.env.AUTONOMOS_INTERNAL_BASE_URL||process.env.RENDER_EXTERNAL_URL||process.env.SITE_URL||'').replace(/\/$/,'');
  const token=String(process.env.AUTONOMOS_TEMPORAL_WORKER_TOKEN||'');
  if(!base)throw new Error('AUTONOMOS_INTERNAL_BASE_URL_or_SITE_URL_missing');
  if(!token)throw new Error('AUTONOMOS_TEMPORAL_WORKER_TOKEN_missing');
  const response=await fetch(`${base}/api/internal/autonomos/temporal/execute`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(20*60_000)});
  const body=await response.json().catch(()=>({}));
  if(!response.ok||body?.ok===false)throw new Error(`autonomos_activity_http_${response.status}:${String(body?.error||body?.reason||'').slice(0,240)}`);
  return body;
}
