// Each job is handed a spend limit computed from the earned treasury when it starts. Several
// jobs start at once and each one reads the same balance, so the limits they are given add up
// to far more than exists -- six concurrent jobs against a $9 treasury are each told they may
// spend $3. If the limit were the only gate, the fleet would spend $18 of $9.
//
// It is not the only gate: every actual charge re-reads the shared treasury under a lock and
// refuses once it is gone. That is the property the owner's "agents spend only what they have
// earned" rests on, and it is worth holding still.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomOSStore } from '../src/autonomos/store.js';
import { ledgerEntry, appendUniqueLedgerEntry } from '../src/autonomos/financial-ledger.js';
import { createJobBudget } from '../src/autonomos/job-budget.js';
import { computeEarnedSpendBudgetUsd } from '../src/autonomos/profit-engine.js';
import { normalizeConfig, DEFAULT_AUTONOMOS_CONFIG } from '../src/autonomos/policy-engine.js';

let checks = 0;
const ok = (condition, label) => { assert.ok(condition, label); checks++; };
const eq = (actual, expected, label) => { assert.equal(actual, expected, `${label} (got ${JSON.stringify(actual)})`); checks++; };

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-treasury-'));
const root = path.join(storage, 'autonomos');
fs.mkdirSync(root, { recursive: true });
const store = new AutonomOSStore(root);
const env = { STORAGE_DIR: storage };

// One settled receipt. Half of the net belongs to the agents, plus the seed allowance.
appendUniqueLedgerEntry(store, ledgerEntry({
  id: 'r1', type: 'revenue', source: 'taskmarket.dev', amountUsd: 20, feeUsd: 0,
  currency: 'USDC', status: 'settled', externalTransactionId: '0x' + 'd'.repeat(64), network: 'eip155:8453'
}));
const config = normalizeConfig({ ...DEFAULT_AUTONOMOS_CONFIG, enabled: true, seedSpendBudgetUsd: 0 });
store.writeJson('config.json', config);

const treasury = () => computeEarnedSpendBudgetUsd(store.readNdjson('ledger.ndjson', -1), config);
const startingTreasury = treasury();
eq(startingTreasury, 10, 'the agents may spend half of the twenty that settled');

// Six jobs, each started at the same moment and each handed the whole treasury as its limit --
// which is exactly what happens when six cycles read the balance before any of them spends.
const budgets = Array.from({ length: 6 }, (_, i) => createJobBudget(startingTreasury, {
  env, jobId: `job-${i}`,
  onCost: (amount) => appendUniqueLedgerEntry(store, ledgerEntry({
    id: `cost-${i}-${Math.random().toString(36).slice(2)}`, type: 'cost',
    jobId: `job-${i}`, source: 'openai', amountUsd: amount, currency: 'USD'
  }))
}));
eq(budgets.length, 6, 'six jobs are in flight');
ok(budgets.reduce((n, b) => n + b.remaining, 0) > startingTreasury * 5,
  'and the limits they were handed add up to far more than exists');

// Each tries to spend $2. Four fit inside the ten; the rest must be refused.
let charged = 0, refused = 0;
for (const budget of budgets) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { budget.charge(2); charged += 2; }
    catch (error) {
      refused++;
      ok(/shared_treasury_spend_limit|job_spend_limit/.test(String(error.message)),
        `a refusal names the limit it hit: ${error.message}`);
    }
  }
}
ok(refused > 0, 'some charges were refused rather than all going through');
ok(charged <= startingTreasury + 1e-9,
  `the fleet spent no more than it had earned: ${charged} of ${startingTreasury}`);

const spent = store.readNdjson('ledger.ndjson', -1)
  .filter(r => r.type === 'cost').reduce((n, r) => n + Number(r.amountUsd || 0), 0);
eq(spent, charged, 'and every charge that went through is in the ledger');
ok(treasury() >= -1e-9, `the treasury never goes negative: ${treasury()}`);

// The kill switch reaches work already in flight, not just work not yet started.
store.writeJson('config.json', normalizeConfig({ ...config, killSwitch: true }));
const stopped = createJobBudget(100, { env, jobId: 'job-stopped', onCost: () => {} });
assert.throws(() => stopped.charge(0.01), /job_cancelled_by_emergency_stop/,
  'an emergency stop refuses the next charge of a running job');
checks++;

fs.rmSync(storage, { recursive: true, force: true });
console.log(`shared-treasury-test OK (${checks} checks, six concurrent jobs against one treasury)`);
