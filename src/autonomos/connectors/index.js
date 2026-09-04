import { McpHttpClient, extractMcpToolPayload } from '../mcp-client.js';
import { normalizeOpportunity } from '../job-normalizer.js';
import { isEvmAddress as isEvmAddressLike } from '../treasury.js';

const T2000_DEFAULT_MCP_URL = 'https://mcp.t2000.ai/mcp';

const CONNECTOR_DEFS = Object.freeze([
  { id:'x402-bazaar', name:'x402 / Bazaar', kind:'seller+discovery', description:'Machine-payable API discovery and seller rail.', requiredEnv:[] },
  { id:'clawlancer', name:'Clawlancer', kind:'jobs', description:'Pre-funded Base/USDC bounties: discover → claim → deliver → paid.', requiredEnv:[], optionalEnv:['CLAWLANCER_API_KEY','CLAWLANCER_AGENT_ID'] },
  { id:'dealwork', name:'dealwork.ai', kind:'jobs', description:'Human+AI hybrid marketplace, USD via Stripe escrow, open-task instant claim.', requiredEnv:[], optionalEnv:['DEALWORK_API_KEY','DEALWORK_AGENT_ID'] },
  // Real bounties run $500-$1500+ USDC/SOL — a different tier from Clawlancer's mostly-$0.01
  // test listings. No escrow lock: it's a competitive submission a human sponsor judges,
  // and payout requires a HUMAN to visit a claim URL with their own wallet (agents can't
  // hold/sign for themselves here) — see claimUrl surfaced in state.pendingHumanClaims.
  { id:'superteam', name:'Superteam Earn', kind:'jobs', description:'Solana ecosystem bounties/projects, $500-$1500+ USDC/SOL. Competitive (not escrow-guaranteed); payout requires a human to claim with claimCode.', requiredEnv:[], optionalEnv:['SUPERTEAM_HUMAN_TELEGRAM'] },
  { id:'virtuals-acp', name:'Virtuals ACP', kind:'jobs+seller', description:'Agent Commerce Protocol jobs and USDC escrow.', requiredEnv:['VIRTUALS_ACP_WALLET_ID','VIRTUALS_ACP_SIGNER'], optionalEnv:['VIRTUALS_ACP_AGENT_ID'] },
  { id:'t2000', name:'t2000', kind:'jobs+seller', description:'Sui/USDC Open Jobs + your paid Service orders via Passport Connect OAuth.', requiredEnv:[], optionalEnv:['T2000_MCP_URL'] },
  { id:'olas-mech', name:'Olas Mech Marketplace', kind:'seller+discovery', description:'Agent-to-agent paid Mech services.', requiredEnv:['OLAS_MECH_API_KEY'], optionalEnv:['OLAS_MECH_ENDPOINT'] },
  { id:'nevermined', name:'Nevermined', kind:'payments', description:'Fiat + crypto agent payment facilitator and metering.', requiredEnv:['NVM_API_KEY'], optionalEnv:['NVM_PLAN_ID'] },
  { id:'openserv', name:'OpenServ', kind:'discovery', description:'Agent/workflow ecosystem; optional authenticated connector.', requiredEnv:['OPENSERV_API_KEY'], optionalEnv:[] },
  // P1 fix: Firecrawl/E2B previously had no entry here at all, so the dashboard could show
  // a fully green AutonomOS while one or both tool keys were missing, unauthorized, or
  // dropped — job-executor would then silently run with fewer tools than the operator
  // assumed. These follow the same requiredEnv-presence pattern as the other simple
  // connectors below; it confirms the key is SET, not that Firecrawl/E2B have accepted it
  // or that the account has remaining quota (that requires a live, billable call this
  // audit intentionally avoids making just to render a status dot).
  { id:'firecrawl', name:'Firecrawl (web_search/web_scrape tool)', kind:'tool', description:'Live web search/scrape tool available to worker agents during job execution.', requiredEnv:['FIRECRAWL_API_KEY'] },
  { id:'e2b', name:'E2B (run_python tool)', kind:'tool', description:'Sandboxed Python execution tool available to worker agents during job execution.', requiredEnv:['E2B_API_KEY'] },
  { id:'github-pr', name:'GitHub (open_pull_request tool)', kind:'tool', description:'Lets worker agents propose code changes to a GitHub repo via Pull Request — never merges automatically. Needs a fine-grained PAT (Contents + Pull requests permission) for a dedicated bot account, not a personal account.', requiredEnv:['GITHUB_TOKEN'] }
]);

export function connectorStatuses(env = process.env, x402Status = {}, persistedCredentials = {}) {
  return CONNECTOR_DEFS.map(def => {
    if (def.id === 'x402-bazaar') return { ...def, status:x402Status.configured?'ready':x402Status.enabled?'needs_configuration':'available', configured:Boolean(x402Status.configured), missing:x402Status.configured?[]:['AUTONOMOS_X402_ENABLED + supported facilitator'], mode:x402Status.mode||'disabled' };
    if (def.id === 'clawlancer') {
      const hasKey=Boolean(String(env.CLAWLANCER_API_KEY||persistedCredentials?.clawlancer?.apiKey||'').trim());
      return { ...def, status:hasKey?'ready':'auto_bootstrap_available', configured:hasKey, missing:hasKey?[]:['agent registration will be created automatically on first cycle'] };
    }
    if (def.id === 'dealwork') {
      const hasKey=Boolean(String(env.DEALWORK_API_KEY||persistedCredentials?.dealwork?.apiKey||'').trim());
      return { ...def, status:hasKey?'ready':'auto_bootstrap_available', configured:hasKey, missing:hasKey?[]:['agent registration will be created automatically on first cycle'] };
    }
    if (def.id === 'superteam') {
      const hasKey=Boolean(persistedCredentials?.superteam?.apiKey);
      return { ...def, status:hasKey?'ready':'auto_bootstrap_available', configured:hasKey, missing:hasKey?[]:['agent registration will be created automatically on first cycle'] };
    }
    if (def.id === 't2000') {
      const connected=Boolean(String(persistedCredentials?.t2000?.accessToken||'').trim());
      return { ...def, status:connected?'ready':'connect_required', configured:connected, missing:connected?[]:['Connect t2000 in the AutonomOS dashboard (Google OAuth → existing Passport).'], mode:'passport_connect_oauth' };
    }
    const missing=def.requiredEnv.filter(key=>!String(env[key]||'').trim());
    return { ...def, status:missing.length?'needs_credentials':'ready', configured:missing.length===0, missing };
  });
}

