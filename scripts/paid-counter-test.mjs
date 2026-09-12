import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { businessSnapshot } from '../src/autonomos/business-snapshot.js';

// counts.paid sits next to grossRevenueUsd on the dashboard. It read:
//
//   !expected.has(id) || Number(expected.get(id))>0 && total>=Number(expected.get(id))
//
// which quietly dropped a known job whose expected payout is 0 — the posting never stated a
// price, which is global-work-hunter's common case rather than an edge one. A fully paid job
// showed paid:0 while gross beside it showed the money: two figures on one dashboard
// contradicting each other. An unknown price is not evidence of underpayment. A known price
// that was not met still is, and that half must not regress.

function snapshotFor({ postedUsd, receivedUsd }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-counter-'));
  fs.mkdirSync(path.join(root, 'autonomos'), { recursive: true });
  fs.writeFileSync(path.join(root, 'autonomos', 'global-work-hunter.json'), JSON.stringify({
    leads: { L1: { id: 'L1', source: 'github', externalId: 'L1', title: 'Job', payoutUsd: postedUsd, amountUsd: postedUsd, currency: 'USDC' } }
  }));
  fs.writeFileSync(path.join(root, 'autonomos', 'global-lead-actioner.json'), JSON.stringify({
    actions: { L1: { route: 'github_issue_comment', commentId: 'c1', status: 'submitted', submittedAt: new Date().toISOString(), deliveryUrl: 'https://example.test/pull/1' } }
  }));
  fs.writeFileSync(path.join(root, 'autonomos', 'ledger.ndjson'), JSON.stringify({
    id: 'r1', at: new Date().toISOString(), type: 'revenue', source: 'github', jobId: 'github_L1',
    amountUsd: receivedUsd, currency: 'USDC', rail: 'crypto', network: 'base', status: 'settled',
    externalTransactionId: '0x' + 'a'.repeat(64)
  }) + '\n');
  const snapshot = businessSnapshot(root);
  fs.rmSync(root, { recursive: true, force: true });
  return snapshot;
}

// 1) Paid in full against a stated price: counted, as it always was.
{
  const s = snapshotFor({ postedUsd: 200, receivedUsd: 200 });
  assert.equal(s.counts.paid, 1);
  assert.equal(s.money.grossRevenueUsd, 200);
}

// 2) Short of a stated price: still not paid. This is the half worth keeping.
{
  const s = snapshotFor({ postedUsd: 200, receivedUsd: 40 });
  assert.equal(s.counts.paid, 0, 'a partial payment must not read as paid');
  assert.equal(s.money.grossRevenueUsd, 40);
}

// 3) No price was ever stated and the money arrived: paid, and no longer contradicting the
// gross figure printed beside it.
{
  const s = snapshotFor({ postedUsd: 0, receivedUsd: 200 });
  assert.equal(s.money.grossRevenueUsd, 200);
  assert.equal(s.counts.paid, 1, 'an unstated price is not evidence of underpayment');
}

console.log('PAID COUNTER: PASS');
