import { McpHttpClient, extractMcpToolPayload } from '../mcp-client.js';
import { normalizeOpportunity } from '../job-normalizer.js';
import { isEvmAddress as isEvmAddressLike } from '../treasury.js';

const CONNECTOR_DEFS = Object.freeze([
  {id:'agenthansa',name:'AgentHansa',kind:'competitive-jobs',description:'Shared rewards and quests.',requiredEnv:['AGENTHANSA_API_KEY']},
  {id:'taskbounty',name:'TaskBounty',kind:'competitive-jobs',description:'Verified coding bounties.',requiredEnv:['TASKBOUNTY_API_KEY','TASKBOUNTY_AGENT_ID']},
  { id:'x402-bazaar', name:'x402 / Bazaar', kind:'seller+discovery', description:'Machine-payable API discovery and seller rail.', requiredEnv:[] },
  { id:'clawlancer', name:'Clawlancer', kind:'jobs', description:'Pre-funded Base/USDC bounties: discover → claim → deliver → paid.', requiredEnv:[], optionalEnv:['CLAWLANCER_API_KEY','CLAWLANCER_AGENT_ID'] },
  { id:'dealwork', name:'dealwork.ai', kind:'jobs', description:'Human+AI hybrid marketplace, USD via Stripe escrow, open-task instant claim.', requiredEnv:[], optionalEnv:['DEALWORK_API_KEY','DEALWORK_AGENT_ID'] },
  // Real bounties run $500-$1500+ USDC/SOL — a different tier from Clawlancer's mostly-$0.01
  // test listings. No escrow lock: it's a competitive submission a human sponsor judges,
  // and payout requires a HUMAN to visit a claim URL with their own wallet (agents can't
  // hold/sign for themselves here) — see claimUrl surfaced in state.pendingHumanClaims.
  { id:'workprotocol', name:'WorkProtocol', kind:'jobs', description:'Verified work exchange with Base/USDC escrow: discover → claim → deliver → verified → payment released.', requiredEnv:['WORKPROTOCOL_API_KEY','WORKPROTOCOL_AGENT_ID'], optionalEnv:['WORKPROTOCOL_API_URL'] },
  // The remaining sources are intentionally feed-gated: we never invent undocumented
  // claim endpoints or pretend a human-first marketplace is autonomously claimable.
  // P1 fix: Firecrawl/E2B previously had no entry here at all, so the dashboard could show
  // a fully green AutonomOS while one or both tool keys were missing, unauthorized, or
  // dropped — job-executor would then silently run with fewer tools than the operator
  // assumed. These follow the same requiredEnv-presence pattern as the other simple
  // connectors below; it confirms the key is SET, not that Firecrawl/E2B have accepted it
  // or that the account has remaining quota (that requires a live, billable call this
  // audit intentionally avoids making just to render a status dot).
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
    if (def.id === 'workprotocol') {
      const hasKey=Boolean(String(env.WORKPROTOCOL_API_KEY||'').trim());
      const hasAgent=Boolean(String(env.WORKPROTOCOL_AGENT_ID||'').trim());
      const configured=hasKey&&hasAgent;
      return { ...def, status:configured?'ready':'needs_credentials', configured, missing:[...(!hasKey?['WORKPROTOCOL_API_KEY']:[]),...(!hasAgent?['WORKPROTOCOL_AGENT_ID']:[])], mode:'instant_escrow_claim' };
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
      const response=await fetch('https://clawlancer.ai/api/agents/register',{method:'POST',headers:{'content-type':'application/json','accept':'application/json','user-agent':'AutonomOS/7.7'},body:JSON.stringify(registerBody),signal:AbortSignal.timeout(15000)});
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
    const agentId=String(env.CLAWLANCER_AGENT_ID||existing.agentId||'').trim();
    const walletMatches=String(existing.walletAddress||'').toLowerCase()===ownerWallet.toLowerCase();
    const lastFixAttempt=Date.parse(String(existing.walletFixLastAttemptAt||0));
    const retryWalletFix=!Number.isFinite(lastFixAttempt)||Date.now()-lastFixAttempt>=60*60_000;
    if (key && agentId && !walletMatches && retryWalletFix) {
      try {
        // Clawlancer's published API exposes PATCH /api/agents/{id}; do not rely on an
        // undocumented /agents/me alias for a payout-critical operation. Failed wallet
        // repairs are retried after a one-hour cooldown instead of being suppressed forever.
        const response=await fetch(`https://clawlancer.ai/api/agents/${encodeURIComponent(agentId)}`,{method:'PATCH',headers:{'content-type':'application/json',accept:'application/json',authorization:`Bearer ${key}`,'user-agent':'AutonomOS/7.7'},body:JSON.stringify({wallet_address:ownerWallet}),signal:AbortSignal.timeout(15000)});
        const body=await safeJson(response);
        const updated={...existing,agentId,walletFixLastAttemptAt:new Date().toISOString()};
        if (response.ok) { updated.walletAddress=ownerWallet; updated.walletVerifiedAt=new Date().toISOString(); delete updated.walletFixLastError; }
        else updated.walletFixLastError=String(body?.error||body?.message||`http_${response.status}`).slice(0,180);
        storeCredential('clawlancer',updated); credentials.clawlancer=updated;
        health.clawlancer={ok:response.ok,walletUpdated:response.ok,status:response.ok?undefined:response.status,detail:response.ok?undefined:(body?.error||body?.message||'')};
      } catch(error){
        const updated={...existing,agentId,walletFixLastAttemptAt:new Date().toISOString(),walletFixLastError:String(error?.message||error).slice(0,180)};
        storeCredential('clawlancer',updated); credentials.clawlancer=updated;
        health.clawlancer={ok:false,error:updated.walletFixLastError};
      }
    }
  }
  if (!String(env.DEALWORK_API_KEY||credentials?.dealwork?.apiKey||'').trim()) {
    try {
      // identityKey must be stable across restarts/redeploys — the docs warn that onboarding
      // without one creates a NEW duplicate agent account every time credentials are lost.
      // Base it on the owner wallet (stable, unique to this deployment) rather than a random value.
      const identityKey=`autonomos-${String(env.AUTONOMOS_OWNER_WALLET||env.AUTONOMOS_AGENT_NAME||'default').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,64)||'autonomos-default'}`;
      const response=await fetch('https://dealwork.ai/api/v1/agents/onboard',{method:'POST',headers:{'content-type':'application/json','accept':'application/json','user-agent':'AutonomOS/7.7'},body:JSON.stringify({autonomous:true,agentName:String(env.AUTONOMOS_AGENT_NAME||'AutonomOS').slice(0,48),description:'Autonomous digital-services worker: public web research, data extraction, structured writing, translation and QA. Typical turnaround: minutes.',capabilityTags:['research','writing','data','translation','automation'],identityKey}),signal:AbortSignal.timeout(15000)});
      const body=await safeJson(response);
      const data=body?.data||body;
      if (response.ok && data?.apiKey) {
        const value={ apiKey:String(data.apiKey), agentAccountId:String(data.agentAccountId||''), hmacSecret:String(data.hmacSecret||''), createdAt:new Date().toISOString(), source:data.recovered?'recovered':'auto_registration' };
        storeCredential('dealwork',value); credentials.dealwork=value;
        health.dealwork={ok:true,bootstrapped:true,recovered:Boolean(data.recovered),agentAccountId:value.agentAccountId};
      } else health.dealwork={ok:false,error:response.ok?'onboard_response_missing_api_key':`http_${response.status}`,detail:data?.error?.message||body?.error||''};
    } catch(error){ health.dealwork={ok:false,error:String(error?.message||error).slice(0,180)}; }
  }
  // is a single POST returning an apiKey + a claimCode. The claimCode is NOT a secret to
  // protect like an API key — it's meant to be handed to the human owner so THEY can claim
  // payouts (agents never hold funds here: "Agents do not complete OAuth, wallet signing,
  // or KYC"). We store it so the dashboard can show the owner exactly which URL to visit.
  if (!credentials?.superteam?.apiKey) {
    try {
      const response=await fetch('https://superteam.fun/api/agents',{method:'POST',headers:{'content-type':'application/json','accept':'application/json','user-agent':'AutonomOS/7.7'},body:JSON.stringify({name:String(env.AUTONOMOS_AGENT_NAME||'AutonomOS').slice(0,48)}),signal:AbortSignal.timeout(15000)});
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
    ['workprotocol',()=>discoverWorkProtocol(env,limit)],
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
  if (opportunity.source==='workprotocol') return workProtocolAction('claim',opportunity,{env});
  return {ok:false,reason:'connector_claim_not_available'};
}

export async function deliverMarketplaceJob(opportunity,claim,deliverable,{env=process.env,credentials={},recordPendingClaim}={}) {
  if (opportunity.source==='clawlancer') return clawlancerAction('deliver',opportunity,{env,credentials,claim,deliverable});
  if (opportunity.source==='dealwork') return dealworkAction('deliver',opportunity,{env,credentials,claim,deliverable});
  if (opportunity.source==='workprotocol') return workProtocolAction('deliver',opportunity,{env,claim,deliverable});
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
  const wpKey=String(env.WORKPROTOCOL_API_KEY||'').trim();
  const wpAgentId=String(env.WORKPROTOCOL_AGENT_ID||'').trim();
  if(wpKey&&wpAgentId){
    try{
      const base=String(env.WORKPROTOCOL_API_URL||'https://workprotocol.ai').replace(/\/$/,'');
      const r=await fetch(`${base}/api/agents/${encodeURIComponent(wpAgentId)}`,{headers:auth(wpKey),signal:AbortSignal.timeout(12000)});
      const body=await safeJson(r);
      const agent=body?.agent||body?.data?.agent||body?.data||body;
      out.workprotocol={
        ok:r.ok,
        network:'Base',
        address:String(agent?.walletAddress||agent?.wallet_address||agent?.payment?.walletAddress||agent?.payment?.wallet_address||''),
        agentId:wpAgentId,
        ...(r.ok?{}:{error:String(body?.error||body?.message||`http_${r.status}`).slice(0,180)})
      };
    }catch(error){out.workprotocol={ok:false,error:String(error?.message||error).slice(0,180),agentId:wpAgentId}}
  }
  return out;
}

async function discoverWorkProtocol(env,limit){
  const key=String(env.WORKPROTOCOL_API_KEY||'').trim();
  const agentId=String(env.WORKPROTOCOL_AGENT_ID||'').trim();
  const base=String(env.WORKPROTOCOL_API_URL||'https://workprotocol.ai').replace(/\/$/,'');
  try{
    const url=`${base}/api/jobs?status=open&min_pay=0.5&sort=newest&limit=${Math.min(100,limit)}&offset=0`;
    const r=await fetch(url,{headers:auth(key),signal:AbortSignal.timeout(15000)});
    const body=await safeJson(r);
    if(!r.ok)return{signals:[],health:{ok:false,status:r.status,error:body?.error||body?.message||'workprotocol_discovery_failed'}};
    const rows=Array.isArray(body?.jobs)?body.jobs:Array.isArray(body?.data?.jobs)?body.data.jobs:Array.isArray(body?.data)?body.data:[];
    const signals=rows.map(raw=>normalizeOpportunity('workprotocol',{
      ...raw,
      id:raw.id||raw.jobId,
      title:raw.title||raw.name,
      description:raw.description||raw.instructions||raw.title,
      category:raw.category||'general',
      budgetUsd:Number(raw.paymentAmount??raw.amount??raw.reward??0),
      currency:String(raw.paymentCurrency||raw.currency||'USDC').toUpperCase(),
      network:String(raw.paymentRail||raw.network||'base'),
      escrowed:true,
      claimMode:'automatic',
      status:raw.status||'open',
      deadline:raw.deadline||'',
      url:raw.jobUrl||raw.url||`${base}/jobs/${raw.id||raw.jobId||''}`,
      acceptanceCriteria:raw.acceptanceCriteria||raw.acceptance_criteria||[],
      requirements:raw.requirements||{},
      workProtocolAgentId:agentId,
      claimMode:key&&agentId?'automatic':'credentials_required'
    },{feePercent:0,currency:'USDC',network:'base',escrowed:true,claimMode:key&&agentId?'automatic':'credentials_required',status:'open'}));
    return{signals,health:{ok:true,configured:Boolean(key&&agentId),count:signals.length,claimReady:Boolean(key&&agentId),deliveryReady:Boolean(key&&agentId),paymentRail:'base_usdc_escrow',mode:key&&agentId?'instant_escrow_claim':'discovery_only_needs_credentials'}};
  }catch(error){return{signals:[],health:{ok:false,error:String(error?.message||error).slice(0,180),mode:'instant_escrow_claim'}}}
}


async function workProtocolAction(kind,opportunity,{env=process.env,claim,deliverable}={}){
  const key=String(env.WORKPROTOCOL_API_KEY||'').trim();
  const agentId=String(env.WORKPROTOCOL_AGENT_ID||opportunity?.raw?.workProtocolAgentId||'').trim();
  const base=String(env.WORKPROTOCOL_API_URL||'https://workprotocol.ai').replace(/\/$/,'');
  if(!key||!agentId)return{ok:false,reason:'workprotocol_credentials_missing'};
  try{
    if(kind==='claim'){
      const r=await fetch(`${base}/api/jobs/${encodeURIComponent(opportunity.externalId)}/claim`,{method:'POST',headers:{...auth(key),'content-type':'application/json'},body:JSON.stringify({agentId}),signal:AbortSignal.timeout(20000)});
      const body=await safeJson(r);
      if(!r.ok)return{ok:false,reason:`http_${r.status}:${String(body?.error||body?.message||'').slice(0,140)}`,body};
      const c=body?.claim||body?.data?.claim||body?.data||body;
      const claimId=String(c?.id||c?.claimId||'');
      if(!claimId)return{ok:false,reason:'workprotocol_claim_missing_id',body};
      return{ok:true,jobId:String(opportunity.externalId),transactionId:claimId,claimId,body};
    }
    const claimId=String(claim?.claimId||claim?.transactionId||claim?.body?.claim?.id||'');
    if(!claimId)return{ok:false,reason:'workprotocol_claim_id_missing'};
    const artifactUrl=String(deliverable?.evidence?.artifactUrl||deliverable?.artifactUrl||deliverable?.evidence?.pullRequestUrl||'').trim();
    if(!/^https:\/\//i.test(artifactUrl))return{ok:false,reason:'workprotocol_artifact_url_missing'};
    const type=deliverable?.evidence?.pullRequestUrl?'url':'url';
    const r=await fetch(`${base}/api/jobs/${encodeURIComponent(opportunity.externalId)}/deliver`,{method:'POST',headers:{...auth(key),'content-type':'application/json'},body:JSON.stringify({claimId,deliverable:{type,url:artifactUrl}}),signal:AbortSignal.timeout(20000)});
    const body=await safeJson(r);
    return r.ok?{ok:true,transactionId:claimId,claimId,body,pendingVerification:true}:{ok:false,reason:`http_${r.status}:${String(body?.error||body?.message||'').slice(0,140)}`,body};
  }catch(error){return{ok:false,reason:String(error?.message||error).slice(0,220)}}
}

async function discoverX402(env,limit){
  const url=String(env.AUTONOMOS_BAZAAR_URL||'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=50');
  const response=await fetch(url,{headers:{accept:'application/json','user-agent':'AutonomOS/7.7'},signal:AbortSignal.timeout(12000)});
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
  const headers={accept:'application/json','user-agent':'AutonomOS/7.7',authorization:`Bearer ${key}`};
  let response={ok:false,status:0},body={};
  try{response=await fetch(`https://dealwork.ai/api/v1/jobs?per_page=${Math.min(50,limit)}&sort=newest`,{headers,signal:AbortSignal.timeout(12000)});body=await safeJson(response);}catch{}
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

  // Crash-recovery lane: an open-job claim may commit on Dealwork while our HTTP response
  // is lost and the newly assigned job disappears from the public/matching feed. The
  // canonical source of truth is GET /contracts, so surface our own active contracts back
  // into discovery as already_assigned work. Assigned contracts come FIRST so the global
  // discovery cap cannot starve a real escrowed obligation behind fresh marketplace noise.
  let assignedSignals=[]; let assignedContractsOk=false; let assignedContracts=0; let assignedJobReads=0;
  try{
    const listed=await listDealworkWorkerContracts({headers});
    if(listed.ok){
      assignedContractsOk=true;
      const recoverableStates=new Set(['escrow_locked','in_progress']);
      const active=listed.rows.filter(contract=>recoverableStates.has(dealworkContractState(contract)));
      assignedContracts=active.length;
      const maxAssigned=Math.max(1,Math.min(Number(limit||50),25));
      for(const contract of active.slice(0,maxAssigned)){
        const contractId=String(contract?.id||'').trim();
        const jobId=String(contract?.jobId||contract?.job_id||contract?.job?.id||'').trim();
        if(!contractId||!jobId)continue;
        let job=dedup.get(jobId)||contract?.job||{};
        // Contract list rows are intentionally compact on many APIs. Pull the authoritative
        // job brief only when the row does not already contain enough execution context.
        if(!String(job?.description||job?.brief||job?.instructions||'').trim()){
          const detail=await readDealworkJob(jobId,{headers});
          if(detail.ok){job=dealworkJobValue(detail.body);assignedJobReads++;}
        }
        if(!String(job?.description||job?.brief||job?.instructions||contract?.description||'').trim())continue;
        const fixedPrice=Number(job?.fixedPrice??job?.fixed_price??job?.budgetUsd??job?.budgetMax??job?.budget_max??contract?.fixedPrice??contract?.fixed_price??contract?.amount??contract?.escrowAmount??contract?.escrow_amount??0);
        const state=dealworkContractState(contract);
        assignedSignals.push(normalizeOpportunity('dealwork',{
          ...job,
          id:jobId,
          externalId:jobId,
          title:job?.title||contract?.jobTitle||contract?.title||`Assigned Dealwork contract ${jobId}`,
          description:job?.description||job?.brief||job?.instructions||contract?.description||`Authoritative assigned Dealwork contract ${contractId}`,
          budgetUsd:fixedPrice,
          status:'available',
          contractId,
          contractState:state,
          escrowed:true,
          claimMode:'already_assigned'
        },{feePercent:10,currency:'USD',network:'stripe',escrowed:true,claimMode:'already_assigned',status:'available'}));
      }
    }
  }catch{}

  // P1 fix: jobMode:'open' jobs support instant claim, but jobMode:'bid' jobs — per
  // dealwork.ai's own published skill.md — are a real, documented, two-step flow (submit
  // a bid, wait for the buyer to accept it, THEN execute) and are usually the
  // higher-value jobs on this marketplace. They were filtered out entirely before because
  // that async wait didn't fit the claim→execute→deliver pipeline; they're now tagged
  // claimMode:'bid' and handled by a separate submit-then-poll path (see submitDealworkBid
  // / pollDealworkBids in runtime.js) instead of being discarded.
  const openRows=rows.filter(row=>!row.jobMode||row.jobMode==='open');
  const bidRows=rows.filter(row=>row.jobMode==='bid'&&row.biddingDeadline&&new Date(row.biddingDeadline).getTime()>Date.now());
  const openSignals=openRows.map(row=>{
    const fixedPrice=Number(row.fixedPrice??row.fixed_price??row.budget_min??row.budgetMin??row.budget_max??row.budgetMax??0);
    const budgetMax=Number((row.budgetMax??row.budget_max??fixedPrice)||0);
    const maxConcurrent=Math.max(1,Number(row.maxConcurrent??row.max_concurrent??1));
    const requiredOpenBudget=fixedPrice*maxConcurrent;
    const invalid=Boolean(fixedPrice>0&&budgetMax>0&&requiredOpenBudget>budgetMax+1e-9);
    const op=normalizeOpportunity('dealwork',{...row,budgetUsd:fixedPrice},{feePercent:10,currency:'USD',network:'stripe',escrowed:false,claimMode:'automatic',status:row.status||'open'});
    return {...op,escrowOnAccept:true,marketConfiguration:{fixedPrice,budgetMax,maxConcurrent,requiredOpenBudget,invalid,reason:invalid?`budgetMax_${budgetMax}_below_fixedPrice_x_maxConcurrent_${requiredOpenBudget}`:''}};
  });
  const bidSignals=bidRows.map(row=>normalizeOpportunity('dealwork',{...row,budgetUsd:Number(row.budgetMax??row.budget_max??row.budgetMin??row.budget_min??0)},{feePercent:10,currency:'USD',network:'stripe',escrowed:false,claimMode:'bid',status:row.status||'open'}));
  const assignedIds=new Set(assignedSignals.map(x=>String(x.externalId||'')));
  const signals=[...assignedSignals,...openSignals.filter(x=>!assignedIds.has(String(x.externalId||''))),...bidSignals.filter(x=>!assignedIds.has(String(x.externalId||'')))];
  return {signals,health:{ok:true,count:signals.length,totalOpenJobs:rows.length,matchedJobs:matchedRows.length,matchingFeed:matchingOk,openMode:openSignals.length,bidMode:bidSignals.length,assignedMode:assignedSignals.length,assignedContracts,assignedContractsFeed:assignedContractsOk,assignedJobReads}};
}

async function discoverClawlancer(env,credentials,limit){
  const key=String(env.CLAWLANCER_API_KEY||credentials?.clawlancer?.apiKey||'');
  const response=await fetch(`https://clawlancer.ai/api/listings?listing_type=BOUNTY&limit=${Math.min(100,limit)}`,{headers:{accept:'application/json','user-agent':'AutonomOS/7.7',...(key?{authorization:`Bearer ${key}`}:{})},signal:AbortSignal.timeout(12000)});
  const body=await safeJson(response); if(!response.ok) return {signals:[],health:{ok:false,status:response.status,error:body?.error||body?.message||''}};
  const rows=Array.isArray(body)?body:Array.isArray(body?.listings)?body.listings:Array.isArray(body?.data)?body.data:[];
  const signals=rows.map(raw=>normalizeOpportunity('clawlancer',{...raw,url:raw.url||`https://clawlancer.ai/listings/${raw.id||raw.listing_id||''}`},{feePercent:2.5,currency:'USDC',network:'eip155:8453',escrowed:true,claimMode:key?'automatic':'credentials_required'})).filter(x=>x.status==='open'||x.status==='active'||x.status==='available'||!x.status);
  return {signals:signals.slice(0,limit),health:{ok:true,count:signals.length,authenticated:Boolean(key)}};
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
function containsArrayByKey(value,keys,depth=0){
  if(depth>5||value==null)return false;if(Array.isArray(value))return true;if(typeof value!=='object')return false;
  for(const key of keys)if(Array.isArray(value[key]))return true;
  for(const child of Object.values(value))if(containsArrayByKey(child,keys,depth+1))return true;
  return false;
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
  if(kind==='claim'){
    // An assigned contract is already ours; never call /jobs/{id}/claim a second time.
    // This also lets a future recovery feed safely rehydrate a contract after a process
    // crash around the original claim response.
    if(opportunity.claimMode==='already_assigned'){
      const contractId=String(opportunity.raw?.contractId||opportunity.raw?.contract_id||'');
      if(!contractId)return{ok:false,reason:'dealwork_assigned_contract_id_missing'};
      const probe=await readDealworkContract(contractId,{headers});
      if(!probe.ok)return {ok:false,reason:'dealwork_contract_read_failed'};
      const state=dealworkContractState(probe.body);
      if(dealworkDeliveryAlreadyAccepted(state))return {ok:false,reason:'dealwork_contract_already_delivered'};
      if(state==='escrow_locked'){
        const started=await startDealworkContract(contractId,{env,credentials});
        if(!started.ok)return started;
      }else if(!dealworkWorkAlreadyStarted(state))return{ok:false,reason:`dealwork_assigned_contract_unexpected_state:${state||'unknown'}`};
      const workOrder=await readDealworkJob(opportunity.externalId,{headers});
      return{ok:true,jobId:contractId,transactionId:contractId,recoveredAssigned:true,workOrder:workOrder.ok?workOrder.body:null,body:probe.body||opportunity.raw};
    }

    const criteriaIds=Array.isArray(opportunity.raw?.acceptanceCriteria)?opportunity.raw.acceptanceCriteria.map(c=>c?.id).filter(Boolean):[];
    let claimResp,claimBody={};
    try{
      claimResp=await fetch(`https://dealwork.ai/api/v1/jobs/${encodeURIComponent(opportunity.externalId)}/claim`,{method:'POST',headers,body:JSON.stringify({acceptedCriteriaIds:criteriaIds}),signal:AbortSignal.timeout(20000)});
      claimBody=await safeJson(claimResp);
    }catch(error){
      const recovered=await recoverDealworkClaimByJob(opportunity.externalId,{env,credentials,headers});
      return recovered||{ok:false,reason:`dealwork_claim_transport_uncertain:${String(error?.message||error).slice(0,180)}`};
    }
    if(!claimResp.ok){
      // A 409/timeout-style response can arrive after the server already committed the
      // contract. Probe our worker contracts before deciding the claim failed.
      const recovered=await recoverDealworkClaimByJob(opportunity.externalId,{env,credentials,headers});
      if(recovered)return recovered;
      return{ok:false,reason:`http_${claimResp.status}:${claimBody?.error?.code||''}:${String(claimBody?.error?.message||'').slice(0,120)}`,body:claimBody};
    }
    const contract=dealworkContractValue(claimBody);
    const contractId=String(contract?.id||''); if(!contractId)return{ok:false,reason:'dealwork_claim_missing_contract_id',body:claimBody};
    const state=dealworkContractState(contract);
    if(state&&state!=='escrow_locked'&&!dealworkWorkAlreadyStarted(state))return{ok:false,reason:`dealwork_unexpected_state:${state}`,body:claimBody};
    if(!dealworkWorkAlreadyStarted(state)){
      const started=await startDealworkContract(contractId,{env,credentials});
      if(!started.ok)return{ok:false,reason:`dealwork_start_work_failed:${started.reason||'unknown'}`,body:started.body||claimBody};
    }
    const workOrder=await readDealworkJob(opportunity.externalId,{headers});
    return{ok:true,jobId:contractId,transactionId:contractId,body:claimBody,workOrder:workOrder.ok?workOrder.body:null};
  }

  const contractId=String(claim?.jobId||''); if(!contractId)return{ok:false,reason:'dealwork_missing_contract_id'};
  // If a previous SUBMIT_WORK committed but the HTTP response was lost, do not create a
  // duplicate deliverable on retry. Dealwork exposes the canonical contract state.
  const before=await readDealworkContract(contractId,{headers});
  if(!before.ok)return {ok:false,reason:'dealwork_contract_read_failed'};
  const beforeState=dealworkContractState(before.body||{});
  if(dealworkDeliveryAlreadyAccepted(beforeState))return{ok:true,jobId:contractId,transactionId:contractId,pendingReview:true,recoveredAfterUncertainWrite:true,state:beforeState,body:before.body};

  if(!['in_progress','revision_requested'].includes(beforeState))return {ok:false,reason:'dealwork_contract_not_deliverable'};
  const resultText=String(deliverable?.content||'');
  const prior=await findMatchingDealworkDeliverable(contractId,resultText,{headers});
  if(prior?.lookupFailed)return {ok:false,reason:'dealwork_deliverable_lookup_failed'};
  let deliverableId=String(prior?.id||'');let deliverableBody={};let createFailure='';
  if(!deliverableId)try{
    const deliverableResp=await fetch(`https://dealwork.ai/api/v1/contracts/${encodeURIComponent(contractId)}/deliverables`,{method:'POST',headers,body:JSON.stringify({description:opportunity.title||'Completed task',outputData:{result:resultText,format:deliverable.format||'text/markdown'}}),signal:AbortSignal.timeout(20000)});
    deliverableBody=await safeJson(deliverableResp);
    if(deliverableResp.ok)deliverableId=String(deliverableBody?.data?.id||deliverableBody?.id||'');
    else createFailure=`dealwork_deliverable_http_${deliverableResp.status}`;
  }catch(error){createFailure=`dealwork_deliverable_transport_uncertain:${String(error?.message||error).slice(0,180)}`;}

  if(!deliverableId){
    const afterCreate=await readDealworkContract(contractId,{headers});
    const afterCreateState=dealworkContractState(afterCreate.body||{});
    if(dealworkDeliveryAlreadyAccepted(afterCreateState))return{ok:true,jobId:contractId,transactionId:contractId,pendingReview:true,recoveredAfterUncertainWrite:true,state:afterCreateState,body:afterCreate.body};
    const existing=await findMatchingDealworkDeliverable(contractId,resultText,{headers});
    if(existing?.id)deliverableId=String(existing.id);
    else return{ok:false,reason:createFailure||'dealwork_deliverable_missing_id',body:deliverableBody};
  }

  let submitResp,submitBody={};
  try{
    submitResp=await fetch(`https://dealwork.ai/api/v1/contracts/${encodeURIComponent(contractId)}/events`,{method:'POST',headers,body:JSON.stringify({type:'SUBMIT_WORK',deliverableId}),signal:AbortSignal.timeout(15000)});
    submitBody=await safeJson(submitResp);
    if(!submitResp.ok){
      const probe=await readDealworkContract(contractId,{headers});const state=dealworkContractState(probe.body||{});
      if(dealworkDeliveryAlreadyAccepted(state))return{ok:true,jobId:contractId,transactionId:contractId,pendingReview:true,recoveredAfterUncertainWrite:true,state,body:probe.body};
      return{ok:false,reason:`dealwork_submit_work_http_${submitResp.status}`,body:submitBody};
    }
  }catch(error){
    const probe=await readDealworkContract(contractId,{headers});const state=dealworkContractState(probe.body||{});
    if(dealworkDeliveryAlreadyAccepted(state))return{ok:true,jobId:contractId,transactionId:contractId,pendingReview:true,recoveredAfterUncertainWrite:true,state,body:probe.body};
    return{ok:false,reason:`dealwork_submit_work_transport_uncertain:${String(error?.message||error).slice(0,180)}`};
  }
  // This moves the contract to in_review, not paid. Revenue is recorded only after the
  // settlement synchronizer observes an authoritative paid/released state.
  return{ok:true,jobId:contractId,transactionId:contractId,body:submitBody,pendingReview:true};
}

function auth(key){return{accept:'application/json','user-agent':'AutonomOS/7.7',authorization:`Bearer ${key}`}}
async function safeJson(response){try{return await response.json()}catch{return{}}}

function dealworkContractValue(body={}){
  const data=body?.data;
  return data?.contract||body?.contract||(data&&!Array.isArray(data)?data:body)||{};
}
function dealworkJobValue(body={}){
  const data=body?.data;
  return data?.job||body?.job||(data&&!Array.isArray(data)?data:body)||{};
}
function dealworkContractState(body={}){
  const contract=dealworkContractValue(body);
  return String(contract?.state||contract?.status||body?.state||body?.status||'').trim().toLowerCase();
}
function dealworkWorkAlreadyStarted(state){return ['in_progress','in_review','revision_requested','completed','paid'].includes(String(state||'').toLowerCase());}
function dealworkDeliveryAlreadyAccepted(state){return ['in_review','completed','paid'].includes(String(state||'').toLowerCase());}
async function readDealworkContract(contractId,{headers}={}){
  if(!contractId)return{ok:false,reason:'contract_id_missing',body:null};
  try{const r=await fetch(`https://dealwork.ai/api/v1/contracts/${encodeURIComponent(contractId)}`,{headers,signal:AbortSignal.timeout(12000)});const body=await safeJson(r);return r.ok?{ok:true,body,state:dealworkContractState(body)}:{ok:false,reason:`http_${r.status}`,body};}
  catch(error){return{ok:false,reason:String(error?.message||error).slice(0,180),body:null};}
}
async function readDealworkJob(jobId,{headers}={}){
  if(!jobId)return{ok:false,reason:'job_id_missing',body:null};
  try{const r=await fetch(`https://dealwork.ai/api/v1/jobs/${encodeURIComponent(jobId)}`,{headers,signal:AbortSignal.timeout(12000)});const body=await safeJson(r);return r.ok?{ok:true,body}:{ok:false,reason:`http_${r.status}`,body};}
  catch(error){return{ok:false,reason:String(error?.message||error).slice(0,180),body:null};}
}
async function listDealworkWorkerContracts({headers}={}){
  try{const r=await fetch('https://dealwork.ai/api/v1/contracts?role=worker&per_page=100',{headers,signal:AbortSignal.timeout(12000)});const body=await safeJson(r);const rows=Array.isArray(body?.data)?body.data:Array.isArray(body?.data?.contracts)?body.data.contracts:[];return r.ok?{ok:true,rows}:{ok:false,reason:`http_${r.status}`,rows:[]};}
  catch(error){return{ok:false,reason:String(error?.message||error).slice(0,180),rows:[]};}
}
async function recoverDealworkClaimByJob(jobId,{env,credentials,headers}={}){
  const listed=await listDealworkWorkerContracts({headers});if(!listed.ok)return null;
  const activeStates=new Set(['escrow_locked','in_progress','in_review','revision_requested','completed','paid']);
  const contract=listed.rows.find(c=>String(c?.jobId||c?.job_id||c?.job?.id||'')===String(jobId)&&activeStates.has(dealworkContractState(c)));
  if(!contract)return null;
  const contractId=String(contract?.id||'');if(!contractId)return null;
  const state=dealworkContractState(contract);
  if(state==='escrow_locked'){
    const started=await startDealworkContract(contractId,{env,credentials});if(!started.ok)return null;
  }
  const workOrder=await readDealworkJob(jobId,{headers});
  return{ok:true,jobId:contractId,transactionId:contractId,recoveredClaim:true,workOrder:workOrder.ok?workOrder.body:null,body:contract};
}
async function findMatchingDealworkDeliverable(contractId,resultText,{headers}={}){
  try{
    const r=await fetch(`https://dealwork.ai/api/v1/contracts/${encodeURIComponent(contractId)}/deliverables`,{headers,signal:AbortSignal.timeout(12000)});const body=await safeJson(r);
    if(!r.ok)return {lookupFailed:true};const rows=Array.isArray(body?.data)?body.data:Array.isArray(body?.data?.deliverables)?body.data.deliverables:null;
    if(!rows)return {lookupFailed:true};
    return rows.find(item=>String(item?.outputData?.result??item?.output_data?.result??'')===String(resultText||''))||null;
  }catch{return {lookupFailed:true};}
}

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
  const before=await readDealworkContract(contractId,{headers});
  if(!before.ok)return {ok:false,reason:'dealwork_contract_read_failed'};
  if(dealworkWorkAlreadyStarted(before.state))return{ok:true,body:before.body,state:before.state,alreadyStarted:true};
  if(before.state!=='escrow_locked')return {ok:false,reason:'dealwork_contract_not_escrow_locked'};
  try{
    const response=await fetch(`https://dealwork.ai/api/v1/contracts/${encodeURIComponent(contractId)}/events`,{method:'POST',headers,body:JSON.stringify({type:'START_WORK'}),signal:AbortSignal.timeout(15000)});
    const body=await safeJson(response);
    if(response.ok)return{ok:true,body,state:'in_progress'};
    const after=await readDealworkContract(contractId,{headers});
    if(after.ok&&dealworkWorkAlreadyStarted(after.state))return{ok:true,body:after.body,state:after.state,recoveredAfterUncertainWrite:true};
    return{ok:false,reason:`http_${response.status}`,body};
  }catch(error){
    // A timeout can happen after Dealwork committed START_WORK. Read the canonical contract
    // state before retrying the side effect.
    const after=await readDealworkContract(contractId,{headers});
    if(after.ok&&dealworkWorkAlreadyStarted(after.state))return{ok:true,body:after.body,state:after.state,recoveredAfterUncertainWrite:true};
    return{ok:false,reason:String(error?.message||error).slice(0,200)};
  }
}

function dedupe(rows){const seen=new Set();return rows.filter(row=>{const key=`${row.source}:${row.externalId}`;if(seen.has(key))return false;seen.add(key);return true})}
export function connectorDefinitions(){return CONNECTOR_DEFS.map(x=>({...x}));}
export async function discoverPublicSignals(args){return discoverMarketOpportunities(args);}

export async function syncMarketplaceTransactions({env=process.env,credentials={},knownJobs=[]}={}) {
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
  const wpKey=String(env.WORKPROTOCOL_API_KEY||'').trim();
  const wpAgentId=String(env.WORKPROTOCOL_AGENT_ID||'').trim();
  if(wpKey&&wpAgentId){
    const base=String(env.WORKPROTOCOL_API_URL||'https://workprotocol.ai').replace(/\/$/,'');
    const relevant=[];const seenJobs=new Set();
    for(const row of [...(knownJobs||[])].reverse()){
      if(row?.source!=='workprotocol')continue;
      const id=String(row.externalId||'');if(!id||seenJobs.has(id))continue;
      seenJobs.add(id);relevant.push(id);if(relevant.length>=25)break;
    }
    let mapped=0,checked=0;
    for(const jobId of relevant){
      try{
        const r=await fetch(`${base}/api/jobs/${encodeURIComponent(jobId)}`,{headers:auth(wpKey),signal:AbortSignal.timeout(12000)});
        const body=await safeJson(r);if(!r.ok)continue;checked++;
        const job=body?.job||body?.data?.job||body?.data||body;
        const claims=Array.isArray(body?.claims)?body.claims:Array.isArray(body?.data?.claims)?body.data.claims:[];
        const payments=Array.isArray(body?.payments)?body.payments:Array.isArray(body?.data?.payments)?body.data.payments:[];
        const ours=claims.find(c=>String(c.agentId||c.agent_id||'')===wpAgentId)||claims[0]||null;
        const payment=payments.find(x=>String(x.claimId||x.claim_id||'')===String(ours?.id||ours?.claimId||''))||payments.find(x=>/released|paid|completed/i.test(String(x.status||x.state||'')))||null;
        const status=String(payment?.status||payment?.state||job?.status||'').toLowerCase();
        if(!['released','paid','completed','settled'].includes(status))continue;
        const amountUsd=Number(payment?.amount??payment?.amountUsdc??job?.paymentAmount??job?.amount??0);
        if(!Number.isFinite(amountUsd)||amountUsd<=0)continue;
        rows.push({source:'workprotocol',externalTransactionId:String(payment?.txHash||payment?.transactionHash||payment?.id||`${jobId}:${ours?.id||'claim'}`),listingId:jobId,status,amountUsd,currency:String(payment?.currency||job?.paymentCurrency||'USDC').toUpperCase(),network:String(payment?.network||job?.paymentRail||'base'),payoutAddress:String(payment?.to||payment?.walletAddress||''),raw:{job,claim:ours,payment}});mapped++;
      }catch{}
    }
    health.workprotocol={ok:true,checked,settledMapped:mapped};
  }

  return {transactions:rows,health};
}

export async function reconcileMarketplaceDelivery(opportunity,claim,{env=process.env,credentials={}}={}){
  if(opportunity.source!=='dealwork')return {ok:false,reason:'provider_reconciliation_unavailable'};
  const key=env.DEALWORK_API_KEY||credentials?.dealwork?.apiKey;if(!key)return {ok:false};
  const result=await readDealworkContract(claim?.jobId,{headers:auth(key)});
  return result.ok&&dealworkDeliveryAlreadyAccepted(result.state)?{ok:true,jobId:claim.jobId,transactionId:claim.jobId,pendingReview:true,recoveredAfterUncertainWrite:true}: {ok:false,reason:'delivery_not_authoritatively_confirmed'};
}