export async function bootstrapMarketCredentials({ env=process.env, credentials={}, storeCredential=()=>{}, ownerWallet='' }={}) {
  const health={};
  if (!String(env.CLAWLANCER_API_KEY||credentials?.clawlancer?.apiKey||'').trim()) {
    try {
      const registerBody={agent_name:String(env.AUTONOMOS_AGENT_NAME||'AutonomOS').slice(0,48),description:'Autonomous digital-services worker: public web research, data extraction, code analysis, structured writing and QA.'};
      // Per Clawlancer's documented "Wallet Options": leaving this out defaults to their
      // custodial "Oracle" wallet — USDC would accumulate there, not with the owner, and
      // would need a separate (currently undocumented/unverified) withdraw step. Passing
      // our own address here is their documented "Custom" option: USDC pays out directly
      // to the owner's wallet on every job, automatically, no withdraw step needed at all.
      if (isEvmAddressLike(ownerWallet)) registerBody.wallet_address = ownerWallet;
      const response=await fetch('https://clawlancer.ai/api/agents/register',{method:'POST',headers:{'content-type':'application/json','accept':'application/json','user-agent':'AutonomOS/2.0'},body:JSON.stringify(registerBody),signal:AbortSignal.timeout(15000)});
      const body=await safeJson(response);
      if (response.ok) {
        const apiKey=body?.api_key||body?.apiKey||body?.key||body?.agent?.api_key||'';
        const agentId=body?.agent_id||body?.agentId||body?.id||body?.agent?.id||'';
        const walletAddress=body?.wallet_address||body?.walletAddress||body?.agent?.wallet_address||body?.agent?.walletAddress||'';
        if (apiKey) {
          const value={ apiKey:String(apiKey), agentId:String(agentId||''), walletAddress:String(walletAddress||''), createdAt:new Date().toISOString(), source:'auto_registration' };
          storeCredential('clawlancer',value); credentials.clawlancer=value;
          health.clawlancer={ok:true,bootstrapped:true,agentId:value.agentId,walletAddress:value.walletAddress};
        } else health.clawlancer={ok:false,error:'registration_response_missing_api_key'};
      } else health.clawlancer={ok:false,error:`http_${response.status}`,detail:body?.error||body?.message||''};
    } catch(error){ health.clawlancer={ok:false,error:String(error?.message||error).slice(0,180)}; }
  } else if (isEvmAddressLike(ownerWallet)) {
    // Already registered (from a previous cycle, possibly before this owner-wallet fix
    // existed) — check whether the stored payout address still matches, and fix it once
    // via the documented profile-update endpoint rather than leaving USDC stuck on
    // Clawlancer's custodial default wallet.
    const existing=credentials?.clawlancer||{};
    const key=String(env.CLAWLANCER_API_KEY||existing.apiKey||'');
    if (key && String(existing.walletAddress||'').toLowerCase()!==ownerWallet.toLowerCase() && !existing.walletFixAttemptedAt) {
      try {
        const response=await fetch('https://clawlancer.ai/api/agents/me',{method:'PATCH',headers:{'content-type':'application/json',accept:'application/json',authorization:`Bearer ${key}`,'user-agent':'AutonomOS/2.0'},body:JSON.stringify({wallet_address:ownerWallet}),signal:AbortSignal.timeout(15000)});
        const body=await safeJson(response);
        const updated={...existing,walletFixAttemptedAt:new Date().toISOString()};
        if (response.ok) { updated.walletAddress=ownerWallet; }
        storeCredential('clawlancer',updated); credentials.clawlancer=updated;
        health.clawlancer={ok:response.ok,walletUpdated:response.ok,status:response.ok?undefined:response.status,detail:response.ok?undefined:(body?.error||body?.message||'')};
      } catch(error){ health.clawlancer={ok:false,error:String(error?.message||error).slice(0,180)}; }
    }
  }
  if (!String(env.DEALWORK_API_KEY||credentials?.dealwork?.apiKey||'').trim()) {
    try {
      // identityKey must be stable across restarts/redeploys — the docs warn that onboarding
      // without one creates a NEW duplicate agent account every time credentials are lost.
      // Base it on the owner wallet (stable, unique to this deployment) rather than a random value.
      const identityKey=`autonomos-${String(env.AUTONOMOS_OWNER_WALLET||env.AUTONOMOS_AGENT_NAME||'default').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,64)||'autonomos-default'}`;
      const response=await fetch('https://dealwork.ai/api/v1/agents/onboard',{method:'POST',headers:{'content-type':'application/json','accept':'application/json','user-agent':'AutonomOS/2.0'},body:JSON.stringify({autonomous:true,agentName:String(env.AUTONOMOS_AGENT_NAME||'AutonomOS').slice(0,48),description:'Autonomous digital-services worker: public web research, data extraction, structured writing, translation and QA. Typical turnaround: minutes.',capabilityTags:['research','writing','data','translation','automation'],identityKey}),signal:AbortSignal.timeout(15000)});
      const body=await safeJson(response);
      const data=body?.data||body;
      if (response.ok && data?.apiKey) {
        const value={ apiKey:String(data.apiKey), agentAccountId:String(data.agentAccountId||''), hmacSecret:String(data.hmacSecret||''), createdAt:new Date().toISOString(), source:data.recovered?'recovered':'auto_registration' };
        storeCredential('dealwork',value); credentials.dealwork=value;
        health.dealwork={ok:true,bootstrapped:true,recovered:Boolean(data.recovered),agentAccountId:value.agentAccountId};
      } else health.dealwork={ok:false,error:response.ok?'onboard_response_missing_api_key':`http_${response.status}`,detail:data?.error?.message||body?.error||''};
    } catch(error){ health.dealwork={ok:false,error:String(error?.message||error).slice(0,180)}; }
  }
  // Superteam Earn: per their own agent skill spec (superteam.fun/skill.md), registration
  // is a single POST returning an apiKey + a claimCode. The claimCode is NOT a secret to
  // protect like an API key — it's meant to be handed to the human owner so THEY can claim
  // payouts (agents never hold funds here: "Agents do not complete OAuth, wallet signing,
  // or KYC"). We store it so the dashboard can show the owner exactly which URL to visit.
  if (!credentials?.superteam?.apiKey) {
    try {
      const response=await fetch('https://superteam.fun/api/agents',{method:'POST',headers:{'content-type':'application/json','accept':'application/json','user-agent':'AutonomOS/2.0'},body:JSON.stringify({name:String(env.AUTONOMOS_AGENT_NAME||'AutonomOS').slice(0,48)}),signal:AbortSignal.timeout(15000)});
      const body=await safeJson(response);
      if (response.ok && body?.apiKey) {
        const value={ apiKey:String(body.apiKey), claimCode:String(body.claimCode||''), agentId:String(body.agentId||''), username:String(body.username||''), createdAt:new Date().toISOString(), source:'auto_registration' };
        storeCredential('superteam',value); credentials.superteam=value;
        health.superteam={ok:true,bootstrapped:true,claimCode:value.claimCode,username:value.username};
      } else health.superteam={ok:false,error:response.ok?'registration_response_missing_api_key':`http_${response.status}`,detail:body?.error||body?.message||''};
    } catch(error){ health.superteam={ok:false,error:String(error?.message||error).slice(0,180)}; }
  }
  return health;
}

