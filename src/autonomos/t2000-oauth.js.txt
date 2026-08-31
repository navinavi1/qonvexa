import crypto from 'node:crypto';

const DEFAULT_MCP_URL = 'https://mcp.t2000.ai/mcp';
const TOKEN_FILE = 't2000-oauth.private.json';
const PENDING_TTL_MS = 15 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;
const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export function createT2000OAuth({ store, siteUrl, env = process.env, logger = console, fetchFn = fetch, now = () => Date.now() } = {}) {
  if (!store) throw new Error('t2000_oauth_store_required');
  const base = normalizeHttpsSiteUrl(siteUrl);
  const mcpUrl = normalizeHttpsUrl(env.T2000_MCP_URL || DEFAULT_MCP_URL, 't2000_mcp_url');
  const callbackUrl = new URL('/api/admin/autonomos/t2000/callback', base).toString();
  const clientMetadataUrl = new URL('/oauth/t2000-client.json', base).toString();
  const storageSecret = String(env.T2000_OAUTH_STORAGE_SECRET || env.ADMIN_SESSION_SECRET || '');

  function clientMetadata() {
    return {
      client_id: clientMetadataUrl,
      client_name: 'QONVEXA AutonomOS',
      client_uri: base,
      redirect_uris: [callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    };
  }

  function readState() {
    const raw=store.readJson(TOKEN_FILE, {});
    if(raw?.v===1&&raw?.ciphertext&&storageSecret){
      try{return decryptState(raw,storageSecret)}catch{return{lastError:'oauth_state_decryption_failed'}}
    }
    return raw&&typeof raw==='object'?raw:{};
  }
  function writeState(value) {
    const safe=sanitizePersisted(value);
    return store.writeSecretJson(TOKEN_FILE, storageSecret?encryptState(safe,storageSecret):safe);
  }

  async function beginConnect() {
    const discovery = await discoverOAuth({ mcpUrl, fetchFn });
    const stored = readState();
    const client = await resolveClientRegistration({
      discovery,
      storedClient: stored.client,
      clientMetadata: clientMetadata(),
      clientMetadataUrl,
      fetchFn
    });

    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(32));
    const createdAt = now();
    const pending = {
      state,
      verifier,
      createdAt,
      expiresAt: createdAt + PENDING_TTL_MS,
      issuer: discovery.authorizationServerMetadata.issuer || discovery.authorizationServer,
      authorizationEndpoint: discovery.authorizationServerMetadata.authorization_endpoint,
      tokenEndpoint: discovery.authorizationServerMetadata.token_endpoint,
      resource: discovery.resource,
      scope: discovery.scope,
      clientId: client.client_id,
      clientSecret: client.client_secret || '',
      tokenEndpointAuthMethod: client.token_endpoint_auth_method || 'none'
    };

    writeState({ ...stored, client, pending, lastError: '' });

    const url = new URL(pending.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', pending.clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('resource', pending.resource);
    if (pending.scope) url.searchParams.set('scope', pending.scope);
    return { authorizationUrl: url.toString(), expiresAt: new Date(pending.expiresAt).toISOString() };
  }

  async function finishConnect(query = {}) {
    const stored = readState();
    const pending = stored.pending;
    if (!pending?.state || !pending?.verifier) throw oauthError('t2000_oauth_pending_state_missing', 400);
    if (now() > Number(pending.expiresAt || 0)) {
      writeState({ ...stored, pending: null, lastError: 'oauth_state_expired' });
      throw oauthError('t2000_oauth_state_expired', 400);
    }
    if (query.error) {
      const reason = cleanText(query.error_description || query.error, 300) || 'oauth_denied';
      writeState({ ...stored, pending: null, lastError: reason });
      throw oauthError(`t2000_oauth_denied:${reason}`, 400);
    }
    if (!safeEqual(String(query.state || ''), String(pending.state || ''))) throw oauthError('t2000_oauth_state_mismatch', 400);
    if (!query.code) throw oauthError('t2000_oauth_code_missing', 400);
    if (query.iss && pending.issuer && normalizeIssuer(query.iss) !== normalizeIssuer(pending.issuer)) throw oauthError('t2000_oauth_issuer_mismatch', 400);

    const token = await exchangeToken({
      endpoint: pending.tokenEndpoint,
      params: {
        grant_type: 'authorization_code',
        code: String(query.code),
        redirect_uri: callbackUrl,
        client_id: pending.clientId,
        code_verifier: pending.verifier,
        resource: pending.resource
      },
      clientSecret: pending.clientSecret,
      authMethod: pending.tokenEndpointAuthMethod,
      fetchFn
    });
    const connectedAt = now();
    const tokenState = tokenToState(token, { connectedAt, existingRefreshToken: '' });
    writeState({
      ...stored,
      client: stored.client || { client_id: pending.clientId },
      pending: null,
      token: tokenState,
      oauth: {
        issuer: pending.issuer,
        tokenEndpoint: pending.tokenEndpoint,
        resource: pending.resource,
        scope: String(token.scope || pending.scope || ''),
        connectedAt,
        sessionMaxExpiresAt: connectedAt + SESSION_MAX_MS
      },
      lastError: ''
    });
    return status();
  }

  async function getAccessToken({ required = false } = {}) {
    let stored = readState();
    let token = stored.token || {};
    if (!token.accessToken) {
      if (required) throw oauthError('t2000_oauth_required', 401);
      return '';
    }
    const hardExpiry = Number(stored.oauth?.sessionMaxExpiresAt || 0);
    if (hardExpiry && now() >= hardExpiry) {
      writeState({ ...stored, token: null, lastError: 'connect_session_expired' });
      if (required) throw oauthError('t2000_oauth_session_expired_reconnect_required', 401);
      return '';
    }
    const expiresAt = Number(token.expiresAt || 0);
    if (!expiresAt || now() < expiresAt - REFRESH_SKEW_MS) return String(token.accessToken);
    if (!token.refreshToken || !stored.oauth?.tokenEndpoint || !stored.client?.client_id) {
      writeState({ ...stored, lastError: 'access_token_expired_reconnect_required' });
      if (required) throw oauthError('t2000_oauth_access_expired_reconnect_required', 401);
      return '';
    }
    try {
      const refreshed = await exchangeToken({
        endpoint: stored.oauth.tokenEndpoint,
        params: {
          grant_type: 'refresh_token',
          refresh_token: token.refreshToken,
          client_id: stored.client.client_id,
          resource: stored.oauth.resource
        },
        clientSecret: stored.client.client_secret || '',
        authMethod: stored.client.token_endpoint_auth_method || 'none',
        fetchFn
      });
      const updated = tokenToState(refreshed, { connectedAt: Number(stored.oauth?.connectedAt || now()), existingRefreshToken: token.refreshToken });
      stored = { ...stored, token: updated, lastError: '' };
      writeState(stored);
      return String(updated.accessToken || '');
    } catch (error) {
      const message = cleanText(error?.message || error, 300);
      writeState({ ...stored, lastError: `refresh_failed:${message}` });
      logger.warn?.('t2000 OAuth refresh failed:', message);
      if (required) throw oauthError(`t2000_oauth_refresh_failed:${message}`, 401);
      return '';
    }
  }

  function disconnect() {
    const stored = readState();
    // Keep dynamic client registration details so a later reconnect does not create
    // needless duplicate OAuth clients. Tokens, pending state and Passport delegation
    // are removed locally; the owner can also revoke the t2000 session in Connections.
    writeState({ client: stored.client || null, pending: null, token: null, oauth: null, lastError: '' });
    return { ok: true, connected: false };
  }

  function status() {
    const stored = readState();
    const token = stored.token || {};
    const oauth = stored.oauth || {};
    const hardExpiry = Number(oauth.sessionMaxExpiresAt || 0);
    const accessExpiry = Number(token.expiresAt || 0);
    const expired = Boolean((hardExpiry && now() >= hardExpiry) || (accessExpiry && now() >= accessExpiry && !token.refreshToken));
    const connected = Boolean(token.accessToken) && !expired;
    const effectiveExpiry = [hardExpiry, accessExpiry].filter(Boolean).sort((a,b)=>a-b)[0] || 0;
    return {
      connected,
      needsReconnect: !connected,
      mcpUrl,
      resource: cleanText(oauth.resource || mcpUrl, 500),
      issuer: cleanText(oauth.issuer || '', 500),
      scope: cleanText(oauth.scope || '', 1000),
      connectedAt: oauth.connectedAt ? new Date(Number(oauth.connectedAt)).toISOString() : '',
      expiresAt: effectiveExpiry ? new Date(effectiveExpiry).toISOString() : '',
      expiresInSeconds: effectiveExpiry ? Math.max(0, Math.floor((effectiveExpiry - now()) / 1000)) : null,
      lastError: cleanText(stored.lastError || '', 300)
    };
  }

  return { mcpUrl, callbackUrl, clientMetadataUrl, clientMetadata, beginConnect, finishConnect, getAccessToken, disconnect, status };
}

async function discoverOAuth({ mcpUrl, fetchFn }) {
  let challenge = {};
  try {
    const probe = await fetchWithTimeout(fetchFn, mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'AutonomOS/2.0' },
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'AutonomOS', version:'2.0.0' } } })
    });
    if (probe.status === 401 || probe.status === 403) challenge = parseWwwAuthenticate(probe.headers.get('www-authenticate') || '');
  } catch {}

  const metadataUrls = [];
  if (challenge.resourceMetadata) metadataUrls.push(challenge.resourceMetadata);
  metadataUrls.push(...protectedResourceMetadataCandidates(mcpUrl));
  let resourceMetadata = null;
  let resourceMetadataUrl = '';
  for (const url of unique(metadataUrls)) {
    try {
      const body = await fetchJson(fetchFn, normalizeHttpsUrl(url, 'resource_metadata'));
      if (body && (body.authorization_servers || body.resource)) { resourceMetadata = body; resourceMetadataUrl = url; break; }
    } catch {}
  }
  if (!resourceMetadata) throw oauthError('t2000_oauth_resource_metadata_not_found', 502);
  const authorizationServer = String((resourceMetadata.authorization_servers || [])[0] || '').trim();
  if (!authorizationServer) throw oauthError('t2000_oauth_authorization_server_missing', 502);
  const authorizationServerMetadata = await discoverAuthorizationServerMetadata({ issuer: authorizationServer, fetchFn });
  if (!authorizationServerMetadata.authorization_endpoint || !authorizationServerMetadata.token_endpoint) throw oauthError('t2000_oauth_server_metadata_incomplete', 502);
  const scope = cleanText(challenge.scope || (Array.isArray(resourceMetadata.scopes_supported) ? resourceMetadata.scopes_supported.join(' ') : ''), 2000);
  const resource = normalizeHttpsUrl(resourceMetadata.resource || mcpUrl, 't2000_resource');
  return { resourceMetadata, resourceMetadataUrl, authorizationServer, authorizationServerMetadata, scope, resource };
}

