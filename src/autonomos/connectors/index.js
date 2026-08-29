import { McpHttpClient, extractMcpToolPayload } from '../mcp-client.js';
import { normalizeOpportunity } from '../job-normalizer.js';
import { isEvmAddress as isEvmAddressLike } from '../treasury.js';

const CONNECTOR_DEFS = Object.freeze([
  { id:'x402-bazaar', name:'x402 / Bazaar', kind:'seller+discovery', description:'Machine-payable API discovery and seller rail.', requiredEnv:[] },
  { id:'clawlancer', name:'Clawlancer', kind:'jobs', description:'Pre-funded Base/USDC bounties: discover → claim → deliver → paid.', requiredEnv:[], optionalEnv:['CLAWLANCER_API_KEY','CLAWLANCER_AGENT_ID'] },
  { id:'dealwork', name:'dealwork.ai', kind:'jobs', description:'Human+AI hybrid marketplace, USD via Stripe escrow, open-task instant claim.', requiredEnv:[], optionalEnv:['DEALWORK_API_KEY','DEALWORK_AGENT_ID'] },
  { id:'virtuals-acp', name:'Virtuals ACP', kind:'jobs+seller', description:'Agent Commerce Protocol jobs and USDC escrow.', requiredEnv:['VIRTUALS_ACP_WALLET_ID','VIRTUALS_ACP_SIGNER'], optionalEnv:['VIRTUALS_ACP_AGENT_ID'] },
  { id:'t2000', name:'t2000', kind:'jobs+seller', description:'Sui/USDC open jobs with pre-funded escrow via Passport Connect.', requiredEnv:['T2000_MCP_URL','T2000_SESSION_TOKEN'], optionalEnv:['T2000_PASSPORT_ADDRESS'] },
  { id:'olas-mech', name:'Olas Mech Marketplace', kind:'seller+discovery', description:'Agent-to-agent paid Mech services.', requiredEnv:['OLAS_MECH_API_KEY'], optionalEnv:['OLAS_MECH_ENDPOINT'] },
  { id:'nevermined', name:'Nevermined', kind:'payments', description:'Fiat + crypto agent payment facilitator and metering.', requiredEnv:['NVM_API_KEY'], optionalEnv:['NVM_PLAN_ID'] },
  { id:'agentverse', name:'Agentverse / Fetch.ai', kind:'discovery', description:'Public agent/function discovery and ASI routing.', requiredEnv:[], optionalEnv:['AGENTVERSE_API_KEY'] },
  { id:'openserv', name:'OpenServ', kind:'discovery', description:'Agent/workflow ecosystem; optional authenticated connector.', requiredEnv:['OPENSERV_API_KEY'], optionalEnv:[] }
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
    if (def.id === 'agentverse') return { ...def, status:'discovery_ready', configured:true, missing:[] };
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
  return health;
}

export async function discoverMarketOpportunities({ env=process.env, credentials={}, limit=100, sources=null }={}) {
  const all=[]; const health={};
  const want=Array.isArray(sources)&&sources.length?new Set(sources):null;
  const jobs=[
    ['x402-bazaar',()=>discoverX402(env,limit)],
    ['clawlancer',()=>discoverClawlancer(env,credentials,limit)],
    ['dealwork',()=>discoverDealwork(env,credentials,limit)],
    ['agentverse',()=>discoverAgentverse(limit)],
    ['t2000',()=>discoverT2000(env,limit)]
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
  if (opportunity.source==='t2000') return t2000Action('claim',opportunity,{env});
  return {ok:false,reason:'connector_claim_not_available'};
}

export async function deliverMarketplaceJob(opportunity,claim,deliverable,{env=process.env,credentials={}}={}) {
  if (opportunity.source==='clawlancer') return clawlancerAction('deliver',opportunity,{env,credentials,claim,deliverable});
  if (opportunity.source==='dealwork') return dealworkAction('deliver',opportunity,{env,credentials,claim,deliverable});
  if (opportunity.source==='t2000') return t2000Action('deliver',opportunity,{env,claim,deliverable});
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
  const response=await fetch(`https://dealwork.ai/api/v1/jobs?per_page=${Math.min(50,limit)}&sort=newest`,{headers:{accept:'application/json','user-agent':'AutonomOS/2.0',authorization:`Bearer ${key}`},signal:AbortSignal.timeout(12000)});
  const body=await safeJson(response); if(!response.ok) return {signals:[],health:{ok:false,status:response.status,error:body?.error?.message||body?.error||''}};
  const rows=Array.isArray(body?.data)?body.data:[];
  // Only jobMode:'open' jobs support instant claim (POST /jobs/{id}/claim) which matches our
  // claim->execute->deliver state machine. jobMode:'bid' jobs require submitting a bid and
  // waiting for the buyer to accept it — a different, asynchronous flow we don't implement
  // yet, so they're filtered out here rather than claimed and failing.
  const openRows=rows.filter(row=>!row.jobMode||row.jobMode==='open');
  const signals=openRows.map(row=>normalizeOpportunity('dealwork',{...row,budgetUsd:Number(row.fixedPrice??row.budget_max??row.budgetMax??row.budget_min??0)},{feePercent:10,currency:'USD',network:'stripe',escrowed:true,claimMode:'automatic',status:row.status||'open'}));
  return {signals,health:{ok:true,count:signals.length,totalOpenJobs:rows.length,filteredOutBidMode:rows.length-openRows.length}};
}

async function discoverClawlancer(env,credentials,limit){
  const key=String(env.CLAWLANCER_API_KEY||credentials?.clawlancer?.apiKey||'');
  const response=await fetch(`https://clawlancer.ai/api/listings?listing_type=BOUNTY&limit=${Math.min(100,limit)}`,{headers:{accept:'application/json','user-agent':'AutonomOS/2.0',...(key?{authorization:`Bearer ${key}`}:{})},signal:AbortSignal.timeout(12000)});
  const body=await safeJson(response); if(!response.ok) return {signals:[],health:{ok:false,status:response.status,error:body?.error||body?.message||''}};
  const rows=Array.isArray(body)?body:Array.isArray(body?.listings)?body.listings:Array.isArray(body?.data)?body.data:[];
  const signals=rows.map(raw=>normalizeOpportunity('clawlancer',{...raw,url:raw.url||`https://clawlancer.ai/listings/${raw.id||raw.listing_id||''}`},{feePercent:2.5,currency:'USDC',network:'eip155:8453',escrowed:true,claimMode:key?'automatic':'credentials_required'})).filter(x=>x.status==='open'||x.status==='active'||x.status==='available'||!x.status);
  return {signals:signals.slice(0,limit),health:{ok:true,count:signals.length,authenticated:Boolean(key)}};
}

async function discoverAgentverse(limit){
  const response=await fetch('https://agentverse.ai/v1/search/functions',{method:'POST',headers:{'content-type':'application/json','accept':'application/json','user-agent':'AutonomOS/2.0'},body:JSON.stringify({limit:Math.min(limit,50),offset:0,sort:'last-modified'}),signal:AbortSignal.timeout(12000)});
  const body=await safeJson(response); if(!response.ok)return{signals:[],health:{ok:false,status:response.status}};
  const rows=Array.isArray(body?.functions)?body.functions:[];
  const signals=rows.map(raw=>normalizeOpportunity('agentverse',{externalId:raw.id,title:raw.name,description:raw.description||raw.name,url:'https://agentverse.ai/marketplace',status:'discovery',priceUsd:0},{claimMode:'route/discovery',escrowed:false,currency:'UNKNOWN'}));
  return {signals,health:{ok:true,count:signals.length,total:Number(body?.total||0)}};
}

async function discoverT2000(env,limit){
  const mcpUrl=String(env.T2000_MCP_URL||''); const token=String(env.T2000_SESSION_TOKEN||'');
  if(mcpUrl&&token){
    try{
      const client=new McpHttpClient({url:mcpUrl,token,timeoutMs:18000}); await client.initialize(); const tools=await client.listTools();
      const jobsTool=tools.find(t=>t.name==='t2000_job_board')||tools.find(t=>/job_board|openings|market/i.test(t.name))||tools.find(t=>t.name==='t2000_jobs')||tools.find(t=>/jobs/i.test(t.name));
      if(!jobsTool)return{signals:[],health:{ok:false,connected:true,error:'jobs_tool_not_found',tools:tools.map(t=>t.name).slice(0,30)}};
      let result; for(const args of [{},{role:'seller'},{role:'buyer'}]){try{result=extractMcpToolPayload(await client.callTool(jobsTool.name,args));if(result)break}catch{}}
      const openings=findArrayByKey(result,['openings','jobs','items','results']);
      const signals=openings.slice(0,limit).map(raw=>normalizeOpportunity('t2000',{...raw,externalId:raw.openingId||raw.opening_id||raw.jobId||raw.job_id||raw.id,url:raw.url||'https://t2000.ai/'},{feePercent:5,currency:'USDC',network:'Sui',escrowed:true,claimMode:'automatic_mcp'}));
      return{signals,health:{ok:true,connected:true,count:signals.length,tool:jobsTool.name,tools:tools.map(t=>t.name).slice(0,30)}};
    }catch(error){return{signals:[],health:{ok:false,connected:false,error:String(error?.message||error).slice(0,220)}}}
  }
  try{
    const response=await fetch('https://t2000.ai/',{headers:{accept:'text/html','user-agent':'AutonomOS/2.0'},signal:AbortSignal.timeout(12000)}); const html=await response.text();
    if(!response.ok)return{signals:[],health:{ok:false,status:response.status,claimReady:false}};
    const settled=[...html.matchAll(/\$([0-9]+(?:\.[0-9]+)?)\s*(?:settled|·)/gi)].slice(0,limit).map((m,i)=>normalizeOpportunity('t2000-public',{externalId:`public-${i}-${m.index}`,title:'t2000 public marketplace activity',description:'Public activity only. Add Passport Connect MCP credentials to discover and claim live openings.',budgetUsd:Number(m[1]),status:'signal',url:'https://t2000.ai/'},{feePercent:5,currency:'USDC',network:'Sui',escrowed:true,claimMode:'needs_passport_connect'}));
    return{signals:settled,health:{ok:true,publicActivitySignals:settled.length,claimReady:false}};
  }catch(error){return{signals:[],health:{ok:false,error:String(error?.message||error).slice(0,180),claimReady:false}}}
}

async function t2000Action(kind,opportunity,{env,claim,deliverable}={}){
  const mcpUrl=String(env.T2000_MCP_URL||''),token=String(env.T2000_SESSION_TOKEN||''); if(!mcpUrl||!token)return{ok:false,reason:'t2000_passport_connect_missing'};
  try{
    const client=new McpHttpClient({url:mcpUrl,token,timeoutMs:22000}); await client.initialize(); const tools=await client.listTools();
    const ext=opportunity.externalId;
    if(kind==='claim'){
      const claimTool=tools.find(t=>t.name==='t2000_job_claim')||tools.find(t=>/job_claim|claim/i.test(t.name));
      if(!claimTool)return{ok:false,reason:'t2000_claim_tool_not_found',tools:tools.map(t=>t.name).slice(0,30)};
      const claimCandidates=[{openingId:ext},{opening_id:ext},{jobId:ext},{id:ext}];
      let last='',claimed=null;
      for(const args of claimCandidates){try{claimed=extractMcpToolPayload(await client.callTool(claimTool.name,args));if(claimed)break}catch(error){last=String(error?.message||error)}}
      if(!claimed)return{ok:false,reason:last.slice(0,200)||'t2000_claim_failed'};
      const jobId=String(claimed?.jobId||claimed?.job_id||claimed?.id||ext);
      // Mandatory per t2000 flow: job_claim only reserves the job. The full work order
      // (requirements, deliverable format, acceptance criteria) lives in job_status and
      // is required before execution — delivering without it risks a rejected/failed job.
      const statusTool=tools.find(t=>t.name==='t2000_job_status')||tools.find(t=>/job_status|status/i.test(t.name));
      let workOrder=null;
      if(statusTool){
        for(const args of [{jobId},{job_id:jobId},{id:jobId}]){try{workOrder=extractMcpToolPayload(await client.callTool(statusTool.name,args));if(workOrder)break}catch{}}
      }
      return{ok:true,tool:claimTool.name,jobId,transactionId:String(claimed?.transactionId||claimed?.tx||''),body:claimed,workOrder:workOrder||null,workOrderMissing:!workOrder};
    }
    const deliverTool=tools.find(t=>t.name==='t2000_job_deliver')||tools.find(t=>/job_deliver|deliver|submit/i.test(t.name));
    if(!deliverTool)return{ok:false,reason:'t2000_deliver_tool_not_found',tools:tools.map(t=>t.name).slice(0,30)};
    const jobId=claim?.jobId||ext;
    const deliverCandidates=[
      {jobId,deliverable:deliverable.content},
      {job_id:jobId,content:deliverable.content},
      {id:jobId,work:deliverable.content}
    ];
    let last=''; for(const args of deliverCandidates){try{const result=extractMcpToolPayload(await client.callTool(deliverTool.name,args));return{ok:true,tool:deliverTool.name,jobId:String(result?.jobId||result?.job_id||result?.id||jobId),transactionId:String(result?.transactionId||result?.tx||''),body:result}}catch(error){last=String(error?.message||error)}}
    return{ok:false,reason:last.slice(0,200)||'t2000_deliver_failed'};
  }catch(error){return{ok:false,reason:String(error?.message||error).slice(0,220)}}
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
      const claimResp=await fetch(`https://dealwork.ai/api/v1/jobs/${encodeURIComponent(opportunity.externalId)}/claim`,{method:'POST',headers,body:JSON.stringify({acceptedCriteriaIds:[]}),signal:AbortSignal.timeout(20000)});
      const claimBody=await safeJson(claimResp); if(!claimResp.ok)return{ok:false,reason:`http_${claimResp.status}`,body:claimBody};
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
          const amountAtomic=tx.amount_usdc_wei??tx.amount_wei??tx.price_wei??tx.amount;
          const rawAmount = tx.amountUsd ?? tx.priceUsd ?? (Number(amountAtomic||0)>1000 ? Number(amountAtomic)/1e6 : Number(amountAtomic||0));
          const amountUsd=Number(rawAmount || 0);
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
  return {transactions:rows,health};
}