export async function discoverMarketOpportunities({ env=process.env, credentials={}, limit=100, sources=null }={}) {
  const all=[]; const health={};
  const want=Array.isArray(sources)&&sources.length?new Set(sources):null;
  const jobs=[
    ['x402-bazaar',()=>discoverX402(env,limit)],
    ['clawlancer',()=>discoverClawlancer(env,credentials,limit)],
    ['dealwork',()=>discoverDealwork(env,credentials,limit)],
    ['t2000',()=>discoverT2000(env,credentials,limit)],
    ['superteam',()=>discoverSuperteam(credentials,limit)]
  ].filter(([id])=>!want||want.has(id));
  const results=await Promise.allSettled(jobs.map(([,fn])=>fn()));
  jobs.forEach(([id],i)=>{
    const result=results[i];
    if (result.status==='fulfilled') { all.push(...result.value.signals); health[id]=result.value.health; }
    else health[id]={ok:false,error:String(result.reason?.message||result.reason).slice(0,180)};
  });
  return { signals:dedupe(all).slice(0,limit*4), health };
}

export async function claimMarketplaceJob(opportunity,{env=process.env,credentials={}}={}) {
  if (opportunity.source==='clawlancer') return clawlancerAction('claim',opportunity,{env,credentials});
  if (opportunity.source==='dealwork') return dealworkAction('claim',opportunity,{env,credentials});
  if (opportunity.source==='t2000') return t2000Action('claim',opportunity,{env,credentials});
  if (opportunity.source==='superteam') return superteamAction('claim',opportunity,{credentials});
  return {ok:false,reason:'connector_claim_not_available'};
}

export async function deliverMarketplaceJob(opportunity,claim,deliverable,{env=process.env,credentials={},recordPendingClaim}={}) {
  if (opportunity.source==='clawlancer') return clawlancerAction('deliver',opportunity,{env,credentials,claim,deliverable});
  if (opportunity.source==='dealwork') return dealworkAction('deliver',opportunity,{env,credentials,claim,deliverable});
  if (opportunity.source==='t2000') return t2000Action('deliver',opportunity,{env,credentials,claim,deliverable});
  if (opportunity.source==='superteam') return superteamAction('deliver',opportunity,{env,credentials,deliverable,recordPendingClaim});
  return {ok:false,reason:'connector_delivery_not_available'};
}

export async function readMarketplaceWallets({env=process.env,credentials={}}={}) {
  const out={};
  const key=String(env.CLAWLANCER_API_KEY||credentials?.clawlancer?.apiKey||'');
  const agentId=String(env.CLAWLANCER_AGENT_ID||credentials?.clawlancer?.agentId||'');
  if (key && agentId) {
    try { const r=await fetch(`https://clawlancer.ai/api/wallet/balance?agent_id=${encodeURIComponent(agentId)}`,{headers:auth(key),signal:AbortSignal.timeout(12000)}); out.clawlancer={ok:r.ok,...await safeJson(r)}; }
    catch(error){ out.clawlancer={ok:false,error:String(error?.message||error)}; }
  }
  const dwKey=String(env.DEALWORK_API_KEY||credentials?.dealwork?.apiKey||'');
  if (dwKey) {
    try { const r=await fetch('https://dealwork.ai/api/v1/wallet/balance',{headers:auth(dwKey),signal:AbortSignal.timeout(12000)}); const body=await safeJson(r); out.dealwork={ok:r.ok,...(body?.data||body)}; }
    catch(error){ out.dealwork={ok:false,error:String(error?.message||error)}; }
  }
  const tToken=t2000Token(env,credentials);
  if(tToken){
    try{
      const client=new McpHttpClient({url:String(env.T2000_MCP_URL||T2000_DEFAULT_MCP_URL),token:tToken,timeoutMs:18000}); await client.initialize(); const tools=await client.listTools();
      const balanceTool=tools.find(t=>t.name==='t2000_balance'),addressTool=tools.find(t=>t.name==='t2000_address');
      const balance=balanceTool?extractMcpToolPayload(await client.callTool(balanceTool.name,{})):null;
      const address=addressTool?extractMcpToolPayload(await client.callTool(addressTool.name,{})):null;
      out.t2000={ok:true,network:'Sui',address:address?.address||address?.passportAddress||address?.passport_address||address||'',balance};
    }catch(error){out.t2000={ok:false,error:String(error?.message||error).slice(0,180)}}
  }
  return out;
}

async function discoverX402(env,limit){
  const url=String(env.AUTONOMOS_BAZAAR_URL||'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=50');
  const response=await fetch(url,{headers:{accept:'application/json','user-agent':'AutonomOS/2.0'},signal:AbortSignal.timeout(12000)});
  if(!response.ok) return {signals:[],health:{ok:false,status:response.status,url}};
  const body=await safeJson(response); const resources=Array.isArray(body)?body:Array.isArray(body?.items)?body.items:Array.isArray(body?.resources)?body.resources:[];
  const signals=[];
  for(const resource of resources.slice(0,limit)){
    const accepted=Array.isArray(resource.accepts)?resource.accepts[0]:null;
    const rawUrl=String(resource.resource?.url||resource.resource||resource.url||''); if(!rawUrl)continue;
    signals.push(normalizeOpportunity('x402-bazaar',{externalId:rawUrl,title:resource.resource?.description||resource.description||rawUrl,url:rawUrl,priceUsd:Number(accepted?.amount||0)/1e6,network:accepted?.network||'',currency:accepted?.extra?.name||'USDC',tags:resource.resource?.tags||resource.tags||[],status:'available'},{claimMode:'buy',escrowed:false}));
  }
  return {signals,health:{ok:true,count:signals.length,url}};
}

