import { resolveLlmEndpoint } from './llm-router.js';

const REASONING_MODEL_RE = /^(gpt-5|o1|o3|o4)/i;

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
      const isReasoningModel = REASONING_MODEL_RE.test(model);
      const baseBody = {
        model,
        messages: messages || [{ role:'system', content:String(system || '') }, { role:'user', content:String(user || '') }]
      };
      if (temperature !== undefined && temperature !== null && Number.isFinite(Number(temperature))) baseBody.temperature = Number(temperature);
      if (Array.isArray(tools) && tools.length) { baseBody.tools = tools; baseBody.tool_choice = 'auto'; }
      const headers = { 'content-type':'application/json', ...(apiKey ? { authorization:`Bearer ${apiKey}` } : {}) };
      const combinedSignal = signal ? AbortSignal.any([AbortSignal.timeout(45000), signal]) : AbortSignal.timeout(45000);

      const attemptCall = async (tokenBudget, reasoningEffort) => {
        let requestBody = { ...baseBody, max_tokens: tokenBudget };
        if (isReasoningModel && reasoningEffort) requestBody.reasoning_effort = reasoningEffort;
        let response; let lastErrorMessage = '';
        for (let attempt = 0; attempt < 4; attempt++) {
          response = await fetch(`${baseUrl}/chat/completions`, { method:'POST', headers, body:JSON.stringify(requestBody), signal:combinedSignal });
          if (response.ok) break;
          const errBody = await safeJsonOrText(response);
          const errMsg = String(errBody?.error?.message || errBody?.message || errBody || '');
          lastErrorMessage = errMsg;
          let adapted = false;
          if (response.status === 400 && Object.prototype.hasOwnProperty.call(requestBody,'temperature') && /temperature/i.test(errMsg) && /(default|unsupported|does not support|only support)/i.test(errMsg)) {
            requestBody = { ...requestBody }; delete requestBody.temperature; adapted = true;
          } else if (response.status === 400 && Object.prototype.hasOwnProperty.call(requestBody,'max_tokens') && /max_tokens/i.test(errMsg) && /max_completion_tokens/i.test(errMsg)) {
            requestBody = { ...requestBody, max_completion_tokens:tokenBudget }; delete requestBody.max_tokens; adapted = true;
          } else if (response.status === 400 && Object.prototype.hasOwnProperty.call(requestBody,'reasoning_effort') && /reasoning_effort/i.test(errMsg)) {
            requestBody = { ...requestBody }; delete requestBody.reasoning_effort; adapted = true;
          }
          if (!adapted) break;
        }
        if (!response?.ok) return { httpOk:false, reason:`llm_http_${response?.status||'unknown'}${lastErrorMessage?`:${lastErrorMessage.slice(0,300)}`:''}` };
        const respBody = await response.json();
        const choice = respBody?.choices?.[0];
        const message = choice?.message;
        const reasoningTokens = Number(respBody?.usage?.completion_tokens_details?.reasoning_tokens || 0);
        return { httpOk:true, message, finishReason: choice?.finish_reason || '', usage: respBody.usage || null, reasoningTokens };
      };

      try {
        let result = await attemptCall(maxTokens, isReasoningModel ? (env.AUTONOMOS_LLM_REASONING_EFFORT || 'low') : undefined);
        if (!result.httpOk) return { ok:false, reason:result.reason, model, provider:route.gateway };
        if (result.message?.tool_calls?.length) return { ok:true, toolCalls:result.message.tool_calls, message:result.message, usage:result.usage, model, provider:route.gateway };
        let text = result.message?.content;
        // Reasoning models can spend the entire token budget on hidden reasoning and return
        // empty visible content with finish_reason 'length'. Retry once with a much bigger
        // budget and minimal reasoning effort before giving up, instead of failing every job.
        if (!text && isReasoningModel && (result.finishReason === 'length' || result.reasoningTokens > 0)) {
          const biggerBudget = Math.max(maxTokens * 4, 4000);
          const retryResult = await attemptCall(biggerBudget, 'minimal');
          if (retryResult.httpOk) {
            if (retryResult.message?.tool_calls?.length) return { ok:true, toolCalls:retryResult.message.tool_calls, message:retryResult.message, usage:retryResult.usage, model, provider:route.gateway };
            text = retryResult.message?.content;
            if (text) return { ok:true, text:String(text), message:retryResult.message, usage:retryResult.usage, model, provider:route.gateway };
            return { ok:false, reason:`llm_reasoning_budget_exhausted:tokens_used=${biggerBudget}`, model, provider:route.gateway };
          }
        }
        if (!text) return { ok:false, reason:'llm_empty_response', model, provider:route.gateway };
        return { ok:true, text:String(text), message:result.message, usage:result.usage, model, provider:route.gateway };
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
