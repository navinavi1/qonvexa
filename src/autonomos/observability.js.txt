export async function emitOperationalLog(event,{env=process.env}={}){
  if(!env.OPENSEARCH_URL)return false;
  try{const base=String(env.OPENSEARCH_URL).replace(/\/$/,'');const auth=env.OPENSEARCH_USERNAME?`Basic ${Buffer.from(`${env.OPENSEARCH_USERNAME}:${env.OPENSEARCH_PASSWORD||''}`).toString('base64')}`:'';await fetch(`${base}/autonomos-events/_doc`,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:auth}:{})},body:JSON.stringify(event),signal:AbortSignal.timeout(4000)});return true;}catch{return false;}
}
