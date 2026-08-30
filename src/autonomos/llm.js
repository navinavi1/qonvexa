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
      try {
        const body = {
          model,
          messages: messages || [{ role:'system', content:String(system || '') }, { role:'user', content:String(user || '') }],
          max_tokens:maxTokens,
          temperature
        };
        if (Array.isArray(tools) && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
        // P0 fix (external audit — Emergency Stop was not a real abort): accept an
        // external AbortSignal (from runtime's per-job AbortController) and combine it
        // with the existing request timeout, so pressing Emergency Stop actually cancels
        // an in-flight LLM call instead of only preventing the *next* one.
        const combinedSignal = signal ? AbortSignal.any([AbortSignal.timeout(45000), signal]) : AbortSignal.timeout(45000);
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method:'POST',
          headers:{
            'content-type':'application/json',
            ...(apiKey ? { authorization:`Bearer ${apiKey}` } : {})
          },
          body:JSON.stringify(body),
          signal:combinedSignal
        });
        if (!response.ok) return { ok:false, reason:`llm_http_${response.status}` };
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
