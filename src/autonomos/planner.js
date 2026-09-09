import { resolveLlmEndpoint } from './llm-router.js';

export async function planJob(opportunity,{llm=null,env=process.env,abortSignal=null,memoryContext=''}={}){
  const fallback=()=>({goal:String(opportunity.title||'Complete job'),steps:[{id:'inspect',role:'planner',doneWhen:'requirements and acceptance criteria understood'},{id:'execute',role:roleFor(opportunity),doneWhen:'deliverable produced and verified with real tools when needed'},{id:'qa',role:'qa-evaluator',doneWhen:'quality gate passes'},{id:'deliver',role:'job-router',doneWhen:'marketplace accepts submission'}],source:'deterministic'});
  if(!llm?.enabled)return fallback();
  if(abortSignal?.aborted)throw new Error('job_cancelled_by_emergency_stop');
  const timeoutMs=Math.max(10,Math.min(120000,Number(env.AUTONOMOS_PLANNER_TIMEOUT_MS)||30000));
  const timeout=AbortSignal.timeout(timeoutMs);const planningSignal=abortSignal?AbortSignal.any([abortSignal,timeout]):timeout;
  const memory=memoryContext?`\nRELEVANT PAST EXPERIENCE (hints only; verify current facts):\n${String(memoryContext).slice(0,6500)}`:'';
  const survival=`\nSURVIVAL SWARM RULES:\n- This is accepted paid work: plan for verified completion, not a partial answer.\n- If knowledge is missing, add a research-worker step to acquire it from public documentation/current sources.\n- If the task spans research + code/automation/content, use multiple specialist roles so helper agents can collaborate.\n- Prefer evidence-producing tools and explicit verification before QA.\n- Reuse existing connected tools and skills; never invent credentials, private keys, KYC, identity, or unverified paid services.\n- Do not plan an external purchase merely to finish the job unless the work order explicitly requires it and policy already authorizes it.\n- Minimize cost, but keep enough verification/repair work to actually finish the accepted job.`;
  const request=`Create a concise execution plan for this marketplace job. Return ONLY JSON with keys goal and steps; each step has id, role, action, doneWhen. Roles must be planner, research-worker, code-worker, automation-worker, content-worker, qa-evaluator, job-router. Choose real verification tools for claims/code and do not invent access you do not have.${survival}\nTITLE: ${opportunity.title}\nTASK: ${String(opportunity.description||'').slice(0,6000)}${memory}`;
  try{
    const directOpenAIKey=String(env.OPENAI_API_KEY||env.AUTONOMOS_LLM_API_KEY||'');
    if(env.AUTONOMOS_USE_OPENAI_AGENTS_SDK!=='false'&&directOpenAIKey&&!env.AUTONOMOS_LLM_BASE_URL&&!llm.budgeted){
      try{
        const {Agent,run,setDefaultOpenAIKey}=await import('@openai/agents');setDefaultOpenAIKey(directOpenAIKey);
        const route=resolveLlmEndpoint({...env,AUTONOMOS_LLM_BASE_URL:''},{task:'planning'});
        const agent=new Agent({name:'AutonomOS Survival Planner',instructions:'Plan legitimate accepted paid work to verified completion. Add specialist helpers when useful. Never invent capabilities, credentials, identity, or evidence. Output JSON only.',model:String(route.model||env.AUTONOMOS_LLM_MODEL||'gpt-5-mini')});
        const out=await run(agent,request,{maxTurns:3,signal:planningSignal});const parsed=parseJson(out.finalOutput);if(Array.isArray(parsed?.steps)&&parsed.steps.length)return{...parsed,source:'openai_agents_sdk'};
      }catch{}
    }
    if(abortSignal?.aborted)throw new Error('job_cancelled_by_emergency_stop');if(planningSignal.aborted)return fallback();
    const result=await llm.complete({messages:[{role:'system',content:'Plan legitimate accepted paid work to verified completion. Return JSON only.'},{role:'user',content:request}],maxTokens:Number(env.AUTONOMOS_PLANNER_MAX_TOKENS||1800),signal:planningSignal,task:'planning'});
    if(result?.ok){const parsed=parseJson(result.text);if(Array.isArray(parsed?.steps)&&parsed.steps.length)return{...parsed,source:'llm_gateway'};}
  }catch{}
  if(abortSignal?.aborted)throw new Error('job_cancelled_by_emergency_stop');return fallback();
}
function roleFor(op){const h=`${op.category||''} ${op.title||''}`.toLowerCase();return /code|bug|repo|api|javascript|python/.test(h)?'code-worker':/research|analysis|data|website/.test(h)?'research-worker':/write|content|translate/.test(h)?'content-worker':'automation-worker'}
function parseJson(value){try{return JSON.parse(String(value||'').replace(/^```json\s*|```$/g,''))}catch{return null}}
