import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeEarnedSpendBudgetUsd, allocateRevenue } from '../src/autonomos/profit-engine.js';
import { normalizeConfig, DEFAULT_AUTONOMOS_CONFIG } from '../src/autonomos/policy-engine.js';
import { createAutonomOS } from '../src/autonomos/runtime.js';

// The cold-start deadlock this file exists to prevent regressing: the agents' spend pool
// starts at seedSpendBudgetUsd, every attempt (successful or not) appends a cost row, and
// executors refuse to start once the pool hits zero — but a job has to execute to earn the
// revenue that would refill it. Owner funding is the recorded way out.

const cfg = { ...DEFAULT_AUTONOMOS_CONFIG, seedSpendBudgetUsd: 3, ownerRevenuePercent: 50, agentTreasuryPercent: 50, survivalMode: true };

// 1) The deadlock is real: spend the seed and the pool is empty, with no revenue in sight.
const drained = computeEarnedSpendBudgetUsd([{ type: 'cost', amountUsd: 3 }], cfg);
assert.equal(drained, 0, 'a drained pool must read as zero');

// 2) Owner funding refills it, and counts in full rather than being split 50/50.
const funded = computeEarnedSpendBudgetUsd([{ type: 'cost', amountUsd: 3 }, { type: 'owner_funding', amountUsd: 25 }], cfg);
assert.equal(funded, 25, 'owner funding must reach the agent pool in full');

// 3) Revenue still only ever contributes the agent half. The owner's half is never spendable.
const earned = computeEarnedSpendBudgetUsd([{ type: 'revenue', amountUsd: 100, status: 'settled' }], { ...cfg, seedSpendBudgetUsd: 0 });
assert.equal(earned, 50, 'revenue must contribute the agent half only');
assert.equal(allocateRevenue(100, cfg).ownerUsd, 50, 'the owner half stays 50%');

// 4) Negative and non-numeric funding rows cannot inflate the pool.
const junk = computeEarnedSpendBudgetUsd([{ type: 'owner_funding', amountUsd: -500 }, { type: 'owner_funding', amountUsd: 'abc' }], { ...cfg, seedSpendBudgetUsd: 0 });
assert.equal(junk, 0, 'malformed funding rows must contribute nothing');

// 5) Testnet funding is excluded, exactly like testnet revenue.
const testnet = computeEarnedSpendBudgetUsd([{ type: 'owner_funding', amountUsd: 99, testnet: true }], { ...cfg, seedSpendBudgetUsd: 0 });
assert.equal(testnet, 0, 'testnet rows must never fund real spending');

// 6) A one-sided split override must complement the other side, not renormalize against a
// stale counterpart: owner 60 used to silently become 54.5/45.5.
process.env.AUTONOMOS_OWNER_REVENUE_PERCENT = '60';
delete process.env.npm_lifecycle_event;
const skewed = normalizeConfig({ ...DEFAULT_AUTONOMOS_CONFIG, ownerRevenuePercent: 50, agentTreasuryPercent: 50, updatedAt: new Date().toISOString() });
assert.equal(skewed.ownerRevenuePercent, 60);
assert.equal(skewed.agentTreasuryPercent, 40);
delete process.env.AUTONOMOS_OWNER_REVENUE_PERCENT;

// 7) With nothing configured the documented 50/50 split is what you get.
const plain = normalizeConfig({ ...DEFAULT_AUTONOMOS_CONFIG, updatedAt: new Date().toISOString() });
assert.equal(plain.ownerRevenuePercent, 50);
assert.equal(plain.agentTreasuryPercent, 50);

// 8) The seed float is owner-controlled from the dashboard and bounded. Reading it from env
// made the form field unsettable (render.yaml pinned it to 3, normalizeConfig re-applied
// that on every save), and a five-figure seed is an UNEARNED allowance that walks straight
// past earnedFundsOnly.
process.env.AUTONOMOS_SEED_SPEND_BUDGET_USD = '3';
const ownerSet = normalizeConfig({ ...DEFAULT_AUTONOMOS_CONFIG, seedSpendBudgetUsd: 25, updatedAt: new Date().toISOString() });
assert.equal(ownerSet.seedSpendBudgetUsd, 25, 'the dashboard value must win over the environment');
process.env.AUTONOMOS_SEED_SPEND_BUDGET_USD = '90000';
assert.equal(normalizeConfig({ ...DEFAULT_AUTONOMOS_CONFIG }).seedSpendBudgetUsd, 3, 'the seed stays bounded');
delete process.env.AUTONOMOS_SEED_SPEND_BUDGET_USD;

// 9) The runtimeEnv block raises the child/job/concurrency caps to 10000/1000/500, so it
// still requires a config the owner actually authorised. A missing or corrupt config.json is
// the moment env must not win.
process.env.AUTONOMOS_RUNTIME_ENV_OVERRIDES = 'true';
process.env.AUTONOMOS_MAX_CHILDREN = '9000';
assert.equal(normalizeConfig({ ...DEFAULT_AUTONOMOS_CONFIG }).maxChildren, 50, 'no persisted config: caps stay low');
assert.equal(normalizeConfig({ ...DEFAULT_AUTONOMOS_CONFIG, updatedAt: new Date().toISOString() }).maxChildren, 9000, 'owner-authorised config: caps apply');
delete process.env.AUTONOMOS_RUNTIME_ENV_OVERRIDES;
delete process.env.AUTONOMOS_MAX_CHILDREN;

// 10) But the spend knobs must still reach a fresh install — that was the original bug.
process.env.AUTONOMOS_MAX_PAID_PROCUREMENT_USD = '25';
assert.equal(normalizeConfig({ ...DEFAULT_AUTONOMOS_CONFIG }).maxPaidProcurementUsd, 25);
delete process.env.AUTONOMOS_MAX_PAID_PROCUREMENT_USD;

// 11) Funding is the one admin action that writes money into the ledger, and every row it
// writes raises what the agents may spend. A double-clicked button or a retried POST must
// not book the amount twice — the browser guard is a convenience, not the enforcement.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treasury-fund-'));
  const wallet = '0x1f674bf085f6fed36fa198287d51edf0fe0bb9e2';
  const runtime = createAutonomOS({ storageDir: root, siteUrl: 'https://qonvexa.co', ownerWallet: wallet,
    env: { AUTONOMOS_ENABLED: 'false', AUTONOMOS_X402_ENABLED: 'false', AUTONOMOS_OWNER_WALLET: wallet },
    logger: { error() {}, warn() {}, info() {} } });

  const first = runtime.fundAgentTreasury({ amountUsd: 40, requestId: 'click-1' });
  const replay = runtime.fundAgentTreasury({ amountUsd: 40, requestId: 'click-1' });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true, 'the same click must not be booked twice');
  assert.equal(replay.availableUsd, first.availableUsd, 'a replay must not raise the pool');

  // A genuinely separate top-up still goes through.
  const second = runtime.fundAgentTreasury({ amountUsd: 10, requestId: 'click-2' });
  assert.equal(second.duplicate, false);
  assert.ok(second.availableUsd > first.availableUsd, 'a second top-up must still count');

  const rows = fs.readFileSync(path.join(root, 'autonomos', 'ledger.ndjson'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse).filter(x => x.type === 'owner_funding');
  assert.equal(rows.length, 2, 'exactly two funding rows, not three');
  assert.equal(rows.reduce((sum, x) => sum + Number(x.amountUsd), 0), 50);

  runtime.stop?.();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('AGENT TREASURY: PASS');
