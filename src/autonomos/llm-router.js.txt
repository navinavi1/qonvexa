export function resolveLlmEndpoint(env=process.env,{task='general'}={}){
  const lite=String(env.LITELLM_BASE_URL||'').replace(/\/$/,'');
  const direct=String(env.AUTONOMOS_LLM_BASE_URL||'').replace(/\/$/,'');
  const modelMap=parse(env.AUTONOMOS_MODEL_ROUTING_JSON,{});
  return{baseUrl:lite||direct,apiKey:String(env.LITELLM_API_KEY||env.AUTONOMOS_LLM_API_KEY||''),model:String(modelMap[task]||env.AUTONOMOS_LLM_MODEL||'gpt-5-mini'),gateway:lite?'litellm':'direct'};
}
function parse(v,f){try{return JSON.parse(String(v||''))}catch{return f}}
