import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutonomOS } from '../src/autonomos/runtime.js';
import { computeEarnedSpendBudgetUsd } from '../src/autonomos/profit-engine.js';

// "Earned spend budget" is the tile that answers whether the agents may spend anything at
// all. admin.js renders it from snapshot().runtime.earnedSpendBudgetUsd through usd(), and
// usd() maps undefined to $0.00 — so an absent key does not look absent, it looks like an
// empty treasury.
//
// The value was only ever assigned inside cycle(). Before the first cycle of a process it
// was missing from the response: on every restart, and for the entire time the runtime is
// paused or emergency-stopped, the tile told the owner the agents had nothing to spend
// while the ledger said otherwise.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-visible-'));
fs.mkdirSync(path.join(root, 'autonomos'), { recursive: true });
const at = new Date().toISOString();
fs.writeFileSync(path.join(root, 'autonomos', 'ledger.ndjson'), [
  { id: 'r1', at, type: 'revenue', source: 'taskforce', amountUsd: 400, grossUsd: 400, currency: 'USDC', rail: 'taskforce_solana_wallet', network: 'solana', status: 'settled', externalTransactionId: 's1' },
  { id: 'c1', at, type: 'cost', source: 'llm', amountUsd: 25, status: 'recorded' }
].map(r => JSON.stringify(r)).join('\n') + '\n');

const wallet = '0x1f674bf085f6fed36fa198287d51edf0fe0bb9e2';
const runtime = createAutonomOS({ storageDir: root, siteUrl: 'https://qonvexa.co', ownerWallet: wallet,
  // Disabled on purpose: this is the state a restart or a paused runtime is actually in.
  env: { AUTONOMOS_ENABLED: 'false', AUTONOMOS_X402_ENABLED: 'false', AUTONOMOS_OWNER_WALLET: wallet },
  logger: { error() {}, warn() {}, info() {} } });

const snap = await runtime.snapshot();
const reported = snap.runtime.earnedSpendBudgetUsd;

// 1) Present without a cycle ever having run.
assert.equal(typeof reported, 'number', 'the tile must not read undefined');
assert.ok(reported > 0, `agents have earned funds, the tile must not say zero (got ${reported})`);

// 2) It agrees with the ledger rather than being an independent guess.
const rows = fs.readFileSync(path.join(root, 'autonomos', 'ledger.ndjson'), 'utf8')
  .split('\n').filter(Boolean).map(JSON.parse);
assert.equal(reported, computeEarnedSpendBudgetUsd(rows, snap.config),
  'the tile and the spend gate must read the same number');

// 3) And it moves when the ledger moves — a funded treasury shows up immediately.
runtime.fundAgentTreasury({ amountUsd: 50, requestId: 'top-up-1' });
const after = (await runtime.snapshot()).runtime.earnedSpendBudgetUsd;
assert.equal(after, reported + 50, 'funding must be visible on the next refresh');

runtime.stop?.();
fs.rmSync(root, { recursive: true, force: true });
console.log('SPEND BUDGET VISIBILITY: PASS');