async function discoverDealwork(env,credentials,limit){
  const key=String(env.DEALWORK_API_KEY||credentials?.dealwork?.apiKey||'');
  if(!key) return {signals:[],health:{ok:false,error:'dealwork_api_key_missing'}};
  const headers={accept:'application/json','user-agent':'AutonomOS/3.0',authorization:`Bearer ${key}`};
  const response=await fetch(`https://dealwork.ai/api/v1/jobs?per_page=${Math.min(50,limit)}&sort=newest`,{headers,signal:AbortSignal.timeout(12000)});
  const body=await safeJson(response); if(!response.ok) return {signals:[],health:{ok:false,status:response.status,error:body?.error?.message||body?.error||''}};
  const publicRows=Array.isArray(body?.data)?body.data:[];
  // dealwork exposes a dedicated authenticated matching feed. Merge it with the public
  // newest feed so AutonomOS prioritizes jobs the marketplace itself considers a fit
  // instead of relying only on chronological discovery. Failure here is non-fatal.
  let matchedRows=[]; let matchingOk=false;
  try{
    const matching=await fetch(`https://dealwork.ai/api/v1/jobs/matching?per_page=${Math.min(50,limit)}`,{headers,signal:AbortSignal.timeout(12000)});
    const matchingBody=await safeJson(matching);
    if(matching.ok){matchedRows=Array.isArray(matchingBody?.data)?matchingBody.data:Array.isArray(matchingBody?.data?.jobs)?matchingBody.data.jobs:[];matchingOk=true;}
  }catch{}
  const dedup=new Map();
  for(const row of [...matchedRows,...publicRows]){const id=String(row?.id||row?.jobId||row?._id||'');if(id&&!dedup.has(id))dedup.set(id,row);}
  const rows=[...dedup.values()];
  // P1 fix: jobMode:'open' jobs support instant claim, but jobMode:'bid' jobs — per
  // dealwork.ai's own published skill.md — are a real, documented, two-step flow (submit
  // a bid, wait for the buyer to accept it, THEN execute) and are usually the
  // higher-value jobs on this marketplace. They were filtered out entirely before because
  // that async wait didn't fit the claim→execute→deliver pipeline; they're now tagged
  // claimMode:'bid' and handled by a separate submit-then-poll path (see submitDealworkBid
  // / pollDealworkBids in runtime.js) instead of being discarded.
  const openRows=rows.filter(row=>!row.jobMode||row.jobMode==='open');
  const bidRows=rows.filter(row=>row.jobMode==='bid'&&row.biddingDeadline&&new Date(row.biddingDeadline).getTime()>Date.now());
  const openSignals=openRows.map(row=>normalizeOpportunity('dealwork',{...row,budgetUsd:Number(row.fixedPrice??row.budget_max??row.budgetMax??row.budget_min??0)},{feePercent:10,currency:'USD',network:'stripe',escrowed:true,claimMode:'automatic',status:row.status||'open'}));
  const bidSignals=bidRows.map(row=>normalizeOpportunity('dealwork',{...row,budgetUsd:Number(row.budgetMax??row.budget_max??row.budgetMin??row.budget_min??0)},{feePercent:10,currency:'USD',network:'stripe',escrowed:false,claimMode:'bid',status:row.status||'open'}));
  const signals=[...openSignals,...bidSignals];
  return {signals,health:{ok:true,count:signals.length,totalOpenJobs:rows.length,matchedJobs:matchedRows.length,matchingFeed:matchingOk,openMode:openSignals.length,bidMode:bidSignals.length}};
}

async function discoverClawlancer(env,credentials,limit){
  const key=String(env.CLAWLANCER_API_KEY||credentials?.clawlancer?.apiKey||'');
  const response=await fetch(`https://clawlancer.ai/api/listings?listing_type=BOUNTY&limit=${Math.min(100,limit)}`,{headers:{accept:'application/json','user-agent':'AutonomOS/2.0',...(key?{authorization:`Bearer ${key}`}:{})},signal:AbortSignal.timeout(12000)});
  const body=await safeJson(response); if(!response.ok) return {signals:[],health:{ok:false,status:response.status,error:body?.error||body?.message||''}};
  const rows=Array.isArray(body)?body:Array.isArray(body?.listings)?body.listings:Array.isArray(body?.data)?body.data:[];
  const signals=rows.map(raw=>normalizeOpportunity('clawlancer',{...raw,url:raw.url||`https://clawlancer.ai/listings/${raw.id||raw.listing_id||''}`},{feePercent:2.5,currency:'USDC',network:'eip155:8453',escrowed:true,claimMode:key?'automatic':'credentials_required'})).filter(x=>x.status==='open'||x.status==='active'||x.status==='available'||!x.status);
  return {signals:signals.slice(0,limit),health:{ok:true,count:signals.length,authenticated:Boolean(key)}};
}

async function discoverSuperteam(credentials,limit){
  const key=String(credentials?.superteam?.apiKey||'');
  if(!key) return {signals:[],health:{ok:false,error:'superteam_not_registered_yet'}};
  try{
    const response=await fetch(`https://superteam.fun/api/agents/listings/live?take=${Math.min(limit,50)}`,{headers:{accept:'application/json','user-agent':'AutonomOS/2.0',authorization:`Bearer ${key}`},signal:AbortSignal.timeout(15000)});
    const body=await safeJson(response);
    if(!response.ok) return {signals:[],health:{ok:false,status:response.status,error:body?.error||body?.message||''}};
    const rows=findArrayByKey(body,['listings','data','items','results']);
    const signals=rows.map(raw=>normalizeOpportunity('superteam',{
      id:raw.id||raw.slug||raw._id,
      title:raw.title||raw.name,
      description:raw.description||raw.summary||raw.requirements||raw.title,
      budgetUsd:raw.usdValue??raw.rewardInUsd??raw.reward??raw.rewardAmount??raw.compensationAmount??0,
      category:raw.type||raw.skills?.[0]||'research',
      url:raw.url||`https://superteam.fun/earn/listing/${raw.slug||raw.id||''}`,
      status:'open'
    },{feePercent:0,currency:'USDC',network:'Solana',escrowed:false,claimMode:'competitive_submission'}));
    return {signals,health:{ok:true,count:signals.length}};
  }catch(error){return {signals:[],health:{ok:false,error:String(error?.message||error).slice(0,180)}}}
}

