export function createLlmClient(env = process.env) {
  const baseUrl = String(env.AUTONOMOS_LLM_BASE_URL || '').replace(/\/$/, '');
  const apiKey = String(env.AUTONOMOS_LLM_API_KEY || '');
  const model = String(env.AUTONOMOS_LLM_MODEL || '');
  const enabled = Boolean(baseUrl && model);

  return {
    enabled,
    provider: enabled ? 'openai-compatible' : 'deterministic',
    model: model || 'none',
    async complete({ system, user, maxTokens = 700, temperature = 0.2 }) {
      if (!enabled) return { ok:false, reason:'llm_not_configured' };
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method:'POST',
          headers:{
            'content-type':'application/json',
            ...(apiKey ? { authorization:`Bearer ${apiKey}` } : {})
          },
          body:JSON.stringify({
            model,
            messages:[{ role:'system', content:String(system || '') }, { role:'user', content:String(user || '') }],
            max_tokens:maxTokens,
            temperature
          }),
          signal:AbortSignal.timeout(45000)
        });
        if (!response.ok) return { ok:false, reason:`llm_http_${response.status}` };
        const body = await response.json();
        const text = body?.choices?.[0]?.message?.content;
        if (!text) return { ok:false, reason:'llm_empty_response' };
        return { ok:true, text:String(text), usage:body.usage || null };
      } catch (error) {
        return { ok:false, reason:String(error?.message || error).slice(0,200) };
      }
    }
  };
}