async function discoverAuthorizationServerMetadata({ issuer, fetchFn }) {
  const normalized = normalizeHttpsUrl(issuer, 'authorization_server');
  const u = new URL(normalized);
  const pathPart = u.pathname.replace(/^\/+|\/+$/g, '');
  const candidates = pathPart ? [
    `${u.origin}/.well-known/oauth-authorization-server/${pathPart}`,
    `${u.origin}/.well-known/openid-configuration/${pathPart}`,
    `${u.origin}/${pathPart}/.well-known/openid-configuration`
  ] : [
    `${u.origin}/.well-known/oauth-authorization-server`,
    `${u.origin}/.well-known/openid-configuration`
  ];
  let last = '';
  for (const candidate of unique(candidates)) {
    try {
      const body = await fetchJson(fetchFn, candidate);
      if (body?.issuer && normalizeIssuer(body.issuer)!==normalizeIssuer(normalized)) continue;
      if (body?.authorization_endpoint && body?.token_endpoint) return body;
    } catch (error) { last = String(error?.message || error); }
  }
  throw oauthError(`t2000_oauth_authorization_metadata_not_found:${cleanText(last,160)}`, 502);
}

async function resolveClientRegistration({ discovery, storedClient, clientMetadata, clientMetadataUrl, fetchFn }) {
  const as = discovery.authorizationServerMetadata;
  if (storedClient?.client_id && normalizeIssuer(storedClient.issuer || discovery.authorizationServer) === normalizeIssuer(discovery.authorizationServer)) return storedClient;
  if (as.client_id_metadata_document_supported === true) {
    if (!clientMetadataUrl.startsWith('https://')) throw oauthError('t2000_oauth_https_site_url_required_for_client_metadata', 500);
    return { client_id: clientMetadataUrl, token_endpoint_auth_method:'none', issuer: discovery.authorizationServer, registrationMode:'client_id_metadata_document' };
  }
  if (as.registration_endpoint) {
    const endpoint = normalizeHttpsUrl(as.registration_endpoint, 'registration_endpoint');
    const response = await fetchWithTimeout(fetchFn, endpoint, {
      method:'POST',
      headers:{ 'content-type':'application/json', accept:'application/json', 'user-agent':'AutonomOS/2.0' },
      body:JSON.stringify(Object.fromEntries(Object.entries(clientMetadata).filter(([key])=>key!=='client_id')))
    });
    const body = await readJsonResponse(response);
    if (!response.ok || !body?.client_id) throw oauthError(`t2000_oauth_dynamic_registration_failed:http_${response.status}:${cleanText(body?.error_description || body?.error || '',140)}`, 502);
    return {
      client_id:String(body.client_id),
      client_secret:String(body.client_secret || ''),
      client_secret_expires_at:Number(body.client_secret_expires_at || 0),
      token_endpoint_auth_method:String(body.token_endpoint_auth_method || clientMetadata.token_endpoint_auth_method || 'none'),
      issuer:discovery.authorizationServer,
      registrationMode:'dynamic_client_registration'
    };
  }
  throw oauthError('t2000_oauth_client_registration_unavailable', 502);
}

