const NETWORKS = Object.freeze({
  'eip155:8453': { name:'Base Mainnet', asset:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', live:true },
  'eip155:84532': { name:'Base Sepolia', asset:'0x036CbD53842c5426634e7929541eC2318f3dCF7e', live:false }
});

export function createX402Gateway({ ownerWallet, siteUrl, env = process.env, onSettlement = () => {} } = {}) {
  const enabled = /^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_X402_ENABLED || 'false'));
  const network = String(env.AUTONOMOS_X402_NETWORK || 'eip155:84532');
  const networkMeta = NETWORKS[network] || NETWORKS['eip155:84532'];
  const facilitatorUrl = String(env.AUTONOMOS_X402_FACILITATOR_URL || (networkMeta.live ? '' : 'https://x402.org/facilitator')).replace(/\/$/,'');
  const authHeaders = parseHeaders(env.AUTONOMOS_X402_FACILITATOR_HEADERS_JSON || '');
  const configured = enabled && /^0x[a-fA-F0-9]{40}$/.test(String(ownerWallet || '')) && Boolean(facilitatorUrl);

  return {
    status() {
      return {
        enabled,
        configured,
        network,
        networkName:networkMeta.name,
        live:networkMeta.live,
        payTo:ownerWallet,
        facilitatorConfigured:Boolean(facilitatorUrl),
        facilitatorAuthConfigured:Object.keys(authHeaders).length > 0,
        mode:!enabled ? 'disabled' : configured ? (networkMeta.live ? 'mainnet' : 'testnet') : 'needs_configuration'
      };
    },

    async protect({ req, res, product, handler }) {
      if (!configured) {
        return res.status(503).json({
          error:'Machine payment rail is not configured.',
          code:'x402_not_configured',
          product:product.id,
          paymentMode:enabled ? 'needs_configuration' : 'disabled'
        });
      }

      const requirements = paymentRequirements(product.priceUsd, ownerWallet, network, networkMeta.asset);
      const resource = {
        url:new URL(product.path, siteUrl).toString(),
        description:product.description,
        mimeType:'application/json',
        serviceName:'AutonomOS',
        tags:product.tags.slice(0,5)
      };
      const extensions = bazaarExtension(product);
      const paymentRequired = { x402Version:2, error:'PAYMENT-SIGNATURE header is required', resource, accepts:[requirements], extensions };
      const rawPayment = req.get('PAYMENT-SIGNATURE') || req.get('payment-signature') || '';
      if (!rawPayment) return sendPaymentRequired(res, paymentRequired);

      let paymentPayload;
      try { paymentPayload = decodeHeaderJson(rawPayment); }
      catch { return sendPaymentRequired(res, { ...paymentRequired, error:'Invalid PAYMENT-SIGNATURE header' }); }
      if (!sameRequirements(paymentPayload?.accepted, requirements)) {
        return sendPaymentRequired(res, { ...paymentRequired, error:'Payment requirements mismatch' });
      }
      if (!extensionsContain(paymentPayload?.extensions, extensions)) {
        return sendPaymentRequired(res, { ...paymentRequired, error:'Required x402 extensions were not echoed by the client' });
      }

      const envelope = { x402Version:2, paymentPayload, paymentRequirements:requirements };
      const verification = await facilitatorPost(facilitatorUrl, '/verify', envelope, authHeaders);
      const verificationValid = verification.body?.isValid === true || verification.body?.valid === true;
      if (!verification.ok || !verificationValid) {
        return sendPaymentRequired(res, { ...paymentRequired, error:verification.body?.invalidReason || verification.body?.reason || verification.error || 'Payment verification failed' });
      }

      let result;
      try { result = await handler(); }
      catch (error) {
        const status = Number(error?.status || 500);
        return res.status(status).json({ error:String(error?.code || error?.message || 'product_execution_failed') });
      }

      const settlement = await facilitatorPost(facilitatorUrl, '/settle', envelope, authHeaders);
      const settlementSuccess = settlement.body?.success === true || settlement.body?.settled === true;
      if (!settlement.ok || !settlementSuccess) {
        return res.status(502).json({ error:'Payment settlement failed.', detail:settlement.body?.errorReason || settlement.body?.reason || settlement.error || '' });
      }

      const settlementPayload = settlement.body;
      res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(settlementPayload)).toString('base64'));
      try {
        await onSettlement({
          product,
          amountUsd:product.priceUsd,
          network,
          live:networkMeta.live,
          payer:settlementPayload.payer || verification.body?.payer || '',
          transaction:settlementPayload.transaction || settlementPayload.txHash || '',
          settledAt:new Date().toISOString()
        });
      } catch {}
      return res.json(result);
    }
  };
}


