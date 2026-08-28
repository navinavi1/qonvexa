import path from 'node:path';
import crypto from 'node:crypto';
import { CORE_AGENTS, buildAgentState, agentMap } from './agents.js';
import { AutonomOSStore } from './store.js';
import { normalizeConfig, DEFAULT_AUTONOMOS_CONFIG, validateAction } from './policy-engine.js';
import { evaluateOpportunity, allocateRevenue } from './profit-engine.js';
import { readBaseBalances, isEvmAddress } from './treasury.js';
import { MACHINE_PRODUCTS, executeProduct, getProduct } from './products.js';
import { createX402Gateway } from './x402.js';
import { connectorStatuses, discoverPublicSignals } from './connectors/index.js';
import { createLlmClient } from './llm.js';

export function createAutonomOS({ storageDir, siteUrl, ownerWallet, env = process.env, logger = console } = {}) {
  if (!storageDir) throw new Error('AutonomOS requires storageDir');
  const rootDir = path.join(storageDir, 'autonomos');
  const store = new AutonomOSStore(rootDir);
  const llm = createLlmClient(env);
  const wallet = isEvmAddress(ownerWallet) ? ownerWallet : String(env.AUTONOMOS_OWNER_WALLET || '');

  let config = normalizeConfig(store.readJson('config.json', {
    ...DEFAULT_AUTONOMOS_CONFIG,
    enabled:/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_ENABLED || 'false'))
  }));
  let state = store.readJson('state.json', defaultState());
  let agents = buildAgentState(Object.fromEntries((store.readJson('agents.json', []) || []).map(x=>[x.id,x])));
  let timer = null;
  let cycleRunning = false;
  const activeJobs = new Map();
  let children = store.readJson('children.json', []);
  let offers = store.readJson('offers.json', defaultOffers());

  const x402 = createX402Gateway({
    ownerWallet:wallet,
    siteUrl,
    env,
    onSettlement:recordSettlement
  });

  cleanupExpiredChildren();
  persistCore();
  if (config.enabled && !config.killSwitch) schedule();

  return {
    products:MACHINE_PRODUCTS,
    get config(){ return config; },
    get ownerWallet(){ return wallet; },

    async snapshot() {
      const ledger = store.readNdjson('ledger.ndjson', 2000);
      const events = store.readNdjson('events.ndjson', 300).reverse();
      const opportunities = store.readNdjson('opportunities.ndjson', 300).reverse();
      const jobs = store.readNdjson('jobs.ndjson', 300).reverse();
      const metrics = calculateMetrics(ledger, jobs);
      return {
        project:'AutonomOS', version:'1.0.0',
        runtime:{
          ...state,
          status:config.killSwitch ? 'emergency_stopped' : config.enabled ? (cycleRunning ? 'working' : 'running') : 'stopped',
          cycleRunning,
          activeJobCount:activeJobs.size,
          llm:{ enabled:llm.enabled, provider:llm.provider, model:llm.model }
        },
        config:safeConfig(config),
        treasury:{ ownerWallet:wallet, ...(state.treasury || {}), allocations:metrics.allocations },
        metrics,
        agents,
        children,
        products:currentProducts().map(product=>({ ...product, payment:x402.status() })),
        connectors:connectorStatuses(env, x402.status()),
        opportunities,
        jobs,
        events,
        missing:missingSetup()
      };
    },

    updateConfig(patch = {}) {
      const allowed = [
        'genesisObjective','minMarginPercent','reservePercent','growthPercent','experimentPercent',
        'heartbeatSeconds','maxChildren','childSpawnConcurrencyThreshold','childTtlMinutes','autoReplication'
      ];
      const next = { ...config };
      for (const key of allowed) if (Object.prototype.hasOwnProperty.call(patch,key)) next[key] = patch[key];
      config = normalizeConfig(next);
      store.writeJson('config.json', config);
      reschedule();
      event('config_updated', { changed:allowed.filter(key=>Object.prototype.hasOwnProperty.call(patch,key)) });
      return safeConfig(config);
    },

    start() {
      config = normalizeConfig({ ...config, enabled:true, killSwitch:false });
      state.startedAt = state.startedAt || new Date().toISOString();
      store.writeJson('config.json', config);
      event('runtime_started', {});
      schedule();
      return { ok:true, status:'running' };
    },

    stop() {
      config = normalizeConfig({ ...config, enabled:false });
      store.writeJson('config.json', config);
      clearTimer();
      event('runtime_stopped', {});
      return { ok:true, status:'stopped' };
    },

    emergencyStop() {
      config = normalizeConfig({ ...config, enabled:false, killSwitch:true, allowExternalSpending:false, zeroSpendMode:true });
      store.writeJson('config.json', config);
      clearTimer();
      for (const job of activeJobs.values()) job.cancelled = true;
      event('emergency_stop', { activeJobs:activeJobs.size });
      return { ok:true, status:'emergency_stopped' };
    },

    clearEmergencyStop() {
      config = normalizeConfig({ ...config, killSwitch:false, enabled:false, allowExternalSpending:false, zeroSpendMode:true });
      store.writeJson('config.json', config);
      event('emergency_stop_cleared', {});
      return { ok:true, status:'stopped' };
    },

    async runCycle() { return cycle('manual'); },

    async refreshTreasury() {
      const balances = await readBaseBalances({ address:wallet, rpcUrl:String(env.AUTONOMOS_BASE_RPC_URL || 'https://mainnet.base.org') });
      state.treasury = balances;
      state.updatedAt = new Date().toISOString();
      store.writeJson('state.json', state);
      event('treasury_refreshed', { ok:balances.ok, usdc:balances.usdc, eth:balances.eth, error:balances.error || '' });
      return balances;
    },

    async handleProductRequest(productId, req, res) {
      const product = currentProduct(productId);
      if (!product) return res.status(404).json({ error:'Unknown product.' });
      return x402.protect({
        req, res, product,
        handler:async()=>executePaidJob(product, Object.fromEntries(Object.entries(req.query || {}).map(([key,val])=>[key,String(val ?? '')])))
      });
    },

    async previewProduct(productId, query) {
      const product = currentProduct(productId);
      if (!product) throw Object.assign(new Error('Unknown product.'), { status:404 });
      return executeTrackedProduct(product, query, { paid:false, source:'admin_preview' });
    },

    catalog() {
      return {
        name:'AutonomOS Machine Services',
        version:'1.0.0',
        ownerWallet:wallet,
        payment:x402.status(),
        products:currentProducts().map(product=>({ ...product, url:new URL(product.path, siteUrl).toString() }))
      };
    }
  };

  async function cycle(trigger) {
    if (cycleRunning) return { ok:false, reason:'cycle_already_running' };
    if (config.killSwitch) return { ok:false, reason:'emergency_stop' };
    if (!config.enabled && trigger !== 'manual') return { ok:false, reason:'runtime_stopped' };
    cycleRunning = true;
    const cycleId = `cy_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const started = Date.now();
    setAgent('prime-governor','working');
    setAgent('opportunity-radar','working');
    try {
      cleanupExpiredChildren();
      const discovery = await discoverPublicSignals({ env });
      for (const signal of discovery.signals) recordOpportunity(signal);
      state.connectorHealth = discovery.health;
      setAgentMetric('opportunity-radar', { tasks:1 });

      setAgent('demand-analyst','working');
      const marketSummary = summarizeSignals(discovery.signals);
      state.marketSummary = marketSummary;
      setAgentMetric('demand-analyst', { tasks:1 });

      setAgent('competition-agent','working');
      state.competition = competitionSnapshot(discovery.signals);
      setAgentMetric('competition-agent', { tasks:1 });

      setAgent('economics-agent','working');
      state.productEconomics = currentProducts().map(product => ({
        id:product.id,
        ...evaluateOpportunity({ expectedRevenueUsd:product.priceUsd, successProbability:1, computeCostUsd:0 }, config)
      }));
      setAgentMetric('economics-agent', { tasks:1 });

      setAgent('pricing-agent','working');
      state.offerOptimization = optimizeOffers(discovery.signals);
      setAgent('offer-architect','working');
      setAgent('distribution-agent','working');
      state.catalogReady = true;
      for (const id of ['pricing-agent','offer-architect','distribution-agent']) setAgentMetric(id,{ tasks:1 });

      if (!state.treasury?.checkedAt || Date.now() - Date.parse(state.treasury.checkedAt || 0) > 10 * 60 * 1000) {
        setAgent('treasury-cfo','working');
        const balances = await readBaseBalances({ address:wallet, rpcUrl:String(env.AUTONOMOS_BASE_RPC_URL || 'https://mainnet.base.org') });
        state.treasury = balances;
        setAgentMetric('treasury-cfo', { tasks:1 });
      }

      setAgent('evolution-agent','working');
      state.lastEvolution = boundedEvolution(discovery.signals);
      setAgentMetric('evolution-agent', { tasks:1 });

      state.cycles = Number(state.cycles || 0) + 1;
      state.lastCycleAt = new Date().toISOString();
      state.lastCycleMs = Date.now() - started;
      state.updatedAt = new Date().toISOString();
      state.lastCycleId = cycleId;
      state.lastCycleTrigger = trigger;
      store.writeJson('state.json', state);
      event('cycle_completed', { cycleId, trigger, ms:state.lastCycleMs, signals:discovery.signals.length });
      return { ok:true, cycleId, ms:state.lastCycleMs, signals:discovery.signals.length };
    } catch (error) {
      state.lastError = String(error?.message || error).slice(0,400);
      state.updatedAt = new Date().toISOString();
      store.writeJson('state.json', state);
      incrementAgentError('prime-governor');
      event('cycle_failed', { cycleId, trigger, error:state.lastError });
      logger.error?.('AutonomOS cycle failed:', error);
      return { ok:false, cycleId, error:state.lastError };
    } finally {
      cycleRunning = false;
      for (const agent of agents) if (agent.status === 'working') agent.status = 'idle';
      persistAgents();
    }
  }

  async function executePaidJob(product, query) {
    return executeTrackedProduct(product, query, { paid:true, source:'x402' });
  }

  async function executeTrackedProduct(product, query, meta) {
    const policy = validateAction({ kind:'execute', productId:product.id }, { ...config, enabled:true });
    if (!policy.allowed) throw Object.assign(new Error(policy.reason), { status:503, code:policy.reason });
    const jobId = `job_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const worker = pickWorker(product.id);
    const startedAt = new Date().toISOString();
    const active = { id:jobId, productId:product.id, workerId:worker.id, startedAt, cancelled:false };
    activeJobs.set(jobId, active);
    maybeSpawnChild(product.id);
    setAgent('job-router','working');
    setWorkerStatus(worker,'working');
    setAgent('security-sentinel','working');
    store.append('jobs.ndjson', { id:jobId, productId:product.id, source:meta.source, status:'started', workerId:worker.id, startedAt });
    event('job_started', { jobId, productId:product.id, workerId:worker.id, source:meta.source });
    try {
      const result = await executeProduct(product.id, query);
      if (active.cancelled) throw Object.assign(new Error('job_cancelled'), { status:503, code:'job_cancelled' });
      setAgent('qa-evaluator','working');
      validateResult(result, product.id);
      const completedAt = new Date().toISOString();
      store.append('jobs.ndjson', { id:jobId, productId:product.id, source:meta.source, status:'completed', workerId:worker.id, startedAt, completedAt });
      setWorkerMetric(worker, { tasks:1 });
      setAgentMetric('job-router', { tasks:1 });
      setAgentMetric('security-sentinel', { tasks:1 });
      setAgentMetric('qa-evaluator', { tasks:1 });
      event('job_completed', { jobId, productId:product.id, workerId:worker.id, paid:meta.paid });
      return { ...result, autonomos:{ jobId, worker:worker.name, payment:meta.paid ? 'verified_before_execution; settlement_after_success' : 'admin_preview' } };
    } catch (error) {
      store.append('jobs.ndjson', { id:jobId, productId:product.id, source:meta.source, status:'failed', workerId:worker.id, startedAt, completedAt:new Date().toISOString(), error:String(error?.message || error).slice(0,300) });
      incrementWorkerError(worker);
      event('job_failed', { jobId, productId:product.id, workerId:worker.id, error:String(error?.message || error).slice(0,200) });
      throw error;
    } finally {
      activeJobs.delete(jobId);
      setWorkerStatus(worker,'idle');
      setAgent('job-router','idle');
      setAgent('qa-evaluator','idle');
      setAgent('security-sentinel','idle');
      persistAgents();
    }
  }

  async function recordSettlement(info) {
    const revenueUsd = info.live ? Number(info.amountUsd || 0) : 0;
    const allocation = allocateRevenue(revenueUsd, config);
    store.append('ledger.ndjson', {
      id:`tx_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      type:'revenue',
      source:'x402',
      productId:info.product.id,
      amountUsd:revenueUsd,
      displayAmountUsd:Number(info.amountUsd || 0),
      testnet:!info.live,
      network:info.network,
      payer:info.payer,
      transaction:info.transaction,
      allocation,
      at:info.settledAt
    });
    setAgentMetric('treasury-cfo', { tasks:1, revenue:revenueUsd });
    setAgentMetric('distribution-agent', { tasks:1, revenue:revenueUsd });
    event('payment_settled', { productId:info.product.id, amountUsd:info.amountUsd, testnet:!info.live, transaction:info.transaction });
  }

  function maybeSpawnChild(productId) {
    if (!config.autoReplication || config.maxChildren <= 0) return null;
    const sameProduct = [...activeJobs.values()].filter(job=>job.productId===productId).length;
    if (sameProduct < config.childSpawnConcurrencyThreshold) return null;
    const activeChildren = children.filter(child=>child.status==='alive');
    if (activeChildren.length >= config.maxChildren) return null;
    const child = {
      id:`child_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
      parent:'replication-manager',
      specialization:productId,
      status:'alive',
      createdAt:new Date().toISOString(),
      expiresAt:new Date(Date.now()+config.childTtlMinutes*60_000).toISOString(),
      budgetUsd:0,
      zeroSpendMode:true,
      tasksCompleted:0,
      revenueUsd:0,
      costUsd:0,
      errors:0,
      runtimeStatus:'idle',
      lastActiveAt:''
    };
    children.push(child);
    store.writeJson('children.json', children);
    setAgentMetric('replication-manager', { tasks:1 });
    event('child_spawned', { childId:child.id, specialization:productId, budgetUsd:0 });
    return child;
  }

  function cleanupExpiredChildren() {
    const now = Date.now();
    let changed = false;
    for (const child of children) {
      if (child.status === 'alive' && Date.parse(child.expiresAt || 0) <= now) {
        child.status = 'expired'; child.closedAt = new Date().toISOString(); changed = true;
        event('child_expired', { childId:child.id, specialization:child.specialization });
      }
    }
    if (changed) store.writeJson('children.json', children);
  }

  function recordOpportunity(signal) {
    const id = crypto.createHash('sha256').update(`${signal.source}:${signal.externalId}`).digest('hex').slice(0,20);
    store.append('opportunities.ndjson', { id, ...signal });
  }

  function currentProducts() {
    return MACHINE_PRODUCTS.map(product => ({ ...product, priceUsd:Number(offers[product.id]?.priceUsd ?? product.priceUsd) }));
  }

  function currentProduct(id) {
    return currentProducts().find(product=>product.id===id) || null;
  }

  function optimizeOffers(signals) {
    const changes = [];
    for (const product of MACHINE_PRODUCTS) {
      const productTags = new Set(product.tags.map(tag=>String(tag).toLowerCase()));
      const comparables = signals.filter(signal => {
        const tags = Array.isArray(signal.tags) ? signal.tags.map(tag=>String(tag).toLowerCase()) : [];
        return Number(signal.priceUsd) > 0 && tags.some(tag=>productTags.has(tag));
      }).map(signal=>Number(signal.priceUsd)).filter(Number.isFinite);
      if (comparables.length < 5) continue;
      const marketMedian = median(comparables);
      const current = Number(offers[product.id]?.priceUsd ?? product.priceUsd);
      const floor = Math.max(0.001, Number(product.priceUsd) * 0.5);
      const ceiling = Math.max(floor, Number(product.priceUsd) * 4);
      const target = Math.max(floor, Math.min(ceiling, marketMedian * 0.75));
      const maxStep = Math.max(0.001, current * 0.10);
      const next = round(Math.max(floor, Math.min(ceiling, current + Math.max(-maxStep, Math.min(maxStep, target-current)))));
      if (Math.abs(next-current) < 0.0005) continue;
      offers[product.id] = { ...(offers[product.id]||{}), priceUsd:next, updatedAt:new Date().toISOString(), basis:'tag_matched_market_median', sampleSize:comparables.length };
      changes.push({ productId:product.id, from:current, to:next, marketMedian, samples:comparables.length });
    }
    if (changes.length) {
      store.writeJson('offers.json', offers);
      for (const change of changes) event('price_optimized', change);
    }
    return { mode:'bounded_market_pricing', changes, at:new Date().toISOString() };
  }

  function boundedEvolution(signals) {
    const tags = new Map();
    for (const signal of signals) for (const tag of Array.isArray(signal.tags) ? signal.tags : []) tags.set(String(tag).toLowerCase(), (tags.get(String(tag).toLowerCase()) || 0) + 1);
    const topTags = [...tags.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([tag,count])=>({tag,count}));
    return { mode:'observe_only', reason:'zero_spend_and_safe_capability_templates', topTags, at:new Date().toISOString() };
  }

  function summarizeSignals(signals) {
    const priced = signals.filter(x=>Number(x.priceUsd)>0);
    return {
      observed:signals.length,
      priced:priced.length,
      medianPriceUsd:median(priced.map(x=>Number(x.priceUsd))),
      networks:[...new Set(signals.map(x=>x.network).filter(Boolean))].slice(0,10),
      at:new Date().toISOString()
    };
  }

  function competitionSnapshot(signals) {
    const prices = signals.map(x=>Number(x.priceUsd)).filter(x=>Number.isFinite(x)&&x>0);
    return { samples:prices.length, minPriceUsd:prices.length?Math.min(...prices):0, maxPriceUsd:prices.length?Math.max(...prices):0, medianPriceUsd:median(prices), at:new Date().toISOString() };
  }

  function pickWorker(productId) {
    const child = children
      .filter(item=>item.status==='alive' && item.specialization===productId)
      .sort((a,b)=>Number(a.tasksCompleted||0)-Number(b.tasksCompleted||0))[0];
    if (child) return { ...child, name:`Child · ${productId}`, isChild:true };
    const id = productId === 'security-headers' ? 'automation-worker' : productId === 'robots-audit' ? 'research-worker' : productId === 'site-snapshot' ? 'research-worker' : productId === 'technology-fingerprint' ? 'code-worker' : productId === 'copy-clarity-signals' ? 'content-worker' : productId === 'conversion-signals' ? 'content-worker' : 'automation-worker';
    return agents.find(agent=>agent.id===id) || agents.find(agent=>agent.id==='research-worker');
  }

  function setWorkerStatus(worker,status) {
    if (!worker?.isChild) return setAgent(worker?.id,status);
    const child = children.find(item=>item.id===worker.id);
    if (!child) return;
    child.status = status === 'working' ? 'alive' : child.status;
    child.runtimeStatus = status;
    if (status === 'working') child.lastActiveAt = new Date().toISOString();
    store.writeJson('children.json', children);
  }

  function setWorkerMetric(worker, { tasks=0, revenue=0, cost=0 } = {}) {
    if (!worker?.isChild) return setAgentMetric(worker?.id, { tasks, revenue, cost });
    const child = children.find(item=>item.id===worker.id);
    if (!child) return;
    child.tasksCompleted = Number(child.tasksCompleted||0) + Number(tasks||0);
    child.revenueUsd = round(Number(child.revenueUsd||0) + Number(revenue||0));
    child.costUsd = round(Number(child.costUsd||0) + Number(cost||0));
    child.lastActiveAt = new Date().toISOString();
    store.writeJson('children.json', children);
  }

  function incrementWorkerError(worker) {
    if (!worker?.isChild) return incrementAgentError(worker?.id);
    const child = children.find(item=>item.id===worker.id);
    if (!child) return;
    child.errors = Number(child.errors||0) + 1;
    child.lastActiveAt = new Date().toISOString();
    store.writeJson('children.json', children);
  }

  function validateResult(result, productId) {
    if (!result || typeof result !== 'object') throw Object.assign(new Error('qa_invalid_result'), { status:502, code:'qa_invalid_result' });
    if (result.product !== productId) throw Object.assign(new Error('qa_product_mismatch'), { status:502, code:'qa_product_mismatch' });
    if (!result.generatedAt) throw Object.assign(new Error('qa_timestamp_missing'), { status:502, code:'qa_timestamp_missing' });
    return true;
  }

  function setAgent(id,status) {
    const agent = agents.find(item=>item.id===id);
    if (!agent) return;
    agent.status = status;
    if (status === 'working') agent.lastActiveAt = new Date().toISOString();
  }

  function setAgentMetric(id, { tasks=0, revenue=0, cost=0 } = {}) {
    const agent = agents.find(item=>item.id===id);
    if (!agent) return;
    agent.tasksCompleted += tasks;
    agent.revenueUsd = round(agent.revenueUsd + revenue);
    agent.costUsd = round(agent.costUsd + cost);
    agent.lastActiveAt = new Date().toISOString();
    persistAgents();
  }

  function incrementAgentError(id) {
    const agent = agents.find(item=>item.id===id);
    if (!agent) return;
    agent.errors += 1; agent.lastActiveAt = new Date().toISOString(); persistAgents();
  }

  function calculateMetrics(ledger, jobs) {
    const dayAgo = Date.now() - 24*60*60*1000;
    const realRevenue = ledger.filter(x=>x.type==='revenue'&&!x.testnet).reduce((sum,x)=>sum+Number(x.amountUsd||0),0);
    const cost = ledger.filter(x=>x.type==='cost').reduce((sum,x)=>sum+Number(x.amountUsd||0),0);
    const revenue24h = ledger.filter(x=>x.type==='revenue'&&!x.testnet&&Date.parse(x.at||0)>=dayAgo).reduce((sum,x)=>sum+Number(x.amountUsd||0),0);
    const cost24h = ledger.filter(x=>x.type==='cost'&&Date.parse(x.at||0)>=dayAgo).reduce((sum,x)=>sum+Number(x.amountUsd||0),0);
    const completed = jobs.filter(x=>x.status==='completed').length;
    const failed = jobs.filter(x=>x.status==='failed').length;
    return {
      totalRevenueUsd:round(realRevenue), totalCostUsd:round(cost), netProfitUsd:round(realRevenue-cost),
      revenue24hUsd:round(revenue24h), cost24hUsd:round(cost24h), net24hUsd:round(revenue24h-cost24h),
      completedJobs:completed, failedJobs:failed,
      activeAgents:agents.filter(x=>x.status!=='disabled').length,
      activeChildren:children.filter(x=>x.status==='alive').length,
      allocations:allocateRevenue(Math.max(0,realRevenue-cost), config)
    };
  }

  function missingSetup() {
    const statuses = connectorStatuses(env, x402.status());
    const missing = [];
    if (!isEvmAddress(wallet)) missing.push({ item:'Owner treasury wallet', status:'missing', detail:'Set AUTONOMOS_OWNER_WALLET to a public 0x EVM address.' });
    if (!x402.status().configured) missing.push({ item:'Live machine-payment rail', status:'missing_credentials_or_facilitator', detail:'Enable x402 and configure a facilitator for the selected network. Testnet works with the public test facilitator; mainnet should use a trusted facilitator.' });
    if (!llm.enabled) missing.push({ item:'Optional reasoning model', status:'optional', detail:'No LLM API is configured. Deterministic agents and machine products still run; generative work remains unavailable.' });
    for (const connector of statuses.filter(x=>x.status==='needs_credentials')) missing.push({ item:connector.name, status:'optional_market_connector', detail:`Needs: ${connector.missing.join(', ')}` });
    return missing;
  }

  function safeConfig(value) {
    const { allowExternalSpending, maxPaidProcurementUsd, ...rest } = value;
    return { ...rest, allowExternalSpending:Boolean(allowExternalSpending), maxPaidProcurementUsd:Number(maxPaidProcurementUsd||0), ownerWallet:wallet, privateKeysStored:false };
  }

  function schedule() {
    clearTimer();
    if (!config.enabled || config.killSwitch) return;
    timer = setInterval(()=>cycle('heartbeat').catch(()=>{}), config.heartbeatSeconds * 1000);
    timer.unref?.();
    setTimeout(()=>cycle('startup').catch(()=>{}), 1200).unref?.();
  }
  function reschedule() { if (config.enabled && !config.killSwitch) schedule(); }
  function clearTimer() { if (timer) clearInterval(timer); timer = null; }
  function persistAgents() { store.writeJson('agents.json', agents); }
  function persistCore() { store.writeJson('config.json', config); store.writeJson('state.json', state); persistAgents(); store.writeJson('children.json', children); store.writeJson('offers.json', offers); }
  function event(type, detail) { store.append('events.ndjson', { at:new Date().toISOString(), type, ...detail }); }
}

function defaultOffers() {
  return Object.fromEntries(MACHINE_PRODUCTS.map(product=>[product.id,{ priceUsd:product.priceUsd, updatedAt:'', basis:'initial' }]));
}

function defaultState() {
  return {
    createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), startedAt:'',
    cycles:0, lastCycleAt:'', lastCycleMs:0, lastCycleId:'', lastCycleTrigger:'', lastError:'',
    treasury:{ ok:false, usdc:0, eth:0, checkedAt:'' }, connectorHealth:{}, marketSummary:{}, competition:{}, productEconomics:[], catalogReady:false
  };
}
function median(values) { if (!values.length) return 0; const sorted=[...values].sort((a,b)=>a-b); const m=Math.floor(sorted.length/2); return round(sorted.length%2?sorted[m]:(sorted[m-1]+sorted[m])/2); }
function round(v) { return Math.round((Number(v||0)+Number.EPSILON)*1e6)/1e6; }
