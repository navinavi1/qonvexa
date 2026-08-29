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
  claimMarketplaceJob, deliverMarketplaceJob, readMarketplaceWallets, syncMarketplaceTransactions
} from './connectors/index.js';
import { createLlmClient } from './llm.js';
import { classifyOpportunity } from './capabilities.js';
import { executeExternalOpportunity } from './job-executor.js';
import { opportunityKey } from './job-normalizer.js';

export function createAutonomOS({ storageDir, siteUrl, ownerWallet, env = process.env, logger = console } = {}) {
  if (!storageDir) throw new Error('AutonomOS requires storageDir');
  const rootDir = path.join(storageDir, 'autonomos');
  const store = new AutonomOSStore(rootDir);
  const llm = createLlmClient(env);
  const wallet = isEvmAddress(ownerWallet) ? ownerWallet : String(env.AUTONOMOS_OWNER_WALLET || '');
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

  let x402Idempotency = store.readJson('x402-idempotency.json', {});
  const x402 = createX402Gateway({ ownerWallet:wallet, siteUrl, env, onSettlement:recordSettlement, idempotency:{
    async get(key){ return x402Idempotency[key] || null; },
    async set(key,value){ x402Idempotency[key]=value; const entries=Object.entries(x402Idempotency); if(entries.length>1000)x402Idempotency=Object.fromEntries(entries.slice(-1000)); store.writeJson('x402-idempotency.json',x402Idempotency); }
  } });
  cleanupExpiredChildren();
  persistCore();
  if (config.enabled && !config.killSwitch) schedule();

  return {
    products:MACHINE_PRODUCTS,
    get config(){ return config; },
    get ownerWallet(){ return wallet; },

    async snapshot() {
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
        opportunities, jobs, events, missing:missingSetup()
      };
    },

    updateConfig(patch = {}) {
      const allowed = [
        'genesisObjective','minMarginPercent','reservePercent','growthPercent','experimentPercent',
        'heartbeatSeconds','fastClaimPollSeconds','maxChildren','childSpawnConcurrencyThreshold','childTtlMinutes','autoReplication',
        'maxApiCostPercentOfPayout','maxJobsPerCycle','autoClaimJobs','requireEscrowForAutoClaim','minJobPayoutUsd',
        'zeroSpendMode','earnedFundsOnly','allowExternalSpending','seedSpendBudgetUsd'
      ];
      const next={...config};
      for(const key of allowed) if(Object.prototype.hasOwnProperty.call(patch,key)) next[key]=patch[key];
      config=normalizeConfig(next); store.writeJson('config.json',config); reschedule();
      event('config_updated',{changed:allowed.filter(k=>Object.prototype.hasOwnProperty.call(patch,k))});
      return safeConfig(config);
    },

    start(){config=normalizeConfig({...config,enabled:true,killSwitch:false});state.startedAt=state.startedAt||new Date().toISOString();store.writeJson('config.json',config);event('runtime_started',{});schedule();return{ok:true,status:'running'};},
    stop(){config=normalizeConfig({...config,enabled:false});store.writeJson('config.json',config);clearTimer();event('runtime_stopped',{});return{ok:true,status:'stopped'};},
    emergencyStop(){config=normalizeConfig({...config,enabled:false,killSwitch:true,allowExternalSpending:false,zeroSpendMode:true});store.writeJson('config.json',config);clearTimer();for(const job of activeJobs.values())job.cancelled=true;event('emergency_stop',{activeJobs:activeJobs.size});return{ok:true,status:'emergency_stopped'};},
    clearEmergencyStop(){config=normalizeConfig({...config,killSwitch:false,enabled:false,allowExternalSpending:false,zeroSpendMode:true});store.writeJson('config.json',config);event('emergency_stop_cleared',{});return{ok:true,status:'stopped'};},
    async runCycle(){return cycle('manual');},

    // One-time recovery for the 'credentials missing during bootstrap' misclassification
    // bug: opportunities discovered in the few seconds before a connector finished
    // bootstrapping got permanently blacklisted. This clears that blacklist so the
    // (now-fixed) retry logic gets a fresh chance at the same opportunities. Does NOT
    // touch seen-opportunities.json (pure discovery dedup, safe to keep) or any ledger/
    // treasury data — only the claim-retry bookkeeping.
    resetClaimHistory(){
      handled.clear(); claimAttempts={};
      persistSet('handled-opportunities.json',handled); store.writeJson('claim-attempts.json',claimAttempts);
      event('claim_history_reset',{});
      return {ok:true};
    },

    async refreshTreasury(){
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
      const boot=await bootstrapMarketCredentials({env,credentials,ownerWallet:wallet,storeCredential:(id,value)=>{credentials={...credentials,[id]:value};store.writeSecretJson('credentials.private.json',credentials);}});
      state.bootstrapHealth=boot;
      const discovery=await discoverMarketOpportunities({env,credentials,limit:100}); state.connectorHealth=discovery.health;
      const cycleLedger=store.readNdjson('ledger.ndjson',4000);
      const availableSpendUsd=computeEarnedSpendBudgetUsd(cycleLedger,config);
      state.earnedSpendBudgetUsd=availableSpendUsd;
      const cycleConfig={...config,availableSpendUsd};
      const normalized=[];
      for(const opportunity of discovery.signals){
        const cap=classifyOpportunity(opportunity,{llmEnabled:llm.enabled});
        const feeUsd=Number(opportunity.budgetUsd||0)*Number(opportunity.feePercent||0)/100;
        const econ=evaluateOpportunity({expectedRevenueUsd:Number(opportunity.budgetUsd||0),successProbability:cap.confidence||0.5,modelCostUsd:cap.estimatedModelCostUsd,marketplaceFeeUsd:feeUsd,computeCostUsd:0},cycleConfig);
        const row={...opportunity,capability:cap,economics:econ}; normalized.push(row); recordOpportunity(row);
      }
      setAgentMetric('opportunity-radar',{tasks:1});
      setAgent('demand-analyst','working');state.marketSummary=summarizeOpportunities(normalized);setAgentMetric('demand-analyst',{tasks:1});
      setAgent('competition-agent','working');state.competition=competitionSnapshot(normalized);setAgentMetric('competition-agent',{tasks:1});
      setAgent('economics-agent','working');state.opportunityEconomics=normalized.slice(0,100).map(x=>({source:x.source,externalId:x.externalId,budgetUsd:x.budgetUsd,capability:x.capability,economics:x.economics}));setAgentMetric('economics-agent',{tasks:1});

      setAgent('pricing-agent','working');state.offerOptimization=optimizeOffers(normalized.filter(x=>x.source==='x402-bazaar'));setAgentMetric('pricing-agent',{tasks:1});
      setAgent('offer-architect','working');setAgentMetric('offer-architect',{tasks:1}); setAgent('distribution-agent','working');state.catalogReady=true;setAgentMetric('distribution-agent',{tasks:1});

      const candidates=normalized.filter(isAutoClaimCandidate).sort((a,b)=>scoreCandidate(b)-scoreCandidate(a)).slice(0,config.maxJobsPerCycle);
      let claimed=0,delivered=0;
      for(const opportunity of candidates){
        const result=await processMarketplaceOpportunity(opportunity); if(result.claimed)claimed++; if(result.delivered)delivered++;
      }

      await syncSettlements();
      if(!state.treasury?.checkedAt||Date.now()-Date.parse(state.treasury.checkedAt||0)>10*60_000){
        setAgent('treasury-cfo','working');state.treasury=await readTreasuryBalances({address:wallet,env});state.marketplaceWallets=await readMarketplaceWallets({env,credentials});setAgentMetric('treasury-cfo',{tasks:1});
      }
      setAgent('evolution-agent','working');state.lastEvolution=boundedEvolution(normalized);setAgentMetric('evolution-agent',{tasks:1});
      state.cycles=Number(state.cycles||0)+1;state.lastCycleAt=new Date().toISOString();state.lastCycleMs=Date.now()-started;state.updatedAt=new Date().toISOString();state.lastCycleId=cycleId;state.lastCycleTrigger=trigger;
      state.lastCycleSummary={opportunities:normalized.length,candidates:candidates.length,claimed,delivered};store.writeJson('state.json',state);
      event('cycle_completed',{cycleId,trigger,ms:state.lastCycleMs,opportunities:normalized.length,candidates:candidates.length,claimed,delivered});
      return{ok:true,cycleId,ms:state.lastCycleMs,opportunities:normalized.length,candidates:candidates.length,claimed,delivered};
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
  function isAutoClaimCandidate(op){
    if(!config.autoClaimJobs)return false;
    const key=opportunityKey(op);
    if(handled.has(key))return false;
    const attempt=claimAttempts[key];
    if(attempt&&Date.now()-Date.parse(attempt.lastAttemptAt||0)<CLAIM_RETRY_BACKOFF_MS)return false;
    if(!['clawlancer','t2000','dealwork'].includes(op.source))return false;
    if(config.requireEscrowForAutoClaim&&!op.escrowed)return false;
    if(Number(op.budgetUsd||0)<Number(config.minJobPayoutUsd||0))return false;
    if(!op.capability?.executable||!op.economics?.allowed)return false;
    if(op.capability.estimatedModelCostUsd>Number(op.budgetUsd||0)*(Number(config.maxApiCostPercentOfPayout||25)/100))return false;
    return ['open','active','available','posted',''].includes(String(op.status||''));
  }
  function scoreCandidate(op){return Number(op.economics?.expectedProfitUsd||0)*Math.max(0.1,Number(op.capability?.confidence||0));}

  async function processMarketplaceOpportunity(op){
    const key=opportunityKey(op);
    setAgent('job-router','working');setAgent('policy-agent','working');setAgent('economics-agent','working');
    const jobId=`ext_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`; const startedAt=new Date().toISOString();
    store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,title:op.title,budgetUsd:op.budgetUsd,currency:op.currency,status:'claiming',startedAt});event('market_job_claiming',{jobId,source:op.source,externalId:op.externalId,budgetUsd:op.budgetUsd});
    const claim=await claimMarketplaceJob(op,{env,credentials});
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
    setAgentMetric('job-router',{tasks:1});maybeSpawnChild(op.category||op.source);
    const worker=pickExternalWorker(op.capability?.skill);setWorkerStatus(worker,'working');activeJobs.set(jobId,{id:jobId,source:op.source,externalId:op.externalId,workerId:worker.id,cancelled:false});
    store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,status:'claimed',transactionId:claim.transactionId||'',workerId:worker.id,at:new Date().toISOString()});event('market_job_claimed',{jobId,source:op.source,externalId:op.externalId,transactionId:claim.transactionId||''});
    try{
      if(op.source==='t2000'&&claim.workOrderMissing){throw new Error('t2000_work_order_unavailable_refusing_blind_delivery');}
      const execOp=claim.workOrder?{...op,__workOrderRaw:claim.workOrder,description:`${op.description}\n\n[t2000 job_status work order]\n${typeof claim.workOrder==='string'?claim.workOrder:JSON.stringify(claim.workOrder).slice(0,4000)}`}:op;
      const deliverable=await executeExternalOpportunity(execOp,op.capability,{llm,siteUrl});
      setAgent('qa-evaluator','working'); validateExternalDeliverable(deliverable,execOp);
      const delivery=await deliverMarketplaceJob(op,claim,deliverable,{env,credentials});
      if(!delivery.ok)throw new Error(`delivery_failed:${delivery.reason||'unknown'}`);
      store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,status:'delivered',transactionId:delivery.transactionId||claim.transactionId||'',workerId:worker.id,deliverableHash:deliverable.hash,at:new Date().toISOString()});
      const actualCostUsd=computeActualCostUsd(deliverable,op.capability);
      setWorkerMetric(worker,{tasks:1,cost:actualCostUsd});setAgentMetric('qa-evaluator',{tasks:1});event('market_job_delivered',{jobId,source:op.source,externalId:op.externalId,transactionId:delivery.transactionId||''});
      recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:actualCostUsd,kind:'model',estimated:!deliverable.evidence?.usage});
      return{claimed:true,delivered:true};
    }catch(error){
      store.append('jobs.ndjson',{id:jobId,source:op.source,externalId:op.externalId,status:'execution_failed',workerId:worker.id,error:String(error?.message||error).slice(0,300),at:new Date().toISOString()});
      incrementWorkerError(worker);event('market_job_failed',{jobId,source:op.source,externalId:op.externalId,error:String(error?.message||error).slice(0,220)});
      // The LLM call (if any) may already have been billed even though the job failed
      // afterwards (bad output, delivery rejected, etc). Record that spend so it isn't
      // silently absorbed as free — this is exactly the "Revenue $1 / Cost $0" bug.
      const incurredCostUsd=Number(op.capability?.estimatedModelCostUsd||0);
      if(incurredCostUsd>0)recordCost({jobId,source:op.source,externalId:op.externalId,amountUsd:incurredCostUsd,kind:'model',estimated:true,note:'job_failed_after_model_call'});
      return{claimed:true,delivered:false};
    }
    finally{activeJobs.delete(jobId);setWorkerStatus(worker,'idle');}
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
    store.append('ledger.ndjson',{id:`cost_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,type:'cost',source,jobId,externalId,kind:kind||'model',amountUsd:amount,estimated:Boolean(estimated),note:note||'',at:new Date().toISOString()});
  }

  async function syncSettlements(){
    const sync=await syncMarketplaceTransactions({env,credentials});state.settlementHealth=sync.health;
    for(const tx of sync.transactions){
      if(!tx.externalTransactionId||settledTx.has(`${tx.source}:${tx.externalTransactionId}`))continue;
      if(!['settled','released','completed','paid'].includes(tx.status))continue;
      const key=`${tx.source}:${tx.externalTransactionId}`;settledTx.add(key);persistSet('settled-transactions.json',settledTx);
      const revenueUsd=Math.max(0,Number(tx.amountUsd||0));store.append('ledger.ndjson',{id:`tx_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,type:'revenue',source:tx.source,externalTransactionId:tx.externalTransactionId,amountUsd:revenueUsd,currency:tx.currency,network:tx.network,allocation:allocateRevenue(revenueUsd,config),at:new Date().toISOString()});
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
    const revenueUsd=info.live?Number(info.amountUsd||0):0;store.append('ledger.ndjson',{id:`tx_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,type:'revenue',source:'x402',productId:info.product.id,amountUsd:revenueUsd,displayAmountUsd:Number(info.amountUsd||0),testnet:!info.live,network:info.network,payer:info.payer,transaction:info.transaction,allocation:allocateRevenue(revenueUsd,config),at:info.settledAt});setAgentMetric('treasury-cfo',{tasks:1,revenue:revenueUsd});setAgentMetric('distribution-agent',{tasks:1,revenue:revenueUsd});event('payment_settled',{productId:info.product.id,amountUsd:info.amountUsd,asset:info.assetSymbol||'USDC',testnet:!info.live,transaction:info.transaction});
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

  function maybeSpawnChild(specialization){if(!config.autoReplication||config.maxChildren<=0)return null;const same=[...activeJobs.values()].filter(j=>(j.productId||j.source)===specialization).length;if(same<config.childSpawnConcurrencyThreshold)return null;const active=children.filter(c=>c.status==='alive');if(active.length>=config.maxChildren)return null;const child={id:`child_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,parent:'replication-manager',specialization,status:'alive',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+config.childTtlMinutes*60_000).toISOString(),budgetUsd:0,zeroSpendMode:true,tasksCompleted:0,revenueUsd:0,costUsd:0,errors:0,runtimeStatus:'idle',queueDepth:0,lastActiveAt:''};children.push(child);store.writeJson('children.json',children);setAgentMetric('replication-manager',{tasks:1});event('child_spawned',{childId:child.id,specialization,budgetUsd:0});return child;}
  function cleanupExpiredChildren(){const now=Date.now();let changed=false;for(const child of children){if(child.status==='alive'&&Date.parse(child.expiresAt||0)<=now){child.status='expired';child.closedAt=new Date().toISOString();changed=true;event('child_expired',{childId:child.id,specialization:child.specialization});}}if(changed)store.writeJson('children.json',children);}
  function pickProductWorker(productId){const child=children.filter(c=>c.status==='alive'&&c.specialization===productId).sort((a,b)=>Number(a.tasksCompleted||0)-Number(b.tasksCompleted||0))[0];if(child)return{...child,name:`Child · ${productId}`,isChild:true};const id=productId==='security-headers'||productId==='robots-audit'?'automation-worker':productId==='technology-fingerprint'?'code-worker':productId==='copy-clarity-signals'||productId==='conversion-signals'?'content-worker':'research-worker';return agents.find(a=>a.id===id)||agents[0];}
  function pickExternalWorker(skill){const map={'web-research':'research-worker','copywriting':'content-worker','code-analysis':'code-worker','translation':'content-worker','data-transform':'automation-worker'};const id=map[skill]||'automation-worker';const child=children.filter(c=>c.status==='alive'&&c.specialization===skill).sort((a,b)=>Number(a.tasksCompleted||0)-Number(b.tasksCompleted||0))[0];return child?{...child,name:`Child · ${skill}`,isChild:true}:agents.find(a=>a.id===id)||agents[0];}
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
      const discovery=await discoverMarketOpportunities({env,credentials,limit:60,sources:['clawlancer','t2000','dealwork']});
      const cycleLedger=store.readNdjson('ledger.ndjson',4000);
      const cycleConfig={...config,availableSpendUsd:computeEarnedSpendBudgetUsd(cycleLedger,config)};
      const normalized=discovery.signals.map(opportunity=>{
        const cap=classifyOpportunity(opportunity,{llmEnabled:llm.enabled});
        const feeUsd=Number(opportunity.budgetUsd||0)*Number(opportunity.feePercent||0)/100;
        const econ=evaluateOpportunity({expectedRevenueUsd:Number(opportunity.budgetUsd||0),successProbability:cap.confidence||0.5,modelCostUsd:cap.estimatedModelCostUsd,marketplaceFeeUsd:feeUsd,computeCostUsd:0},cycleConfig);
        const row={...opportunity,capability:cap,economics:econ}; recordOpportunity(row); return row;
      });
      const candidates=normalized.filter(isAutoClaimCandidate).sort((a,b)=>scoreCandidate(b)-scoreCandidate(a)).slice(0,config.maxJobsPerCycle);
      for(const op of candidates)await processMarketplaceOpportunity(op);
      return{ok:true,found:normalized.length,claimed:candidates.length};
    }catch(error){return{ok:false,reason:String(error?.message||error).slice(0,200)};}
    finally{fastCycleRunning=false;}
  }
  function reschedule(){if(config.enabled&&!config.killSwitch)schedule();} function persistAgents(){store.writeJson('agents.json',agents);} function persistCore(){store.writeJson('config.json',config);store.writeJson('state.json',state);persistAgents();store.writeJson('children.json',children);store.writeJson('offers.json',offers);} function event(type,detail){store.append('events.ndjson',{at:new Date().toISOString(),type,...detail});}
}

function defaultOffers(){return Object.fromEntries(MACHINE_PRODUCTS.map(p=>[p.id,{priceUsd:p.priceUsd,updatedAt:'',basis:'initial'}]));}
function defaultState(){return{createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),startedAt:'',cycles:0,lastCycleAt:'',lastCycleMs:0,lastCycleId:'',lastCycleTrigger:'',lastError:'',treasury:{ok:false,usdc:0,usdt:0,eth:0,checkedAt:''},marketplaceWallets:{},connectorHealth:{},marketSummary:{},competition:{},catalogReady:false};}
function median(values){if(!values.length)return 0;const s=[...values].sort((a,b)=>a-b),m=Math.floor(s.length/2);return round(s.length%2?s[m]:(s[m-1]+s[m])/2);}function round(v){return Math.round((Number(v||0)+Number.EPSILON)*1e6)/1e6;}
