import { resolveLlmEndpoint } from './llm-router.js';

export function createLlmClient(env = process.env) {
  const initial=resolveLlmEndpoint(env,{task:'general'});
  const enabled = Boolean(initial.baseUrl && initial.model);
  let consecutiveFailures=0;
  let circuitOpenUntil=0;

  const client={
    enabled,
    provider: enabled ? initial.gateway : 'deterministic',
    model: initial.model || 'none',
    get available(){return enabled&&Date.now()>=circuitOpenUntil;},
    status(){return{enabled,available:enabled&&Date.now()>=circuitOpenUntil,provider:client.provider,model:client.model,consecutiveFailures,circuitOpenUntil:circuitOpenUntil?new Date(circuitOpenUntil).toISOString():''};},
    async complete({ system, user, messages, tools, maxTokens = 700, temperature, signal, task='general', model:requestedModel='' }) {
      const route=resolveLlmEndpoint(env,{task});
      const baseUrl=route.baseUrl; const apiKey=route.apiKey; const model=String(requestedModel||route.model||'');
      if (!baseUrl || !model) return { ok:false, reason:'llm_not_configured' };
      if(Date.now()<circuitOpenUntil)return{ok:false,reason:'llm_circuit_open',model,provider:route.gateway};

      const baseMessages=messages || [{ role:'system', content:String(system || '') }, { role:'user', content:String(user || '') }];
      const body = {model,messages:baseMessages,max_tokens:maxTokens};
      if (temperature !== undefined && temperature !== null && Number.isFinite(Number(temperature))) body.temperature = Number(temperature);
      if (Array.isArray(tools) && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
      const headers = { 'content-type':'application/json', ...(apiKey ? { authorization:`Bearer ${apiKey}` } : {}) };

      try {
        const combinedSignal = signal ? AbortSignal.any([AbortSignal.timeout(Number(env.AUTONOMOS_LLM_TIMEOUT_MS||120000)), signal]) : AbortSignal.timeout(Number(env.AUTONOMOS_LLM_TIMEOUT_MS||120000));
        let requestBody = { ...body };
        let lastReason='';
        // GPT-5 class models can spend a small completion budget on reasoning and return
        // no visible text. Retry empty completions once with a larger completion budget
        // and low reasoning effort instead of failing every paid job as llm_empty_response.
        for (let attempt = 0; attempt < 4; attempt++) {
          const response = await fetch(`${baseUrl}/chat/completions`, { method:'POST', headers, body:JSON.stringify(requestBody), signal:combinedSignal });
          if(!response.ok){
            const errBody = await safeJsonOrText(response);
            const errMsg = String(errBody?.error?.message || errBody?.message || errBody || '');
            lastReason=`llm_http_${response.status}${errMsg?`:${errMsg.slice(0,300)}`:''}`;
            let adapted=false;
            if(response.status===400&&Object.prototype.hasOwnProperty.call(requestBody,'temperature')&&/temperature/i.test(errMsg)&&/(default|unsupported|does not support|only support)/i.test(errMsg)){
              requestBody={...requestBody};delete requestBody.temperature;adapted=true;
            }else if(response.status===400&&Object.prototype.hasOwnProperty.call(requestBody,'max_tokens')&&/max_tokens/i.test(errMsg)&&/max_completion_tokens/i.test(errMsg)){
              requestBody={...requestBody,max_completion_tokens:maxTokens};delete requestBody.max_tokens;adapted=true;
            }
            if(adapted)continue;
            registerFailure(response.status>=500||response.status===429);
            return {ok:false,reason:lastReason,model,provider:route.gateway};
          }

          const respBody=await response.json();
          const message=respBody?.choices?.[0]?.message;
          if(message?.tool_calls?.length){registerSuccess();return{ok:true,toolCalls:message.tool_calls,message,usage:respBody.usage||null,model,provider:route.gateway};}
          const text=extractText(message?.content);
          if(text){registerSuccess();return{ok:true,text,message:{...message,content:text},usage:respBody.usage||null,model,provider:route.gateway};}

          lastReason='llm_empty_response';
          if(attempt<3){
            const next=Math.min(12000,Math.max(Number(requestBody.max_completion_tokens||requestBody.max_tokens||maxTokens)*2,3200));
            requestBody={...requestBody,max_completion_tokens:next,reasoning_effort:'low'};
            delete requestBody.max_tokens;
            delete requestBody.temperature;
            continue;
          }
        }
        registerFailure(true);
        return{ok:false,reason:lastReason||'llm_empty_response',model,provider:route.gateway};
      } catch (error) {
        const reason = signal?.aborted ? 'aborted_by_emergency_stop' : String(error?.message || error).slice(0,200);
        registerFailure(!signal?.aborted);
        return { ok:false, reason, model, provider:route.gateway };
      }
    }
  };

  function registerSuccess(){consecutiveFailures=0;circuitOpenUntil=0;}
  function registerFailure(count=true){
    if(!count)return;
    consecutiveFailures++;
    if(consecutiveFailures>=3)circuitOpenUntil=Date.now()+Math.max(30_000,Number(env.AUTONOMOS_LLM_CIRCUIT_BREAKER_MS||120000));
  }
  return client;
}

function extractText(content){
  if(typeof content==='string')return content.trim();
  if(Array.isArray(content))return content.map(part=>typeof part==='string'?part:String(part?.text||part?.content||'')).join('').trim();
  return String(content?.text||'').trim();
}
async function safeJsonOrText(response) {const raw = await response.text().catch(() => '');try { return JSON.parse(raw); } catch { return raw.slice(0, 500); }}
