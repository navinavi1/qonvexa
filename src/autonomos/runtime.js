import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { CORE_AGENTS, buildAgentState } from './agents.js';
import { AutonomOSStore } from './store.js';
import { normalizeConfig, DEFAULT_AUTONOMOS_CONFIG, validateAction, isDemoOrTestOpportunity } from './policy-engine.js';
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
import { emitOperationalLog } from './observability.js';
import { AutonomOSCache } from './cache.js';
import { ArtifactStore } from './artifact-store.js';
import { dispatchPaidOpportunity, temporalEnabled } from './temporal-client.js';
import { dispatchTriggerPaidOpportunity, triggerEnabled } from './trigger-client.js';
import { estimateOutcomeProbability } from './outcome-model.js';
import { ledgerEntry } from './financial-ledger.js';
import { TaskAgentRuntime } from './task-agent-runtime.js';
import { buildAcceptanceContract, validateAcceptanceContract, buildEvidencePack } from './acceptance-engine.js';
import { buildLearningSnapshot, recommendActions, scoreOpportunity, createJobIdentity, canTransition } from './agency-intelligence.js';
import { JobRegistry, classifyFailure } from './job-registry.js';

// Whether a processMarketplaceOpportunity() result should be reported as ok:true to a
// durable dispatcher (Trigger.dev/Temporal), whose own retry only makes sense before
// anything is committed on the marketplace side. Once claimed/bid, re-running the whole
// opportunity from scratch would re-attempt claimMarketplaceJob() and risk a double
// claim/bid — recovery for an already-claimed job is recoverInFlightJobs()'s job, not
// the durable dispatcher's transport-level retry.
export function shouldReportSuccessToDurableDispatcher(result){
  return Boolean(result?.claimed)||Boolean(result?.bidSubmitted)||Boolean(result?.durable)||Boolean(result?.delivered);
}

// Order-independent by design: compares timestamps rather than relying on the caller
// passing rows in any particular order. jobs.ndjson is append-only, so a row's own 'at'
// (or 'startedAt' for a job's very first row, which predates the 'at' field convention)
// is a reliable ordering key regardless of array order. Previously this relied on the
// caller pre-reversing jobs.ndjson into newest-first order — correct today only because
// the one call site happened to do that, but silently wrong for any other order.
export function latestStatuses(jobs){
  const out={};
  for(const row of jobs||[]){
    const k=row.id||`${row.source}:${row.externalId}`;
    if(!k)continue;
    const ts=String(row.at||row.startedAt||'');
    const existing=out[k];
    if(!existing||ts>=String(existing.at||existing.startedAt||''))out[k]=row;
  }
  return out;
}