function bazaarExtension(product) {
  const info = {
    input: {
      type:'http',
      method:'GET',
      discoverable:true,
      queryParams:{ url:'https://example.com' }
    },
    inputSchema:{
      type:'object',
      properties:{ url:{ type:'string', format:'uri', description:'Public http(s) website URL to analyze.' } },
      required:['url'],
      additionalProperties:false
    },
    output:{
      type:'json',
      example:{ product:product.id, target:'https://example.com', generatedAt:'2026-01-01T00:00:00.000Z' }
    }
  };
  return {
    bazaar:{
      info,
      schema:{
        type:'object',
        properties:{
          input:{ type:'object' },
          inputSchema:{ type:'object' },
          output:{ type:'object' }
        },
        required:['input','inputSchema','output'],
        additionalProperties:true
      }
    }
  };
}

function extensionsContain(candidate, expected) {
  if (!expected || !Object.keys(expected).length) return true;
  if (!candidate || typeof candidate !== 'object') return false;
  for (const key of Object.keys(expected)) {
    if (!candidate[key] || typeof candidate[key] !== 'object') return false;
    const expectedInfo = JSON.stringify(expected[key].info || {});
    const candidateInfo = JSON.stringify(candidate[key].info || {});
    if (expectedInfo !== candidateInfo) return false;
  }
  return true;
}

function paymentRequirements(priceUsd, payTo, network, asset) {
  const atomic = BigInt(Math.max(1, Math.round(Number(priceUsd || 0) * 1_000_000)));
  return {
    scheme:'exact', network, amount:atomic.toString(), asset, payTo,
    maxTimeoutSeconds:60,
    extra:{ name:'USDC', version:'2' }
  };
}

function sendPaymentRequired(res, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  res.setHeader('PAYMENT-REQUIRED', encoded);
  res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED,PAYMENT-RESPONSE');
  return res.status(402).json(payload);
}

function decodeHeaderJson(value) {
  const normalized = String(value).trim();
  const json = Buffer.from(normalized, 'base64').toString('utf8');
  return JSON.parse(json);
}

async function facilitatorPost(baseUrl, endpoint, body, headers) {
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method:'POST',
      headers:{ 'content-type':'application/json', ...headers },
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(30000)
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    return { ok:response.ok, status:response.status, body:payload, error:response.ok ? '' : `facilitator_http_${response.status}` };
  } catch (error) {
    return { ok:false, status:0, body:null, error:String(error?.message || error).slice(0,300) };
  }
}

function sameRequirements(candidate, expected) {
  if (!candidate) return false;
  for (const key of ['scheme','network','amount','asset','payTo','maxTimeoutSeconds']) {
    if (String(candidate[key] ?? '') !== String(expected[key] ?? '')) return false;
  }
  return true;
}

function parseHeaders(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(String(raw));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    for (const [key,val] of Object.entries(value)) {
      if (/^[A-Za-z0-9-]{1,80}$/.test(key) && typeof val === 'string' && val.length < 4000) out[key] = val;
    }
    return out;
  } catch { return {}; }
}
