import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CORE_AGENTS } from '../src/autonomos/agents.js';
import { normalizeConfig, validateAction } from '../src/autonomos/policy-engine.js';
import { evaluateOpportunity, allocateRevenue } from '../src/autonomos/profit-engine.js';
import { validatePublicUrl, ProductError, MACHINE_PRODUCTS } from '../src/autonomos/products.js';
import { createAutonomOS } from '../src/autonomos/runtime.js';
import { isEvmAddress } from '../src/autonomos/treasury.js';
import { createX402Gateway } from '../src/autonomos/x402.js';

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
    assert.equal(snap.runtime.status, 'stopped');
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

console.log(`AutonomOS audit PASS: ${checks.length}/${checks.length} checks`);
for (const check of checks) console.log(`  ✓ ${check.name}`);
