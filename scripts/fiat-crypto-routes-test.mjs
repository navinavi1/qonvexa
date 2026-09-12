import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FiatCryptoRoutePlanner } from '../src/autonomos/fiat-crypto-route-planner.js';

// This document is the owner's list of earnings that need a decision before they can become
// crypto. Two `continue`s dropped leads from it without a trace: one for a payout currency
// the planner did not recognise, one for anything outside a six-entry FIAT list. Between
// them they discarded the common case — global-work-hunter writes payoutCurrency 'UNKNOWN'
// whenever the posting does not state one — so money the owner needed to act on was simply
// absent from the only place that would have told them.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fiat-routes-'));
fs.mkdirSync(path.join(root, 'autonomos'), { recursive: true });

// Leads shaped exactly as global-work-hunter.js writes them.
const leads = {
  a: { id: 'a', title: 'USDC bounty',      payoutCurrency: 'USDC',    amountUsd: 200 },
  b: { id: 'b', title: 'Paid in euro',     payoutCurrency: 'EUR',     amountUsd: 300 },
  c: { id: 'c', title: 'Currency unstated', payoutCurrency: 'UNKNOWN', amountUsd: 500 },
  d: { id: 'd', title: 'Also unstated',    payoutCurrency: '',        amountUsd: 900 },
  e: { id: 'e', title: 'Japanese yen',     payoutCurrency: 'JPY',     amountUsd: 400 }
};
fs.writeFileSync(path.join(root, 'autonomos', 'global-work-hunter.json'), JSON.stringify({ leads }));

const planner = new FiatCryptoRoutePlanner({ env: { STORAGE_DIR: root }, storageDir: root,
  logger: { info() {}, warn() {}, error() {} } });
planner.refresh();
planner.stop?.();

const out = JSON.parse(fs.readFileSync(path.join(root, 'autonomos', 'fiat-crypto-routes.json'), 'utf8'));

// 1) Nothing is dropped. This is the whole point.
assert.equal(out.routes.length, 5, 'every lead must appear');
const byId = Object.fromEntries(out.routes.map(r => [r.leadId, r]));
for (const id of Object.keys(leads)) assert.ok(byId[id], `lead ${id} vanished`);

// 2) Each case is classified as what it actually is, not lumped together.
assert.equal(byId.a.mode, 'direct_crypto_preferred');
assert.equal(byId.a.requiresOwnerAction, false, 'crypto already lands in the wallet');
assert.equal(byId.b.mode, 'fiat_conversion_research_required');
assert.equal(byId.c.mode, 'payout_currency_undetermined');
assert.equal(byId.d.mode, 'payout_currency_undetermined');
assert.equal(byId.d.currency, 'UNKNOWN', 'an empty currency is reported as unknown, not blank');
assert.equal(byId.e.mode, 'unsupported_currency_needs_owner_rail', 'JPY is fiat too');

// 3) The owner can see the scale without reading the rows, and the largest first.
assert.equal(out.summary.leads, 5);
assert.equal(out.summary.needingOwnerAction, 4);
assert.equal(out.summary.valueNeedingOwnerActionUsd, 2100, '300 + 500 + 900 + 400');
assert.deepEqual(out.routes.map(r => r.amountUsd), [900, 500, 400, 300, 200], 'sorted by value');

// 4) The safety policy is unchanged: this plans, it never moves money.
assert.equal(out.policy.autoBankTransfer, false);
assert.equal(out.policy.autoExchangeTrade, false);
assert.equal(out.policy.privateKeysStored, false);
assert.equal(out.policy.ownerApprovalRequiredForFinancialTransfer, true);
for (const row of out.routes) assert.equal(row.autoTransferAllowed, false);

fs.rmSync(root, { recursive: true, force: true });
console.log('FIAT CRYPTO ROUTES: PASS');
