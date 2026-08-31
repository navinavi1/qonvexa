import path from 'node:path';
import crypto from 'node:crypto';
import { CORE_AGENTS, buildAgentState } from './agents.js';
import { AutonomOSStore } from './store.js';
import { normalizeConfig, DEFAULT_AUTONOMOS_CONFIG, validateAction } from './policy-engine.js';
import { evaluateOpportunity, allocateRevenue, computeEarnedSpendBudgetUsd } from './profit-engine.js';
import { readTreasuryBalances, isEvmAddress } from './treasury.js';
import { MACHINE_PRODUCTS, executeProduct } from './products.js';
import { createX402Gateway } from './x402.js';
import {
  connectorStatuses, discoverMarketOpportunities, bootstrapMarketCredentials,
  claimMarketplaceJob, deliverMarketplaceJob, readMarketplaceWallets, syncMarketplaceTransactions,
  submitDealworkBid, checkDealworkBidStatus, startDealworkContract
} from './connectors/index.js';
import { createLlmClient } from './llm.js';
import { classifyOpportunity } from './capabilities.js';
import { executeExternalOpportunity } from './job-executor.js';
import { opportunityKey } from './job-normalizer.js';
import { createT2000OAuth } from './t2000-oauth.js';
import { infrastructureStatus } from './infrastructure.js';
import { paymentDestinations, selectPayoutRoute } from './payment-router.js';
import { orchestrateJob } from './orchestration.js';
import { AgentMemory } from './memory.js';
import { EventBus } from './event-bus.js';
import { desiredChildCapacity, buildChildRole, groupQueueBySkill } from './autoscaler.js';
import { emitOperationalLog } from './observability.js';
import { AutonomOSCache } from './cache.js';
import { ArtifactStore } from './artifact-store.js';
import { dispatchPaidOpportunity, temporalEnabled } from './temporal-client.js';
import { estimateOutcomeProbability } from './outcome-model.js';
import { ledgerEntry } from './financial-ledger.js';

