export function createLlmClient(env = process.env) {
  const baseUrl = String(env.AUTONOMOS_LLM_BASE_URL || '').replace(/\/$/, '');
  const apiKey = String(env.AUTONOMOS_LLM_API_KEY || '');
  const model = String(env.AUTONOMOS_LLM_MODEL || '');
  const enabled = Boolean(baseUrl && model);

  return {
    enabled,
    provider: enabled ? 'openai-compatible' : 'deterministic',
    model: model || 'none',
    async complete({ system, user, messages, tools, maxTokens = 700, temperature, signal }) {
      if (!enabled) return { ok:false, reason:'llm_not_configured' };
      const body = {
        model,
        messages: messages || [{ role:'system', content:String(system || '') }, { role:'user', content:String(user || '') }],
        max_tokens:maxTokens
      };
      // Newer reasoning models (including the currently configured GPT-5 family) may
      // reject any non-default temperature. Only send it when a caller explicitly asks
      // for one; the job executor deliberately leaves it unset for maximum compatibility.
      if (temperature !== undefined && temperature !== null && Number.isFinite(Number(temperature))) body.temperature = Number(temperature);
      if (Array.isArray(tools) && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
      const headers = { 'content-type':'application/json', ...(apiKey ? { authorization:`Bearer ${apiKey}` } : {}) };
      try {
        // P0 fix (external audit — Emergency Stop was not a real abort): accept an
        // external AbortSignal (from runtime's per-job AbortController) and combine it
        // with the existing request timeout, so pressing Emergency Stop actually cancels
        // an in-flight LLM call instead of only preventing the *next* one.
        const combinedSignal = signal ? AbortSignal.any([AbortSignal.timeout(45000), signal]) : AbortSignal.timeout(45000);
        let requestBody = { ...body };
        let response;
        let lastErrorMessage = '';
        // Compatibility loop: some reasoning models reject `temperature`, some reject
        // classic `max_tokens`, and a provider can reject both sequentially. The previous
        // one-shot retry fixed only whichever error appeared first. Adapt at most twice,
        // changing only fields the API explicitly says are unsupported.
        for (let attempt = 0; attempt < 3; attempt++) {
          response = await fetch(`${baseUrl}/chat/completions`, { method:'POST', headers, body:JSON.stringify(requestBody), signal:combinedSignal });
          if (response.ok) break;
          const errBody = await safeJsonOrText(response);
          const errMsg = String(errBody?.error?.message || errBody?.message || errBody || '');
          lastErrorMessage = errMsg;
          let adapted = false;
          if (response.status === 400 && Object.prototype.hasOwnProperty.call(requestBody,'temperature') && /temperature/i.test(errMsg) && /(default|unsupported|does not support|only support)/i.test(errMsg)) {
            requestBody = { ...requestBody };
            delete requestBody.temperature;
            adapted = true;
          } else if (response.status === 400 && Object.prototype.hasOwnProperty.call(requestBody,'max_tokens') && /max_tokens/i.test(errMsg) && /max_completion_tokens/i.test(errMsg)) {
            requestBody = { ...requestBody, max_completion_tokens:maxTokens };
            delete requestBody.max_tokens;
            adapted = true;
          }
          if (!adapted) break;
        }
        if (!response?.ok) {
          return { ok:false, reason:`llm_http_${response?.status||'unknown'}${lastErrorMessage?`:${lastErrorMessage.slice(0,300)}`:''}` };
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
