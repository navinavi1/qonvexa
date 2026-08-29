// Real capability tools for worker agents — actual web search/scrape (Firecrawl) and
// actual sandboxed Python execution (E2B). Without these, the LLM worker can only
// generate plausible-sounding text; with them it can verify facts and check that code
// actually runs before the deliverable is submitted.

export async function firecrawlSearch(query, env = process.env) {
  const key = String(env.FIRECRAWL_API_KEY || '');
  if (!key) return { ok: false, error: 'firecrawl_api_key_missing' };
  try {
    const response = await fetch('https://api.firecrawl.dev/v2/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: String(query || '').slice(0, 400), limit: 5 }),
      signal: AbortSignal.timeout(20000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false) return { ok: false, error: `http_${response.status}`, detail: body?.error || '' };
    const results = (Array.isArray(body?.data) ? body.data : []).slice(0, 5).map(r => ({
      title: String(r?.title || '').slice(0, 200),
      url: String(r?.url || ''),
      snippet: String(r?.description || r?.markdown || '').slice(0, 500)
    }));
    return { ok: true, results };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 200) };
  }
}

export async function firecrawlScrape(url, env = process.env) {
  const key = String(env.FIRECRAWL_API_KEY || '');
  if (!key) return { ok: false, error: 'firecrawl_api_key_missing' };
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'invalid_url' };
  try {
    const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ url: String(url), formats: ['markdown'], onlyMainContent: true, timeout: 25000 }),
      signal: AbortSignal.timeout(30000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false) return { ok: false, error: `http_${response.status}`, detail: body?.error || '' };
    const markdown = String(body?.data?.markdown || '');
    return { ok: true, content: markdown.slice(0, 8000) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 200) };
  }
}

export async function e2bRunPython(code, env = process.env) {
  const key = String(env.E2B_API_KEY || '');
  if (!key) return { ok: false, error: 'e2b_api_key_missing' };
  let sbx;
  try {
    const { Sandbox } = await import('@e2b/code-interpreter');
    sbx = await Sandbox.create({ apiKey: key, timeoutMs: 30000 });
    const execution = await sbx.runCode(String(code || '').slice(0, 20000));
    const stdout = (execution?.logs?.stdout || []).join('\n').slice(0, 4000);
    const stderr = (execution?.logs?.stderr || []).join('\n').slice(0, 2000);
    const errorText = execution?.error ? `${execution.error.name}: ${execution.error.value}` : '';
    return { ok: true, stdout, stderr, error: errorText, result: String(execution?.text || '').slice(0, 4000) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 300) };
  } finally {
    if (sbx) { try { await sbx.kill(); } catch { /* best effort cleanup */ } }
  }
}

// Tool schemas in OpenAI-compatible function-calling format.
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the live web for current, real information. Use this before writing anything that claims to be researched or fact-based.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_scrape',
      description: 'Fetch the actual current content of a specific URL as markdown. Use this to read a page the task references or a page found via web_search.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full URL to fetch' } }, required: ['url'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_python',
      description: 'Execute Python code in a real sandbox and see its actual output/errors. Use this to verify code works before submitting it as a deliverable, or to compute an exact answer instead of guessing.',
      parameters: { type: 'object', properties: { code: { type: 'string', description: 'Python source code to execute' } }, required: ['code'] }
    }
  }
];

export async function runTool(name, args, env = process.env) {
  if (name === 'web_search') return firecrawlSearch(args?.query, env);
  if (name === 'web_scrape') return firecrawlScrape(args?.url, env);
  if (name === 'run_python') return e2bRunPython(args?.code, env);
  return { ok: false, error: `unknown_tool:${name}` };
}