async function exchangeToken({ endpoint, params, clientSecret = '', authMethod = 'none', fetchFn }) {
  const url = normalizeHttpsUrl(endpoint, 'token_endpoint');
  const body = new URLSearchParams();
  for (const [key,value] of Object.entries(params || {})) if (value !== undefined && value !== null && String(value) !== '') body.set(key, String(value));
  const headers = { 'content-type':'application/x-www-form-urlencoded', accept:'application/json', 'user-agent':'AutonomOS/2.0' };
  if (clientSecret && authMethod === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${params.client_id}:${clientSecret}`).toString('base64')}`;
  } else if (clientSecret && authMethod === 'client_secret_post') {
    body.set('client_secret', clientSecret);
  }
  const response = await fetchWithTimeout(fetchFn, url, { method:'POST', headers, body:body.toString() });
  const payload = await readJsonResponse(response);
  if (!response.ok || !payload?.access_token) throw oauthError(`t2000_oauth_token_exchange_failed:http_${response.status}:${cleanText(payload?.error_description || payload?.error || '',180)}`, 502);
  return payload;
}

function tokenToState(token, { connectedAt, existingRefreshToken = '' } = {}) {
  const expiresIn = Number(token.expires_in || 0);
  return {
    accessToken:String(token.access_token || ''),
    tokenType:String(token.token_type || 'Bearer'),
    refreshToken:String(token.refresh_token || existingRefreshToken || ''),
    scope:String(token.scope || ''),
    issuedAt:Number(connectedAt || Date.now()),
    expiresAt:expiresIn > 0 ? Number(connectedAt || Date.now()) + expiresIn * 1000 : 0
  };
}