export function createAutonomOS({ storageDir, siteUrl, ownerWallet, env = process.env, logger = console } = {}) {
  if (!storageDir) throw new Error('AutonomOS requires storageDir');
  const rootDir = path.join(storageDir, 'autonomos');
  const store = new AutonomOSStore(rootDir);
  const llm = createLlmClient(env);
  const wallet = isEvmAddress(ownerWallet) ? ownerWallet : String(env.AUTONOMOS_OWNER_WALLET || '');
  const t2000OAuth = createT2000OAuth({ store, siteUrl, env, logger });
  const memory = new AgentMemory({env,logger});
  const eventBus = new EventBus({env,logger});
  const cache = new AutonomOSCache({env,logger});
  const artifactStore = new ArtifactStore({env});
  Promise.allSettled([memory.init(),eventBus.init(),cache.init(),artifactStore.init()]);
  let credentials = store.readJson('credentials.private.json', {});
  let config = normalizeConfig(store.readJson('config.json', {
    ...DEFAULT_AUTONOMOS_CONFIG,
    enabled:/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_ENABLED || 'false'))
  }));
  let state = store.readJson('state.json', defaultState());
  let agents = buildAgentState(Object.fromEntries((store.readJson('agents.json', []) || []).map(x=>[x.id,x])));
  let children = store.readJson('children.json', []);
  let offers = store.readJson('offers.json', defaultOffers());
  let timer = null;
  let fastTimer = null;
  let cycleRunning = false;
  let fastCycleRunning = false;
  const activeJobs = new Map();
  const seen = new Set(store.readJson('seen-opportunities.json', []));
  const handled = new Set(store.readJson('handled-opportunities.json', []));
  const settledTx = new Set(store.readJson('settled-transactions.json', []));
  // Tracks failed claim attempts per opportunity so transient errors (timeouts, 5xx,
  // network blips) can be retried on a later cycle instead of the opportunity being
  // silently abandoned after one failure — see MAX_CLAIM_ATTEMPTS / claim-retry logic below.
  let claimAttempts = store.readJson('claim-attempts.json', {});
  const MAX_CLAIM_ATTEMPTS = 5;
  const CLAIM_RETRY_BACKOFF_MS = 90_000;
  // Assigned t2000 work remains in the seller queue after a local execution failure.
  // Retry it carefully instead of either stranding it forever (old handled-set behavior)
  // or burning model/API spend every 15 seconds on the same bad job.
  let executionAttempts = store.readJson('execution-attempts.json', {});
  const MAX_EXECUTION_ATTEMPTS = 3;
  const EXECUTION_RETRY_BACKOFF_MS = 5 * 60_000;
  // Jobs that survived past a successful marketplace claim but not yet past delivery —
  // see writeInFlightJob/recoverInFlightJobs for why this exists (P1: claimed-job/restart protection).
  let inFlightJobs = store.readJson('in-flight-jobs.json', {});
  let pendingHumanClaims = store.readJson('pending-human-claims.json', []);
  let pendingDealworkBids = store.readJson('pending-dealwork-bids.json', {});

  let x402Idempotency = store.readJson('x402-idempotency.json', {});
  const x402 = createX402Gateway({ ownerWallet:wallet, siteUrl, env, onSettlement:recordSettlement, idempotency:{
    async get(key){ return x402Idempotency[key] || null; },
    async set(key,value){ x402Idempotency[key]=value; const entries=Object.entries(x402Idempotency); if(entries.length>1000)x402Idempotency=Object.fromEntries(entries.slice(-1000)); store.writeJson('x402-idempotency.json',x402Idempotency); }
  } });
  cleanupExpiredChildren();
  persistCore();
  recoverStartup().catch(()=>{});
  if (config.enabled && !config.killSwitch) schedule();

  return {
    products:MACHINE_PRODUCTS,
    get config(){ return config; },
    get ownerWallet(){ return wallet; },

    async processTemporalOpportunity(opportunity){
      if(!opportunity||typeof opportunity!=='object')return{ok:false,reason:'invalid_opportunity'};
      const result=await processMarketplaceOpportunity(opportunity);
      return{ok:true,...result};
    },

    async snapshot() {
      await syncT2000Credential().catch(()=>{});
      const ledger = store.readNdjson('ledger.ndjson', 4000);
      const events = store.readNdjson('events.ndjson', 500).reverse();
      const opportunities = store.readNdjson('opportunities.ndjson', 500).reverse();
      const jobs = store.readNdjson('jobs.ndjson', 500).reverse();
      const metrics = calculateMetrics(ledger, jobs, opportunities);
      return {
        project:'AutonomOS', version:'2.0.0',
        runtime:{
          ...state,
          status:config.killSwitch ? 'emergency_stopped' : config.enabled ? (cycleRunning ? 'working' : 'running') : 'stopped',
          cycleRunning, activeJobCount:activeJobs.size,
          llm:{ enabled:llm.enabled, provider:llm.provider, model:llm.model }
        },
        config:safeConfig(config),
        treasury:{ ownerWallet:wallet, ...(state.treasury || {}), marketplaceWallets:state.marketplaceWallets||{}, allocations:metrics.allocations },
        metrics, agents, children,
        products:currentProducts().map(product=>({ ...product, payment:x402.status() })),
        connectors:connectorStatuses(env, x402.status(), credentials).map(c=>{ const h=state.connectorHealth?.[c.id]||state.connectorHealth?.[`${c.id}-public`]||null; return h&&c.configured&&!h.ok?{...c,status:'degraded',health:h}:{...c,health:h}; }),
        t2000:{...t2000OAuth.status(),health:state.connectorHealth?.t2000||null,wallet:state.marketplaceWallets?.t2000||null},
        infrastructure:infrastructureStatus(env),
        payouts:paymentDestinations(env),
        opportunities, jobs, events, missing:missingSetup(), pendingHumanClaims, pendingDealworkBidsCount:Object.keys(pendingDealworkBids).length
      };
    },

    updateConfig(patch = {}) {
      const allowed = [
        'genesisObjective','minMarginPercent','reservePercent','growthPercent','experimentPercent',
        'heartbeatSeconds','fastClaimPollSeconds','maxChildren','childSpawnConcurrencyThreshold','childTtlMinutes','autoReplication',
        'maxApiCostPercentOfPayout','maxJobsPerCycle','maxConcurrentJobs','autoClaimJobs','requireEscrowForAutoClaim','minJobPayoutUsd',
        'clawlancerMinJobPayoutUsd','dealworkMinJobPayoutUsd','superteamMinJobPayoutUsd','t2000MinOpenJobPayoutUsd','t2000PriorityOpenJobPayoutUsd','t2000PremiumOpenJobPayoutUsd',
        // P0 fix (external audit): maxPaidProcurementUsd defaults to 0 and was NOT in this
        // list, so even an owner who correctly set zeroSpendMode:false and
        // allowExternalSpending:true through the admin UI still had every paid tool call
        // (Firecrawl/E2B) denied with 'above_spend_limit' — the one field that actually
        // raises the ceiling had no way to be changed outside hand-editing config.json.
        'zeroSpendMode','earnedFundsOnly','allowExternalSpending','seedSpendBudgetUsd','maxPaidProcurementUsd'
      ];
      const next={...config};
      for(const key of allowed) if(Object.prototype.hasOwnProperty.call(patch,key)) next[key]=patch[key];
      config=normalizeConfig(next); store.writeJson('config.json',config); reschedule();
      event('config_updated',{changed:allowed.filter(k=>Object.prototype.hasOwnProperty.call(patch,k))});
      return safeConfig(config);
    },

    start(){config=normalizeConfig({...config,enabled:true,killSwitch:false});state.startedAt=state.startedAt||new Date().toISOString();store.writeJson('config.json',config);event('runtime_started',{});schedule();return{ok:true,status:'running'};},
    stop(){config=normalizeConfig({...config,enabled:false});store.writeJson('config.json',config);clearTimer();event('runtime_stopped',{});return{ok:true,status:'stopped'};},
    emergencyStop(){config=normalizeConfig({...config,enabled:false,killSwitch:true,allowExternalSpending:false,zeroSpendMode:true});store.writeJson('config.json',config);clearTimer();
      // P0 fix (external audit): previously this only set job.cancelled=true, a flag that
      // NOTHING actually checked mid-flight — an already-running LLM/Firecrawl/E2B/GitHub
      // call, or a marketplace delivery POST, would run to completion and could still
      // spend money or submit work after Emergency Stop was pressed. Each active job now
      // carries its own AbortController (set at claim/recovery time); aborting it here
      // actually cancels the in-flight fetch/sandbox call via the signal threaded through
      // job-executor.js → llm.js/tools.js.
      for(const job of activeJobs.values()){job.cancelled=true;try{job.abortController?.abort();}catch{}}
      event('emergency_stop',{activeJobs:activeJobs.size});return{ok:true,status:'emergency_stopped'};},
    clearEmergencyStop(){config=normalizeConfig({...config,killSwitch:false,enabled:false,allowExternalSpending:false,zeroSpendMode:true});store.writeJson('config.json',config);event('emergency_stop_cleared',{});return{ok:true,status:'stopped'};},
    async runCycle(){return cycle('manual');},

    // One-time recovery for the 'credentials missing during bootstrap' misclassification
    // bug: opportunities discovered in the few seconds before a connector finished
    // bootstrapping got permanently blacklisted. This clears that blacklist so the
    // (now-fixed) retry logic gets a fresh chance at the same opportunities. Does NOT
    // touch seen-opportunities.json (pure discovery dedup, safe to keep) or any ledger/
    // treasury data — only the claim-retry bookkeeping.
    resetClaimHistory(){
      handled.clear(); claimAttempts={}; executionAttempts={};
      persistSet('handled-opportunities.json',handled); store.writeJson('claim-attempts.json',claimAttempts); store.writeJson('execution-attempts.json',executionAttempts);
      event('claim_history_reset',{});
      return {ok:true};
    },

    t2000ClientMetadata(){ return t2000OAuth.clientMetadata(); },
    async beginT2000Connect(){
      const result=await t2000OAuth.beginConnect();
      event('t2000_oauth_started',{});
      return result;
    },
    async finishT2000Connect(query={}){
      const status=await t2000OAuth.finishConnect(query);
      await syncT2000Credential({required:true});
      const discovery=await discoverMarketOpportunities({env,credentials,limit:20,sources:['t2000']});
      state.connectorHealth={...(state.connectorHealth||{}),t2000:discovery.health?.t2000||{ok:false,error:'t2000_probe_failed'}};
      updateT2000QualificationHealth(discovery.signals||[]);
      state.marketplaceWallets=await readMarketplaceWallets({env,credentials});
      state.updatedAt=new Date().toISOString();store.writeJson('state.json',state);
      event('t2000_oauth_connected',{openCount:state.connectorHealth.t2000?.openCount||0,sellerQueueCount:state.connectorHealth.t2000?.sellerQueueCount||0});
      return {...status,health:state.connectorHealth.t2000,wallet:state.marketplaceWallets?.t2000||null};
    },
    async refreshT2000Jobs(){
      await syncT2000Credential({required:true});
      const discovery=await discoverMarketOpportunities({env,credentials,limit:Number(env.T2000_DISCOVERY_LIMIT||200),sources:['t2000']});
      state.connectorHealth={...(state.connectorHealth||{}),t2000:discovery.health?.t2000||{ok:false,error:'t2000_probe_failed'}};
      updateT2000QualificationHealth(discovery.signals||[]);
      state.updatedAt=new Date().toISOString();store.writeJson('state.json',state);
      for(const op of discovery.signals||[])recordOpportunity({...op,manualRefresh:true});
      cache.setJson('t2000:last-refresh',{at:new Date().toISOString(),signals:(discovery.signals||[]).slice(0,200),health:state.connectorHealth.t2000},120).catch(()=>{});
      event('t2000_jobs_refreshed',{found:(discovery.signals||[]).length,openCount:state.connectorHealth.t2000?.openCount||0});
      return{ok:true,found:(discovery.signals||[]).length,health:state.connectorHealth.t2000,signals:(discovery.signals||[]).slice(0,200)};
    },

    disconnectT2000(){
      const result=t2000OAuth.disconnect();
      const next={...credentials};delete next.t2000;credentials=next;
      state.connectorHealth={...(state.connectorHealth||{}),t2000:{ok:false,connected:false,error:'t2000_oauth_required'}};
      if(state.marketplaceWallets?.t2000)delete state.marketplaceWallets.t2000;
      state.updatedAt=new Date().toISOString();store.writeJson('state.json',state);
      event('t2000_oauth_disconnected',{});
      return result;
    },

    async refreshTreasury(){
      await syncT2000Credential().catch(()=>{});
      state.treasury=await readTreasuryBalances({address:wallet,env});
      state.marketplaceWallets=await readMarketplaceWallets({env,credentials});
      state.updatedAt=new Date().toISOString();store.writeJson('state.json',state);
      event('treasury_refreshed',{ok:state.treasury.ok,assets:state.treasury.assets?.length||0});
      return {...state.treasury,marketplaceWallets:state.marketplaceWallets};
    },

    async handleProductRequest(productId,req,res){
      const product=currentProduct(productId); if(!product)return res.status(404).json({error:'Unknown product.'});
      return x402.protect({req,res,product,handler:async()=>executeTrackedProduct(product,Object.fromEntries(Object.entries(req.query||{}).map(([k,v])=>[k,String(v??'')])),{paid:true,source:'x402'})});
    },
    async previewProduct(productId,query){const product=currentProduct(productId);if(!product)throw Object.assign(new Error('Unknown product.'),{status:404});return executeTrackedProduct(product,query,{paid:false,source:'admin_preview'});},
    catalog(){return{name:'AutonomOS Machine Services',version:'2.0.0',ownerWallet:wallet,payment:x402.status(),products:currentProducts().map(p=>({...p,url:new URL(p.path,siteUrl).toString()}))};}
  };

  async function cycle(trigger){
    if(cycleRunning)return{ok:false,reason:'cycle_already_running'};
    if(config.killSwitch)return{ok:false,reason:'emergency_stop'};
    if(!config.enabled&&trigger!=='manual')return{ok:false,reason:'runtime_stopped'};
    cycleRunning=true; const cycleId=`cy_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`; const started=Date.now();
    setAgent('prime-governor','working'); setAgent('policy-agent','working'); setAgent('opportunity-radar','working');
    try{
      cleanupExpiredChildren();
      await recoverInFlightJobs({max:Math.max(1,Math.min(3,Number(config.maxConcurrentJobs||4)))}).catch(()=>{});
      await syncT2000Credential().catch(()=>{});
      await pollDealworkBids().catch(()=>{});
      const boot=await bootstrapMarketCredentials({env,credentials,ownerWallet:wallet,storeCredential:(id,value)=>{credentials={...credentials,[id]:value};store.writeSecretJson('credentials.private.json',credentials);}});
      state.bootstrapHealth=boot;
      const discovery=await discoverMarketOpportunities({env,credentials,limit:100}); state.connectorHealth=discovery.health;
      const cycleLedger=store.readNdjson('ledger.ndjson',4000);
      const jobHistory=store.readNdjson('jobs.ndjson',4000);
      const availableSpendUsd=computeEarnedSpendBudgetUsd(cycleLedger,config);
      state.earnedSpendBudgetUsd=availableSpendUsd;
      const cycleConfig={...config,availableSpendUsd};
      const normalized=[];
      for(const opportunity of discovery.signals){
        const cap=classifyOpportunity(opportunity,capabilityContext());
        const outcome=estimateOutcomeProbability(opportunity,cap,jobHistory);
        const feeUsd=Number(opportunity.budgetUsd||0)*Number(opportunity.feePercent||0)/100;
        const econ=evaluateOpportunity({expectedRevenueUsd:Number(opportunity.budgetUsd||0),successProbability:outcome.probability,modelCostUsd:cap.estimatedModelCostUsd,marketplaceFeeUsd:feeUsd,computeCostUsd:0},cycleConfig);
        const payoutRoute=selectPayoutRoute({currency:opportunity.currency,marketplace:opportunity.source,supportedMethods:inferPayoutMethods(opportunity),amountUsd:Number(opportunity.budgetUsd||0)},env);
        const row={...opportunity,capability:cap,outcome,economics:econ,payoutRoute}; normalized.push(row); recordOpportunity(row);
      }
      setAgentMetric('opportunity-radar',{tasks:1});
      updateT2000QualificationHealth(normalized);
      setAgent('demand-analyst','working');state.marketSummary=summarizeOpportunities(normalized);setAgentMetric('demand-analyst',{tasks:1});
      setAgent('competition-agent','working');state.competition=competitionSnapshot(normalized);setAgentMetric('competition-agent',{tasks:1});
      setAgent('economics-agent','working');
      // P1 fix: slice(0,100) in raw discovery order (x402-bazaar first, then clawlancer
      // with up to 100 signals of its own) could fill the entire 100-item cap before
      // Dealwork or t2000 opportunities were ever included — so the diagnostic panel
      // could show 0 Dealwork/t2000 entries not because none existed, but because they
      // never survived the slice. Now it samples per-source so every auto-claimable
      // source is represented regardless of how many x402/clawlancer signals came in.
      state.opportunityEconomics=sampleAcrossSources(normalized,['clawlancer','dealwork','t2000','superteam'],40).map(x=>({source:x.source,externalId:x.externalId,title:x.title,budgetUsd:x.budgetUsd,capability:x.capability,outcome:x.outcome,economics:x.economics,payoutRoute:x.payoutRoute,candidacy:explainCandidacy(x)}));
      setAgentMetric('economics-agent',{tasks:1});

      setAgent('pricing-agent','working');state.offerOptimization=optimizeOffers(normalized.filter(x=>x.source==='x402-bazaar'));setAgentMetric('pricing-agent',{tasks:1});
      setAgent('offer-architect','working');setAgentMetric('offer-architect',{tasks:1}); setAgent('distribution-agent','working');state.catalogReady=true;setAgentMetric('distribution-agent',{tasks:1});

      const candidates=normalized.filter(isAutoClaimCandidate).sort((a,b)=>scoreCandidate(b)-scoreCandidate(a)).slice(0,config.maxJobsPerCycle);
      reconcileElasticWorkers(candidates);
      const processed=await mapLimit(candidates,Number(config.maxConcurrentJobs||4),async opportunity=>{
        if(temporalEnabled(env)){
          const dispatched=await dispatchPaidOpportunity(opportunity,env);
          if(dispatched.ok){event('temporal_job_dispatched',{source:opportunity.source,externalId:opportunity.externalId,workflowId:dispatched.workflowId,duplicate:Boolean(dispatched.duplicate)});return{claimed:false,delivered:false,temporal:true};}
          event('temporal_dispatch_fallback',{source:opportunity.source,externalId:opportunity.externalId,reason:dispatched.reason||''});
        }
        return processMarketplaceOpportunity(opportunity);
      });
      const claimed=processed.filter(x=>x?.claimed).length,delivered=processed.filter(x=>x?.delivered).length,temporalDispatched=processed.filter(x=>x?.temporal).length;

      await syncSettlements();
      if(!state.treasury?.checkedAt||Date.now()-Date.parse(state.treasury.checkedAt||0)>10*60_000){
        setAgent('treasury-cfo','working');state.treasury=await readTreasuryBalances({address:wallet,env});state.marketplaceWallets=await readMarketplaceWallets({env,credentials});setAgentMetric('treasury-cfo',{tasks:1});
      }
      setAgent('evolution-agent','working');state.lastEvolution=boundedEvolution(normalized);setAgentMetric('evolution-agent',{tasks:1});
      state.cycles=Number(state.cycles||0)+1;state.lastCycleAt=new Date().toISOString();state.lastCycleMs=Date.now()-started;state.updatedAt=new Date().toISOString();state.lastCycleId=cycleId;state.lastCycleTrigger=trigger;
      state.lastCycleSummary={opportunities:normalized.length,candidates:candidates.length,claimed,delivered,temporalDispatched,concurrency:Number(config.maxConcurrentJobs||4),elasticChildren:children.filter(c=>c.status==='alive').length};store.writeJson('state.json',state);
      event('cycle_completed',{cycleId,trigger,ms:state.lastCycleMs,opportunities:normalized.length,candidates:candidates.length,claimed,delivered,temporalDispatched});
      return{ok:true,cycleId,ms:state.lastCycleMs,opportunities:normalized.length,candidates:candidates.length,claimed,delivered,temporalDispatched};
    }catch(error){state.lastError=String(error?.message||error).slice(0,400);state.updatedAt=new Date().toISOString();store.writeJson('state.json',state);incrementAgentError('prime-governor');event('cycle_failed',{cycleId,trigger,error:state.lastError});logger.error?.('AutonomOS cycle failed:',error);return{ok:false,cycleId,error:state.lastError};}
    finally{cycleRunning=false;for(const agent of agents)if(agent.status==='working')agent.status='idle';persistAgents();}
  }

  function isTransientClaimFailure(reason){
    const text=String(reason||'').toLowerCase();
    if(/http_5\d\d/.test(text))return true; // server-side error, worth retrying
    if(/http_4\d\d/.test(text))return false; // e.g. 404 not found, 409 already claimed, 401/403 auth
    if(/timeout|timed out|network|econnreset|fetch failed|abort|enotfound|econnrefused/.test(text))return true;
    // '..._api_key_missing' fires during the few seconds a connector's bootstrap
    // registration is still in flight — it is NOT a permanent condition, and treating
    // it as terminal was silently blacklisting good opportunities forever the moment
    // they were unlucky enough to be discovered before bootstrap finished.
    if(/api_key_missing/.test(text))return true;
    if(/not_found|not_available/.test(text))return false;
    return true; // unknown shape — default to retrying a few times rather than losing the job
  }
  // P1 fix (visibility): isAutoClaimCandidate used to just return true/false, so when
  // EVERY discovered opportunity was rejected, nobody — not the owner, not me — could
  // tell whether it was policy (autoClaimJobs off), economics (too expensive vs payout),
  // capability (missing tooling), or something else. Same checks, but now they explain
  // themselves, and that explanation gets stored per-opportunity for the dashboard.
  function explainCandidacy(op){
    const reasons=[];
    const paidAssignedT2000Order=op.source==='t2000'&&op.claimMode==='already_assigned';
    if(!config.autoClaimJobs)reasons.push('auto_claim_disabled_in_policy');
    const key=opportunityKey(op);
    if(!paidAssignedT2000Order&&handled.has(key))reasons.push('already_handled_permanently_rejected_or_delivered');
    const attempt=claimAttempts[key];
    if(!paidAssignedT2000Order&&attempt&&Date.now()-Date.parse(attempt.lastAttemptAt||0)<CLAIM_RETRY_BACKOFF_MS)reasons.push('recent_claim_attempt_still_in_backoff');
    if(paidAssignedT2000Order){
      const executionAttempt=executionAttempts[key];
      if(executionAttempt&&Number(executionAttempt.count||0)>=MAX_EXECUTION_ATTEMPTS)reasons.push(`assigned_execution_retry_limit_reached:${MAX_EXECUTION_ATTEMPTS}`);
      else if(executionAttempt&&Date.now()-Date.parse(executionAttempt.lastAttemptAt||0)<EXECUTION_RETRY_BACKOFF_MS)reasons.push('assigned_execution_retry_backoff');
    }
    if(!['clawlancer','t2000','dealwork','superteam'].includes(op.source))reasons.push('source_not_in_auto_claim_allowlist');
    // Superteam Earn has no escrow concept at all (competitive submission, judged by a
    // human sponsor) — requiring escrowed:true for it would permanently block every
    // Superteam opportunity regardless of quality, so it's exempt from this specific check.
    // Dealwork bid-mode jobs are the same shape while a bid is outstanding: escrow only
    // locks once the buyer accepts a bid, which hasn't happened yet at discovery time.
    if(config.requireEscrowForAutoClaim&&!op.escrowed&&op.source!=='superteam'&&!(op.source==='dealwork'&&op.claimMode==='bid'))reasons.push('not_escrowed_and_escrow_required');
    // A t2000 seller-queue item is not an opportunity we are deciding whether to accept:
    // the buyer has already purchased our published Service and funded/assigned the job.
    // Some seller-queue responses omit the service price; applying discovery-time payout
    // floors or payout-percentage economics to a missing price would strand a real paid
    // order. Capability/safety, owner auto-work policy and execution spend controls still
    // apply, while t2000_job_status supplies the authoritative work order before execution.
    if(!paidAssignedT2000Order&&Number(op.budgetUsd||0)<Number(config.minJobPayoutUsd||0))reasons.push(`budget_below_minJobPayoutUsd:${config.minJobPayoutUsd}`);
    // t2000 has many cent-level Open Jobs. Those are useful for testing the marketplace,
    // but they are not the revenue target of this deployment. Keep seller-queue work that
    // is already assigned to us flowing (we have already accepted that obligation), while
    // refusing to claim any NEW t2000 Open Job below the dedicated floor.
    const marketFloors={clawlancer:Number(config.clawlancerMinJobPayoutUsd||5),dealwork:Number(config.dealworkMinJobPayoutUsd||10),superteam:Number(config.superteamMinJobPayoutUsd||25)};
    if(!paidAssignedT2000Order&&marketFloors[op.source]!==undefined&&Number(op.budgetUsd||0)<marketFloors[op.source])reasons.push(`${op.source}_job_below_floor:${marketFloors[op.source]}`);
    if(op.source==='t2000'&&!paidAssignedT2000Order&&Number(op.budgetUsd||0)<Number(config.t2000MinOpenJobPayoutUsd||35))reasons.push(`t2000_open_job_below_floor:${config.t2000MinOpenJobPayoutUsd}`);
    if(!op.capability?.executable)reasons.push(`capability_not_executable:${op.capability?.mode||'unknown'}`);
    if(!paidAssignedT2000Order&&!op.economics?.allowed)reasons.push(`economics_blocked:${op.economics?.reason||'unknown'}`);
    if(!paidAssignedT2000Order&&op.payoutRoute&&op.payoutRoute.ok===false)reasons.push(`payout_blocked:${op.payoutRoute.reason||'unknown'}`);
    const apiCostCeiling=Number(op.budgetUsd||0)*(Number(config.maxApiCostPercentOfPayout||25)/100);
    if(!paidAssignedT2000Order&&Number(op.capability?.estimatedModelCostUsd||0)>apiCostCeiling)reasons.push(`estimated_model_cost_${op.capability?.estimatedModelCostUsd}_exceeds_${Math.round(Number(config.maxApiCostPercentOfPayout||25))}pct_of_payout_ceiling_${apiCostCeiling.toFixed(4)}`);
    if(!['open','active','available','posted',''].includes(String(op.status||'')))reasons.push(`status_not_open:${op.status}`);
    return { isCandidate:reasons.length===0, reasons };
  }
  function isAutoClaimCandidate(op){ return explainCandidacy(op).isCandidate; }
  function scoreCandidate(op){
    const paidOrder=op.source==='t2000'&&op.claimMode==='already_assigned';
    if(paidOrder)return 1_000_000+Number(op.economics?.expectedProfitUsd||0);
    const budget=Number(op.budgetUsd||0);
    let t2000TierBonus=0;
    if(op.source==='t2000'){
      if(budget>=Number(config.t2000PremiumOpenJobPayoutUsd||100))t2000TierBonus=100_000;
      else if(budget>=Number(config.t2000PriorityOpenJobPayoutUsd||65))t2000TierBonus=50_000;
      else if(budget>=Number(config.t2000MinOpenJobPayoutUsd||35))t2000TierBonus=10_000;
    }
    return t2000TierBonus+Number(op.economics?.expectedProfitUsd||0)*Math.max(0.05,Number(op.outcome?.probability||0.05));
  }

  async function processMarketplaceOpportunity(op){
    const key=opportunityKey(op);
    setAgent('job-router','working');setAgent('policy-agent','working');setAgent('economics-agent','working');
    const jobId=`ext_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`; const startedAt=new Date().toISOString();
    // P1 fix: dealwork.ai bid-mode jobs (the higher-value tier — real published examples
    // run $5-$80+, not the $0.01-0.03 open-mode listings) can't be claimed instantly; per
    // their own documented flow, a bid is submitted and the buyer decides minutes to days
    // later. Submitting the bid is NOT "claiming" the job — nothing is escrowed yet and no
    // work should start — so this returns early here instead of falling into the same
    // claim→execute→deliver pipeline every other opportunity uses. See pollDealworkBids()
    // for what happens once (if) the buyer accepts.
    if(op.source==='dealwork'&&op.claimMode==='bid'){
      store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:'bidding',startedAt});
      const bid=await submitDealworkBid(op,{env,credentials});
      if(!bid.ok){
        handled.add(key);persistSet('handled-opportunities.json',handled);
        store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,status:'bid_failed',at:new Date().toISOString(),reason:bid.reason||''});
        event('market_bid_failed',{jobId,source:op.source,externalId:op.externalId,reason:bid.reason||''});
        return{claimed:false,delivered:false};
      }
      // One bid per job per agent (platform rule) — mark handled immediately so discovery
      // never tries to bid on this same job again; the OUTCOME is tracked separately in
      // pendingDealworkBids so a later 'accepted' status can still be acted on.
      handled.add(key);persistSet('handled-opportunities.json',handled);
      pendingDealworkBids[bid.bidId]={jobId,op,submittedAt:new Date().toISOString()};
      store.writeJson('pending-dealwork-bids.json',pendingDealworkBids);
      store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,status:'bid_submitted',bidId:bid.bidId,at:new Date().toISOString()});
      event('market_bid_submitted',{jobId,source:op.source,externalId:op.externalId,bidId:bid.bidId,proposedAmountUsd:op.budgetUsd});
      return{claimed:false,delivered:false,bidSubmitted:true};
    }
    store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:'claiming',startedAt});event('market_job_claiming',{jobId,source:op.source,externalId:op.externalId,budgetUsd:op.budgetUsd});
    let claim;
    try{
      if(op.source==='t2000')await syncT2000Credential({required:true});
      claim=await claimMarketplaceJob(op,{env,credentials});
    }catch(error){claim={ok:false,reason:String(error?.message||error).slice(0,220)}}
    if(!claim.ok){
      const attempts=Number(claimAttempts[key]?.count||0)+1;
      const terminal=!isTransientClaimFailure(claim.reason)||attempts>=MAX_CLAIM_ATTEMPTS;
      claimAttempts[key]={count:attempts,lastAttemptAt:new Date().toISOString(),reason:claim.reason||''};store.writeJson('claim-attempts.json',claimAttempts);
      if(terminal){handled.add(key);persistSet('handled-opportunities.json',handled);delete claimAttempts[key];store.writeJson('claim-attempts.json',claimAttempts);}
      store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,status:'claim_failed',attempts,terminal,at:new Date().toISOString(),reason:claim.reason||''});
      event('market_job_claim_failed',{jobId,source:op.source,externalId:op.externalId,attempts,terminal,reason:claim.reason||''});
      return{claimed:false,delivered:false};
    }
    // Claim succeeded: this opportunity is now truly spoken for, so it's safe to mark handled.
    handled.add(key);persistSet('handled-opportunities.json',handled);
    if(claimAttempts[key]){delete claimAttempts[key];store.writeJson('claim-attempts.json',claimAttempts);}
    setAgentMetric('job-router',{tasks:1});maybeSpawnChild(op.capability?.skill||op.category||op.source);
    const worker=pickExternalWorker(op.capability?.skill);setWorkerStatus(worker,'working');
    // P0 fix (external audit — Emergency Stop was not a real abort): give this job its own
    // AbortController and store it alongside cancelled:true so emergencyStop() below can
    // actually interrupt an in-flight LLM/Firecrawl/E2B/GitHub call, not just prevent
    // starting a new one.
    const abortController=new AbortController();
    activeJobs.set(jobId,{id:jobId,source:op.source,externalId:op.externalId,workerId:worker.id,cancelled:false,abortController});
    store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,status:'claimed',transactionId:claim.transactionId||'',workerId:worker.id,at:new Date().toISOString()});event('market_job_claimed',{jobId,source:op.source,externalId:op.externalId,transactionId:claim.transactionId||''});
    // P1 fix: persist everything needed to resume AFTER a successful claim. Previously,
    // a claim locked real escrow on the marketplace, but the only record that execution
    // still needed to happen lived in the in-memory activeJobs Map — a Render restart
    // between claim and delivery silently orphaned an already-claimed job forever (no
    // retry path existed since `handled` already excludes it from re-discovery). Now the
    // full op/claim/worker is written to disk and only cleared once delivered — see
    // recoverInFlightJobs() below, called once at startup.
    writeInFlightJob(jobId,{jobId,op,claim,workerId:worker.id,startedAt:new Date().toISOString()});
    let deliverable; // hoisted so the catch block below can still see partial tool spend
    try{
      if(op.source==='t2000'&&claim.workOrderMissing){throw new Error('t2000_work_order_unavailable_refusing_blind_delivery');}
      const execOp=claim.workOrder?{...op,__workOrderRaw:claim.workOrder,description:`${op.description}\n\n[t2000 job_status work order]\n${typeof claim.workOrder==='string'?claim.workOrder:JSON.stringify(claim.workOrder).slice(0,4000)}${op.source==='t2000'?'\n\n[t2000 delivery constraint] Final delivery body must be at most 16 KiB UTF-8. If the result is larger, summarize it and include stable links/hashes where the work order permits.':''}`}:op;
      deliverable=await orchestrateJob(execOp,{llm,memory,env,abortSignal:abortController.signal,onEvent:(type,detail)=>event(type,{jobId,source:op.source,...detail}),execute:(plannedOp)=>executeExternalOpportunity(plannedOp,op.capability,{llm,siteUrl,env,config,abortSignal:abortController.signal,memoryContext:plannedOp.__memoryContext||''})});
      setAgent('qa-evaluator','working'); validateExternalDeliverable(deliverable,execOp);
      if(op.source==='t2000')await syncT2000Credential({required:true});
      const delivery=await deliverMarketplaceJob(op,claim,deliverable,{env,credentials,recordPendingClaim});
      if(!delivery.ok)throw new Error(`delivery_failed:${delivery.reason||'unknown'}`);
      store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,status:'delivered',transactionId:delivery.transactionId||claim.transactionId||'',workerId:worker.id,deliverableHash:deliverable.hash,at:new Date().toISOString()});
      const actualCostUsd=computeActualCostUsd(deliverable,op.capability);
      const toolCostUsd=Number(deliverable.evidence?.toolCostUsd||0);
      setWorkerMetric(worker,{tasks:1,cost:actualCostUsd+toolCostUsd});setAgentMetric('qa-evaluator',{tasks:1});event('market_job_delivered',{jobId,source:op.source,externalId:op.externalId,transactionId:delivery.transactionId||''});
      memory.remember({key:`job:${op.source}:${op.externalId}`,kind:'experience',content:deliverable.content,metadata:{title:op.title,source:op.source,skill:op.capability?.skill,budgetUsd:op.budgetUsd,qa:deliverable.evidence?.qa||null},utility:0.9}).catch(()=>{});
      artifactStore.putText(`jobs/${jobId}/deliverable.md`,deliverable.content,deliverable.format||'text/markdown').catch(()=>{});
      recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:actualCostUsd,kind:'model',estimated:!deliverable.evidence?.usage});
      // P1 fix: Firecrawl/E2B spend was previously invisible to the ledger entirely —
      // recorded here as its own 'tool_api' cost row so Profit Engine accounting
      // (computeEarnedSpendBudgetUsd, netProfitUsd) reflects real tool spend, not just LLM tokens.
      if(toolCostUsd>0)recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:toolCostUsd,kind:'tool_api',estimated:true,note:'firecrawl_e2b_call_cost_estimate'});
      if(executionAttempts[key]){delete executionAttempts[key];store.writeJson('execution-attempts.json',executionAttempts);}
      clearInFlightJob(jobId);
      return{claimed:true,delivered:true};
    }catch(error){
      store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,status:'execution_failed',workerId:worker.id,error:String(error?.message||error).slice(0,300),at:new Date().toISOString()});
      incrementWorkerError(worker);event('market_job_failed',{jobId,source:op.source,externalId:op.externalId,error:String(error?.message||error).slice(0,220)});
      // The LLM call (if any) may already have been billed even though the job failed
      // afterwards (bad output, delivery rejected, etc). Record that spend so it isn't
      // silently absorbed as free — this is exactly the "Revenue $1 / Cost $0" bug.
      // P1 fix: this previously only accounted for the estimated LLM cost — if
      // Firecrawl/E2B calls had already succeeded before a LATER step failed (QA
      // rejection, delivery error), that real tool spend in `deliverable.evidence`
      // was silently dropped because `deliverable` wasn't in scope in this catch block.
      const incurredCostUsd=Number(op.capability?.estimatedModelCostUsd||0);
      const incurredToolCostUsd=Number(deliverable?.evidence?.toolCostUsd||0);
      if(incurredCostUsd>0)recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:incurredCostUsd,kind:'model',estimated:true,note:'job_failed_after_model_call'});
      if(incurredToolCostUsd>0)recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:incurredToolCostUsd,kind:'tool_api',estimated:true,note:'job_failed_after_tool_calls'});
      const previous=executionAttempts[key]||{};
      executionAttempts[key]={count:Number(previous.count||0)+1,lastAttemptAt:new Date().toISOString(),reason:String(error?.message||error).slice(0,220)};
      store.writeJson('execution-attempts.json',executionAttempts);
      // Keep the durable in-flight record after claim. A restart or later recovery cycle
      // must be able to resume the already-owned job instead of silently orphaning it.
      writeInFlightJob(jobId,{...inFlightJobs[jobId],lastError:String(error?.message||error).slice(0,220),retryCount:executionAttempts[key].count,lastFailedAt:new Date().toISOString()});
      return{claimed:true,delivered:false,retryScheduled:executionAttempts[key].count<MAX_EXECUTION_ATTEMPTS};
    }
    finally{activeJobs.delete(jobId);setWorkerStatus(worker,'idle');}
  }

  function writeInFlightJob(jobId,record){inFlightJobs[jobId]=record;store.writeJson('in-flight-jobs.json',inFlightJobs);}
  function clearInFlightJob(jobId){if(!(jobId in inFlightJobs))return;delete inFlightJobs[jobId];store.writeJson('in-flight-jobs.json',inFlightJobs);}
  // Superteam Earn (and any future non-escrow, human-claimed marketplace) can't settle
  // automatically — a human must visit claimUrl with their own wallet. Without this list
  // surfaced somewhere, a win is invisible and the money is functionally unclaimable.
  function recordPendingClaim(entry){ pendingHumanClaims.unshift({...entry, id:`claim_${Date.now().toString(36)}`}); if(pendingHumanClaims.length>50)pendingHumanClaims.length=50; store.writeJson('pending-human-claims.json',pendingHumanClaims); event('pending_human_claim_created',{title:entry.title,claimUrl:entry.claimUrl}); }

  // Runs once at startup: any job that made it past claimMarketplaceJob (escrow already
  // locked on the marketplace) but never reached a terminal 'delivered'/'execution_failed'
  // status before the process stopped gets exactly one resume attempt — re-running
  // execute+deliver (never re-claiming, since the claim already succeeded and re-claiming
  // an already-claimed job would just fail or double-spend escrow). This is best-effort:
  // if the underlying opportunity object is missing fields the connector needs, it fails
  // like any other execution_failed job and is cleared, rather than retried forever.
  // P1 fix: checks every outstanding dealwork.ai bid once per full cycle (bid decisions
  // arrive over minutes-to-days per their own docs, not seconds, so this doesn't need the
  // 15s fast-claim cadence). An 'accepted' bid already has an escrow-locked contract on
  // dealwork's side — this starts it and hands off to the exact same execute+deliver path
  // every other marketplace uses, by constructing the same {ok:true,jobId} shape
  // claimMarketplaceJob would have returned, so deliverMarketplaceJob's existing dealwork
  // branch (deliverables → SUBMIT_WORK) needs no changes at all.
  async function pollDealworkBids(){
    const entries=Object.entries(pendingDealworkBids);
    for(const [bidId,record] of entries){
      const status=await checkDealworkBidStatus(bidId,{env,credentials});
      if(!status.ok)continue; // transient — leave it pending, try again next cycle
      if(status.status==='pending')continue;
      if(status.status!=='accepted'){
        // rejected / withdrawn / expired — nothing more to do, already in `handled`.
        delete pendingDealworkBids[bidId];store.writeJson('pending-dealwork-bids.json',pendingDealworkBids);
        event('market_bid_resolved',{bidId,status:status.status,source:'dealwork'});
        continue;
      }
      if(!status.contractId){continue;} // accepted but contract not linked yet — retry next cycle
      const {jobId,op}=record;
      const worker=pickExternalWorker(op.capability?.skill);setWorkerStatus(worker,'working');
      const abortController=new AbortController();
      activeJobs.set(jobId,{id:jobId,source:op.source,externalId:op.externalId,workerId:worker.id,cancelled:false,abortController});
      let deliverable;
      try{
        const started=await startDealworkContract(status.contractId,{env,credentials});
        if(!started.ok)throw new Error(`dealwork_start_work_failed:${started.reason||'unknown'}`);
        store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,status:'claimed',transactionId:status.contractId,workerId:worker.id,at:new Date().toISOString()});
        event('market_job_claimed',{jobId,source:op.source,externalId:op.externalId,transactionId:status.contractId,recovered:false,fromBid:true});
        const syntheticClaim={ok:true,jobId:status.contractId,transactionId:status.contractId};
        writeInFlightJob(jobId,{jobId,op,claim:syntheticClaim,workerId:worker.id,startedAt:new Date().toISOString(),fromBid:true});
        deliverable=await orchestrateJob(op,{llm,memory,env,abortSignal:abortController.signal,onEvent:(type,detail)=>event(type,{jobId,source:op.source,...detail}),execute:(plannedOp)=>executeExternalOpportunity(plannedOp,op.capability,{llm,siteUrl,env,config,abortSignal:abortController.signal,memoryContext:plannedOp.__memoryContext||''})});
        validateExternalDeliverable(deliverable,op);
        const delivery=await deliverMarketplaceJob(op,syntheticClaim,deliverable,{env,credentials,recordPendingClaim});
        if(!delivery.ok)throw new Error(`delivery_failed:${delivery.reason||'unknown'}`);
        store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,status:'delivered',transactionId:delivery.transactionId||status.contractId,workerId:worker.id,deliverableHash:deliverable.hash,at:new Date().toISOString()});
        const actualCostUsd=computeActualCostUsd(deliverable,op.capability);
        const toolCostUsd=Number(deliverable.evidence?.toolCostUsd||0);
        setWorkerMetric(worker,{tasks:1,cost:actualCostUsd+toolCostUsd});
        recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:actualCostUsd,kind:'model',estimated:!deliverable.evidence?.usage});
        if(toolCostUsd>0)recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:toolCostUsd,kind:'tool_api',estimated:true,note:'firecrawl_e2b_call_cost_estimate'});
        event('market_job_delivered',{jobId,source:op.source,externalId:op.externalId,transactionId:delivery.transactionId||status.contractId,fromBid:true});
        memory.remember({key:`job:${op.source}:${op.externalId}`,kind:'experience',content:deliverable.content,metadata:{title:op.title,source:op.source,skill:op.capability?.skill,budgetUsd:op.budgetUsd,qa:deliverable.evidence?.qa||null},utility:0.9}).catch(()=>{});
        clearInFlightJob(jobId);
        if(executionAttempts[opportunityKey(op)]){delete executionAttempts[opportunityKey(op)];store.writeJson('execution-attempts.json',executionAttempts);}
      }catch(error){
        store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,status:'execution_failed',workerId:worker.id,error:String(error?.message||error).slice(0,300),at:new Date().toISOString()});
        incrementWorkerError(worker);event('market_job_failed',{jobId,source:op.source,externalId:op.externalId,error:String(error?.message||error).slice(0,220),fromBid:true});
        const incurredToolCostUsd=Number(deliverable?.evidence?.toolCostUsd||0);
        if(incurredToolCostUsd>0)recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:incurredToolCostUsd,kind:'tool_api',estimated:true,note:'job_failed_after_tool_calls'});
        const execKey=opportunityKey(op);const previous=executionAttempts[execKey]||{};
        executionAttempts[execKey]={count:Number(previous.count||0)+1,lastAttemptAt:new Date().toISOString(),reason:String(error?.message||error).slice(0,220)};store.writeJson('execution-attempts.json',executionAttempts);
        if(inFlightJobs[jobId])writeInFlightJob(jobId,{...inFlightJobs[jobId],lastError:String(error?.message||error).slice(0,220),retryCount:executionAttempts[execKey].count,lastFailedAt:new Date().toISOString()});
      }finally{
        activeJobs.delete(jobId);setWorkerStatus(worker,'idle');
        delete pendingDealworkBids[bidId];store.writeJson('pending-dealwork-bids.json',pendingDealworkBids);
      }
    }
  }

  async function recoverInFlightJobs({max=3}={}){
    const pending=Object.values(inFlightJobs).filter(record=>record?.jobId&&!activeJobs.has(record.jobId)).slice(0,Math.max(1,Number(max||3)));
    let recovered=0,failed=0,manualAttention=0;
    for(const record of pending){
      const {jobId,op,claim}=record;if(!op||!claim)continue;
      const key=opportunityKey(op);const attempt=executionAttempts[key]||{};
      if(Number(attempt.count||0)>=MAX_EXECUTION_ATTEMPTS){manualAttention++;writeInFlightJob(jobId,{...record,status:'manual_attention',manualAttentionAt:record.manualAttentionAt||new Date().toISOString()});continue;}
      if(attempt.lastAttemptAt&&Date.now()-Date.parse(attempt.lastAttemptAt)<EXECUTION_RETRY_BACKOFF_MS)continue;
      const worker=children.find(c=>c.id===record.workerId&&c.status==='alive')||agents.find(a=>a.id===record.workerId)||pickExternalWorker(op.capability?.skill);
      const abortController=new AbortController();setWorkerStatus(worker,'working');activeJobs.set(jobId,{id:jobId,source:op.source,externalId:op.externalId,workerId:worker.id,cancelled:false,abortController});
      event('market_job_recovery_attempt',{jobId,source:op.source,externalId:op.externalId,attempt:Number(attempt.count||0)+1});
      let deliverable;
      try{
        if(op.source==='t2000'&&claim.workOrderMissing)throw new Error('t2000_work_order_unavailable_refusing_blind_delivery');
        const execOp=claim.workOrder?{...op,__workOrderRaw:claim.workOrder,description:`${op.description}\n\n[t2000 job_status work order]\n${typeof claim.workOrder==='string'?claim.workOrder:JSON.stringify(claim.workOrder).slice(0,4000)}${op.source==='t2000'?'\n\n[t2000 delivery constraint] Final delivery body must be at most 16 KiB UTF-8. If larger, summarize and include stable artifact links/hashes where permitted.':''}`}:op;
        deliverable=await orchestrateJob(execOp,{llm,memory,env,abortSignal:abortController.signal,onEvent:(type,detail)=>event(type,{jobId,source:op.source,...detail}),execute:(plannedOp)=>executeExternalOpportunity(plannedOp,op.capability,{llm,siteUrl,env,config,abortSignal:abortController.signal,memoryContext:plannedOp.__memoryContext||''})});
        validateExternalDeliverable(deliverable,execOp);if(op.source==='t2000')await syncT2000Credential({required:true});
        const delivery=await deliverMarketplaceJob(op,claim,deliverable,{env,credentials,recordPendingClaim});if(!delivery.ok)throw new Error(`delivery_failed:${delivery.reason||'unknown'}`);
        store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,status:'delivered',transactionId:delivery.transactionId||claim.transactionId||'',workerId:worker.id,deliverableHash:deliverable.hash,at:new Date().toISOString(),recovered:true});
        const actualCostUsd=computeActualCostUsd(deliverable,op.capability);const toolCostUsd=Number(deliverable.evidence?.toolCostUsd||0);setWorkerMetric(worker,{tasks:1,cost:actualCostUsd+toolCostUsd});recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:actualCostUsd,kind:'model',estimated:!deliverable.evidence?.usage});if(toolCostUsd>0)recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:toolCostUsd,kind:'tool_api',estimated:true,note:'recovered_job_tool_cost'});
        memory.remember({key:`job:${op.source}:${op.externalId}`,kind:'experience',content:deliverable.content,metadata:{title:op.title,source:op.source,skill:op.capability?.skill,budgetUsd:op.budgetUsd,qa:deliverable.evidence?.qa||null},utility:0.9}).catch(()=>{});artifactStore.putText(`jobs/${jobId}/deliverable.md`,deliverable.content,deliverable.format||'text/markdown').catch(()=>{});
        event('market_job_delivered',{jobId,source:op.source,externalId:op.externalId,transactionId:delivery.transactionId||'',recovered:true});clearInFlightJob(jobId);delete executionAttempts[key];store.writeJson('execution-attempts.json',executionAttempts);recovered++;
      }catch(error){
        failed++;const nextCount=Number(attempt.count||0)+1;executionAttempts[key]={count:nextCount,lastAttemptAt:new Date().toISOString(),reason:String(error?.message||error).slice(0,220)};store.writeJson('execution-attempts.json',executionAttempts);const manual=nextCount>=MAX_EXECUTION_ATTEMPTS;writeInFlightJob(jobId,{...record,lastError:String(error?.message||error).slice(0,220),retryCount:nextCount,lastFailedAt:new Date().toISOString(),status:manual?'manual_attention':'retry_pending',...(manual?{manualAttentionAt:new Date().toISOString()}:{})});
        store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,status:manual?'manual_attention':'execution_failed',workerId:worker.id,error:String(error?.message||error).slice(0,300),at:new Date().toISOString(),recovered:true,retryCount:nextCount});incrementWorkerError(worker);event(manual?'market_job_manual_attention':'market_job_failed',{jobId,source:op.source,externalId:op.externalId,error:String(error?.message||error).slice(0,220),recovered:true,retryCount:nextCount});if(manual)manualAttention++;
      }finally{activeJobs.delete(jobId);setWorkerStatus(worker,'idle');}
    }
    return{ok:true,pending:Object.keys(inFlightJobs).length,recovered,failed,manualAttention};
  }

  function computeActualCostUsd(deliverable,capability){
    const usage=deliverable?.evidence?.usage;
    if(usage&&(usage.prompt_tokens||usage.completion_tokens)){
      const inPerM=Number(env.AUTONOMOS_LLM_INPUT_USD_PER_MILLION||0.25);
      const outPerM=Number(env.AUTONOMOS_LLM_OUTPUT_USD_PER_MILLION||2);
      const inputCost=(Number(usage.prompt_tokens||0)/1e6)*inPerM;
      const outputCost=(Number(usage.completion_tokens||0)/1e6)*outPerM;
      return round(inputCost+outputCost);
    }
    return round(Number(capability?.estimatedModelCostUsd||0));
  }
  function recordCost({jobId,source,externalId,amountUsd,kind,estimated,note}){
    const amount=Math.max(0,Number(amountUsd||0)); if(amount<=0)return;
    store.append('ledger.ndjson',{...ledgerEntry({id:`cost_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,type:'cost',source,jobId,externalId,amountUsd:amount,apiCostUsd:amount,estimated:Boolean(estimated),note:note||'',status:kind||'model'}),kind:kind||'model'});
  }

  async function syncSettlements(){
    await syncT2000Credential().catch(()=>{});
    const sync=await syncMarketplaceTransactions({env,credentials});state.settlementHealth=sync.health;
    for(const tx of sync.transactions){
      if(!tx.externalTransactionId||settledTx.has(`${tx.source}:${tx.externalTransactionId}`))continue;
      if(!['settled','released','completed','paid'].includes(tx.status))continue;
      const key=`${tx.source}:${tx.externalTransactionId}`;settledTx.add(key);persistSet('settled-transactions.json',settledTx);
      const revenueUsd=Math.max(0,Number(tx.amountUsd||0));store.append('ledger.ndjson',ledgerEntry({id:`tx_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,type:'revenue',source:tx.source,externalTransactionId:tx.externalTransactionId,grossUsd:revenueUsd,amountUsd:revenueUsd,currency:tx.currency,network:tx.network,allocation:allocateRevenue(revenueUsd,config),status:'settled'}));
      setAgentMetric('treasury-cfo',{tasks:1,revenue:revenueUsd});event('market_payment_settled',{source:tx.source,transactionId:tx.externalTransactionId,amountUsd:revenueUsd,currency:tx.currency});
    }
  }

  async function executeTrackedProduct(product,query,meta){
    const policy=validateAction({kind:'execute',productId:product.id},{...config,enabled:true});if(!policy.allowed)throw Object.assign(new Error(policy.reason),{status:503,code:policy.reason});
    const jobId=`job_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;const worker=pickProductWorker(product.id);const startedAt=new Date().toISOString();activeJobs.set(jobId,{id:jobId,productId:product.id,workerId:worker.id,startedAt,cancelled:false});maybeSpawnChild(product.id);setAgent('job-router','working');setWorkerStatus(worker,'working');setAgent('security-sentinel','working');store.append('jobs.ndjson',{id:jobId,productId:product.id,source:meta.source,status:'started',workerId:worker.id,startedAt});event('job_started',{jobId,productId:product.id,workerId:worker.id,source:meta.source});
    try{const result=await executeProduct(product.id,query);if(activeJobs.get(jobId)?.cancelled)throw Object.assign(new Error('job_cancelled'),{status:503,code:'job_cancelled'});setAgent('qa-evaluator','working');validateProductResult(result,product.id);store.append('jobs.ndjson',{id:jobId,productId:product.id,source:meta.source,status:'completed',workerId:worker.id,startedAt,completedAt:new Date().toISOString()});setWorkerMetric(worker,{tasks:1});setAgentMetric('job-router',{tasks:1});setAgentMetric('security-sentinel',{tasks:1});setAgentMetric('qa-evaluator',{tasks:1});event('job_completed',{jobId,productId:product.id,workerId:worker.id,paid:meta.paid});return{...result,autonomos:{jobId,worker:worker.name,payment:meta.paid?'verified-before-execution; settlement-after-success':'admin_preview'}};}
    catch(error){store.append('jobs.ndjson',{id:jobId,productId:product.id,source:meta.source,status:'failed',workerId:worker.id,startedAt,completedAt:new Date().toISOString(),error:String(error?.message||error).slice(0,300)});incrementWorkerError(worker);event('job_failed',{jobId,productId:product.id,error:String(error?.message||error).slice(0,200)});throw error;}
    finally{activeJobs.delete(jobId);setWorkerStatus(worker,'idle');setAgent('job-router','idle');setAgent('qa-evaluator','idle');setAgent('security-sentinel','idle');persistAgents();}
  }

  async function recordSettlement(info){
    const revenueUsd=info.live?Number(info.amountUsd||0):0;store.append('ledger.ndjson',{...ledgerEntry({id:`tx_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,type:'revenue',source:'x402',productId:info.product.id,grossUsd:revenueUsd,amountUsd:revenueUsd,displayAmountUsd:Number(info.amountUsd||0),testnet:!info.live,network:info.network,allocation:allocateRevenue(revenueUsd,config),status:info.live?'settled':'testnet'}),at:info.settledAt,payer:info.payer,transaction:info.transaction});setAgentMetric('treasury-cfo',{tasks:1,revenue:revenueUsd});setAgentMetric('distribution-agent',{tasks:1,revenue:revenueUsd});event('payment_settled',{productId:info.product.id,amountUsd:info.amountUsd,asset:info.assetSymbol||'USDC',testnet:!info.live,transaction:info.transaction});
  }

  function recordOpportunity(op){const key=opportunityKey(op);if(seen.has(key))return;seen.add(key);persistSet('seen-opportunities.json',seen);store.append('opportunities.ndjson',{id:crypto.createHash('sha256').update(key).digest('hex').slice(0,20),...stripRaw(op)});}
  function stripRaw(op){const {raw,...rest}=op;return rest;}
  function persistSet(name,set){store.writeJson(name,[...set].slice(-10000));}
  function currentProducts(){return MACHINE_PRODUCTS.map(p=>({...p,priceUsd:Number(offers[p.id]?.priceUsd??p.priceUsd)}));}
  function currentProduct(id){return currentProducts().find(p=>p.id===id)||null;}

  function optimizeOffers(signals){const changes=[];for(const product of MACHINE_PRODUCTS){const tags=new Set(product.tags.map(x=>String(x).toLowerCase()));const comps=signals.filter(s=>Number(s.budgetUsd)>0&&(s.tags||[]).some?.(t=>tags.has(String(t).toLowerCase()))).map(s=>Number(s.budgetUsd)).filter(Number.isFinite);if(comps.length<5)continue;const marketMedian=median(comps);const current=Number(offers[product.id]?.priceUsd??product.priceUsd);const floor=Math.max(.001,product.priceUsd*.5),ceiling=Math.max(floor,product.priceUsd*4),target=Math.max(floor,Math.min(ceiling,marketMedian*.75)),maxStep=Math.max(.001,current*.1),next=round(Math.max(floor,Math.min(ceiling,current+Math.max(-maxStep,Math.min(maxStep,target-current)))));if(Math.abs(next-current)<.0005)continue;offers[product.id]={...(offers[product.id]||{}),priceUsd:next,updatedAt:new Date().toISOString(),basis:'market_median',sampleSize:comps.length};changes.push({productId:product.id,from:current,to:next,marketMedian,samples:comps.length});}if(changes.length){store.writeJson('offers.json',offers);for(const c of changes)event('price_optimized',c);}return{mode:'bounded_market_pricing',changes,at:new Date().toISOString()};}
  function boundedEvolution(signals){const bySource={};for(const s of signals)bySource[s.source]=(bySource[s.source]||0)+1;return{mode:'market_feedback',sources:bySource,at:new Date().toISOString()};}
  function summarizeOpportunities(rows){const jobs=rows.filter(x=>x.escrowed&&x.budgetUsd>0);const executable=jobs.filter(x=>x.capability?.executable);const profitable=executable.filter(x=>x.economics?.allowed);return{observed:rows.length,escrowedJobs:jobs.length,executable:executable.length,profitable:profitable.length,medianPayoutUsd:median(jobs.map(x=>x.budgetUsd)),sources:[...new Set(rows.map(x=>x.source))],at:new Date().toISOString()};}
  function competitionSnapshot(rows){const prices=rows.map(x=>Number(x.budgetUsd)).filter(x=>Number.isFinite(x)&&x>0);return{samples:prices.length,minPayoutUsd:prices.length?Math.min(...prices):0,maxPayoutUsd:prices.length?Math.max(...prices):0,medianPayoutUsd:median(prices),at:new Date().toISOString()};}

  function maybeSpawnChild(specialization){
    const active=children.filter(c=>c.status==='alive');
    const desired=desiredChildCapacity({queueDepth:Math.max(1,activeJobs.size+1),activeJobs:activeJobs.size,currentChildren:active.length,config:{...config,availableSpendUsd:Number(state.earnedSpendBudgetUsd||0)},estimatedCostPerChildUsd:0});
    if(active.length>=desired||active.length>=Number(config.maxChildren||0))return null;
    return spawnChild(specialization,desired);
  }
  function spawnChild(specialization,desiredCapacity=0){
    const active=children.filter(c=>c.status==='alive');if(active.length>=Number(config.maxChildren||0))return null;
    const role=buildChildRole(specialization,active.length);const child={id:`child_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,parent:'replication-manager',specialization,role:role.role,name:role.name,status:'alive',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+config.childTtlMinutes*60_000).toISOString(),budgetUsd:0,zeroSpendMode:true,tasksCompleted:0,revenueUsd:0,costUsd:0,errors:0,runtimeStatus:'idle',queueDepth:0,lastActiveAt:''};children.push(child);store.writeJson('children.json',children);setAgentMetric('replication-manager',{tasks:1});event('child_spawned',{childId:child.id,specialization,role:child.role,budgetUsd:0,desiredCapacity});return child;
  }
  function reconcileElasticWorkers(candidates=[]){
    cleanupExpiredChildren();const active=children.filter(c=>c.status==='alive');const desired=desiredChildCapacity({queueDepth:candidates.length,activeJobs:activeJobs.size,currentChildren:active.length,config:{...config,availableSpendUsd:Number(state.earnedSpendBudgetUsd||0)},estimatedCostPerChildUsd:0});const bySkill=groupQueueBySkill(candidates);
    while(children.filter(c=>c.status==='alive').length<desired){const skill=Object.entries(bySkill).sort((a,b)=>b[1]-a[1])[0]?.[0]||'general-digital';if(!spawnChild(skill,desired))break;bySkill[skill]=Math.max(0,Number(bySkill[skill]||0)-Number(config.childSpawnConcurrencyThreshold||2));}
    const alive=children.filter(c=>c.status==='alive');if(alive.length>desired){const removable=alive.filter(c=>c.runtimeStatus!=='working').sort((a,b)=>Date.parse(a.lastActiveAt||a.createdAt||0)-Date.parse(b.lastActiveAt||b.createdAt||0));for(const child of removable.slice(0,alive.length-desired)){child.status='scaled_down';child.closedAt=new Date().toISOString();event('child_scaled_down',{childId:child.id,specialization:child.specialization});}store.writeJson('children.json',children);}
    return{desired,alive:children.filter(c=>c.status==='alive').length,bySkill};
  }
  function cleanupExpiredChildren(){const now=Date.now();let changed=false;for(const child of children){if(child.status==='alive'&&Date.parse(child.expiresAt||0)<=now){child.status='expired';child.closedAt=new Date().toISOString();changed=true;event('child_expired',{childId:child.id,specialization:child.specialization});}}if(changed)store.writeJson('children.json',children);}
  function pickProductWorker(productId){const child=children.filter(c=>c.status==='alive'&&c.specialization===productId).sort((a,b)=>Number(a.tasksCompleted||0)-Number(b.tasksCompleted||0))[0];if(child)return{...child,name:`Child · ${productId}`,isChild:true};const id=productId==='security-headers'||productId==='robots-audit'?'automation-worker':productId==='technology-fingerprint'?'code-worker':productId==='copy-clarity-signals'||productId==='conversion-signals'?'content-worker':'research-worker';return agents.find(a=>a.id===id)||agents[0];}
  function pickExternalWorker(skill){const map={'web-research':'research-worker','copywriting':'content-worker','code-analysis':'code-worker','translation':'content-worker','data-transform':'automation-worker'};const id=map[skill]||'automation-worker';const child=children.filter(c=>c.status==='alive'&&c.specialization===skill).sort((a,b)=>(a.runtimeStatus==='working'?1:0)-(b.runtimeStatus==='working'?1:0)||Number(a.tasksCompleted||0)-Number(b.tasksCompleted||0))[0];return child?{...child,name:`Child · ${skill}`,isChild:true}:agents.find(a=>a.id===id)||agents[0];}
  function setWorkerStatus(worker,status){if(!worker?.isChild)return setAgent(worker?.id,status);const child=children.find(c=>c.id===worker.id);if(!child)return;child.runtimeStatus=status;if(status==='working')child.lastActiveAt=new Date().toISOString();store.writeJson('children.json',children);}
  function setWorkerMetric(worker,{tasks=0,revenue=0,cost=0}={}){if(!worker?.isChild)return setAgentMetric(worker?.id,{tasks,revenue,cost});const child=children.find(c=>c.id===worker.id);if(!child)return;child.tasksCompleted=Number(child.tasksCompleted||0)+Number(tasks||0);child.revenueUsd=round(Number(child.revenueUsd||0)+Number(revenue||0));child.costUsd=round(Number(child.costUsd||0)+Number(cost||0));child.lastActiveAt=new Date().toISOString();store.writeJson('children.json',children);}
  function incrementWorkerError(worker){if(!worker?.isChild)return incrementAgentError(worker?.id);const child=children.find(c=>c.id===worker.id);if(!child)return;child.errors=Number(child.errors||0)+1;child.lastActiveAt=new Date().toISOString();store.writeJson('children.json',children);}
  function validateProductResult(result,productId){if(!result||typeof result!=='object')throw Object.assign(new Error('qa_invalid_result'),{status:502});if(result.product!==productId)throw Object.assign(new Error('qa_product_mismatch'),{status:502});if(!result.generatedAt)throw Object.assign(new Error('qa_timestamp_missing'),{status:502});}
  function validateExternalDeliverable(d,op){
    if(!d||!String(d.content||'').trim())throw new Error('qa_empty_deliverable');
    const content=String(d.content);
    if(content.length>100000)throw new Error('qa_deliverable_too_large');
    if(/password|seed phrase|private key/i.test(op.description)&&!/public key/i.test(op.description))throw new Error('qa_sensitive_task_rejected');

    // Deterministic outputs (dictionary translation, security-header audits, etc.) come
    // from code, not an LLM, so they cannot contain a refusal/echo and are trusted as-is.
    if(d.evidence?.mode==='deterministic_dictionary'||d.evidence?.mode==='deterministic_product')return true;

    // Below this point the deliverable came from an LLM call — check it actually
    // attempted the task instead of refusing, apologizing, or padding with filler.
    const REFUSAL_PATTERNS=/\b(i cannot|i can'?t|i'm unable|i am unable|as an ai|i don'?t have access|i'm not able to|sorry,? (i|but))\b/i;
    if(REFUSAL_PATTERNS.test(content.slice(0,400)))throw new Error('qa_refusal_or_apology_detected');

    // A deliverable that's mostly a verbatim echo of the task text is not completed work.
    const normalizedContent=content.toLowerCase().replace(/\s+/g,' ').trim();
    const normalizedTask=String(op.description||'').toLowerCase().replace(/\s+/g,' ').trim();
    if(normalizedTask.length>40&&normalizedContent.length<normalizedTask.length*1.2&&normalizedContent.includes(normalizedTask.slice(0,Math.min(80,normalizedTask.length)))){
      throw new Error('qa_deliverable_echoes_task_not_completed');
    }

    // Sanity floor: a real deliverable for a paid job is essentially never single-digit
    // characters long (empty check above catches truly empty, this catches near-empty).
    if(content.trim().length<15)throw new Error('qa_deliverable_too_short');

    // Best-effort acceptance-criteria check against t2000's real work order, when we
    // managed to fetch one via job_status. Not a full grader, but catches the most
    // common t2000 rejection cause the audit flagged: ignoring a stated required format.
    const workOrderText=typeof op.__workOrderRaw==='string'?op.__workOrderRaw:op.__workOrderRaw?JSON.stringify(op.__workOrderRaw):'';
    if(workOrderText){
      const requiredFormat=(workOrderText.match(/required format:?\s*["'`]?([a-z0-9./+-]{2,20})/i)||[])[1];
      if(requiredFormat&&!content.toLowerCase().includes(requiredFormat.toLowerCase())&&!(d.format||'').toLowerCase().includes(requiredFormat.toLowerCase())){
        throw new Error(`qa_required_format_mismatch:${requiredFormat}`);
      }
    }
    return true;
  }
  function setAgent(id,status){const a=agents.find(x=>x.id===id);if(!a)return;a.status=status;if(status==='working')a.lastActiveAt=new Date().toISOString();}
  function setAgentMetric(id,{tasks=0,revenue=0,cost=0}={}){const a=agents.find(x=>x.id===id);if(!a)return;a.tasksCompleted+=Number(tasks||0);a.revenueUsd=round(a.revenueUsd+Number(revenue||0));a.costUsd=round(a.costUsd+Number(cost||0));a.lastActiveAt=new Date().toISOString();persistAgents();}
  function incrementAgentError(id){const a=agents.find(x=>x.id===id);if(!a)return;a.errors+=1;a.lastActiveAt=new Date().toISOString();persistAgents();}
  function calculateMetrics(ledger,jobs,opportunities){const dayAgo=Date.now()-86400000;const revenue=ledger.filter(x=>x.type==='revenue'&&!x.testnet).reduce((s,x)=>s+Number(x.amountUsd||0),0);const cost=ledger.filter(x=>x.type==='cost').reduce((s,x)=>s+Number(x.amountUsd||0),0);const r24=ledger.filter(x=>x.type==='revenue'&&!x.testnet&&Date.parse(x.at||0)>=dayAgo).reduce((s,x)=>s+Number(x.amountUsd||0),0);const c24=ledger.filter(x=>x.type==='cost'&&Date.parse(x.at||0)>=dayAgo).reduce((s,x)=>s+Number(x.amountUsd||0),0);const latestByJob=latestStatuses(jobs);const statuses=Object.values(latestByJob).map(x=>x.status);return{totalRevenueUsd:round(revenue),totalCostUsd:round(cost),netProfitUsd:round(revenue-cost),revenue24hUsd:round(r24),cost24hUsd:round(c24),net24hUsd:round(r24-c24),completedJobs:statuses.filter(x=>['completed','delivered','settled','paid'].includes(x)).length,failedJobs:statuses.filter(x=>String(x).includes('failed')).length,claimedJobs:statuses.filter(x=>['claimed','delivered','settled','paid'].includes(x)).length,deliveredJobs:statuses.filter(x=>['delivered','settled','paid'].includes(x)).length,paidJobs:ledger.filter(x=>x.type==='revenue'&&!x.testnet).length,opportunitiesFound:opportunities.length,activeAgents:agents.filter(x=>x.status!=='disabled').length,activeChildren:children.filter(x=>x.status==='alive').length,allocations:allocateRevenue(Math.max(0,revenue-cost),config)};}
  function latestStatuses(jobs){const out={};for(const row of [...jobs].reverse()){const k=row.id||`${row.source}:${row.externalId}`;out[k]=row;}return out;}
  function missingSetup(){const statuses=connectorStatuses(env,x402.status(),credentials);const missing=[];if(!isEvmAddress(wallet))missing.push({item:'Owner treasury wallet',status:'missing',detail:'Set AUTONOMOS_OWNER_WALLET to a public EVM address.'});if(!x402.status().configured)missing.push({item:'Live x402 seller rail',status:'missing',detail:'Enable x402 with a facilitator.'});if(!llm.enabled)missing.push({item:'Reasoning model',status:'optional_but_limits_jobs',detail:'Without an LLM, AutonomOS only auto-claims jobs it can complete deterministically.'});for(const c of statuses.filter(x=>['needs_credentials','needs_configuration'].includes(x.status)))missing.push({item:c.name,status:'external_setup',detail:`Needs: ${(c.missing||[]).join(', ')}`});return missing;}
  function safeConfig(value){const{allowExternalSpending,maxPaidProcurementUsd,...rest}=value;return{...rest,allowExternalSpending:Boolean(allowExternalSpending),maxPaidProcurementUsd:Number(maxPaidProcurementUsd||0),ownerWallet:wallet,privateKeysStored:false};}
  async function syncT2000Credential({required=false}={}){
    const token=await t2000OAuth.getAccessToken({required});
    const next={...credentials};
    if(token)next.t2000={accessToken:token,source:'passport_connect_oauth'};else delete next.t2000;
    credentials=next;
    return token;
  }
  function updateT2000QualificationHealth(rows=[]){
    const h=state.connectorHealth?.t2000;
    if(!h)return;
    const open=(rows||[]).filter(op=>op.source==='t2000'&&op.claimMode!=='already_assigned');
    const min=Number(config.t2000MinOpenJobPayoutUsd||35);
    const priority=Number(config.t2000PriorityOpenJobPayoutUsd||65);
    const premium=Number(config.t2000PremiumOpenJobPayoutUsd||100);
    state.connectorHealth.t2000={...h,openFloorUsd:min,eligibleOpenCount:open.filter(op=>Number(op.budgetUsd||0)>=min).length,priorityOpenCount:open.filter(op=>Number(op.budgetUsd||0)>=priority).length,premiumOpenCount:open.filter(op=>Number(op.budgetUsd||0)>=premium).length};
  }
  async function recoverStartup(){await syncT2000Credential().catch(()=>{});await recoverInFlightJobs();}
  function schedule(){clearTimer();if(!config.enabled||config.killSwitch)return;timer=setInterval(()=>cycle('heartbeat').catch(()=>{}),config.heartbeatSeconds*1000);timer.unref?.();setTimeout(()=>cycle('startup').catch(()=>{}),1200).unref?.();if(config.autoClaimJobs){fastTimer=setInterval(()=>fastClaimCycle().catch(()=>{}),config.fastClaimPollSeconds*1000);fastTimer.unref?.();}}
  function clearTimer(){if(timer)clearInterval(timer);timer=null;if(fastTimer)clearInterval(fastTimer);fastTimer=null;}
  // Fast lane: on Clawlancer/t2000, first-claim-wins, so the audit flagged the default
  // 60s heartbeat as too slow. This polls ONLY those two connectors' already-verified
  // listing endpoints (no new/unverified APIs) and runs the same claim state machine as
  // the full cycle, so it shares seen/handled/claimAttempts safely — it just does none of
  // the heavier per-cycle work (treasury refresh, offer pricing, competition snapshot).
  async function fastClaimCycle(){
    if(fastCycleRunning||cycleRunning)return{ok:false,reason:'cycle_busy'};
    if(config.killSwitch||!config.enabled||!config.autoClaimJobs)return{ok:false,reason:'not_applicable'};
    fastCycleRunning=true;
    try{
      await syncT2000Credential().catch(()=>{});
      const discovery=await discoverMarketOpportunities({env,credentials,limit:60,sources:['clawlancer','t2000','dealwork']});
      const cycleLedger=store.readNdjson('ledger.ndjson',4000);
      const jobHistory=store.readNdjson('jobs.ndjson',4000);
      const cycleConfig={...config,availableSpendUsd:computeEarnedSpendBudgetUsd(cycleLedger,config)};
      const normalized=discovery.signals.map(opportunity=>{
        const cap=classifyOpportunity(opportunity,capabilityContext());
        const outcome=estimateOutcomeProbability(opportunity,cap,jobHistory);
        const feeUsd=Number(opportunity.budgetUsd||0)*Number(opportunity.feePercent||0)/100;
        const econ=evaluateOpportunity({expectedRevenueUsd:Number(opportunity.budgetUsd||0),successProbability:outcome.probability,modelCostUsd:cap.estimatedModelCostUsd,marketplaceFeeUsd:feeUsd,computeCostUsd:0},cycleConfig);
        const payoutRoute=selectPayoutRoute({currency:opportunity.currency,marketplace:opportunity.source,supportedMethods:inferPayoutMethods(opportunity),amountUsd:Number(opportunity.budgetUsd||0)},env);
        const row={...opportunity,capability:cap,outcome,economics:econ,payoutRoute}; recordOpportunity(row); return row;
      });
      updateT2000QualificationHealth(normalized);
      const candidates=normalized.filter(isAutoClaimCandidate).sort((a,b)=>scoreCandidate(b)-scoreCandidate(a)).slice(0,config.maxJobsPerCycle);reconcileElasticWorkers(candidates);
      const rows=await mapLimit(candidates,Number(config.maxConcurrentJobs||4),async op=>{if(temporalEnabled(env)){const dispatched=await dispatchPaidOpportunity(op,env);if(dispatched.ok){event('temporal_job_dispatched',{source:op.source,externalId:op.externalId,workflowId:dispatched.workflowId,duplicate:Boolean(dispatched.duplicate),fastLane:true});return{temporal:true};}event('temporal_dispatch_fallback',{source:op.source,externalId:op.externalId,reason:dispatched.reason||'',fastLane:true});}return processMarketplaceOpportunity(op);});
      return{ok:true,found:normalized.length,processed:rows.filter(x=>!x?.temporal).length,temporalDispatched:rows.filter(x=>x?.temporal).length};
    }catch(error){return{ok:false,reason:String(error?.message||error).slice(0,200)};}
    finally{fastCycleRunning=false;}
  }
  function capabilityContext(){return{llmEnabled:llm.enabled,hasGithubPrTool:Boolean(env.GITHUB_TOKEN),hasShellTool:Boolean(env.E2B_API_KEY),hasBrowserTool:Boolean(env.BROWSERBASE_API_KEY&&env.BROWSERBASE_PROJECT_ID),hasDeployTool:Boolean(env.AUTONOMOS_DEPLOY_WEBHOOK_URL),hasArtifactTool:Boolean(env.S3_ENDPOINT&&env.S3_BUCKET&&env.S3_ACCESS_KEY_ID&&env.S3_SECRET_ACCESS_KEY),hasAppTool:Boolean(env.COMPOSIO_API_KEY)};}
  function inferPayoutMethods(op){if(op?.source==='clawlancer')return['crypto'];if(['t2000','dealwork','superteam'].includes(op?.source))return['marketplace'];return Array.isArray(op?.supportedMethods)?op.supportedMethods:[];}
  async function mapLimit(items,limit,worker){const rows=Array.from(items||[]);const out=new Array(rows.length);let cursor=0;const runners=Array.from({length:Math.min(rows.length,Math.max(1,Number(limit||1)))},async()=>{while(true){const index=cursor++;if(index>=rows.length)return;try{out[index]=await worker(rows[index],index);}catch(error){out[index]={ok:false,error:String(error?.message||error).slice(0,220)};}}});await Promise.all(runners);return out;}
  function reschedule(){if(config.enabled&&!config.killSwitch)schedule();} function persistAgents(){store.writeJson('agents.json',agents);} function persistCore(){store.writeJson('config.json',config);store.writeJson('state.json',state);persistAgents();store.writeJson('children.json',children);store.writeJson('offers.json',offers);} function event(type,detail){const row={at:new Date().toISOString(),type,...detail};store.append('events.ndjson',row);eventBus.publish(type,row).catch(()=>{});emitOperationalLog(row,{env}).catch(()=>{});}
}

function defaultOffers(){return Object.fromEntries(MACHINE_PRODUCTS.map(p=>[p.id,{priceUsd:p.priceUsd,updatedAt:'',basis:'initial'}]));}
function defaultState(){return{createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),startedAt:'',cycles:0,lastCycleAt:'',lastCycleMs:0,lastCycleId:'',lastCycleTrigger:'',lastError:'',treasury:{ok:false,usdc:0,usdt:0,eth:0,checkedAt:''},marketplaceWallets:{},connectorHealth:{},marketSummary:{},competition:{},catalogReady:false};}
function median(values){if(!values.length)return 0;const s=[...values].sort((a,b)=>a-b),m=Math.floor(s.length/2);return round(s.length%2?s[m]:(s[m-1]+s[m])/2);}function round(v){return Math.round((Number(v||0)+Number.EPSILON)*1e6)/1e6;}
function sampleAcrossSources(rows,sources,perSource){const out=[];for(const source of sources)out.push(...rows.filter(r=>r.source===source).slice(0,perSource));return out;}
