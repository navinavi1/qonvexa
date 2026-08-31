import { resolveLlmEndpoint } from './llm-router.js';

export function createLlmClient(env = process.env) {
  const initial=resolveLlmEndpoint(env,{task:'general'});
  const enabled = Boolean(initial.baseUrl && initial.model);

  return {
    enabled,
    provider: enabled ? initial.gateway : 'deterministic',
    model: initial.model || 'none',
    async complete({ system, user, messages, tools, maxTokens = 700, temperature, signal, task='general', model:requestedModel='' }) {
      const route=resolveLlmEndpoint(env,{task});
      const baseUrl=route.baseUrl; const apiKey=route.apiKey; const model=String(requestedModel||route.model||'');
      if (!baseUrl || !model) return { ok:false, reason:'llm_not_configured' };
      const body = {
        model,
        messages: messages || [{ role:'system', content:String(system || '') }, { role:'user', content:String(user || '') }],
        max_tokens:maxTokens
      };
      if (temperature !== undefined && temperature !== null && Number.isFinite(Number(temperature))) body.temperature = Number(temperature);
      if (Array.isArray(tools) && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
      const headers = { 'content-type':'application/json', ...(apiKey ? { authorization:`Bearer ${apiKey}` } : {}) };
      try {
        const combinedSignal = signal ? AbortSignal.any([AbortSignal.timeout(45000), signal]) : AbortSignal.timeout(45000);
        let requestBody = { ...body };
        let response;
        let lastErrorMessage = '';
        for (let attempt = 0; attempt < 3; attempt++) {
          response = await fetch(`${baseUrl}/chat/completions`, { method:'POST', headers, body:JSON.stringify(requestBody), signal:combinedSignal });
          if (response.ok) break;
          const errBody = await safeJsonOrText(response);
          const errMsg = String(errBody?.error?.message || errBody?.message || errBody || '');
          lastErrorMessage = errMsg;
          let adapted = false;
          if (response.status === 400 && Object.prototype.hasOwnProperty.call(requestBody,'temperature') && /temperature/i.test(errMsg) && /(default|unsupported|does not support|only support)/i.test(errMsg)) {
            requestBody = { ...requestBody }; delete requestBody.temperature; adapted = true;
          } else if (response.status === 400 && Object.prototype.hasOwnProperty.call(requestBody,'max_tokens') && /max_tokens/i.test(errMsg) && /max_completion_tokens/i.test(errMsg)) {
            requestBody = { ...requestBody, max_completion_tokens:maxTokens }; delete requestBody.max_tokens; adapted = true;
          }
          if (!adapted) break;
        }
        if (!response?.ok) return { ok:false, reason:`llm_http_${response?.status||'unknown'}${lastErrorMessage?`:${lastErrorMessage.slice(0,300)}`:''}`, model, provider:route.gateway };
        const respBody = await response.json();
        const message = respBody?.choices?.[0]?.message;
        if (message?.tool_calls?.length) return { ok:true, toolCalls:message.tool_calls, message, usage:respBody.usage || null, model, provider:route.gateway };
        const text = message?.content;
        if (!text) return { ok:false, reason:'llm_empty_response', model, provider:route.gateway };
        return { ok:true, text:String(text), message, usage:respBody.usage || null, model, provider:route.gateway };
      } catch (error) {
        const reason = signal?.aborted ? 'aborted_by_emergency_stop' : String(error?.message || error).slice(0,200);
        return { ok:false, reason, model, provider:route.gateway };
      }
    }
  };
}

async function safeJsonOrText(response) {
  const raw = await response.text().catch(() => '');
  try { return JSON.parse(raw); } catch { return raw.slice(0, 500); }
}
