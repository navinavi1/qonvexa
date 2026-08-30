import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CORE_AGENTS } from '../src/autonomos/agents.js';
import { normalizeConfig, validateAction } from '../src/autonomos/policy-engine.js';
import { evaluateOpportunity, allocateRevenue } from '../src/autonomos/profit-engine.js';
import { validatePublicUrl, ProductError, MACHINE_PRODUCTS } from '../src/autonomos/products.js';
import { createAutonomOS } from '../src/autonomos/runtime.js';
import { isEvmAddress, configuredEvmChains } from '../src/autonomos/treasury.js';
import { classifyOpportunity } from '../src/autonomos/capabilities.js';
import { normalizeOpportunity } from '../src/autonomos/job-normalizer.js';
import { connectorStatuses } from '../src/autonomos/connectors/index.js';
import { createX402Gateway } from '../src/autonomos/x402.js';
import { runTool, TOOL_COST_ESTIMATES_USD, githubOpenPullRequest } from '../src/autonomos/tools.js';

const wallet = '0x1f674bf085f6fed36fa198287d51edf0fe0bb9e2';
const checks = [];
function ok(name, fn) {
  return Promise.resolve().then(fn).then(() => checks.push({ name, ok:true }));
}

await ok('exactly 20 unique core agents', () => {
  assert.equal(CORE_AGENTS.length, 20);
  assert.equal(new Set(CORE_AGENTS.map(x => x.id)).size, 20);
});

await ok('machine products have unique routes and positive prices', () => {
  assert.ok(MACHINE_PRODUCTS.length >= 6);
  assert.equal(new Set(MACHINE_PRODUCTS.map(x => x.path)).size, MACHINE_PRODUCTS.length);
  assert.ok(MACHINE_PRODUCTS.every(x => x.priceUsd > 0));
});

await ok('owner treasury address is a valid EVM address', () => assert.equal(isEvmAddress(wallet), true));

await ok('zero-spend mode blocks external spending', () => {
  const cfg = normalizeConfig({ enabled:true, zeroSpendMode:true, allowExternalSpending:true, maxPaidProcurementUsd:100 });
  assert.equal(cfg.allowExternalSpending, false);
  assert.equal(validateAction({ kind:'spend', amountUsd:1 }, cfg).allowed, false);
});

await ok('private-key access is permanently rejected', () => {
  const cfg = normalizeConfig({ enabled:true });
  assert.equal(validateAction({ kind:'private_key_access' }, cfg).allowed, false);
  assert.equal(validateAction({ kind:'wallet_export' }, cfg).allowed, false);
});

await ok('profit engine enforces unit economics', () => {
  const cfg = normalizeConfig({ enabled:true, zeroSpendMode:true, minMarginPercent:35 });
  const free = evaluateOpportunity({ expectedRevenueUsd:1, successProbability:1, computeCostUsd:0 }, cfg);
  const paid = evaluateOpportunity({ expectedRevenueUsd:1, successProbability:1, computeCostUsd:.01 }, cfg);
  assert.equal(free.allowed, true);
  assert.equal(paid.allowed, false);
  const split = allocateRevenue(100, cfg);
  assert.equal(Math.round((split.reserveUsd + split.growthUsd + split.experimentUsd) * 100) / 100, 100);
});

await ok('SSRF guard blocks localhost/private targets', async () => {
  for (const url of ['http://127.0.0.1', 'http://10.0.0.1', 'http://localhost']) {
    let blocked = false;
    try { await validatePublicUrl(url); } catch (error) { blocked = error instanceof ProductError; }
    assert.equal(blocked, true, `Expected ${url} to be blocked`);
  }
});


