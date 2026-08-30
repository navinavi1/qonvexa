export function createLlmClient(env = process.env) {
  const baseUrl = String(env.AUTONOMOS_LLM_BASE_URL || '').replace(/\/$/, '');
  const apiKey = String(env.AUTONOMOS_LLM_API_KEY || '');
  const model = String(env.AUTONOMOS_LLM_MODEL || '');
  const enabled = Boolean(baseUrl && model);

  return {
    enabled,
    provider: enabled ? 'openai-compatible' : 'deterministic',
    model: model || 'none',
    async complete({ system, user, messages, tools, maxTokens = 700, temperature = 0.2, signal }) {
      if (!enabled) return { ok:false, reason:'llm_not_configured' };
      const body = {
        model,
        messages: messages || [{ role:'system', content:String(system || '') }, { role:'user', content:String(user || '') }],
        max_tokens:maxTokens,
        temperature
      };
      if (Array.isArray(tools) && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
      const headers = { 'content-type':'application/json', ...(apiKey ? { authorization:`Bearer ${apiKey}` } : {}) };
      try {
        // P0 fix (external audit — Emergency Stop was not a real abort): accept an
        // external AbortSignal (from runtime's per-job AbortController) and combine it
        // with the existing request timeout, so pressing Emergency Stop actually cancels
        // an in-flight LLM call instead of only preventing the *next* one.
        const combinedSignal = signal ? AbortSignal.any([AbortSignal.timeout(45000), signal]) : AbortSignal.timeout(45000);
        let response = await fetch(`${baseUrl}/chat/completions`, { method:'POST', headers, body:JSON.stringify(body), signal:combinedSignal });
        if (!response.ok) {
          const errBody = await safeJsonOrText(response);
          const errMsg = String(errBody?.error?.message || errBody?.message || errBody || '');
          let retried = false;
          // P0 fix: this used to discard the API's actual error message and only report
          // "llm_http_400" — impossible to diagnose from the dashboard. It also never
          // adapted to a real, common incompatibility with newer reasoning-tier models
          // (o1/o3/gpt-5 family): many providers reject the classic `max_tokens` field
          // for these models with a 400 telling you to use `max_completion_tokens`
          // instead, and some reject a non-default `temperature` the same way. Detect
          // those two specific, self-describing errors and retry once with the
          // corrected body instead of just failing — this is exactly the kind of 400
          // that started appearing the moment real (non-deterministic) LLM calls with
          // tools began actually running.
          if (response.status === 400 && /max_tokens/i.test(errMsg) && /max_completion_tokens/i.test(errMsg)) {
            const retryBody = { ...body }; delete retryBody.max_tokens; retryBody.max_completion_tokens = maxTokens;
            response = await fetch(`${baseUrl}/chat/completions`, { method:'POST', headers, body:JSON.stringify(retryBody), signal:combinedSignal });
            retried = true;
          } else if (response.status === 400 && /temperature/i.test(errMsg) && /(default|unsupported|does not support|only support)/i.test(errMsg)) {
            const retryBody = { ...body }; delete retryBody.temperature;
            response = await fetch(`${baseUrl}/chat/completions`, { method:'POST', headers, body:JSON.stringify(retryBody), signal:combinedSignal });
            retried = true;
          }
          if (!response.ok) {
            let finalErrMsg = errMsg;
            if (retried) { const retryErrBody = await safeJsonOrText(response); finalErrMsg = String(retryErrBody?.error?.message || retryErrBody?.message || retryErrBody || ''); }
            return { ok:false, reason:`llm_http_${response.status}${finalErrMsg?`:${finalErrMsg.slice(0,300)}`:''}` };
          }
        }
        const respBody = await response.json();
        const message = respBody?.choices?.[0]?.message;
        if (message?.tool_calls?.length) return { ok:true, toolCalls:message.tool_calls, message, usage:respBody.usage || null };
        const text = message?.content;
        if (!text) return { ok:false, reason:'llm_empty_response' };
        return { ok:true, text:String(text), message, usage:respBody.usage || null };
      } catch (error) {
        const reason = signal?.aborted ? 'aborted_by_emergency_stop' : String(error?.message || error).slice(0,200);
        return { ok:false, reason };
      }
    }
  };
}

async function safeJsonOrText(response) {
  const raw = await response.text().catch(() => '');
  try { return JSON.parse(raw); } catch { return raw.slice(0, 500); }
}
