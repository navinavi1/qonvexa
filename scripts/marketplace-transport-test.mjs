import assert from 'node:assert/strict';
import { MarketplaceHttp, arrayEnvelope, publicUrl } from '../src/autonomos/marketplace-http.js';

// This transport sat in the repository, complete and imported by nothing, while every
// marketplace call was a bare fetch with no cooldown: a 429 was retried on the next cycle
// regardless of retry-after, and rejected credentials were re-sent every minute forever.

const json = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body
});

let now = 1_000_000;
const clock = () => now;

// 1) A 429 parks the lane for exactly as long as the server asked.
{
  const state = {};
  const http = new MarketplaceHttp({ origin: 'https://x.test', apiKey: 'k', state, now: clock,
    fetchImpl: async () => json(429, {}, { 'retry-after': '90' }) });
  const first = await http.request('/api/tasks');
  assert.equal(first.ok, false);
  assert.equal(state.reason, 'rate_limited');
  assert.equal(state.until, now + 90_000, 'retry-after must set the cooldown');

  let called = 0;
  const parked = new MarketplaceHttp({ origin: 'https://x.test', apiKey: 'k', state, now: clock,
    fetchImpl: async () => { called++; return json(200, []); } });
  const second = await parked.request('/api/tasks');
  assert.equal(called, 0, 'a parked lane must not touch the network at all');
  assert.equal(second.reason, 'rate_limited');
  assert.equal(second.retryAt, state.until);
}

// 2) Rejected credentials park the lane instead of being replayed every cycle.
{
  const state = {};
  const http = new MarketplaceHttp({ origin: 'https://x.test', apiKey: 'bad', state, now: clock,
    fetchImpl: async () => json(401, { error: 'nope' }) });
  await http.request('/api/tasks');
  assert.equal(state.reason, 'credentials_rejected');
  assert.equal(state.until, now + 300_000);
}

// 3) Reads retry once on a server error; writes never do, and report themselves uncertain
// so the caller cannot assume the side effect did not happen.
{
  let reads = 0;
  const readHttp = new MarketplaceHttp({ origin: 'https://x.test', apiKey: 'k', state: {}, now: clock,
    fetchImpl: async () => { reads++; return reads === 1 ? json(500, {}) : json(200, { tasks: [{ id: 1 }] }); } });
  const ok = await readHttp.request('/api/tasks');
  assert.equal(reads, 2, 'a read retries once past a 500');
  assert.equal(ok.ok, true);
  assert.deepEqual(arrayEnvelope(ok.data, ['tasks']), [{ id: 1 }]);

  let writes = 0;
  const writeHttp = new MarketplaceHttp({ origin: 'https://x.test', apiKey: 'k', state: {}, now: clock,
    fetchImpl: async () => { writes++; return json(500, {}); } });
  const wrote = await writeHttp.request('/api/apply', { method: 'POST', body: { message: 'hi' } });
  assert.equal(writes, 1, 'a write is never retried blind');
  assert.equal(wrote.uncertain, true, 'an ambiguous write must be reported as uncertain');
}

// 4) A 200 carrying an unexpected shape is schema drift, not success.
{
  const http = new MarketplaceHttp({ origin: 'https://x.test', apiKey: 'k', state: {}, now: clock,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => null }) });
  const result = await http.request('/api/tasks');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema_drift');
  assert.throws(() => arrayEnvelope({ unexpected: true }, ['tasks']), /schema_drift/);
}

// 5) Guards that keep a marketplace response from steering us somewhere else.
assert.equal(publicUrl('http://insecure.test/x'), '', 'plain http is not accepted');
assert.equal(publicUrl('https://user:pw@host.test/x'), '', 'credentials in a URL are not accepted');
assert.equal(publicUrl('https://ok.test/x'), 'https://ok.test/x');

{
  const http = new MarketplaceHttp({ origin: 'https://x.test', apiKey: 'k', state: {}, now: clock,
    fetchImpl: async () => json(200, []) });
  assert.equal((await http.request('//evil.test/api')).reason, 'invalid_api_path');
  const noKey = new MarketplaceHttp({ origin: 'https://x.test', apiKey: '', state: {}, now: clock,
    fetchImpl: async () => json(200, []) });
  assert.equal((await noKey.request('/api/tasks')).reason, 'credentials_missing');
}

// 6) A served cooldown clears the strike count. Failures used to only ever grow, and this
// state is persisted, so after three failures every later error re-parked the lane for
// another two minutes for the life of the deployment.
{
  const state = { failures: 3, until: now - 1, reason: 'network_error' };
  let called = 0;
  const http = new MarketplaceHttp({ origin: 'https://x.test', apiKey: 'k', state, now: clock,
    fetchImpl: async () => { called++; return json(200, { tasks: [] }); } });
  const result = await http.request('/api/tasks');
  assert.equal(called, 1, 'an expired cooldown must let the request through');
  assert.equal(result.ok, true);
  assert.equal(state.failures, 0, 'strikes must not survive a served cooldown');
}

// 7) An empty or non-JSON 200 is "no work today", not a strike toward parking the lane —
// that is exactly what the previous bare-fetch path treated as an empty list.
{
  const state = {};
  const http = new MarketplaceHttp({ origin: 'https://x.test', apiKey: 'k', state, now: clock,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => null }) });
  for (let i = 0; i < 4; i++) await http.request('/api/tasks');
  assert.equal(state.failures || 0, 0, 'schema drift must not accumulate strikes');
  assert.equal(state.until || 0, 0, 'schema drift must not park the lane');
}

// 8) The server's own message survives to the caller; it used to be reduced to http_<status>.
{
  const http = new MarketplaceHttp({ origin: 'https://x.test', apiKey: 'k', state: {}, now: clock,
    fetchImpl: async () => json(400, { error: { message: 'budget below minimum' } }) });
  assert.equal((await http.request('/api/tasks')).detail, 'budget below minimum');
}

console.log('MARKETPLACE TRANSPORT: PASS');
