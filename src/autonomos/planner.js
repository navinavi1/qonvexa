import { resolveLlmEndpoint } from './llm-router.js';

export async function planJob(opportunity,{llm=null,env=process.env,abortSignal=null,memoryContext=''}={}){
  const fallback=()=>({goal:String(opportunity.title||'Complete job'),steps:[{id:'inspect',role:'planner',doneWhen:'requirements understood'},{id:'execute',role:roleFor(opportunity),doneWhen:'deliverable produced and verified with real tools when needed'},{id:'qa',role:'qa-evaluator',doneWhen:'quality gate passes'},{id:'deliver',role:'job-router',doneWhen:'marketplace accepts submission'}],source:'deterministic'});
  if(!llm?.enabled)return fallback();
  const memory=memoryContext?`\nRELEVANT PAST EXPERIENCE (use as hints, never as proof of current facts):\n${String(memoryContext).slice(0,6500)}`:'';
  const request=`Create a concise execution plan for this marketplace job. Return ONLY JSON with keys goal and steps; each step has id, role, action, doneWhen. Roles must be planner, research-worker, code-worker, automation-worker, content-worker, qa-evaluator, job-router. Choose real verification tools for claims/code and do not invent access you do not have.\nTITLE: ${opportunity.title}\nTASK: ${String(opportunity.description||'').slice(0,6000)}${memory}`;
  try{
    // The official Agents SDK uses an OpenAI client. Use it when a direct OpenAI key is
    // configured. If AutonomOS is routed through LiteLLM/another OpenAI-compatible gateway,
    // keep using our gateway-aware llm.complete path instead of silently bypassing routing.
    const directOpenAIKey=String(env.OPENAI_API_KEY||(!env.LITELLM_BASE_URL&&!env.AUTONOMOS_LLM_BASE_URL?env.AUTONOMOS_LLM_API_KEY:'')||'');
    if(env.AUTONOMOS_USE_OPENAI_AGENTS_SDK!=='false'&&directOpenAIKey){
      try{
        const {Agent,run,setDefaultOpenAIKey}=await import('@openai/agents');
        setDefaultOpenAIKey(directOpenAIKey);
        const route=resolveLlmEndpoint({...env,LITELLM_BASE_URL:'',AUTONOMOS_LLM_BASE_URL:''},{task:'planning'});
        const agent=new Agent({name:'AutonomOS Planner',instructions:'Plan legitimate paid digital-service work. Never invent capabilities or evidence. Output JSON only.',model:String(route.model||env.AUTONOMOS_LLM_MODEL||'gpt-5-mini')});
        const out=await run(agent,request,{maxTurns:3,signal:abortSignal||undefined});
        const parsed=parseJson(out.finalOutput);
        if(Array.isArray(parsed?.steps)&&parsed.steps.length)return{...parsed,source:'openai_agents_sdk'};
      }catch{/* fall through to gateway client */}
    }
    const result=await llm.complete({messages:[{role:'system',content:'Plan legitimate paid work. Return JSON only.'},{role:'user',content:request}],maxTokens:Number(env.AUTONOMOS_PLANNER_MAX_TOKENS||1500),signal:abortSignal,task:'planning'});
    if(result?.ok){const parsed=parseJson(result.text);if(Array.isArray(parsed?.steps)&&parsed.steps.length)return{...parsed,source:'llm_gateway'};}
  }catch{/* fall through */}
  return fallback();
}
function roleFor(op){const h=`${op.category||''} ${op.title||''}`.toLowerCase();return /code|bug|repo|api|javascript|python/.test(h)?'code-worker':/research|analysis|data|website/.test(h)?'research-worker':/write|content|translate/.test(h)?'content-worker':'automation-worker'}
function parseJson(value){try{return JSON.parse(String(value||'').replace(/^```json\s*|```$/g,''))}catch{return null}}