function protectedResourceMetadataCandidates(mcpUrl) {
  const u = new URL(mcpUrl);
  const p = u.pathname.replace(/^\/+/, '');
  const out = [];
  if (p) out.push(`${u.origin}/.well-known/oauth-protected-resource/${p}`);
  out.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return out;
}

function parseWwwAuthenticate(header) {
  const resourceMetadata = matchParam(header, 'resource_metadata');
  const scope = matchParam(header, 'scope');
  return { resourceMetadata, scope };
}
function matchParam(header, name) {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]+)"|([^,\\s]+))`, 'i');
  const m = String(header || '').match(re);
  return cleanText(m?.[1] || m?.[2] || '', 2000);
}

async function fetchJson(fetchFn, url) {
  const response = await fetchWithTimeout(fetchFn, url, { headers:{ accept:'application/json', 'user-agent':'AutonomOS/2.0', 'mcp-protocol-version':'2025-06-18' } });
  const body = await readJsonResponse(response);
  if (!response.ok) throw new Error(`http_${response.status}`);
  return body;
}
async function readJsonResponse(response) {
  let text='';try{text=await response.text()}catch{return{}}
  if(!text)return{};try{return JSON.parse(text)}catch{return{raw:text.slice(0,2000)}}
}
async function fetchWithTimeout(fetchFn, url, options = {}) {
  return fetchFn(url, { ...options, signal:options.signal || AbortSignal.timeout(15000), redirect:'follow' });
}

function normalizeHttpsSiteUrl(value) {
  const url = new URL(String(value || ''));
  if (!['https:','http:'].includes(url.protocol)) throw new Error('invalid_site_url');
  url.pathname = '/'; url.search = ''; url.hash = '';
  return url.toString();
}
function normalizeHttpsUrl(value, label = 'url') {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:') throw oauthError(`${label}_must_be_https`, 400);
  return url.toString();
}
function normalizeIssuer(value) { try { const u = new URL(String(value || '')); return `${u.origin}${u.pathname.replace(/\/$/,'')}`; } catch { return String(value || '').replace(/\/$/,''); } }
function base64url(value) { return Buffer.from(value).toString('base64url'); }
function safeEqual(a,b) { const aa=Buffer.from(a),bb=Buffer.from(b); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
function cleanText(value,max=300) { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function oauthError(message,status=500){const error=new Error(message);error.status=status;return error;}
function sanitizePersisted(value) { return JSON.parse(JSON.stringify(value ?? {})); }

function encryptState(value,secret){
  const key=crypto.createHash('sha256').update(`t2000-oauth:${secret}`).digest();
  const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);const tag=cipher.getAuthTag();
  return{v:1,alg:'A256GCM',iv:iv.toString('base64url'),tag:tag.toString('base64url'),ciphertext:ciphertext.toString('base64url')};
}
function decryptState(envelope,secret){
  const key=crypto.createHash('sha256').update(`t2000-oauth:${secret}`).digest();
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64url'));decipher.setAuthTag(Buffer.from(envelope.tag,'base64url'));
  const plain=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64url')),decipher.final()]).toString('utf8');return JSON.parse(plain);
}