// Each candidate's own economics were already checked against availableSpendUsd
// individually (evaluateOpportunity), but that check used the SAME static snapshot for
// every candidate in the cycle — nothing tracked that several selected together could
// jointly spend several times the actual earned budget. Skips (doesn't stop at) any
// candidate that would push the running total over budget, so a cheaper, lower-ranked
// one further down the list still gets a chance to fit.
export function selectBudgetAwareCandidates(rankedRows,cycleConfig,earnedBudgetUsd,onSkip=()=>{}){
  const capSpend=!cycleConfig.zeroSpendMode&&cycleConfig.earnedFundsOnly&&!cycleConfig.allowExternalSpending;
  const maxJobs=Math.max(1,Number(cycleConfig.maxJobsPerCycle||1));
  const picked=[];
  let cumulativeUsd=0;
  for(const row of rankedRows){
    if(picked.length>=maxJobs)break;
    const rowCostUsd=Number(row.economics?.outOfPocketCostUsd||0);
    if(capSpend&&cumulativeUsd+rowCostUsd>earnedBudgetUsd+0.000001){
      onSkip({source:row.source,externalId:row.externalId,rowCostUsd,cumulativeUsd,earnedBudgetUsd});
      continue;
    }
    picked.push(row); cumulativeUsd+=rowCostUsd;
  }
  return picked;
}

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
  const jobRegistry = new JobRegistry({store});
  const taskAgents = new TaskAgentRuntime({env,onEvent:(type,detail)=>event(type,detail)});
  let learning = store.readJson('learning.json', {generatedAt:'',sampleSize:0,sources:{},skills:{},outcomes:{},opportunitiesObserved:0});
  // Agency Intelligence is advisory: it may rank already-qualified jobs, but it cannot
  // weaken safety, spend, credential, payout or QA policy.

  const integrationsReady=Promise.allSettled([memory.init(),eventBus.init(),cache.init(),artifactStore.init()]);
  let credentials = store.readJson('credentials.private.json', {});
  let config = normalizeConfig(store.readJson('config.json', {
    ...DEFAULT_AUTONOMOS_CONFIG,
    enabled:/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_ENABLED || 'false'))
  }));
  let state = store.readJson('state.json', defaultState());
  let agents = buildAgentState(Object.fromEntries((store.readJson('agents.json', []) || []).map(x=>[x.id,x])));
  let children = [];
  // v13 migration: legacy persistent child-agent pool is retired. Workers are job-scoped.
  store.writeJson('children.json', children);
  let offers = store.readJson('offers.json', defaultOffers());
  let timer = null;
  let fastTimer = null;
  let cycleRunning = false;
  let fastCycleRunning = false;
  const activeJobs = new Map();
  const seen = new Set(store.readJson('seen-opportunities.json', []));
  // Real, observable use of the Job State Machine: track each job's last known status
  // and flag (non-blocking — this is telemetry, not a gate, since jobs.ndjson has
  // always been append-only and changing that now would be a much bigger, riskier
  // change) any transition the state machine doesn't recognize. Previously
  // canTransition()/JOB_STATES existed only in agency-intelligence.js and a unit test —
  // nothing in the running system ever called them.
  const lastJobStatus=new Map();
  for(const [id,row] of Object.entries(latestStatuses(store.readNdjson('jobs.ndjson',4000)))){
    if(row?.status)lastJobStatus.set(id,String(row.status));
  }
  function appendJobStatus(record){
    const id=String(record?.id||'');
    const nextStatus=String(record?.status||'');
    const previousStatus=id?lastJobStatus.get(id):undefined;
    if(id&&previousStatus&&nextStatus&&!canTransition(previousStatus,nextStatus)){
      event('job_state_transition_blocked',{jobId:id,from:previousStatus,to:nextStatus});
      throw new Error(`invalid_job_transition:${previousStatus}->${nextStatus}`);
    }
    if(id&&nextStatus)lastJobStatus.set(id,nextStatus);
    store.append('jobs.ndjson',record);
  }
  const handled = new Set(store.readJson('handled-opportunities.json', []));
  // One-time v7.1 state migration: legacy handled jobs are classified into immutable
  // market/policy tombstones or our-system holds before the runtime starts scanning.
  const registryMigration=store.readJson('job-registry-migration-v71.json',null);
  if(!registryMigration){
    const migrated=jobRegistry.migrateLegacy({handledKeys:[...handled],jobs:store.readNdjson('jobs.ndjson',0)});
    store.writeJson('job-registry-migration-v71.json',{...migrated,at:new Date().toISOString()});
  }
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
  // Separate from executionAttempts on purpose: a delivery failure with an HTTP 4xx/5xx
  // status is the MARKETPLACE'S OWN submission API failing, not something our retries or
  // an operator's "Reset auto-claim history" click can fix. Without this, resetting wipes
  // executionAttempts too, and the same jobs that are failing purely because of a marketplace
  // outage flood right back in on the very next cycle.
  let platformFailures = store.readJson('platform-side-failures.json', {});
  const PLATFORM_FAILURE_COOLDOWN_MS = Number(env.AUTONOMOS_PLATFORM_FAILURE_COOLDOWN_MS || 6 * 60 * 60_000);
  // Matches errors like delivery_failed:http_403:Internal Server Error or http_500 — the
  // marketplace's own submission endpoint rejecting/erroring, not our QA or execution logic.
  const PLATFORM_SIDE_ERROR_PATTERN = /delivery_failed:http_[45]\d\d/i;
  function recordIfPlatformSideFailure(key,errorMessage){
    if(!PLATFORM_SIDE_ERROR_PATTERN.test(String(errorMessage||'')))return;
    const previous=platformFailures[key]||{};
    platformFailures[key]={count:Number(previous.count||0)+1,lastFailedAt:new Date().toISOString(),reason:String(errorMessage).slice(0,220)};
    store.writeJson('platform-side-failures.json',platformFailures);
    event('platform_side_delivery_failure_cooldown_started',{key,cooldownMs:PLATFORM_FAILURE_COOLDOWN_MS});
  }
  function platformFailureCooldownRemainingMs(key){
    const entry=platformFailures[key];
    if(!entry)return 0;
    const elapsed=Date.now()-Date.parse(entry.lastFailedAt||0);
    return Math.max(0,PLATFORM_FAILURE_COOLDOWN_MS-elapsed);
  }
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
  persistCore();
  const recoveryReady=integrationsReady.then(()=>recoverStartup()).catch(()=>{});
  if (config.enabled && !config.killSwitch) schedule();

  return {
    products:MACHINE_PRODUCTS,
    get config(){ return config; },
    get ownerWallet(){ return wallet; },

    async processDurableOpportunity(opportunity){
      if(!opportunity||typeof opportunity!=='object')return{ok:false,reason:'invalid_opportunity'};
      const result=await processMarketplaceOpportunity(opportunity);
      return{ok:shouldReportSuccessToDurableDispatcher(result),...result};
    },

    // Backward-compatible alias for the deferred Temporal worker.
    async processTemporalOpportunity(opportunity){
      return this.processDurableOpportunity(opportunity);
    },

    async snapshot() {
      await syncT2000Credential().catch(()=>{});
      const ledger = store.readNdjson('ledger.ndjson', 4000);
      const events = store.readNdjson('events.ndjson', 500).reverse();
      const opportunities = store.readNdjson('opportunities.ndjson', 500).reverse();
      const jobs = store.readNdjson('jobs.ndjson', 500).reverse();
      taskAgents.retireOrphans([...activeJobs.keys()]);
      const metrics = calculateMetrics(ledger, jobs, opportunities, seen.size);
      return {
        project:'AutonomOS', version:'7.1.0',
        runtime:{
          ...state,
          status:config.killSwitch ? 'emergency_stopped' : config.enabled ? (cycleRunning ? 'working' : 'running') : 'stopped',
          cycleRunning, activeJobCount:activeJobs.size,
          queueDepth:Number(state.lastCycleSummary?.candidates||0),
          taskAgents:taskAgents.summary(),
          activeJobs:[...activeJobs.values()].map(job=>({id:job.id,source:job.source||'',externalId:job.externalId||'',title:job.title||'',productId:job.productId||'',workerId:job.workerId||'',startedAt:job.startedAt||'',etaAt:job.etaAt||'',estimatedMinutes:Number(job.estimatedMinutes||0),deadline:job.deadline||'',budgetUsd:Number(job.budgetUsd||0),currency:job.currency||'',claimMode:job.claimMode||'',escrowed:Boolean(job.escrowed)})),
          llm:llm.status ? llm.status() : { enabled:llm.enabled, available:llm.enabled, provider:llm.provider, model:llm.model },
          jobRegistry:{summary:jobRegistry.summary(),queues:jobRegistry.queues({limit:100})},
          incidents:buildIncidents()
        },
        config:safeConfig(config),
        treasury:{ ownerWallet:wallet, ...(state.treasury || {}), marketplaceWallets:state.marketplaceWallets||{}, allocations:metrics.allocations },
        metrics, agents, children, taskAgents:taskAgents.snapshot(),
        products:currentProducts().map(product=>({ ...product, payment:x402.status() })),
        connectors:connectorStatuses(env, x402.status(), credentials).map(c=>{ const h=state.connectorHealth?.[c.id]||state.connectorHealth?.[`${c.id}-public`]||null; return h&&c.configured&&!h.ok?{...c,status:'degraded',health:h}:{...c,health:h}; }),
        t2000:{...t2000OAuth.status(),health:state.connectorHealth?.t2000||null,wallet:state.marketplaceWallets?.t2000||null},
        infrastructure:infrastructureStatus(env),
        payouts:paymentDestinations(env),
        opportunities, jobs, events, missing:missingSetup(), pendingHumanClaims,
        jobRegistry:{summary:jobRegistry.summary(),queues:jobRegistry.queues({limit:80})},
        pendingDealworkBidsCount:Object.keys(pendingDealworkBids).length,
        agencyIntelligence:{
          version:'4.0.0',
          learning,
          recommendations:recommendActions(learning),
          guarantees:[
            'learning_only_ranks_qualified_work',
            'learning_cannot_change_safety_or_spend_limits',
            'job_identity_is_idempotent_by_source_and_external_id',
            'paid_execution_is_claimed_once_then_recovered_durably'
          ]
        }
      };
    },

    updateConfig(patch = {}) {
      const allowed = [
        'genesisObjective','minMarginPercent','reservePercent','growthPercent','experimentPercent',
        'heartbeatSeconds','fastClaimPollSeconds','maxChildren','childSpawnConcurrencyThreshold','childTtlMinutes','autoReplication',
        'maxApiCostPercentOfPayout','maxJobsPerCycle','maxConcurrentJobs','autoClaimJobs','autoCompetitiveSubmissions','requireEscrowForAutoClaim','rejectDemoAndTestJobs','minJobPayoutUsd',
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
      // v7 safety: this compatibility endpoint NO LONGER forgets terminal jobs.
      // It clears only transient claim retry timers. Permanent graveyard/owned jobs remain
      // invisible to agents forever for the same job fingerprint, surviving refresh/restart.
      claimAttempts={};
      store.writeJson('claim-attempts.json',claimAttempts);
      event('transient_claim_retries_cleared',{permanentRegistryPreserved:true});
      return {ok:true,permanentRegistryPreserved:true};
    },

    retryTransientFailures(){
      claimAttempts={};
      store.writeJson('claim-attempts.json',claimAttempts);
      const released=jobRegistry.releaseTransientRetries();
      for(const [key,attempt] of Object.entries(executionAttempts)){
        const opRecord=Object.values(inFlightJobs).find(x=>x?.op&&opportunityKey(x.op)===key);
        if(opRecord){
          const row=jobRegistry.get(opRecord.op);
          if(row?.failureOwner==='transient')delete executionAttempts[key];
        }
      }
      store.writeJson('execution-attempts.json',executionAttempts);
      event('transient_retries_released',{released:released.released,permanentRegistryPreserved:true});
      return {ok:true,released:released.released,permanentRegistryPreserved:true};
    },

    async runLiveSelfTest(){
      await syncT2000Credential().catch(()=>{});
      const started=Date.now();
      const result=await discoverMarketOpportunities({env,credentials,limit:10,sources:['clawlancer','dealwork','t2000','superteam','clawjobs']});
      const sources=Object.fromEntries(Object.entries(result.health||{}).map(([id,h])=>[id,{ok:Boolean(h?.ok),disabled:Boolean(h?.disabled),mode:h?.mode||'',count:Number(h?.count||0),error:String(h?.error||'').slice(0,180)}]));
      const report={ok:Object.values(sources).some(x=>x.ok&&!x.disabled),safe:true,claimsPerformed:false,signals:Number(result.signals?.length||0),sources,ms:Date.now()-started,at:new Date().toISOString()};
      store.writeJson('live-self-test.json',report);event('live_self_test_completed',report);return report;
    },

    async reconcilePayments(){
      await syncSettlements();
      return {ok:true,settlementHealth:state.settlementHealth||{},at:new Date().toISOString()};
    },

    archiveLegacyHistory(){
      const stamp=new Date().toISOString().replace(/[:.]/g,'-');
      const names=['jobs.ndjson','events.ndjson','opportunities.ndjson'];
      const archived=[];
      for(const name of names){
        const source=store.file(name);
        if(!fs.existsSync(source))continue;
        const target=store.file(`archive-${stamp}-${name}`);
        fs.copyFileSync(source,target);
        fs.writeFileSync(source,'',{mode:0o600});
        archived.push(name);
      }
      seen.clear();persistSet('seen-opportunities.json',seen);lastJobStatus.clear();
      event('legacy_history_archived',{archived,permanentTombstonesPreserved:true,ledgerPreserved:true});
      return {ok:true,archived,permanentTombstonesPreserved:true,ledgerPreserved:true};
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
    catalog(){return{name:'AutonomOS Machine Services',version:'7.1.0',ownerWallet:wallet,payment:x402.status(),products:currentProducts().map(p=>({...p,url:new URL(p.path,siteUrl).toString()}))};}
  };

  async function cycle(trigger){
    if(cycleRunning)return{ok:false,reason:'cycle_already_running'};
    if(config.killSwitch)return{ok:false,reason:'emergency_stop'};
    if(!config.enabled&&trigger!=='manual')return{ok:false,reason:'runtime_stopped'};
    await integrationsReady; await recoveryReady;
    cycleRunning=true; const cycleId=`cy_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`; const started=Date.now();
    setAgent('prime-governor','working'); setAgent('policy-agent','working'); setAgent('opportunity-radar','working');
    try{
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
        const row={...opportunity,capability:cap,outcome,economics:econ,payoutRoute};
        row.jobIdentity=createJobIdentity(opportunity);
        row.intelligence=scoreOpportunity(row,learning);
        jobRegistry.observe(row,{legacyHandled:handled.has(opportunityKey(row))});
        const registryRow=jobRegistry.get(row);
        if(registryRow?.failureOwner==='our_system'&&registryRow?.status==='system_blocked'&&cap.executable)jobRegistry.releaseSystemBlocked(row,{capabilityVersion:capabilityVersion()});
        row.preflight={ok:Boolean(cap.executable),requiredCapabilities:cap.requiredCapabilities||[],missingTools:cap.missingTools||[],requiresArtifact:Boolean(cap.requiresArtifact),mode:cap.mode,capabilityVersion:capabilityVersion()};
        normalized.push(row); recordOpportunity(row);
      }
      setAgentMetric('opportunity-radar',{tasks:1});
      updateT2000QualificationHealth(normalized);
      setAgent('opportunity-radar','working');state.marketSummary=summarizeOpportunities(normalized);state.marketFunnel=buildMarketFunnel(normalized);state.marketplaceYield=buildMarketplaceYield(normalized,jobHistory,cycleLedger);setAgentMetric('opportunity-radar',{tasks:1});
      setAgent('opportunity-radar','working');state.competition=competitionSnapshot(normalized);setAgentMetric('opportunity-radar',{tasks:1});
      setAgent('economics-agent','working');
      // P1 fix: slice(0,100) in raw discovery order (x402-bazaar first, then clawlancer
      // with up to 100 signals of its own) could fill the entire 100-item cap before
      // Dealwork or t2000 opportunities were ever included — so the diagnostic panel
      // could show 0 Dealwork/t2000 entries not because none existed, but because they
      // never survived the slice. Now it samples per-source so every auto-claimable
      // source is represented regardless of how many x402/clawlancer signals came in.
      for(const row of normalized) applyPermanentDiscoveryDisposition(row);
      state.opportunityEconomics=sampleAcrossSources(normalized,['clawlancer','dealwork','t2000','superteam','clawjobs','laborx','dework','bountycaster','questbook'],60).map(x=>({source:x.source,externalId:x.externalId,title:x.title,budgetUsd:x.budgetUsd,currency:x.currency,claimMode:x.claimMode,deadline:x.deadline,observedAt:x.observedAt,capability:x.capability,outcome:x.outcome,economics:x.economics,payoutRoute:x.payoutRoute,preflight:x.preflight,candidacy:explainCandidacy(x),registry:jobRegistry.get(x)}));
      setAgentMetric('economics-agent',{tasks:1});

      setAgent('economics-agent','working');state.offerOptimization=optimizeOffers(normalized.filter(x=>x.source==='x402-bazaar'));setAgentMetric('economics-agent',{tasks:1});
      state.catalogReady=true;

      const candidates=selectBudgetAwareCandidates(normalized.filter(isAutoClaimCandidate)
        .sort((a,b)=>(Number(b.intelligence?.score||0)-Number(a.intelligence?.score||0)) || (scoreCandidate(b)-scoreCandidate(a))),cycleConfig,cycleConfig.availableSpendUsd,detail=>event('candidate_skipped_cycle_budget',detail));

      const processed=await mapLimit(candidates,Number(config.maxConcurrentJobs||4),async opportunity=>{
        if(triggerEnabled(env)){
          const dispatched=await dispatchTriggerPaidOpportunity(opportunity,env);
          if(dispatched.ok){event('trigger_job_dispatched',{source:opportunity.source,externalId:opportunity.externalId,runId:dispatched.runId||''});return{claimed:false,delivered:false,durable:true,provider:'trigger'};}
          event('trigger_dispatch_fallback',{source:opportunity.source,externalId:opportunity.externalId,reason:dispatched.reason||''});
        }else if(temporalEnabled(env)){
          const dispatched=await dispatchPaidOpportunity(opportunity,env);
          if(dispatched.ok){event('temporal_job_dispatched',{source:opportunity.source,externalId:opportunity.externalId,workflowId:dispatched.workflowId,duplicate:Boolean(dispatched.duplicate)});return{claimed:false,delivered:false,durable:true,provider:'temporal'};}
          event('temporal_dispatch_fallback',{source:opportunity.source,externalId:opportunity.externalId,reason:dispatched.reason||''});
        }
        return processMarketplaceOpportunity(opportunity);
      });
      const claimed=processed.filter(x=>x?.claimed).length,delivered=processed.filter(x=>x?.delivered).length,triggerDispatched=processed.filter(x=>x?.provider==='trigger').length,temporalDispatched=processed.filter(x=>x?.provider==='temporal').length,durableDispatched=triggerDispatched+temporalDispatched;

      await syncSettlements();
      const postCycleJobs=store.readNdjson('jobs.ndjson',5000);
      const postCycleOpportunities=store.readNdjson('opportunities.ndjson',1000);
      learning=buildLearningSnapshot(postCycleJobs,postCycleOpportunities);
      learning.updatedFromCycle=cycleId;
      store.writeJson('learning.json',learning);
      state.learningSummary={sampleSize:learning.sampleSize,recommendations:recommendActions(learning)};
      if(!state.treasury?.checkedAt||Date.now()-Date.parse(state.treasury.checkedAt||0)>10*60_000){
        setAgent('treasury-cfo','working');state.treasury=await readTreasuryBalances({address:wallet,env});state.marketplaceWallets=await readMarketplaceWallets({env,credentials});setAgentMetric('treasury-cfo',{tasks:1});
      }
      setAgent('evolution-agent','working');state.lastEvolution=boundedEvolution(normalized);setAgentMetric('evolution-agent',{tasks:1});
      state.cycles=Number(state.cycles||0)+1;state.lastCycleAt=new Date().toISOString();state.lastCycleMs=Date.now()-started;state.updatedAt=new Date().toISOString();state.lastCycleId=cycleId;state.lastCycleTrigger=trigger;
      state.lastCycleSummary={opportunities:normalized.length,candidates:candidates.length,claimed,delivered,durableDispatched,triggerDispatched,temporalDispatched,concurrency:Number(config.maxConcurrentJobs||4),elasticChildren:children.filter(c=>c.status==='alive').length};store.writeJson('state.json',state);
      event('cycle_completed',{cycleId,trigger,ms:state.lastCycleMs,opportunities:normalized.length,candidates:candidates.length,claimed,delivered,durableDispatched,triggerDispatched,temporalDispatched});
      return{ok:true,cycleId,ms:state.lastCycleMs,opportunities:normalized.length,candidates:candidates.length,claimed,delivered,durableDispatched,triggerDispatched,temporalDispatched};
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
    const platformCooldownRemainingMs=platformFailureCooldownRemainingMs(key);
    if(platformCooldownRemainingMs>0)reasons.push(`employer_side_delivery_error_cooldown:${Math.ceil(platformCooldownRemainingMs/60000)}min_remaining`);
    const registryBlock=!paidAssignedT2000Order?jobRegistry.blockReason(op):null;
    if(registryBlock)reasons.push(`registry_blocked:${registryBlock.status}:${registryBlock.reasonCode}`);
    const attempt=claimAttempts[key];
    if(!paidAssignedT2000Order&&attempt&&Date.now()-Date.parse(attempt.lastAttemptAt||0)<retryDelayMs(CLAIM_RETRY_BACKOFF_MS,Number(attempt.count||1),6*60*60_000))reasons.push('recent_claim_attempt_still_in_backoff');
    if(paidAssignedT2000Order){
      const executionAttempt=executionAttempts[key];
      if(executionAttempt&&Number(executionAttempt.count||0)>=MAX_EXECUTION_ATTEMPTS)reasons.push(`assigned_execution_retry_limit_reached:${MAX_EXECUTION_ATTEMPTS}`);
      else if(executionAttempt&&Date.now()-Date.parse(executionAttempt.lastAttemptAt||0)<retryDelayMs(EXECUTION_RETRY_BACKOFF_MS,Number(executionAttempt.count||1),24*60*60_000))reasons.push('assigned_execution_retry_backoff');
    }
    if(!['clawlancer','t2000','dealwork'].includes(op.source) && !(op.source==='superteam'&&config.autoCompetitiveSubmissions))reasons.push(op.source==='superteam'?'competitive_auto_submit_disabled':'source_not_in_auto_claim_allowlist');
    if(!paidAssignedT2000Order&&config.rejectDemoAndTestJobs&&isDemoOrTestOpportunity(op))reasons.push('demo_or_test_opportunity');
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
    const marketFloors={clawlancer:Number(config.clawlancerMinJobPayoutUsd||25),dealwork:Number(config.dealworkMinJobPayoutUsd||25),superteam:Number(config.superteamMinJobPayoutUsd||25)};
    if(!paidAssignedT2000Order&&marketFloors[op.source]!==undefined&&Number(op.budgetUsd||0)<marketFloors[op.source])reasons.push(`${op.source}_job_below_floor:${marketFloors[op.source]}`);
    if(op.source==='t2000'&&!paidAssignedT2000Order&&Number(op.budgetUsd||0)<Number(config.t2000MinOpenJobPayoutUsd||35))reasons.push(`t2000_open_job_below_floor:${config.t2000MinOpenJobPayoutUsd}`);
    if(!op.capability?.executable)reasons.push(`capability_not_executable:${op.capability?.mode||'unknown'}${op.capability?.missingTools?.length?`:missing_${op.capability.missingTools.join('+')}`:''}`);
    if(!paidAssignedT2000Order&&!op.economics?.allowed)reasons.push(`economics_blocked:${op.economics?.reason||'unknown'}`);
    if(!paidAssignedT2000Order&&op.payoutRoute&&op.payoutRoute.ok===false)reasons.push(`payout_blocked:${op.payoutRoute.reason||'unknown'}`);
    const apiCostCeiling=Number(op.budgetUsd||0)*(Number(config.maxApiCostPercentOfPayout||25)/100);
    if(!paidAssignedT2000Order&&Number(op.capability?.estimatedModelCostUsd||0)>apiCostCeiling)reasons.push(`estimated_model_cost_${op.capability?.estimatedModelCostUsd}_exceeds_${Math.round(Number(config.maxApiCostPercentOfPayout||25))}pct_of_payout_ceiling_${apiCostCeiling.toFixed(4)}`);
    if(!['open','active','available','posted',''].includes(String(op.status||'')))reasons.push(`status_not_open:${op.status}`);
    return { isCandidate:reasons.length===0, reasons };
  }
  function applyPermanentDiscoveryDisposition(op){
    const candidacy=explainCandidacy(op);
    const permanentReason=(candidacy.reasons||[]).find(reason=>
      /^budget_below_|_job_below_floor:|^t2000_open_job_below_floor:|^demo_or_test_opportunity$|^status_not_open:|^not_escrowed_and_escrow_required$|^economics_blocked:non_positive_profit/.test(String(reason))
    );
    if(permanentReason&&!String(permanentReason).startsWith('registry_blocked:')){
      jobRegistry.markPermanent(op,{owner:'policy',reasonCode:'discovery_policy_rejection',reason:permanentReason});
    }else if(candidacy.isCandidate){
      const competitive=['bid','competitive_submission','grant_proposal'].includes(String(op.claimMode||''));
      jobRegistry.setState(op,competitive?'proposal':'ready',{reasonCode:competitive?'qualified_competitive_lane':'qualified_ready'});
    }
    return candidacy;
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
    const jobId=createJobIdentity(op).id; const startedAt=new Date().toISOString();
    // P1 fix: dealwork.ai bid-mode jobs (the higher-value tier — real published examples
    // run $5-$80+, not the $0.01-0.03 open-mode listings) can't be claimed instantly; per
    // their own documented flow, a bid is submitted and the buyer decides minutes to days
    // later. Submitting the bid is NOT "claiming" the job — nothing is escrowed yet and no
    // work should start — so this returns early here instead of falling into the same
    // claim→execute→deliver pipeline every other opportunity uses. See pollDealworkBids()
    // for what happens once (if) the buyer accepts.
    if(op.source==='dealwork'&&op.claimMode==='bid'){
      appendJobStatus({id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:'bidding',startedAt});
      const bid=await submitDealworkBid(op,{env,credentials});
      if(!bid.ok){
        handled.add(key);persistSet('handled-opportunities.json',handled);
        const failure=classifyFailure(bid.reason||'bid_failed',{phase:'claim'});
        if(failure.permanent)jobRegistry.markPermanent(op,{owner:failure.owner,reasonCode:failure.reasonCode,reason:bid.reason||'bid_failed'});
        else jobRegistry.markRetry(op,{owner:failure.owner,reasonCode:failure.reasonCode,reason:bid.reason||'bid_failed',attempts:1,retryAfter:new Date(Date.now()+CLAIM_RETRY_BACKOFF_MS).toISOString()});
        appendJobStatus({id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:'bid_failed',at:new Date().toISOString(),reason:bid.reason||''});
        event('market_bid_failed',{jobId,source:op.source,externalId:op.externalId,reason:bid.reason||''});
        return{claimed:false,delivered:false};
      }
      // One bid per job per agent (platform rule) — mark handled immediately so discovery
      // never tries to bid on this same job again; the OUTCOME is tracked separately in
      // pendingDealworkBids so a later 'accepted' status can still be acted on.
      handled.add(key);persistSet('handled-opportunities.json',handled);
      jobRegistry.setState(op,'bid_submitted',{reasonCode:'bid_submitted',bidId:bid.bidId});
      pendingDealworkBids[bid.bidId]={jobId,op,submittedAt:new Date().toISOString()};
      store.writeJson('pending-dealwork-bids.json',pendingDealworkBids);
      appendJobStatus({id:jobId,source:op.source,externalId:op.externalId,status:'bid_submitted',bidId:bid.bidId,at:new Date().toISOString()});
      event('market_bid_submitted',{jobId,source:op.source,externalId:op.externalId,bidId:bid.bidId,proposedAmountUsd:op.budgetUsd});
      return{claimed:false,delivered:false,bidSubmitted:true};
    }
    appendJobStatus({id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:'claiming',startedAt});event('market_job_claiming',{jobId,source:op.source,externalId:op.externalId,budgetUsd:op.budgetUsd});
    let claim;
    try{
      if(op.source==='t2000')await syncT2000Credential({required:true});
      claim=await claimMarketplaceJob(op,{env,credentials});
    }catch(error){claim={ok:false,reason:String(error?.message||error).slice(0,220)}}
    if(!claim.ok){
      const attempts=Number(claimAttempts[key]?.count||0)+1;
      const terminal=!isTransientClaimFailure(claim.reason)||attempts>=MAX_CLAIM_ATTEMPTS;
      claimAttempts[key]={count:attempts,lastAttemptAt:new Date().toISOString(),reason:claim.reason||''};store.writeJson('claim-attempts.json',claimAttempts);
      if(terminal){
        delete claimAttempts[key];store.writeJson('claim-attempts.json',claimAttempts);
        const failure=classifyFailure(claim.reason||'claim_failed',{phase:'claim'});
        if(failure.permanent&&failure.owner!=='our_system'){
          handled.add(key);persistSet('handled-opportunities.json',handled);
          jobRegistry.markPermanent(op,{owner:failure.owner,reasonCode:failure.reasonCode,reason:claim.reason||'claim_failed'});
        }else if(failure.owner==='our_system'){
          jobRegistry.markSystemBlocked(op,{reasonCode:failure.reasonCode||'claim_internal_failure',reason:claim.reason||'claim_failed',attempts,capabilityVersion:capabilityVersion()});
        }else{
          handled.add(key);persistSet('handled-opportunities.json',handled);
          jobRegistry.markPermanent(op,{owner:failure.owner||'market',reasonCode:'claim_retry_limit_exhausted',reason:claim.reason||'claim_failed'});
        }
      }else{
        const failure=classifyFailure(claim.reason||'claim_failed',{phase:'claim'});
        jobRegistry.markRetry(op,{owner:failure.owner,reasonCode:failure.reasonCode,reason:claim.reason||'claim_failed',attempts,retryAfter:new Date(Date.now()+retryDelayMs(CLAIM_RETRY_BACKOFF_MS,attempts,6*60*60_000)).toISOString()});
      }
      appendJobStatus({id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:'claim_failed',attempts,terminal,at:new Date().toISOString(),reason:claim.reason||''});
      event('market_job_claim_failed',{jobId,source:op.source,externalId:op.externalId,attempts,terminal,reason:claim.reason||''});
      return{claimed:false,delivered:false};
    }
    // Claim succeeded: this opportunity is now truly spoken for, so it's safe to mark handled.
    handled.add(key);persistSet('handled-opportunities.json',handled);
    jobRegistry.setState(op,'claimed',{reasonCode:'market_claim_succeeded',claimedAt:new Date().toISOString()});
    if(claimAttempts[key]){delete claimAttempts[key];store.writeJson('claim-attempts.json',claimAttempts);}
    setAgentMetric('job-router',{tasks:1});
    const worker=pickExternalWorker(op.capability?.skill);setWorkerStatus(worker,'working');
    // P0 fix (external audit — Emergency Stop was not a real abort): give this job its own
    // AbortController and store it alongside cancelled:true so emergencyStop() below can
    // actually interrupt an in-flight LLM/Firecrawl/E2B/GitHub call, not just prevent
    // starting a new one.
    const abortController=new AbortController();
    const estimatedMinutes=estimateJobDurationMinutes(op);
    activeJobs.set(jobId,{id:jobId,source:op.source,externalId:op.externalId,title:op.title||'',workerId:worker.id,startedAt,etaAt:new Date(Date.parse(startedAt)+estimatedMinutes*60000).toISOString(),estimatedMinutes,deadline:op.deadline||'',budgetUsd:Number(op.budgetUsd||0),currency:op.currency||'',claimMode:op.claimMode||'',escrowed:Boolean(op.escrowed),cancelled:false,abortController});
    jobRegistry.setState(op,'executing',{jobId,workerId:worker.id,startedAt,etaAt:new Date(Date.parse(startedAt)+estimatedMinutes*60000).toISOString()});
    appendJobStatus({id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:'claimed',transactionId:claim.transactionId||'',workerId:worker.id,at:new Date().toISOString()});event('market_job_claimed',{jobId,source:op.source,externalId:op.externalId,transactionId:claim.transactionId||''});
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
      const execOp={...op,jobId,acceptanceContract:op.acceptanceContract||buildAcceptanceContract(op),executionBudgetUsd:Number(op.executionBudgetUsd||config.availableSpendUsd||config.seedSpendBudgetUsd||0),jobSpendCeilingUsd:Number(op.budgetUsd||0)*(Number(config.maxApiCostPercentOfPayout||25)/100),...(claim.workOrder?{__workOrderRaw:claim.workOrder,description:`${op.description}\n\n[t2000 job_status work order]\n${typeof claim.workOrder==='string'?claim.workOrder:JSON.stringify(claim.workOrder).slice(0,4000)}${op.source==='t2000'?'\n\n[t2000 delivery constraint] Final delivery body must be at most 16 KiB UTF-8. If the result is larger, summarize it and include stable links/hashes where the work order permits.':''}`}:{})};
      deliverable=await orchestrateJob(execOp,{llm,memory,taskAgents,jobId,env,maxTaskAgents:Number(config.maxChildren||12),abortSignal:abortController.signal,onEvent:(type,detail)=>event(type,{jobId,source:op.source,...detail}),execute:(plannedOp,execOpts={})=>executeExternalOpportunity(plannedOp,op.capability,{llm,siteUrl,env,config,abortSignal:abortController.signal,memoryContext:plannedOp.__memoryContext||'',...execOpts})});
      setAgent('qa-evaluator','working'); validateExternalDeliverable(deliverable,execOp);
      if(op.source==='t2000')await syncT2000Credential({required:true});
      const delivery=await deliverMarketplaceJob(op,claim,deliverable,{env,credentials,recordPendingClaim});
      if(!delivery.ok)throw new Error(`delivery_failed:${delivery.reason||'unknown'}`);
      appendJobStatus({id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:'delivered',transactionId:delivery.transactionId||claim.transactionId||'',workerId:worker.id,deliverableHash:deliverable.hash,at:new Date().toISOString()});
      jobRegistry.setState(op,'delivered',{reasonCode:'delivery_accepted',transactionId:delivery.transactionId||claim.transactionId||'',deliveredAt:new Date().toISOString()});
      const actualCostUsd=computeActualCostUsd(deliverable,op.capability);
      const toolCostUsd=Number(deliverable.evidence?.toolCostUsd||0);
      setWorkerMetric(worker,{tasks:1,cost:actualCostUsd+toolCostUsd});setAgentMetric('qa-evaluator',{tasks:1});event('market_job_delivered',{jobId,source:op.source,externalId:op.externalId,transactionId:delivery.transactionId||''});
      if (op.source !== 'superteam') {
        const pendingLearning=store.readJson('learning-pending.json',{});
        pendingLearning[jobId]={jobId,source:op.source,externalId:op.externalId,skill:op.capability?.skill||'',title:op.title,description:op.description,deliverableHash:deliverable.hash,accepted:false,createdAt:new Date().toISOString(),tenantScope:op.tenantScope||op.clientId||'global'};
        store.writeJson('learning-pending.json',pendingLearning);
      }
      artifactStore.putJson(`jobs/${jobId}/evidence-pack.json`, deliverable.evidence?.evidencePack || buildEvidencePack({jobId,opportunity:op,deliverable})).catch(()=>{});
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
      appendJobStatus({id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:'execution_failed',workerId:worker.id,error:String(error?.message||error).slice(0,300),at:new Date().toISOString()});
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
      recordIfPlatformSideFailure(key,error?.message||error);
      store.writeJson('execution-attempts.json',executionAttempts);
      const failure=classifyFailure(error,{phase:'execution'});
      if(failure.permanent&&failure.owner!=='our_system'){
        jobRegistry.markPermanent(op,{owner:failure.owner,reasonCode:failure.reasonCode,reason:String(error?.message||error)});
        clearInFlightJob(jobId);
      }else if(failure.owner==='our_system'&&executionAttempts[key].count>=MAX_EXECUTION_ATTEMPTS){
        jobRegistry.markSystemBlocked(op,{reasonCode:failure.reasonCode||'execution_retry_limit_attention',reason:String(error?.message||error),attempts:executionAttempts[key].count,capabilityVersion:capabilityVersion()});
        writeInFlightJob(jobId,{...inFlightJobs[jobId],lastError:String(error?.message||error).slice(0,220),retryCount:executionAttempts[key].count,lastFailedAt:new Date().toISOString(),status:'system_blocked'});
      }else{
        jobRegistry.markRetry(op,{owner:failure.owner,reasonCode:failure.reasonCode,reason:String(error?.message||error),attempts:executionAttempts[key].count,retryAfter:new Date(Date.now()+retryDelayMs(EXECUTION_RETRY_BACKOFF_MS,executionAttempts[key].count,24*60*60_000)).toISOString(),phase:'execution'});
      }
      // Keep the durable in-flight record after claim. A restart or later recovery cycle
      // must be able to resume the already-owned job instead of silently orphaning it.
      if(!(failure.permanent&&failure.owner!=='our_system'))writeInFlightJob(jobId,{...inFlightJobs[jobId],lastError:String(error?.message||error).slice(0,220),retryCount:executionAttempts[key].count,lastFailedAt:new Date().toISOString()});
      return{claimed:true,delivered:false,retryScheduled:!(failure.permanent&&failure.owner!=='our_system')&&executionAttempts[key].count<MAX_EXECUTION_ATTEMPTS};
    }
    finally{activeJobs.delete(jobId);setWorkerStatus(worker,'idle');}
  }

  function estimateJobDurationMinutes(op){
    const skill=String(op?.capability?.skill||'');
    if(skill==='translation'||skill==='copywriting')return 8;
    if(skill==='web-research'||skill==='data-transform')return 15;
    if(skill==='code-analysis'||skill==='document-generation')return 25;
    if(skill==='browser-ops'||skill==='app-automation')return 20;
    return 15;
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
      activeJobs.set(jobId,{id:jobId,source:op.source,externalId:op.externalId,title:op.title||'',workerId:worker.id,startedAt:new Date().toISOString(),etaAt:new Date(Date.now()+estimateJobDurationMinutes(op)*60000).toISOString(),estimatedMinutes:estimateJobDurationMinutes(op),deadline:op.deadline||'',budgetUsd:Number(op.budgetUsd||0),currency:op.currency||'',claimMode:op.claimMode||'bid',escrowed:Boolean(op.escrowed),cancelled:false,abortController});
      jobRegistry.setState(op,'executing',{jobId,workerId:worker.id,reasonCode:'accepted_bid_execution'});
      let deliverable;
      try{
        const started=await startDealworkContract(status.contractId,{env,credentials});
        if(!started.ok)throw new Error(`dealwork_start_work_failed:${started.reason||'unknown'}`);
        appendJobStatus({id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:'claimed',transactionId:status.contractId,workerId:worker.id,at:new Date().toISOString()});
        event('market_job_claimed',{jobId,source:op.source,externalId:op.externalId,transactionId:status.contractId,recovered:false,fromBid:true});
        const syntheticClaim={ok:true,jobId:status.contractId,transactionId:status.contractId};
        writeInFlightJob(jobId,{jobId,op,claim:syntheticClaim,workerId:worker.id,startedAt:new Date().toISOString(),fromBid:true});
        deliverable=await orchestrateJob(op,{llm,memory,taskAgents,jobId,env,maxTaskAgents:Number(config.maxChildren||12),abortSignal:abortController.signal,onEvent:(type,detail)=>event(type,{jobId,source:op.source,...detail}),execute:(plannedOp,execOpts={})=>executeExternalOpportunity(plannedOp,op.capability,{llm,siteUrl,env,config,abortSignal:abortController.signal,memoryContext:plannedOp.__memoryContext||'',...execOpts})});
        validateExternalDeliverable(deliverable,op);
        const delivery=await deliverMarketplaceJob(op,syntheticClaim,deliverable,{env,credentials,recordPendingClaim});
        if(!delivery.ok)throw new Error(`delivery_failed:${delivery.reason||'unknown'}`);
        appendJobStatus({id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:'delivered',transactionId:delivery.transactionId||status.contractId,workerId:worker.id,deliverableHash:deliverable.hash,at:new Date().toISOString()});
        const actualCostUsd=computeActualCostUsd(deliverable,op.capability);
        const toolCostUsd=Number(deliverable.evidence?.toolCostUsd||0);
        setWorkerMetric(worker,{tasks:1,cost:actualCostUsd+toolCostUsd});
        recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:actualCostUsd,kind:'model',estimated:!deliverable.evidence?.usage});
        if(toolCostUsd>0)recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:toolCostUsd,kind:'tool_api',estimated:true,note:'firecrawl_e2b_call_cost_estimate'});
        event('market_job_delivered',{jobId,source:op.source,externalId:op.externalId,transactionId:delivery.transactionId||status.contractId,fromBid:true});
        jobRegistry.setState(op,'delivered',{reasonCode:'delivery_accepted',transactionId:delivery.transactionId||status.contractId||'',deliveredAt:new Date().toISOString()});
        if (op.source !== 'superteam') {
        const pendingLearning=store.readJson('learning-pending.json',{});
        pendingLearning[jobId]={jobId,source:op.source,externalId:op.externalId,skill:op.capability?.skill||'',title:op.title,description:op.description,deliverableHash:deliverable.hash,accepted:false,createdAt:new Date().toISOString(),tenantScope:op.tenantScope||op.clientId||'global'};
        store.writeJson('learning-pending.json',pendingLearning);
      }
      artifactStore.putJson(`jobs/${jobId}/evidence-pack.json`, deliverable.evidence?.evidencePack || buildEvidencePack({jobId,opportunity:op,deliverable})).catch(()=>{});
        clearInFlightJob(jobId);
        if(executionAttempts[opportunityKey(op)]){delete executionAttempts[opportunityKey(op)];store.writeJson('execution-attempts.json',executionAttempts);}
      }catch(error){
        appendJobStatus({id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:'execution_failed',workerId:worker.id,error:String(error?.message||error).slice(0,300),at:new Date().toISOString()});
        incrementWorkerError(worker);event('market_job_failed',{jobId,source:op.source,externalId:op.externalId,error:String(error?.message||error).slice(0,220),fromBid:true});
        const incurredToolCostUsd=Number(deliverable?.evidence?.toolCostUsd||0);
        if(incurredToolCostUsd>0)recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:incurredToolCostUsd,kind:'tool_api',estimated:true,note:'job_failed_after_tool_calls'});
        const execKey=opportunityKey(op);const previous=executionAttempts[execKey]||{};
        executionAttempts[execKey]={count:Number(previous.count||0)+1,lastAttemptAt:new Date().toISOString(),reason:String(error?.message||error).slice(0,220)};store.writeJson('execution-attempts.json',executionAttempts);recordIfPlatformSideFailure(execKey,error?.message||error);
        const failure=classifyFailure(error,{phase:'execution'});
        if(failure.permanent&&failure.owner!=='our_system'){jobRegistry.markPermanent(op,{owner:failure.owner,reasonCode:failure.reasonCode,reason:String(error?.message||error)});clearInFlightJob(jobId);}
        else jobRegistry.markRetry(op,{owner:failure.owner,reasonCode:failure.reasonCode,reason:String(error?.message||error),attempts:executionAttempts[execKey].count,retryAfter:new Date(Date.now()+EXECUTION_RETRY_BACKOFF_MS).toISOString(),phase:'execution'});
        if(inFlightJobs[jobId]&&!(failure.permanent&&failure.owner!=='our_system'))writeInFlightJob(jobId,{...inFlightJobs[jobId],lastError:String(error?.message||error).slice(0,220),retryCount:executionAttempts[execKey].count,lastFailedAt:new Date().toISOString()});
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
      if(attempt.lastAttemptAt&&Date.now()-Date.parse(attempt.lastAttemptAt)<retryDelayMs(EXECUTION_RETRY_BACKOFF_MS,Number(attempt.count||1),24*60*60_000))continue;
      const worker=children.find(c=>c.id===record.workerId&&c.status==='alive')||agents.find(a=>a.id===record.workerId)||pickExternalWorker(op.capability?.skill);
      const abortController=new AbortController();const recoveredStartedAt=new Date().toISOString();setWorkerStatus(worker,'working');activeJobs.set(jobId,{id:jobId,source:op.source,externalId:op.externalId,title:op.title||'',workerId:worker.id,startedAt:recoveredStartedAt,etaAt:new Date(Date.parse(recoveredStartedAt)+estimateJobDurationMinutes(op)*60000).toISOString(),estimatedMinutes:estimateJobDurationMinutes(op),deadline:op.deadline||'',budgetUsd:Number(op.budgetUsd||0),currency:op.currency||'',claimMode:op.claimMode||'',escrowed:Boolean(op.escrowed),cancelled:false,abortController});jobRegistry.setState(op,'executing',{jobId,workerId:worker.id,recovered:true});
      event('market_job_recovery_attempt',{jobId,source:op.source,externalId:op.externalId,attempt:Number(attempt.count||0)+1});
      let deliverable;
      try{
        if(op.source==='t2000'&&claim.workOrderMissing)throw new Error('t2000_work_order_unavailable_refusing_blind_delivery');
        const execOp={...op,jobId,acceptanceContract:op.acceptanceContract||buildAcceptanceContract(op),executionBudgetUsd:Number(op.executionBudgetUsd||config.availableSpendUsd||config.seedSpendBudgetUsd||0),jobSpendCeilingUsd:Number(op.budgetUsd||0)*(Number(config.maxApiCostPercentOfPayout||25)/100),...(claim.workOrder?{__workOrderRaw:claim.workOrder,description:`${op.description}\n\n[t2000 job_status work order]\n${typeof claim.workOrder==='string'?claim.workOrder:JSON.stringify(claim.workOrder).slice(0,4000)}${op.source==='t2000'?'\n\n[t2000 delivery constraint] Final delivery body must be at most 16 KiB UTF-8. If larger, summarize and include stable artifact links/hashes where permitted.':''}`}:{})};
        deliverable=await orchestrateJob(execOp,{llm,memory,taskAgents,jobId,env,maxTaskAgents:Number(config.maxChildren||12),abortSignal:abortController.signal,onEvent:(type,detail)=>event(type,{jobId,source:op.source,...detail}),execute:(plannedOp,execOpts={})=>executeExternalOpportunity(plannedOp,op.capability,{llm,siteUrl,env,config,abortSignal:abortController.signal,memoryContext:plannedOp.__memoryContext||'',...execOpts})});
        validateExternalDeliverable(deliverable,execOp);if(op.source==='t2000')await syncT2000Credential({required:true});
        const delivery=await deliverMarketplaceJob(op,claim,deliverable,{env,credentials,recordPendingClaim});if(!delivery.ok)throw new Error(`delivery_failed:${delivery.reason||'unknown'}`);
        appendJobStatus({id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:'delivered',transactionId:delivery.transactionId||claim.transactionId||'',workerId:worker.id,deliverableHash:deliverable.hash,at:new Date().toISOString(),recovered:true});
        const actualCostUsd=computeActualCostUsd(deliverable,op.capability);const toolCostUsd=Number(deliverable.evidence?.toolCostUsd||0);setWorkerMetric(worker,{tasks:1,cost:actualCostUsd+toolCostUsd});recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:actualCostUsd,kind:'model',estimated:!deliverable.evidence?.usage});if(toolCostUsd>0)recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:toolCostUsd,kind:'tool_api',estimated:true,note:'recovered_job_tool_cost'});
        if (op.source !== 'superteam') {
        const pendingLearning=store.readJson('learning-pending.json',{});
        pendingLearning[jobId]={jobId,source:op.source,externalId:op.externalId,skill:op.capability?.skill||'',title:op.title,description:op.description,deliverableHash:deliverable.hash,accepted:false,createdAt:new Date().toISOString(),tenantScope:op.tenantScope||op.clientId||'global'};
        store.writeJson('learning-pending.json',pendingLearning);
      }
      artifactStore.putJson(`jobs/${jobId}/evidence-pack.json`, deliverable.evidence?.evidencePack || buildEvidencePack({jobId,opportunity:op,deliverable})).catch(()=>{});artifactStore.putText(`jobs/${jobId}/deliverable.md`,deliverable.content,deliverable.format||'text/markdown').catch(()=>{});
        event('market_job_delivered',{jobId,source:op.source,externalId:op.externalId,transactionId:delivery.transactionId||'',recovered:true});jobRegistry.setState(op,'delivered',{reasonCode:'delivery_accepted',transactionId:delivery.transactionId||'',deliveredAt:new Date().toISOString(),recovered:true});clearInFlightJob(jobId);delete executionAttempts[key];store.writeJson('execution-attempts.json',executionAttempts);recovered++;
      }catch(error){
        failed++;const nextCount=Number(attempt.count||0)+1;executionAttempts[key]={count:nextCount,lastAttemptAt:new Date().toISOString(),reason:String(error?.message||error).slice(0,220)};store.writeJson('execution-attempts.json',executionAttempts);recordIfPlatformSideFailure(key,error?.message||error);const failure=classifyFailure(error,{phase:'execution'});const externalPermanent=failure.permanent&&failure.owner!=='our_system';const manual=nextCount>=MAX_EXECUTION_ATTEMPTS&&!externalPermanent;if(externalPermanent){jobRegistry.markPermanent(op,{owner:failure.owner,reasonCode:failure.reasonCode,reason:String(error?.message||error)});clearInFlightJob(jobId);}else{if(manual&&failure.owner==='our_system')jobRegistry.markSystemBlocked(op,{reasonCode:failure.reasonCode||'execution_retry_limit_attention',reason:String(error?.message||error),attempts:nextCount,capabilityVersion:capabilityVersion()});else jobRegistry.markRetry(op,{owner:failure.owner,reasonCode:failure.reasonCode,reason:String(error?.message||error),attempts:nextCount,retryAfter:manual?'':new Date(Date.now()+retryDelayMs(EXECUTION_RETRY_BACKOFF_MS,nextCount,24*60*60_000)).toISOString(),phase:'execution'});writeInFlightJob(jobId,{...record,lastError:String(error?.message||error).slice(0,220),retryCount:nextCount,lastFailedAt:new Date().toISOString(),status:manual?'system_blocked':'retry_pending',...(manual?{manualAttentionAt:new Date().toISOString()}:{})});}
        appendJobStatus({id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:manual?'manual_attention':'execution_failed',workerId:worker.id,error:String(error?.message||error).slice(0,300),at:new Date().toISOString(),recovered:true,retryCount:nextCount});incrementWorkerError(worker);event(manual?'market_job_manual_attention':'market_job_failed',{jobId,source:op.source,externalId:op.externalId,error:String(error?.message||error).slice(0,220),recovered:true,retryCount:nextCount});if(manual)manualAttention++;
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
      const revenueUsd=Math.max(0,Number(tx.amountUsd||0));store.append('ledger.ndjson',ledgerEntry({id:`tx_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,type:'revenue',source:tx.source,externalTransactionId:tx.externalTransactionId,grossUsd:revenueUsd,amountUsd:revenueUsd,currency:tx.currency,network:tx.network,allocation:allocateRevenue(revenueUsd,config),status:'settled',jobId:String(tx.listingId||tx.jobId||'')}));
      const registryIdentity=`${tx.source}:${String(tx.listingId||tx.jobId||'')}`;
      const registryRow=jobRegistry.get(registryIdentity);
      if(registryRow)jobRegistry.setState(registryRow,'paid',{reasonCode:'marketplace_payment_settled',transactionId:tx.externalTransactionId,amountUsd:revenueUsd,currency:tx.currency,paidAt:new Date().toISOString()});
      const pending=store.readJson('learning-pending.json',{});
      const matches=Object.entries(pending).filter(([,row])=>row.source===tx.source && (String(row.externalId)===String(tx.listingId||tx.jobId||'') || String(row.jobId)===String(tx.listingId||tx.jobId||'')));
      for(const [pendingId,row] of matches){
        await memory.remember({key:`settled:${row.source}:${row.externalId}`,kind:'experience',content:`Settled job ${row.source}/${row.externalId}: ${row.title||''}`,utility:1,tenantScope:row.tenantScope||'global',jobScope:row.jobId,metadata:{settledAt:new Date().toISOString(),revenueUsd,deliverableHash:row.deliverableHash||''}}).catch(()=>{});
        delete pending[pendingId];
      }
      if(matches.length)store.writeJson('learning-pending.json',pending);
      setAgentMetric('treasury-cfo',{tasks:1,revenue:revenueUsd});event('market_payment_settled',{source:tx.source,transactionId:tx.externalTransactionId,amountUsd:revenueUsd,currency:tx.currency});
    }
  }

  async function executeTrackedProduct(product,query,meta){
    const policy=validateAction({kind:'execute',productId:product.id},{...config,enabled:true});if(!policy.allowed)throw Object.assign(new Error(policy.reason),{status:503,code:policy.reason});
    const jobId=`job_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;const worker=pickProductWorker(product.id);const startedAt=new Date().toISOString();activeJobs.set(jobId,{id:jobId,productId:product.id,workerId:worker.id,startedAt,cancelled:false});setAgent('job-router','working');setWorkerStatus(worker,'working');setAgent('security-sentinel','working');appendJobStatus({id:jobId,productId:product.id,source:meta.source,status:'started',workerId:worker.id,startedAt});event('job_started',{jobId,productId:product.id,workerId:worker.id,source:meta.source});
    try{const result=await executeProduct(product.id,query);if(activeJobs.get(jobId)?.cancelled)throw Object.assign(new Error('job_cancelled'),{status:503,code:'job_cancelled'});setAgent('qa-evaluator','working');validateProductResult(result,product.id);appendJobStatus({id:jobId,productId:product.id,source:meta.source,status:'completed',workerId:worker.id,startedAt,completedAt:new Date().toISOString()});setWorkerMetric(worker,{tasks:1});setAgentMetric('job-router',{tasks:1});setAgentMetric('security-sentinel',{tasks:1});setAgentMetric('qa-evaluator',{tasks:1});event('job_completed',{jobId,productId:product.id,workerId:worker.id,paid:meta.paid});return{...result,autonomos:{jobId,worker:worker.name,payment:meta.paid?'verified-before-execution; settlement-after-success':'admin_preview'}};}
    catch(error){appendJobStatus({id:jobId,productId:product.id,source:meta.source,status:'failed',workerId:worker.id,startedAt,completedAt:new Date().toISOString(),error:String(error?.message||error).slice(0,300)});incrementWorkerError(worker);event('job_failed',{jobId,productId:product.id,error:String(error?.message||error).slice(0,200)});throw error;}
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
  function marketFloor(op){
    if(op?.source==='t2000')return Number(config.t2000MinOpenJobPayoutUsd||35);
    if(op?.source==='clawlancer')return Number(config.clawlancerMinJobPayoutUsd||25);
    if(op?.source==='dealwork')return Number(config.dealworkMinJobPayoutUsd||25);
    if(op?.source==='superteam')return Number(config.superteamMinJobPayoutUsd||25);
    return Number(config.minJobPayoutUsd||25);
  }
  function blockerBucket(reason=''){
    const r=String(reason);
    if(/budget_below|below_floor|payout_ceiling/.test(r))return 'below_payout';
    if(/not_escrowed/.test(r))return 'no_escrow';
    if(/source_not|competitive_auto_submit/.test(r))return 'not_claimable';
    if(/capability_not|missing_/.test(r))return 'capability_missing';
    if(/registry_blocked:.*(?:graveyard|permanent|finished)|duplicate/.test(r))return 'duplicate_permanent';
    if(/registry_blocked:.*(?:system_blocked|capability_hold|manual_attention)/.test(r))return 'system_blocked';
    if(/economics_blocked|estimated_model_cost/.test(r))return 'economics_failed';
    if(/auth|credential|api_key/.test(r))return 'auth_missing';
    if(/status_not_open|expired|closed/.test(r))return 'expired_closed';
    return 'other';
  }
  function buildMarketFunnel(rows){
    const paid=rows.filter(x=>Number(x.budgetUsd||0)>0);
    const aboveFloor=paid.filter(x=>x.source==='t2000'&&x.claimMode==='already_assigned'||Number(x.budgetUsd||0)>=marketFloor(x));
    const executable=aboveFloor.filter(x=>x.capability?.executable);
    const profitable=executable.filter(x=>x.economics?.allowed);
    const evaluated=rows.map(x=>({row:x,c:explainCandidacy(x)}));
    const claimable=evaluated.filter(x=>!x.c.reasons.some(r=>/source_not_in_auto_claim_allowlist|competitive_auto_submit_disabled|not_escrowed_and_escrow_required|status_not_open/.test(String(r)))).length;
    const ready=evaluated.filter(x=>x.c.isCandidate).length;
    const blockers={};for(const {c} of evaluated)for(const reason of c.reasons){const k=blockerBucket(reason);blockers[k]=(blockers[k]||0)+1;}
    return{rawSignals:rows.length,paidJobs:paid.length,aboveFloor:aboveFloor.length,executable:executable.length,profitable:profitable.length,claimable,ready,blockers,at:new Date().toISOString()};
  }
  function buildMarketplaceYield(rows,jobs=[],ledger=[]){
    const sources=[...new Set(rows.map(x=>x.source).filter(Boolean))];
    return sources.map(source=>{
      const rs=rows.filter(x=>x.source===source), js=jobs.filter(x=>x.source===source);
      const paid=rs.filter(x=>Number(x.budgetUsd||0)>0),above=paid.filter(x=>Number(x.budgetUsd||0)>=marketFloor(x));
      const executable=above.filter(x=>x.capability?.executable),profitable=executable.filter(x=>x.economics?.allowed),ready=rs.filter(x=>explainCandidacy(x).isCandidate);
      const claimed=js.filter(x=>/claimed|bidding|executing|delivered|settled|paid/.test(String(x.status||''))).length;
      const delivered=js.filter(x=>/delivered|settled|paid/.test(String(x.status||''))).length;
      const paidCount=js.filter(x=>/settled|paid/.test(String(x.status||''))).length;
      const revenues=ledger.filter(x=>x.source===source&&x.type==='revenue').reduce((n,x)=>n+Number(x.amountUsd||x.grossUsd||0),0);
      const costs=ledger.filter(x=>x.source===source&&x.type==='cost').reduce((n,x)=>n+Number(x.amountUsd||x.costUsd||0),0);
      return{source,signals:rs.length,paidJobs:paid.length,aboveFloor:above.length,executable:executable.length,profitable:profitable.length,ready:ready.length,claims:claimed,claimSuccessRate:claimed?Math.min(1,delivered/claimed):0,deliverySuccessRate:delivered?Math.min(1,paidCount/delivered):0,paidCount,revenueUsd:round(revenues),costUsd:round(costs),netUsd:round(revenues-costs),medianPayoutUsd:median(paid.map(x=>Number(x.budgetUsd||0))),lastUsefulJob:ready[0]?.observedAt||'',lastPaidJob:js.find(x=>/settled|paid/.test(String(x.status||'')))?.at||''};
    });
  }
  function summarizeOpportunities(rows){const jobs=rows.filter(x=>Number(x.budgetUsd)>0);const executable=jobs.filter(x=>x.capability?.executable);const profitable=executable.filter(x=>x.economics?.allowed);return{observed:rows.length,escrowedJobs:rows.filter(x=>x.escrowed&&x.budgetUsd>0).length,paidJobs:jobs.length,executable:executable.length,profitable:profitable.length,medianPayoutUsd:median(jobs.map(x=>x.budgetUsd)),sources:[...new Set(rows.map(x=>x.source))],at:new Date().toISOString()};}
  function retryDelayMs(baseMs,attempt,maxMs){return Math.min(Number(maxMs||baseMs),Math.max(Number(baseMs||0),Number(baseMs||0)*Math.pow(2,Math.max(0,Number(attempt||1)-1))));}
  function competitionSnapshot(rows){const prices=rows.map(x=>Number(x.budgetUsd)).filter(x=>Number.isFinite(x)&&x>0);return{samples:prices.length,minPayoutUsd:prices.length?Math.min(...prices):0,maxPayoutUsd:prices.length?Math.max(...prices):0,medianPayoutUsd:median(prices),at:new Date().toISOString()};}

  // Legacy persistent child-agent autoscaling was removed in v13. The only execution
  // workforce is TaskAgentRuntime, created from the accepted job plan and bounded by
  // config.maxChildren (kept as the API field for backward compatibility).
  function pickProductWorker(productId){return{id:'dynamic-workforce',name:`Dynamic Worker · ${productId}`,isDynamic:true};}
  function pickExternalWorker(skill){return{id:'dynamic-workforce',name:`Dynamic Worker · ${skill||'general'}`,isDynamic:true};}
  function setWorkerStatus(worker,status){if(worker?.isDynamic)return;if(!worker?.isChild)return setAgent(worker?.id,status);const child=children.find(c=>c.id===worker.id);if(!child)return;child.runtimeStatus=status;if(status==='working')child.lastActiveAt=new Date().toISOString();store.writeJson('children.json',children);}
  function setWorkerMetric(worker,{tasks=0,revenue=0,cost=0}={}){if(worker?.isDynamic)return;if(!worker?.isChild)return setAgentMetric(worker?.id,{tasks,revenue,cost});const child=children.find(c=>c.id===worker.id);if(!child)return;child.tasksCompleted=Number(child.tasksCompleted||0)+Number(tasks||0);child.revenueUsd=round(Number(child.revenueUsd||0)+Number(revenue||0));child.costUsd=round(Number(child.costUsd||0)+Number(cost||0));child.lastActiveAt=new Date().toISOString();store.writeJson('children.json',children);}
  function incrementWorkerError(worker){if(worker?.isDynamic)return;if(!worker?.isChild)return incrementAgentError(worker?.id);const child=children.find(c=>c.id===worker.id);if(!child)return;child.errors=Number(child.errors||0)+1;child.lastActiveAt=new Date().toISOString();store.writeJson('children.json',children);}
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
    const finalContract=op.acceptanceContract||buildAcceptanceContract(op);
    const acceptance=validateAcceptanceContract(finalContract,d);
    if(!acceptance.ok)throw new Error(`acceptance_contract_failed:${acceptance.reasons.join(',').slice(0,180)}`);
    return true;
  }
  function setAgent(id,status){const a=agents.find(x=>x.id===id);if(!a)return;a.status=status;if(status==='working')a.lastActiveAt=new Date().toISOString();}
  function setAgentMetric(id,{tasks=0,revenue=0,cost=0}={}){const a=agents.find(x=>x.id===id);if(!a)return;a.tasksCompleted+=Number(tasks||0);a.revenueUsd=round(a.revenueUsd+Number(revenue||0));a.costUsd=round(a.costUsd+Number(cost||0));a.lastActiveAt=new Date().toISOString();persistAgents();}
  function incrementAgentError(id){const a=agents.find(x=>x.id===id);if(!a)return;a.errors+=1;a.lastActiveAt=new Date().toISOString();persistAgents();}
  function calculateMetrics(ledger,jobs,opportunities,totalUniqueOpportunities){const dayAgo=Date.now()-86400000;const weekAgo=Date.now()-7*86400000;const costEntries=ledger.filter(x=>x.type==='cost');const revenueEntries=ledger.filter(x=>x.type==='revenue'&&!x.testnet);const revenue=revenueEntries.reduce((s,x)=>s+Number(x.amountUsd||0),0);const cost=costEntries.reduce((s,x)=>s+Number(x.amountUsd||0),0);const r24=revenueEntries.filter(x=>Date.parse(x.at||0)>=dayAgo).reduce((s,x)=>s+Number(x.amountUsd||0),0);const c24=costEntries.filter(x=>Date.parse(x.at||0)>=dayAgo).reduce((s,x)=>s+Number(x.amountUsd||0),0);const r7=revenueEntries.filter(x=>Date.parse(x.at||0)>=weekAgo).reduce((s,x)=>s+Number(x.amountUsd||0),0);const c7=costEntries.filter(x=>Date.parse(x.at||0)>=weekAgo).reduce((s,x)=>s+Number(x.amountUsd||0),0);const latestByJob=latestStatuses(jobs);const statuses=Object.values(latestByJob).map(x=>x.status);return{totalRevenueUsd:round(revenue),totalCostUsd:round(cost),netProfitUsd:round(revenue-cost),revenue24hUsd:round(r24),cost24hUsd:round(c24),net24hUsd:round(r24-c24),revenue7dUsd:round(r7),cost7dUsd:round(c7),net7dUsd:round(r7-c7),completedJobs:statuses.filter(x=>['settled','paid','completed'].includes(x)).length,failedJobs:statuses.filter(x=>String(x).includes('failed')).length,claimedJobs:statuses.filter(x=>['claimed','bidding','bid_submitted','delivered','settled','paid'].includes(x)).length,deliveredJobs:statuses.filter(x=>['delivered','settled','paid'].includes(x)).length,paidJobs:ledger.filter(x=>x.type==='revenue'&&!x.testnet).length,opportunitiesFound:Number(totalUniqueOpportunities??opportunities.length),activeAgents:agents.filter(x=>x.status==='working').length,activeChildren:children.filter(x=>x.status==='alive').length,allocations:allocateRevenue(Math.max(0,revenue-cost),config),
    // Diagnostic only: if lastCostEntryAt is recent (matches recent job failures) but
    // cost24hUsd still shows $0, the bug is in the 24h aggregation. If lastCostEntryAt is
    // old/empty despite recent failed jobs, recordCost() is not being reached for them —
    // two very different bugs that look identical from totalCostUsd/cost24hUsd alone.
    costEntriesCount:costEntries.length,lastCostEntryAt:costEntries.length?costEntries.reduce((latest,x)=>!latest||Date.parse(x.at||0)>Date.parse(latest)?x.at:latest,null):null};}
  
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
        const acceptanceContract=buildAcceptanceContract({...opportunity,capability:cap});
        const row={...opportunity,capability:cap,outcome,economics:econ,payoutRoute,acceptanceContract,executionBudgetUsd:Math.max(0,Number(cycleConfig.availableSpendUsd||0)),jobId:createJobIdentity(opportunity).id};
        row.intelligence=scoreOpportunity(row,learning);
        jobRegistry.observe(row,{legacyHandled:handled.has(opportunityKey(row))});
        applyPermanentDiscoveryDisposition(row);
        recordOpportunity(row); return row;
      });
      updateT2000QualificationHealth(normalized);
      const candidates=selectBudgetAwareCandidates(normalized.filter(isAutoClaimCandidate)
        .sort((a,b)=>(Number(b.intelligence?.score||0)-Number(a.intelligence?.score||0)) || (scoreCandidate(b)-scoreCandidate(a))),cycleConfig,cycleConfig.availableSpendUsd,detail=>event('candidate_skipped_cycle_budget',detail));
      const rows=await mapLimit(candidates,Number(config.maxConcurrentJobs||4),async op=>{if(triggerEnabled(env)){const dispatched=await dispatchTriggerPaidOpportunity(op,env);if(dispatched.ok){event('trigger_job_dispatched',{source:op.source,externalId:op.externalId,runId:dispatched.runId||'',fastLane:true});return{durable:true,provider:'trigger'};}event('trigger_dispatch_fallback',{source:op.source,externalId:op.externalId,reason:dispatched.reason||'',fastLane:true});}else if(temporalEnabled(env)){const dispatched=await dispatchPaidOpportunity(op,env);if(dispatched.ok){event('temporal_job_dispatched',{source:op.source,externalId:op.externalId,workflowId:dispatched.workflowId,duplicate:Boolean(dispatched.duplicate),fastLane:true});return{durable:true,provider:'temporal'};}event('temporal_dispatch_fallback',{source:op.source,externalId:op.externalId,reason:dispatched.reason||'',fastLane:true});}return processMarketplaceOpportunity(op);});
      return{ok:true,found:normalized.length,processed:rows.filter(x=>!x?.durable).length,durableDispatched:rows.filter(x=>x?.durable).length,triggerDispatched:rows.filter(x=>x?.provider==='trigger').length,temporalDispatched:rows.filter(x=>x?.provider==='temporal').length};
    }catch(error){return{ok:false,reason:String(error?.message||error).slice(0,200)};}
    finally{fastCycleRunning=false;}
  }
  function capabilityContext(){return{llmEnabled:Boolean(llm.available??llm.enabled),hasGithubPrTool:Boolean(env.GITHUB_TOKEN),hasShellTool:Boolean(env.E2B_API_KEY),hasBrowserTool:Boolean(env.BROWSERBASE_API_KEY&&env.BROWSERBASE_PROJECT_ID),hasDeployTool:Boolean(env.AUTONOMOS_DEPLOY_WEBHOOK_URL),hasArtifactTool:Boolean(env.S3_ENDPOINT&&env.S3_BUCKET&&env.S3_ACCESS_KEY_ID&&env.S3_SECRET_ACCESS_KEY),hasAppTool:Boolean(env.COMPOSIO_API_KEY),hasWebSearchTool:Boolean(env.FIRECRAWL_API_KEY||env.TAVILY_API_KEY)};}
  function capabilityVersion(){
    return crypto.createHash('sha256').update(JSON.stringify({model:llm.model||'',firecrawl:Boolean(env.FIRECRAWL_API_KEY),tavily:Boolean(env.TAVILY_API_KEY),e2b:Boolean(env.E2B_API_KEY),browserbase:Boolean(env.BROWSERBASE_API_KEY&&env.BROWSERBASE_PROJECT_ID),composio:Boolean(env.COMPOSIO_API_KEY),github:Boolean(env.GITHUB_TOKEN),artifact:Boolean(env.S3_ENDPOINT&&env.S3_BUCKET)})).digest('hex').slice(0,16);
  }
  function buildIncidents(){
    const out=[];const now=Date.now();const summary=jobRegistry.summary();
    if(config.enabled&&Number(summary.ready||0)===0&&state.lastCycleAt&&now-Date.parse(state.lastCycleAt)>30*60_000)out.push({severity:'warning',code:'no_ready_jobs',source:'runtime',firstSeenAt:state.lastCycleAt,message:'No Ready jobs after repeated market scans.',recommendedAction:'Inspect blockers and marketplace yield.'});
    if(llm.status&&llm.status().available===false)out.push({severity:'critical',code:'llm_circuit_open',source:'llm',message:'LLM circuit breaker is open.',recommendedAction:'Stop new claims until model health recovers.'});
    for(const [source,h] of Object.entries(state.connectorHealth||{})){if(h&&h.ok===false)out.push({severity:'warning',code:'connector_unavailable',source,message:String(h.error||h.status||'Connector unavailable').slice(0,220),recommendedAction:'Check credentials/API health.'});}
    if(summary.systemBlocked>0)out.push({severity:'warning',code:'system_blocked_jobs',source:'execution',message:`${summary.systemBlocked} jobs are held because of our execution/capability failures.`,recommendedAction:'Inspect System Blocked; fix capability before release.'});
    return out.slice(0,20);
  }
  function inferPayoutMethods(op){if(op?.source==='clawlancer')return['crypto'];if(['t2000','dealwork','superteam'].includes(op?.source))return['marketplace'];return Array.isArray(op?.supportedMethods)?op.supportedMethods:[];}
  async function mapLimit(items,limit,worker){const rows=Array.from(items||[]);const out=new Array(rows.length);let cursor=0;const runners=Array.from({length:Math.min(rows.length,Math.max(1,Number(limit||1)))},async()=>{while(true){const index=cursor++;if(index>=rows.length)return;try{out[index]=await worker(rows[index],index);}catch(error){out[index]={ok:false,error:String(error?.message||error).slice(0,220)};}}});await Promise.all(runners);return out;}
  function reschedule(){if(config.enabled&&!config.killSwitch)schedule();} function persistAgents(){store.writeJson('agents.json',agents);} function persistCore(){store.writeJson('config.json',config);store.writeJson('state.json',state);persistAgents();store.writeJson('children.json',children);store.writeJson('offers.json',offers);} function event(type,detail){const row={at:new Date().toISOString(),type,...detail};store.append('events.ndjson',row);eventBus.publish(type,row).catch(()=>{});emitOperationalLog(row,{env}).catch(()=>{});}
}

function defaultOffers(){return Object.fromEntries(MACHINE_PRODUCTS.map(p=>[p.id,{priceUsd:p.priceUsd,updatedAt:'',basis:'initial'}]));}
function defaultState(){return{createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),startedAt:'',cycles:0,lastCycleAt:'',lastCycleMs:0,lastCycleId:'',lastCycleTrigger:'',lastError:'',treasury:{ok:false,usdc:0,usdt:0,eth:0,checkedAt:''},marketplaceWallets:{},connectorHealth:{},marketSummary:{},competition:{},catalogReady:false};}
function median(values){if(!values.length)return 0;const s=[...values].sort((a,b)=>a-b),m=Math.floor(s.length/2);return round(s.length%2?s[m]:(s[m-1]+s[m])/2);}function round(v){return Math.round((Number(v||0)+Number.EPSILON)*1e6)/1e6;}
function sampleAcrossSources(rows,sources,perSource){const out=[];for(const source of sources)out.push(...rows.filter(r=>r.source===source).slice(0,perSource));return out;}