function extractDeliverableLink(deliverable){
  const calls=deliverable?.evidence?.toolCalls;
  if(!Array.isArray(calls))return'';
  for(const call of calls){
    if(!call?.ok)continue;
    for(const artifact of (Array.isArray(call.artifacts)?call.artifacts:[])){
      const url=String(artifact?.url||'');
      if(artifact?.ok&&/^https?:\/\//i.test(url))return url;
    }
  }
  return'';
}

async function superteamAction(kind,opportunity,{env=process.env,credentials,deliverable,recordPendingClaim}={}){
  const cred=credentials?.superteam; const key=String(cred?.apiKey||''); if(!key)return{ok:false,reason:'superteam_api_key_missing'};
  // No escrow/reservation step exists on this platform — "claiming" is just proceeding
  // straight to a submission, so there is nothing to reserve here and no network call is
  // needed or possible; the actual work happens at 'deliver'.
  if(kind==='claim')return{ok:true,jobId:opportunity.externalId,transactionId:''};
  try{
    // Per superteam.fun/earn/agents: telegram is REQUIRED for project-type listings
    // (optional otherwise) and must be the human operator's own t.me/<username> URL —
    // an agent cannot supply this itself. Sending it on every submission is harmless
    // for non-project listings, so no listing-type branch is needed here.
    const telegram=String(env.SUPERTEAM_HUMAN_TELEGRAM||'').trim();
    const payload={listingId:opportunity.externalId,link:extractDeliverableLink(deliverable),tweet:'',otherInfo:String(deliverable.content||'').slice(0,3000),eligibilityAnswers:[],ask:null,...(telegram?{telegram}:{})};
    const response=await fetch('https://superteam.fun/api/agents/submissions/create',{method:'POST',headers:{'content-type':'application/json',accept:'application/json',authorization:`Bearer ${key}`,'user-agent':'AutonomOS/2.0'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
    const body=await safeJson(response);
    if(!response.ok)return{ok:false,reason:`http_${response.status}:${body?.error||body?.message||''}`.slice(0,200)};
    // This is the one marketplace where "delivered" genuinely does NOT mean "will be
    // paid soon" — Superteam judges submissions over days/weeks, and even a win pays out
    // to the human's own wallet only after they visit the claim URL below. Nothing about
    // this can be automated further (by design — see superteam.fun/skill.md), so the
    // dashboard needs to surface it clearly rather than implying it's handled.
    // Submission is not a win. Keep the claimCode private until the marketplace reports a win.
    return{ok:true,transactionId:opportunity.externalId,body,pendingHumanClaim:true};
  }catch(error){return{ok:false,reason:String(error?.message||error).slice(0,200)}}
}

async function discoverT2000(env,credentials,limit){
  const mcpUrl=String(env.T2000_MCP_URL||T2000_DEFAULT_MCP_URL);
  const token=t2000Token(env,credentials);
  if(!token) return {signals:[],health:{ok:false,connected:false,claimReady:false,error:'t2000_oauth_required'}};
  try{
    const client=new McpHttpClient({url:mcpUrl,token,timeoutMs:22000});
    await client.initialize();
    const tools=await client.listTools();
    const boardTool=tools.find(t=>t.name==='t2000_job_board');
    const inboxTool=tools.find(t=>t.name==='t2000_jobs');
    const signals=[];
    let openCount=0,sellerQueueCount=0;

    if(boardTool){
      // Fetch more than the first MCP page when the server supports offset/page cursors.
      // Several earlier builds always showed the same ~6 jobs because discovery stopped
      // after one tool call. We try conservative page shapes, dedupe by id, and stop when
      // the server repeats the same page (covers implementations that simply ignore offset).
      const openings=[]; const rawSeen=new Set(); const pageSize=Math.min(50,Math.max(10,limit));
      for(let page=0;page<Math.min(10,Math.ceil(limit/pageSize));page++){
        let payload=null;
        const offset=page*pageSize;
        const candidates=page===0?[{limit:pageSize},{limit:pageSize,offset:0},{page:1,limit:pageSize},{}]:[{limit:pageSize,offset},{page:page+1,limit:pageSize}];
        for(const args of candidates){try{payload=extractMcpToolPayload(await client.callTool(boardTool.name,args));if(payload)break}catch{}}
        const batch=findArrayByKey(payload,['jobs','openings','items','listings','data']);
        if(!batch.length)break;
        let added=0;
        for(const raw of batch){const id=String(raw?.id||raw?.openingId||raw?.opening_id||raw?.jobId||raw?.job_id||'');if(!id||rawSeen.has(id))continue;rawSeen.add(id);openings.push(raw);added++;if(openings.length>=limit)break;}
        if(openings.length>=limit||added===0||batch.length<pageSize)break;
      }
      const openSignals=openings.slice(0,limit).map(raw=>{
        const batchId=String(raw.batchId||raw.batch_id||'');
        const budgetUsd=t2000Amount(raw);
        return normalizeOpportunity('t2000',{
          ...raw,
          externalId:raw.id||raw.openingId||raw.opening_id||raw.jobId||raw.job_id,
          title:raw.title||raw.briefPreview||raw.brief_preview||raw.serviceName||'t2000 Open Job',
          description:raw.briefPreview||raw.brief_preview||raw.brief||raw.description||raw.title||'t2000 Open Job',
          budgetUsd,
          status:'open',
          claimMode:batchId?'automatic_mcp_batch':'automatic_mcp',
          t2000BatchId:batchId,
          url:raw.url||'https://t2000.ai/jobs'
        },{feePercent:5,currency:'USDC',network:'Sui',escrowed:true,claimMode:batchId?'automatic_mcp_batch':'automatic_mcp'});
      }).filter(x=>x.externalId);
      signals.push(...openSignals); openCount=openSignals.length;
    }

    // A Service bought from our existing t2000 seller profile does NOT appear on the
    // public Open Job board. The documented seller delivery queue is t2000_jobs with
    // needsOnly:true + role:'seller'. These jobs are already assigned/funded, so runtime
    // must execute them directly instead of attempting a second claim.
    if(inboxTool){
      let payload=null;
      for(const args of [{needsOnly:true,role:'seller'},{role:'seller',needsOnly:true}]){
        try{payload=extractMcpToolPayload(await client.callTool(inboxTool.name,args));if(payload)break}catch{}
      }
      const jobs=findArrayByKey(payload,['jobs','items','data','queue','matching']);
      const sellerSignals=jobs.slice(0,limit).map(raw=>normalizeOpportunity('t2000',{
        ...raw,
        externalId:raw.jobId||raw.job_id||raw.id,
        title:raw.title||raw.serviceName||raw.service_name||raw.listingName||raw.listing_name||'t2000 paid Service order',
        description:raw.briefPreview||raw.brief_preview||raw.brief||raw.requirements||raw.description||'Paid t2000 Service order. Fetch the complete work order with t2000_job_status before execution.',
        budgetUsd:t2000Amount(raw),
        status:'available',
        claimMode:'already_assigned',
        t2000OriginalStatus:String(raw.status||raw.state||''),
        url:raw.url||'https://t2000.ai/manage/jobs'
      },{feePercent:5,currency:'USDC',network:'Sui',escrowed:true,claimMode:'already_assigned',status:'available'})).filter(x=>x.externalId);
      signals.push(...sellerSignals); sellerQueueCount=sellerSignals.length;
    }

    return {signals,health:{ok:true,connected:true,claimReady:Boolean(boardTool),deliveryQueueReady:Boolean(inboxTool),openCount,sellerQueueCount,tools:tools.map(t=>t.name).filter(n=>n.startsWith('t2000_')).slice(0,60)}};
  }catch(error){return{signals:[],health:{ok:false,connected:false,claimReady:false,error:String(error?.message||error).slice(0,220)}}}
}

async function t2000Action(kind,opportunity,{env,credentials,claim,deliverable}={}){
  const mcpUrl=String(env.T2000_MCP_URL||T2000_DEFAULT_MCP_URL);
  const token=t2000Token(env,credentials);
  if(!token)return{ok:false,reason:'t2000_oauth_required'};
  try{
    const client=new McpHttpClient({url:mcpUrl,token,timeoutMs:22000}); await client.initialize(); const tools=await client.listTools();
    const ext=String(opportunity.externalId||'');
    if(kind==='claim'){
      let claimed=null,claimToolName='already_assigned';
      // Direct Service orders are already buyer-funded and assigned to this Passport.
      // Claiming them again is incorrect; simply fetch their work order and execute.
      if(opportunity.claimMode!=='already_assigned'){
        const batchId=String(opportunity.raw?.t2000BatchId||opportunity.raw?.batchId||opportunity.raw?.batch_id||'');
        const claimTool=opportunity.claimMode==='automatic_mcp_batch'
          ? tools.find(t=>t.name==='t2000_job_batch_claim')
          : tools.find(t=>t.name==='t2000_job_claim');
        if(!claimTool)return{ok:false,reason:opportunity.claimMode==='automatic_mcp_batch'?'t2000_batch_claim_tool_not_found':'t2000_claim_tool_not_found',tools:tools.map(t=>t.name).slice(0,40)};
        claimToolName=claimTool.name;
        const claimCandidates=opportunity.claimMode==='automatic_mcp_batch'
          ? [{batchId},{batch_id:batchId},{id:batchId}]
          : [{openingId:ext},{id:ext},{opening_id:ext},{jobId:ext}];
        let last='';
        const selectedClaims=selectMcpArguments(claimTool?.inputSchema||claimTool?.parameters||null,claimCandidates);
        if(!selectedClaims.length)return{ok:false,reason:'t2000_claim_schema_not_supported'};
        for(const args of selectedClaims.slice(0,2)){
          if(Object.values(args).every(v=>!String(v||'')))continue;
          try{claimed=extractMcpToolPayload(await client.callTool(claimTool.name,args));if(claimed)break}catch(error){last=String(error?.message||error)}
        }
        if(!claimed)return{ok:false,reason:last.slice(0,220)||'t2000_claim_failed'};
      }
      const jobId=String(claimed?.jobId||claimed?.job_id||claimed?.id||ext);
      const statusTool=tools.find(t=>t.name==='t2000_job_status');
      if(!statusTool)return{ok:false,reason:'t2000_job_status_tool_not_found'};
      let jobStatus=null,lastStatus='';
      for(const args of [{jobId},{job_id:jobId},{id:jobId}]){
        try{jobStatus=extractMcpToolPayload(await client.callTool(statusTool.name,args));if(jobStatus)break}catch(error){lastStatus=String(error?.message||error)}
      }
      if(!jobStatus)return{ok:false,reason:lastStatus.slice(0,220)||'t2000_work_order_unavailable'};
      const workOrder=jobStatus?.workOrder||jobStatus?.work_order||jobStatus;
      return{ok:true,tool:claimToolName,jobId,transactionId:String(claimed?.transactionId||claimed?.tx||claimed?.digest||''),body:claimed||jobStatus,workOrder,workOrderMissing:!workOrder,alreadyAssigned:opportunity.claimMode==='already_assigned'};
    }
    const deliverTool=tools.find(t=>t.name==='t2000_job_deliver');
    if(!deliverTool)return{ok:false,reason:'t2000_deliver_tool_not_found',tools:tools.map(t=>t.name).slice(0,40)};
    const jobId=String(claim?.jobId||ext);
    const body=String(deliverable?.content||'');
    const bytes=Buffer.byteLength(body,'utf8');
    if(bytes>16*1024)return{ok:false,reason:`t2000_delivery_body_over_16kib:${bytes}`};
    // Current t2000 docs define the delivery itself as the body string. Keep small
    // backward-compatible fallbacks after the documented body shape in case their live
    // tool schema names the field differently; tools/call will reject invalid shapes.
    const candidateSet=[{jobId,body},{jobId,delivery:body},{jobId,deliverable:body},{job_id:jobId,body}];
    const candidates=selectMcpArguments(deliverTool?.inputSchema || deliverTool?.parameters || null,candidateSet);
    if (!candidates.length) return {ok:false,reason:'t2000_delivery_schema_not_supported',tool:deliverTool.name};
    let last='';
    for(const args of candidates.slice(0,2)){
      try{const result=extractMcpToolPayload(await client.callTool(deliverTool.name,args));return{ok:true,tool:deliverTool.name,jobId:String(result?.jobId||result?.job_id||result?.id||jobId),transactionId:String(result?.transactionId||result?.tx||result?.digest||''),body:result}}catch(error){last=String(error?.message||error)}
    }
    return{ok:false,reason:last.slice(0,220)||'t2000_deliver_failed'};
  }catch(error){return{ok:false,reason:String(error?.message||error).slice(0,240)}}
}


function selectMcpArguments(schema,candidates=[]){
  if(!schema||typeof schema!=='object') return candidates.slice(0,1);
  const props=Array.isArray(schema?.properties)?schema.properties:Object.keys(schema?.properties||{});
  const required=new Set(Array.isArray(schema?.required)?schema.required:[]);
  return candidates.filter(args=>{
    const keys=Object.keys(args||{});
    if(props.length && keys.some(k=>!props.includes(k))) return false;
    for(const key of required) if(args?.[key]===undefined||args?.[key]===null||args?.[key]==='') return false;
    return true;
  });
}

function t2000Token(_env,credentials){return String(credentials?.t2000?.accessToken||'').trim();}
export function t2000Amount(raw={}){
  // Only accept fields whose units are explicit or are part of the documented t2000
  // USD/USDC payloads. Never infer units from magnitude.
  const explicit=[
    ['sellerPayoutUsdc',raw.sellerPayoutUsdc],['seller_payout_usdc',raw.seller_payout_usdc],
    ['payoutUsdc',raw.payoutUsdc],['payout_usdc',raw.payout_usdc],
    ['maxUsdc',raw.maxUsdc],['max_usdc',raw.max_usdc],['minUsdc',raw.minUsdc],['min_usdc',raw.min_usdc],
    ['priceUsdc',raw.priceUsdc],['price_usdc',raw.price_usdc],['budgetUsdc',raw.budgetUsdc],['budget_usdc',raw.budget_usdc],
    ['rewardUsdc',raw.rewardUsdc],['reward_usdc',raw.reward_usdc],
    ['budgetUsd',raw.budgetUsd],['priceUsd',raw.priceUsd],['amountUsd',raw.amountUsd],['rewardUsd',raw.rewardUsd],
    ['budget',raw.budget],['price',raw.price],['reward',raw.reward]
  ];
  for(const [,value] of explicit){const n=Number(value);if(Number.isFinite(n)&&n>=0)return n;}
  const atomic=[['amount_usdc_atomic',raw.amount_usdc_atomic],['amountAtomic',raw.amountAtomic],['amount_atomic',raw.amount_atomic],['price_usdc_atomic',raw.price_usdc_atomic],['reward_usdc_atomic',raw.reward_usdc_atomic]];
  for(const [,value] of atomic){const n=Number(value);if(Number.isFinite(n)&&n>=0)return n/1e6;}
  return 0;
}

function findArrayByKey(value,keys,depth=0){
  if(depth>5||value==null)return[]; if(Array.isArray(value))return value;
  if(typeof value!=='object')return[];
  for(const key of keys)if(Array.isArray(value[key]))return value[key];
  for(const child of Object.values(value)){const found=findArrayByKey(child,keys,depth+1);if(found.length)return found;}
  return[];
}

async function clawlancerAction(kind,opportunity,{env,credentials,claim,deliverable}){
  const key=String(env.CLAWLANCER_API_KEY||credentials?.clawlancer?.apiKey||''); if(!key)return{ok:false,reason:'clawlancer_api_key_missing'};
  try{
    if(kind==='claim'){
      const agentId=String(credentials?.clawlancer?.agentId||'');
      const r=await fetch(`https://clawlancer.ai/api/listings/${encodeURIComponent(opportunity.externalId)}/claim`,{method:'POST',headers:{...auth(key),'content-type':'application/json'},body:JSON.stringify(agentId?{agent_id:agentId}:{}),signal:AbortSignal.timeout(20000)}); const body=await safeJson(r);
      return r.ok?{ok:true,transactionId:String(body.transaction_id||body.transactionId||body.id||body.transaction?.id||''),body}:{ok:false,reason:`http_${r.status}`,body};
    }
    const txId=String(claim?.transactionId||claim?.body?.transaction_id||claim?.body?.transaction?.id||''); if(!txId)return{ok:false,reason:'transaction_id_missing_after_claim'};
    const payload={deliverable:deliverable.content,content:deliverable.content,format:deliverable.format,evidence:deliverable.evidence||{},proof_hash:deliverable.hash};
    const r=await fetch(`https://clawlancer.ai/api/transactions/${encodeURIComponent(txId)}/deliver`,{method:'POST',headers:{...auth(key),'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)}); const body=await safeJson(r);
    return r.ok?{ok:true,transactionId:txId,body}:{ok:false,reason:`http_${r.status}`,body};
  }catch(error){return{ok:false,reason:String(error?.message||error).slice(0,200)}}
}

async function dealworkAction(kind,opportunity,{env,credentials,claim,deliverable}={}){
  const key=String(env.DEALWORK_API_KEY||credentials?.dealwork?.apiKey||''); if(!key)return{ok:false,reason:'dealwork_api_key_missing'};
  const headers={...auth(key),'content-type':'application/json'};
  try{
    if(kind==='claim'){
      const criteriaIds=Array.isArray(opportunity.raw?.acceptanceCriteria)?opportunity.raw.acceptanceCriteria.map(c=>c?.id).filter(Boolean):[];
      const claimResp=await fetch(`https://dealwork.ai/api/v1/jobs/${encodeURIComponent(opportunity.externalId)}/claim`,{method:'POST',headers,body:JSON.stringify({acceptedCriteriaIds:criteriaIds}),signal:AbortSignal.timeout(20000)});
      const claimBody=await safeJson(claimResp); if(!claimResp.ok)return{ok:false,reason:`http_${claimResp.status}:${claimBody?.error?.code||''}:${String(claimBody?.error?.message||'').slice(0,120)}`,body:claimBody};
      const contract=claimBody?.data?.contract||claimBody?.contract||claimBody?.data;
      const contractId=String(contract?.id||''); if(!contractId)return{ok:false,reason:'dealwork_claim_missing_contract_id',body:claimBody};
      // Platform's own rule: "Never work before escrow locks. Verify contract state is
      // escrow_locked before START_WORK." Claiming an open task locks escrow immediately,
      // so this should always be safe, but we still check the returned state defensively.
      if(contract?.state&&contract.state!=='escrow_locked')return{ok:false,reason:`dealwork_unexpected_state:${contract.state}`,body:claimBody};
      const startResp=await fetch(`https://dealwork.ai/api/v1/contracts/${encodeURIComponent(contractId)}/events`,{method:'POST',headers,body:JSON.stringify({type:'START_WORK'}),signal:AbortSignal.timeout(15000)});
      const startBody=await safeJson(startResp); if(!startResp.ok)return{ok:false,reason:`dealwork_start_work_http_${startResp.status}`,body:startBody};
      return{ok:true,jobId:contractId,transactionId:'',body:startBody};
    }
    const contractId=claim?.jobId; if(!contractId)return{ok:false,reason:'dealwork_missing_contract_id'};
    const deliverableResp=await fetch(`https://dealwork.ai/api/v1/contracts/${encodeURIComponent(contractId)}/deliverables`,{method:'POST',headers,body:JSON.stringify({description:opportunity.title||'Completed task',outputData:{result:deliverable.content,format:deliverable.format||'text/markdown'}}),signal:AbortSignal.timeout(20000)});
    const deliverableBody=await safeJson(deliverableResp); if(!deliverableResp.ok)return{ok:false,reason:`dealwork_deliverable_http_${deliverableResp.status}`,body:deliverableBody};
    const deliverableId=String(deliverableBody?.data?.id||deliverableBody?.id||''); if(!deliverableId)return{ok:false,reason:'dealwork_deliverable_missing_id',body:deliverableBody};
    const submitResp=await fetch(`https://dealwork.ai/api/v1/contracts/${encodeURIComponent(contractId)}/events`,{method:'POST',headers,body:JSON.stringify({type:'SUBMIT_WORK',deliverableId}),signal:AbortSignal.timeout(15000)});
    const submitBody=await safeJson(submitResp); if(!submitResp.ok)return{ok:false,reason:`dealwork_submit_work_http_${submitResp.status}`,body:submitBody};
    // NOTE: this moves the contract to in_review, not paid. The buyer (human or agent) must
    // APPROVE — or it auto-approves after 24h. Real revenue is only recorded once
    // syncMarketplaceTransactions sees the contract in a 'paid' state (see below).
    return{ok:true,jobId:contractId,transactionId:contractId,body:submitBody,pendingReview:true};
  }catch(error){return{ok:false,reason:String(error?.message||error).slice(0,220)}}
}

function auth(key){return{accept:'application/json','user-agent':'AutonomOS/2.0',authorization:`Bearer ${key}`}}
async function safeJson(response){try{return await response.json()}catch{return{}}}

// P1 fix: submit-then-wait implementation of dealwork.ai's documented bid flow (see
// skill.md: POST /jobs/{id}/bids -> wait for buyer -> GET /bids/mine to see acceptance ->
// contract already exists in escrow_locked -> START_WORK -> execute -> deliver). We bid at
// the job's own budgetMax since we have no competitive-pricing intelligence — this is a
// deliberately simple default, not a strategy; our own profit-engine economics check
// (already run before this is ever called, same as any other candidate) is what decides
// whether that price is even worth bidding at.
export async function submitDealworkBid(opportunity,{env=process.env,credentials={}}={}){
  const key=String(env.DEALWORK_API_KEY||credentials?.dealwork?.apiKey||''); if(!key)return{ok:false,reason:'dealwork_api_key_missing'};
  const headers={...auth(key),'content-type':'application/json'};
  const proposedAmount=Number(opportunity.budgetUsd||0).toFixed(2);
  const proposalText=String(`Automated proposal for "${opportunity.title}". Approach: analyze the requirements, produce the deliverable directly matching the stated acceptance criteria, and submit for review. Estimated turnaround: under 1 hour.`).slice(0,900);
  try{
    const response=await fetch(`https://dealwork.ai/api/v1/jobs/${encodeURIComponent(opportunity.externalId)}/bids`,{method:'POST',headers,body:JSON.stringify({proposedAmount,estimatedHours:1,proposalText}),signal:AbortSignal.timeout(15000)});
    const body=await safeJson(response);
    if(!response.ok)return{ok:false,reason:`http_${response.status}:${body?.error?.code||''}:${String(body?.error?.message||'').slice(0,120)}`};
    const bidId=String(body?.data?.id||body?.id||''); if(!bidId)return{ok:false,reason:'dealwork_bid_missing_id'};
    return{ok:true,bidId};
  }catch(error){return{ok:false,reason:String(error?.message||error).slice(0,200)}}
}

// Polls our own outstanding bids and reports which ones the buyer has acted on. Does NOT
// execute or deliver anything itself — runtime.js owns that, the same way it already owns
// execution for every other marketplace, so LLM/tool-cost accounting and Emergency Stop
// wiring stay in one place instead of being duplicated per-connector.
export async function checkDealworkBidStatus(bidId,{env=process.env,credentials={}}={}){
  const key=String(env.DEALWORK_API_KEY||credentials?.dealwork?.apiKey||''); if(!key)return{ok:false,reason:'dealwork_api_key_missing'};
  try{
    const response=await fetch(`https://dealwork.ai/api/v1/bids/mine?per_page=50`,{headers:auth(key),signal:AbortSignal.timeout(12000)});
    const body=await safeJson(response); if(!response.ok)return{ok:false,reason:`http_${response.status}`};
    const rows=Array.isArray(body?.data)?body.data:[];
    const bid=rows.find(b=>String(b?.id||'')===bidId);
    if(!bid)return{ok:true,status:'not_found'};
    return{ok:true,status:String(bid.status||'pending'),contractId:String(bid.contractId||bid.contract?.id||'')};
  }catch(error){return{ok:false,reason:String(error?.message||error).slice(0,200)}}
}

// Once a bid is accepted, dealwork.ai has already created the contract in escrow_locked —
// there is no separate "claim" call for bid-mode (unlike open-mode's /jobs/{id}/claim).
// This does the same START_WORK the open-mode claim path already does, just against an
// existing contract instead of a freshly-claimed one.
export async function startDealworkContract(contractId,{env=process.env,credentials={}}={}){
  const key=String(env.DEALWORK_API_KEY||credentials?.dealwork?.apiKey||''); if(!key)return{ok:false,reason:'dealwork_api_key_missing'};
  const headers={...auth(key),'content-type':'application/json'};
  try{
    const response=await fetch(`https://dealwork.ai/api/v1/contracts/${encodeURIComponent(contractId)}/events`,{method:'POST',headers,body:JSON.stringify({type:'START_WORK'}),signal:AbortSignal.timeout(15000)});
    const body=await safeJson(response); if(!response.ok)return{ok:false,reason:`http_${response.status}`};
    return{ok:true,body};
  }catch(error){return{ok:false,reason:String(error?.message||error).slice(0,200)}}
}

function dedupe(rows){const seen=new Set();return rows.filter(row=>{const key=`${row.source}:${row.externalId}`;if(seen.has(key))return false;seen.add(key);return true})}
export function connectorDefinitions(){return CONNECTOR_DEFS.map(x=>({...x}));}
export async function discoverPublicSignals(args){return discoverMarketOpportunities(args);}

export async function syncMarketplaceTransactions({env=process.env,credentials={}}={}) {
  const rows=[]; const health={};
  const key=String(env.CLAWLANCER_API_KEY||credentials?.clawlancer?.apiKey||'');
  if(key){
    try{
      const r=await fetch('https://clawlancer.ai/api/transactions',{headers:auth(key),signal:AbortSignal.timeout(12000)});
      const body=await safeJson(r); const txs=Array.isArray(body)?body:Array.isArray(body?.transactions)?body.transactions:Array.isArray(body?.data)?body.data:[];
      if(r.ok){
        for(const tx of txs.slice(0,100)){
          const status=String(tx.status||tx.state||'').toLowerCase();
          const explicitUsd=tx.amountUsd??tx.priceUsd??tx.rewardUsd;
          const explicitUsdc=tx.amountUsdc??tx.priceUsdc??tx.rewardUsdc;
          const atomic=tx.amount_usdc_wei??tx.price_wei??tx.amount_wei??tx.amount_usdc_atomic;
          const rawAmount=explicitUsd!=null?Number(explicitUsd):explicitUsdc!=null?Number(explicitUsdc):atomic!=null?Number(atomic)/1e6:0;
          const amountUsd=Number.isFinite(rawAmount)&&rawAmount>=0?rawAmount:0;
          rows.push({source:'clawlancer',externalTransactionId:String(tx.id||tx.transaction_id||tx.tx_id||''),listingId:String(tx.listing_id||tx.listingId||''),status,amountUsd,currency:'USDC',network:'eip155:8453',payoutAddress:String(tx.payout_address||tx.wallet_address||''),raw:tx});
        }
        health.clawlancer={ok:true,count:rows.length};
      } else health.clawlancer={ok:false,status:r.status,error:body?.error||body?.message||''};
    }catch(error){health.clawlancer={ok:false,error:String(error?.message||error).slice(0,180)}}
  }
  const dwKey=String(env.DEALWORK_API_KEY||credentials?.dealwork?.apiKey||'');
  if(dwKey){
    try{
      const r=await fetch('https://dealwork.ai/api/v1/contracts?role=worker&state=paid&per_page=50',{headers:auth(dwKey),signal:AbortSignal.timeout(12000)});
      const body=await safeJson(r); const contracts=Array.isArray(body?.data)?body.data:[];
      if(r.ok){
        for(const c of contracts){
          rows.push({source:'dealwork',externalTransactionId:String(c.id||''),listingId:String(c.jobId||''),status:'paid',amountUsd:Number(c.amount||0),currency:'USD',network:'stripe',payoutAddress:'',raw:c});
        }
        health.dealwork={ok:true,count:contracts.length};
      } else health.dealwork={ok:false,status:r.status,error:body?.error?.message||body?.error||''};
    }catch(error){health.dealwork={ok:false,error:String(error?.message||error).slice(0,180)}}
  }
  // t2000 settlement sync uses the documented read-only seller job inbox. Never pick a
  // tool heuristically by a word like "payment": financial connectors must only call a
  // known read tool here. Settled seller jobs are de-duplicated by job id in runtime.
  const t2000Url=String(env.T2000_MCP_URL||T2000_DEFAULT_MCP_URL),t2000TokenValue=t2000Token(env,credentials);
  if(t2000TokenValue){
    try{
      const client=new McpHttpClient({url:t2000Url,token:t2000TokenValue,timeoutMs:18000}); await client.initialize(); const tools=await client.listTools();
      const jobsTool=tools.find(t=>t.name==='t2000_jobs');
      if(jobsTool){
        const payload=extractMcpToolPayload(await client.callTool(jobsTool.name,{role:'seller'}));
        const jobs=findArrayByKey(payload,['jobs','items','data','queue','matching']);
        let mapped=0;
        for(const job of jobs.slice(0,150)){
          const status=String(job.status||job.state||'').toLowerCase();
          if(!['settled','released','completed','paid'].includes(status))continue;
          const jobId=String(job.jobId||job.job_id||job.id||'');
          const amountUsd=t2000Amount(job);
          if(!jobId||amountUsd<=0)continue;
          rows.push({source:'t2000',externalTransactionId:jobId,listingId:jobId,status,amountUsd,currency:'USDC',network:'Sui',payoutAddress:String(job.sellerAddress||job.seller_address||''),raw:job});mapped++;
        }
        health.t2000={ok:true,connected:true,count:jobs.length,settledMapped:mapped,tool:jobsTool.name};
      } else health.t2000={ok:false,connected:true,error:'t2000_jobs_tool_not_found',tools:tools.map(t=>t.name).slice(0,40)};
    }catch(error){health.t2000={ok:false,connected:false,error:String(error?.message||error).slice(0,180)}}
  }
  return {transactions:rows,health};
}
