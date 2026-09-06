// Runtime owns business retries. Durable workers only retry transport failures.
export async function readDurableResponse(response, prefix='autonomos_worker') {
  const retryable=response.status===408||response.status===429||response.status>=500;
  let body;
  try { body=await response.json(); }
  catch { if(response.ok||retryable)throw new Error(`${prefix}_invalid_response:${response.status}`); }
  if(retryable)throw new Error(`${prefix}_http_${response.status}:${String(body?.error||body?.reason||'').slice(0,240)}`);
  if(!response.ok)return {ok:false,terminal:true,reason:`${prefix}_http_${response.status}`,status:response.status};
  if(!body||typeof body!=='object'||Array.isArray(body))throw new Error(`${prefix}_invalid_response:${response.status}`);
  return body;
}
