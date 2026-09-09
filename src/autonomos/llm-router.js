export function resolveLlmEndpoint(env=process.env,{task='general'}={}){
  const explicit=String(env.AUTONOMOS_LLM_BASE_URL||'').replace(/\/$/,'');
  const openaiKey=String(env.OPENAI_API_KEY||'');
  const baseUrl=explicit||(openaiKey?'https://api.openai.com/v1':'');
  const modelMap=parse(env.AUTONOMOS_MODEL_ROUTING_JSON,{});
  return{baseUrl,apiKey:String(env.AUTONOMOS_LLM_API_KEY||openaiKey||''),model:String(modelMap[task]||env.AUTONOMOS_LLM_MODEL||'gpt-5-mini'),gateway:baseUrl?'openai_compatible':'none'};
}
function parse(v,f){try{return JSON.parse(String(v||''))}catch{return f}}
