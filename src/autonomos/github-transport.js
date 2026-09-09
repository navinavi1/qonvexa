import { reserveResource } from './resource-control.js';

const accounts = new Map();
export const githubAvailable = (env = process.env) => Boolean(env.GITHUB_TOKEN || env.COMPOSIO_API_KEY);
const timeout = signal => signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);

// Keep credentials in the existing account provider. Never copy a connected OAuth token
// into the agent prompt or sandbox. Public reads and authorized repo writes share auth.
export async function githubRequest(endpoint, { method = 'GET', body, env = process.env, signal, fetchImpl = (...a) => fetch(...a) } = {}) {
  if (!/^\/(?:user(?:\?|$)|repos\/|search\/)/.test(endpoint) || /[\r\n\\]/.test(endpoint) || endpoint.includes('..'))
    throw new Error('github_endpoint_not_allowed');
  method = method.toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT'].includes(method) || body?.force === true) throw new Error('github_operation_not_allowed');
  const cap = await reserveResource('github', 1, env);
  if (!cap.ok) return { ok: false, status: 429, value: { message: cap.error }, error: cap.error };
  let response;
  if (env.GITHUB_TOKEN) {
    response = await fetchImpl('https://api.github.com' + endpoint, {
      method, redirect: 'error', signal: timeout(signal),
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    return { ok: response.ok, status: response.status, value: await response.json().catch(() => null) };
  }
  if (!env.COMPOSIO_API_KEY) return { ok: false, status: 401, error: 'github_connection_missing' };
  const allowed = String(env.AUTONOMOS_COMPOSIO_ALLOW_TOOLKITS || '').toUpperCase().split(',').map(x => x.trim()).filter(Boolean);
  const denied = String(env.AUTONOMOS_COMPOSIO_DENY_TOOLKITS || '').toUpperCase().split(',').map(x => x.trim());
  if (denied.includes('GITHUB') || (allowed.length && !allowed.includes('GITHUB'))) return { ok: false, status: 403, error: 'github_toolkit_not_allowed' };
  const quota = await reserveResource('composio', 1, env);
  if (!quota.ok) return { ok: false, status: 429, error: quota.error };
  const headers = { 'x-api-key': env.COMPOSIO_API_KEY, 'content-type': 'application/json', accept: 'application/json' };
  let mapping = {}; try { mapping = JSON.parse(env.AUTONOMOS_COMPOSIO_ACCOUNTS_JSON || '{}'); } catch {}
  const cache = accounts.get(env.COMPOSIO_API_KEY);
  let account = mapping.github || mapping.GITHUB || (cache?.expires > Date.now() ? cache.id : '');
  if (!account) {
    const r = await fetchImpl('https://backend.composio.dev/api/v3.1/connected_accounts?toolkit_slugs=github&statuses=ACTIVE&limit=10', { headers, signal: timeout(signal), redirect: 'error' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: 'github_account_lookup_failed' };
    const active = (data.items || []).filter(x => x.status === 'ACTIVE' && !x.is_disabled);
    if (active.length !== 1) return { ok: false, status: 401, error: active.length ? 'github_account_ambiguous' : 'github_connection_missing' };
    account = active[0].id; accounts.set(env.COMPOSIO_API_KEY, { id: account, expires: Date.now() + 300000 });
  }
  response = await fetchImpl('https://backend.composio.dev/api/v3.1/tools/execute/proxy', {
    method: 'POST', headers, redirect: 'error', signal: timeout(signal),
    body: JSON.stringify({ connected_account_id: account, endpoint, method, ...(body !== undefined ? { body } : {}), parameters: [{ name: 'Accept', value: 'application/vnd.github+json', in: 'header' }, { name: 'X-GitHub-Api-Version', value: '2022-11-28', in: 'header' }] })
  });
  const data = await response.json().catch(() => ({}));
  const status = Number(data.status ?? data.status_code ?? response.status);
  return { ok: response.ok && status >= 200 && status < 300 && data.successful !== false, status, value: data.data ?? data.body ?? data, error: response.ok ? '' : 'github_proxy_failed' };
}

export async function githubPages(endpoint, options = {}) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const r = await githubRequest(endpoint + (endpoint.includes('?') ? '&' : '?') + `per_page=100&page=${page}`, options);
    if (!r.ok || !Array.isArray(r.value)) throw new Error('github_paginated_read_failed_' + r.status);
    rows.push(...r.value);
    if (r.value.length < 100) return rows;
  }
  throw new Error('github_pagination_incomplete');
}
