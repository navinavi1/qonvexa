const CONNECTOR_DEFS = Object.freeze([
  {
    id:'x402-bazaar', name:'x402 / Bazaar', kind:'market',
    description:'Machine-payable API discovery and seller rail.',
    requiredEnv:[],
    optionalEnv:['AUTONOMOS_BAZAAR_URL','AUTONOMOS_X402_FACILITATOR_URL','AUTONOMOS_X402_FACILITATOR_HEADERS_JSON']
  },
  {
    id:'virtuals-acp', name:'Virtuals ACP', kind:'market',
    description:'Agent-to-agent jobs with USDC escrow on Base.',
    requiredEnv:['VIRTUALS_ACP_WALLET_ID','VIRTUALS_ACP_SIGNER'],
    optionalEnv:['VIRTUALS_ACP_AGENT_ID','VIRTUALS_ACP_RPC_URL']
  },
  {
    id:'olas-mech', name:'Olas Mech Marketplace', kind:'market',
    description:'Marketplace for agent-provided Mech services.',
    requiredEnv:['OLAS_MECH_API_KEY'], optionalEnv:['OLAS_MECH_ENDPOINT']
  },
  {
    id:'nevermined', name:'Nevermined', kind:'payments',
    description:'Agent monetization, metering and x402-compatible payment infrastructure.',
    requiredEnv:['NVM_API_KEY'], optionalEnv:['NVM_PLAN_ID']
  },
  {
    id:'skyfire', name:'Skyfire', kind:'payments',
    description:'Agent identity, wallets and programmable payments.',
    requiredEnv:['SKYFIRE_API_KEY'], optionalEnv:[]
  },
  {
    id:'openserv', name:'OpenServ', kind:'market',
    description:'Agent marketplace and x402-compatible services.',
    requiredEnv:['OPENSERV_API_KEY'], optionalEnv:[]
  },
  {
    id:'agentverse', name:'Agentverse / Fetch.ai', kind:'discovery',
    description:'Discoverable agent network and service registry.',
    requiredEnv:['AGENTVERSE_API_KEY'], optionalEnv:[]
  },
  {
    id:'conway', name:'Conway Automaton', kind:'runtime',
    description:'Optional sovereign runtime/compute integration; AutonomOS does not depend on it.',
    requiredEnv:['CONWAY_API_KEY'], optionalEnv:['CONWAY_API_URL']
  }
]);

export function connectorStatuses(env = process.env, x402Status = {}) {
  return CONNECTOR_DEFS.map(def => {
    const missing = def.requiredEnv.filter(key => !String(env[key] || '').trim());
    if (def.id === 'x402-bazaar') {
      return {
        ...def,
        status:x402Status.configured ? 'ready' : x402Status.enabled ? 'needs_configuration' : 'available',
        configured:Boolean(x402Status.configured),
        missing:x402Status.configured ? [] : ['AUTONOMOS_X402_ENABLED + facilitator for selected network'],
        mode:x402Status.mode || 'disabled'
      };
    }
    return { ...def, status:missing.length ? 'needs_credentials' : 'ready', configured:missing.length === 0, missing };
  });
}

export async function discoverPublicSignals({ env = process.env, limit = 60 } = {}) {
  const url = String(env.AUTONOMOS_BAZAAR_URL || 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=50');
  const signals = [];
  let bazaar = { ok:false, url, count:0, error:'' };
  try {
    const response = await fetch(url, {
      headers:{ accept:'application/json', 'user-agent':'AutonomOS/1.0' },
      signal:AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const body = await response.json();
    const resources = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : Array.isArray(body?.resources) ? body.resources : [];
    bazaar = { ok:true, url, count:resources.length, error:'' };
    for (const resource of resources.slice(0,limit)) {
      const accepted = Array.isArray(resource.accepts) ? resource.accepts[0] : null;
      const amount = Number(accepted?.amount || 0) / 1_000_000;
      const rawUrl = String(resource.resource || resource.url || resource?.resource?.url || '');
      if (!rawUrl) continue;
      signals.push({
        source:'x402-bazaar',
        externalId:rawUrl,
        title:resource?.resource?.description || resource.description || rawUrl,
        url:rawUrl,
        network:accepted?.network || '',
        priceUsd:Number.isFinite(amount) ? amount : 0,
        tags:resource?.resource?.tags || resource.tags || [],
        observedAt:new Date().toISOString()
      });
    }
  } catch (error) {
    bazaar.error = String(error?.message || error).slice(0,200);
  }
  return { signals, health:{ bazaar } };
}

export function connectorDefinitions() { return CONNECTOR_DEFS.map(item=>({...item})); }
