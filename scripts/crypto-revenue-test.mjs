import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isCryptoRevenue } from '../src/autonomos/financial-ledger.js';
import { businessSnapshot } from '../src/autonomos/business-snapshot.js';

// The dashboard tile "Надійшло у крипто" is the owner's answer to "did the money reach my
// wallets". It asked `rail === 'crypto' || /^eip155:/.test(network)`, which only ever
// matched inbound-receipt.js and x402. Every other crypto rail read as zero — most
// importantly the TaskForce worker, which settles USDC on Solana into the Phantom wallet
// and writes rail 'taskforce_solana_wallet' with network 'solana'.

// 1) Rows exactly as each writer in this repository actually spells them.
const crypto = [
  { rail: 'taskforce_solana_wallet', network: 'solana', currency: 'USDC' }, // taskforce-worker.js
  { rail: 'crypto', network: 'base', currency: 'USDC' },                    // inbound-receipt.js
  { rail: '', network: 'eip155:8453', currency: 'USDC' },                   // x402.js
  { rail: '', network: 'base', currency: 'USDC' },                          // runtime settlement
  { rail: '', network: '', currency: 'SOL' },                               // currency alone is proof
  { rail: '', network: 'bitcoin', currency: 'BTC' }
];
for (const row of crypto) assert.equal(isCryptoRevenue(row), true, JSON.stringify(row));

// 2) Fiat rails must stay out, or the tile stops meaning anything.
const fiat = [
  { rail: 'agrenting_escrow', network: '', currency: 'USD' },  // agrenting-worker.js
  { rail: 'card', network: '', currency: 'USD' },              // the Stripe bridge
  { rail: '', network: '', currency: 'USD' },                  // native-market-worker.js
  { rail: '', network: '', currency: 'EUR' },
  {}
];
for (const row of fiat) assert.equal(isCryptoRevenue(row), false, JSON.stringify(row));

// 3) End to end through the snapshot the dashboard actually renders.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-revenue-'));
fs.mkdirSync(path.join(root, 'autonomos'), { recursive: true });
const rows = [
  { id: 'tf1', type: 'revenue', source: 'taskforce', amountUsd: 300, currency: 'USDC', rail: 'taskforce_solana_wallet', network: 'solana', status: 'settled', externalTransactionId: 'a1' },
  { id: 'ag1', type: 'revenue', source: 'agrenting', amountUsd: 150, currency: 'USD', rail: 'agrenting_escrow', status: 'settled', externalTransactionId: 'b2' },
  { id: 'in1', type: 'revenue', source: 'direct-client', amountUsd: 50, currency: 'USDC', rail: 'crypto', network: 'base', status: 'confirmed', externalTransactionId: '0x' + 'c'.repeat(64) }
];
fs.writeFileSync(path.join(root, 'autonomos', 'ledger.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

const money = businessSnapshot(root).money;
assert.equal(money.grossRevenueUsd, 500, 'every settled receipt counts toward gross');
assert.equal(money.cryptoRevenueUsd, 350, 'the Solana settlement must be reported as crypto');

fs.rmSync(root, { recursive: true, force: true });
console.log('CRYPTO REVENUE: PASS');