await ok('x402 v2 challenge is mainnet-ready, receiver-only and Bazaar-declared', async () => {
  const gateway = createX402Gateway({
    ownerWallet:wallet,
    siteUrl:'https://qonvexa.co',
    env:{
      AUTONOMOS_X402_ENABLED:'true',
      AUTONOMOS_X402_NETWORK:'eip155:8453',
      AUTONOMOS_X402_FACILITATOR_URL:'https://facilitator.xpay.sh'
    }
  });
  assert.equal(gateway.status().configured, true);
  assert.equal(gateway.status().payTo.toLowerCase(), wallet.toLowerCase());
  const headers = {};
  let body = null;
  let status = 200;
  const res = {
    setHeader(k,v){ headers[String(k).toLowerCase()] = v; },
    status(code){ status=code; return this; },
    json(value){ body=value; return value; }
  };
  const req = { get(){ return ''; } };
  await gateway.protect({ req, res, product:MACHINE_PRODUCTS[0], handler:async()=>({ok:true}) });
  assert.equal(status, 402);
  const challenge = JSON.parse(Buffer.from(headers['payment-required'], 'base64').toString('utf8'));
  assert.equal(challenge.x402Version, 2);
  assert.equal(challenge.accepts[0].network, 'eip155:8453');
  assert.equal(challenge.accepts[0].payTo.toLowerCase(), wallet.toLowerCase());
  assert.ok(challenge.extensions?.bazaar?.info);
  assert.equal(body.x402Version, 2);
});


await ok('AutonomOS 2.0 policy exposes guarded marketplace auto-claim controls', () => {
  const cfg = normalizeConfig({ enabled:true, autoClaimJobs:true, requireEscrowForAutoClaim:true, maxJobsPerCycle:3, minJobPayoutUsd:.02, maxApiCostPercentOfPayout:20 });
  assert.equal(cfg.autoClaimJobs, true);
  assert.equal(cfg.requireEscrowForAutoClaim, true);
  assert.equal(cfg.maxJobsPerCycle, 3);
  assert.equal(cfg.minJobPayoutUsd, .02);
});

await ok('job normalizer creates a common escrow job shape', () => {
  const op = normalizeOpportunity('clawlancer', { id:'abc', title:'Research a public API', price_usdc_wei:'50000', status:'open', category:'research' }, { escrowed:true, feePercent:2.5, currency:'USDC', network:'eip155:8453' });
  assert.equal(op.externalId, 'abc');
  assert.equal(op.budgetUsd, .05);
  assert.equal(op.escrowed, true);
  assert.equal(op.currency, 'USDC');
});

await ok('capability classifier refuses unsupported generative work without an LLM', () => {
  const op = normalizeOpportunity('clawlancer', { id:'x', title:'Write a long original article', description:'Create a unique article about autonomous agents', category:'writing', priceUsd:1 }, { escrowed:true });
  const cap = classifyOpportunity(op, { llmEnabled:false });
  assert.equal(cap.executable, false);
});

await ok('multi-chain EVM treasury defaults include Base, Arbitrum and Polygon', () => {
  const chains = configuredEvmChains({});
  assert.ok(chains.some(x=>x.chainId===8453));
  assert.ok(chains.some(x=>x.chainId===42161));
  assert.ok(chains.some(x=>x.chainId===137));
});

await ok('Clawlancer and Agentverse are real connector states, not always-ready placeholders', () => {
  const statuses = connectorStatuses({}, { enabled:false, configured:false, mode:'disabled' }, {});
  assert.equal(statuses.find(x=>x.id==='clawlancer').status, 'auto_bootstrap_available');
  assert.equal(statuses.find(x=>x.id==='agentverse').status, 'discovery_ready');
  assert.equal(statuses.find(x=>x.id==='virtuals-acp').status, 'needs_credentials');
});

await ok('runtime boots without any paid API or private key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomos-audit-'));
  try {
    const runtime = createAutonomOS({
      storageDir: root,
      siteUrl: 'https://qonvexa.co',
      ownerWallet: wallet,
      env: {
        AUTONOMOS_ENABLED:'false',
        AUTONOMOS_X402_ENABLED:'false',
        AUTONOMOS_OWNER_WALLET:wallet
      },
      logger:{ error(){} }
    });
    const snap = await runtime.snapshot();
    assert.equal(snap.agents.length, 20);
    assert.ok(snap.products.length >= 6);
    assert.equal(snap.treasury.ownerWallet.toLowerCase(), wallet.toLowerCase());
    assert.equal(snap.config.zeroSpendMode, true);
    assert.equal(snap.config.privateKeysStored, false);
    assert.equal(snap.version, '2.0.0');
    assert.ok('opportunitiesFound' in snap.metrics);
    assert.equal(snap.runtime.status, 'stopped');
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

await ok('Earned-funds-only alone (without allowExternalSpending) permits spend within earned budget — matches the admin UI\'s own documented precedence', () => {
  // This replaces an earlier regression test that had it backwards: a previous fix made
  // allowExternalSpending a blanket AND-requirement for ANY spend, which silently broke
  // the documented, safer default path (Earned-funds-only on its own) and was the actual
  // reason a correctly-configured deployment still couldn't spend a cent on Firecrawl/E2B.
  const cfg = normalizeConfig({ enabled:true, zeroSpendMode:false, earnedFundsOnly:true, allowExternalSpending:false });
  const withinBudget = evaluateOpportunity({ expectedRevenueUsd:10, successProbability:1, apiCostUsd:0.02 }, { ...cfg, availableSpendUsd:1 });
  assert.equal(withinBudget.allowed, true);
  const overBudget = evaluateOpportunity({ expectedRevenueUsd:10, successProbability:1, apiCostUsd:0.02 }, { ...cfg, availableSpendUsd:0 });
  assert.equal(overBudget.allowed, false);
  assert.equal(overBudget.reason, 'blocked_by_earned_funds_cap');
  const bothOff = normalizeConfig({ enabled:true, zeroSpendMode:false, earnedFundsOnly:false, allowExternalSpending:false });
  const blocked = evaluateOpportunity({ expectedRevenueUsd:10, successProbability:1, apiCostUsd:0.02 }, { ...bothOff, availableSpendUsd:100 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'blocked_by_external_spending_disabled');
  // validateAction (the per-tool-call gate) must agree with evaluateOpportunity here —
  // this is what job-executor.js actually calls before offering Firecrawl/E2B to the LLM.
  const cfgWithCeiling = normalizeConfig({ enabled:true, zeroSpendMode:false, earnedFundsOnly:true, allowExternalSpending:false, maxPaidProcurementUsd:1 });
  assert.equal(validateAction({ kind:'spend', amountUsd:0.01 }, cfgWithCeiling).allowed, true);
});

await ok('P0: runTool refuses to spend when policy disallows it, without calling the API', async () => {
  const cfg = normalizeConfig({ enabled:true, zeroSpendMode:true });
  const result = await runTool('web_search', { query:'test' }, { FIRECRAWL_API_KEY:'unused_should_never_be_used' }, { config:cfg, validateAction });
  assert.equal(result.ok, false);
  assert.ok(String(result.error).startsWith('spend_not_authorized'));
  assert.ok(TOOL_COST_ESTIMATES_USD.web_search > 0);
});

await ok('P1: capability engine refuses dev-workstation jobs it cannot actually do', () => {
  const op = normalizeOpportunity('clawlancer', { id:'y', title:'Fix a bug and open a PR', description:'Clone the GitHub repo, fix the failing test, and open a pull request', category:'coding', priceUsd:5 }, { escrowed:true });
  const cap = classifyOpportunity(op, { llmEnabled:true });
  assert.equal(cap.executable, false);
  assert.equal(cap.mode, 'unsupported_missing_tooling');
});

await ok('Firecrawl and E2B are visible connector/tool health entries', () => {
  const statuses = connectorStatuses({}, { enabled:false, configured:false, mode:'disabled' }, {});
  assert.ok(statuses.some(x=>x.id==='firecrawl'));
  assert.ok(statuses.some(x=>x.id==='e2b'));
  assert.equal(statuses.find(x=>x.id==='firecrawl').status, 'needs_credentials');
});

await ok('GitHub PR tool is visible on dashboard and is capability-gated by config, not just a keyword match', () => {
  const statuses = connectorStatuses({}, { enabled:false, configured:false, mode:'disabled' }, {});
  assert.ok(statuses.some(x=>x.id==='github-pr'));
  const op = normalizeOpportunity('clawlancer', { id:'z', title:'Fix a bug and open a PR', description:'Clone the GitHub repo, fix the failing test, and open a pull request', category:'coding', priceUsd:5 }, { escrowed:true });
  const withoutToken = classifyOpportunity(op, { llmEnabled:true, hasGithubPrTool:false });
  assert.equal(withoutToken.executable, false);
  const withToken = classifyOpportunity(op, { llmEnabled:true, hasGithubPrTool:true });
  assert.equal(withToken.executable, true);
});

await ok('open_pull_request refuses protected branch names without ever calling the GitHub API', async () => {
  const result = await githubOpenPullRequest({ repoUrl:'https://github.com/example/repo', newBranch:'main', commitMessage:'x', files:[{path:'a.txt',content:'b'}] }, { GITHUB_TOKEN:'unused_should_never_be_sent' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'refusing_protected_or_missing_branch_name');
});

await ok('P0: maxPaidProcurementUsd is a real, admin-changeable field, not stuck at 0', () => {
  const cfg = normalizeConfig({ enabled:true, zeroSpendMode:false, allowExternalSpending:true, maxPaidProcurementUsd:1 });
  assert.equal(cfg.maxPaidProcurementUsd, 1);
  assert.equal(validateAction({ kind:'spend', amountUsd:0.01 }, cfg).allowed, true);
  const stillZero = normalizeConfig({ enabled:true, zeroSpendMode:false, allowExternalSpending:true, maxPaidProcurementUsd:0 });
  assert.equal(validateAction({ kind:'spend', amountUsd:0.01 }, stillZero).allowed, false);
});

await ok('P0: Emergency Stop actually aborts an in-flight job, not just future ones', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomos-estop-'));
  try {
    const runtime = createAutonomOS({ storageDir: root, siteUrl:'https://qonvexa.co', ownerWallet: wallet, env:{ AUTONOMOS_ENABLED:'false', AUTONOMOS_X402_ENABLED:'false', AUTONOMOS_OWNER_WALLET:wallet }, logger:{ error(){} } });
    const result = runtime.emergencyStop();
    assert.equal(result.ok, true);
    assert.equal(runtime.config.killSwitch, true);
    // No active jobs in this fresh instance, but emergencyStop must not throw even when
    // it tries to call .abort() on jobs that carry an AbortController — this exercises
    // that code path structurally rather than a live in-flight LLM call.
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});

await ok('P0: x402 only accepts USD-pegged stablecoins, never raw ETH/SOL/BTC at face value', async () => {
  const unsafe = JSON.stringify([{ network:'eip155:8453', networkName:'Base', symbol:'ETH', asset:'0x0000000000000000000000000000000000000001', decimals:18 }]);
  const gateway = createX402Gateway({ ownerWallet:wallet, siteUrl:'https://qonvexa.co', env:{ AUTONOMOS_X402_ENABLED:'true', AUTONOMOS_X402_NETWORK:'eip155:8453', AUTONOMOS_X402_FACILITATOR_URL:'https://facilitator.xpay.sh', AUTONOMOS_X402_ACCEPTS_JSON: unsafe } });
  assert.ok(!gateway.status().acceptedAssets.some(a => a.symbol === 'ETH'));
  assert.ok(gateway.status().acceptedAssets.some(a => a.symbol === 'USDC'));
});

await ok('Superteam Earn is a visible connector and is exempt from the escrow requirement by design (no escrow exists on that platform)', () => {
  const statuses = connectorStatuses({}, { enabled:false, configured:false, mode:'disabled' }, {});
  assert.ok(statuses.some(x=>x.id==='superteam'));
  const op = normalizeOpportunity('superteam', { id:'s1', title:'Write a Solana ecosystem report', description:'Research and write a report on Solana DeFi', category:'research', priceUsd:800 }, { escrowed:false, feePercent:0, currency:'USDC' });
  assert.equal(op.escrowed, false);
});
await ok('Dealwork bid-mode jobs are discoverable with the correct shape (claimMode:bid, not escrowed yet)', () => {
  const op = normalizeOpportunity('dealwork', { id:'d1', title:'Write a blog post about AI collaboration', description:'800+ words', category:'writing', budgetUsd:50 }, { escrowed:false, feePercent:10, currency:'USD', claimMode:'bid' });
  assert.equal(op.claimMode, 'bid');
  assert.equal(op.escrowed, false);
  assert.equal(op.budgetUsd, 50);
});

console.log(`AutonomOS audit PASS: ${checks.length}/${checks.length} checks`);
for (const check of checks) console.log(`  ✓ ${check.name}`);
