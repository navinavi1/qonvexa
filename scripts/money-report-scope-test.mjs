import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DailyMoneyReporter } from '../src/autonomos/daily-money-reporter.js';

// The money report mixes two scopes on purpose: `money` is overridden with businessSnapshot's
// lifetime totals (revenue stays ledger-authoritative), while bySource is built from today's
// rows alone. Nothing said so. A report stamped with today's date showing lifetime gross and
// an empty bySource reads as money from nowhere, and the owner had no way to see what today
// actually earned — the daily figures were computed and then thrown away.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'money-scope-'));
fs.mkdirSync(path.join(root, 'autonomos'), { recursive: true });
const today = new Date().toISOString();
const old = new Date(Date.now() - 5 * 86400000).toISOString();

fs.writeFileSync(path.join(root, 'autonomos', 'ledger.ndjson'), [
  { id: 'old1', at: old,   type: 'revenue', source: 'taskforce', amountUsd: 200, grossUsd: 200, currency: 'USDC', rail: 'taskforce_solana_wallet', network: 'solana', status: 'settled', externalTransactionId: 'x1' },
  { id: 'new1', at: today, type: 'revenue', source: 'taskforce', amountUsd: 100, grossUsd: 100, currency: 'USDC', rail: 'taskforce_solana_wallet', network: 'solana', status: 'settled', externalTransactionId: 'x2' },
  { id: 'new2', at: today, type: 'cost',    source: 'llm',       amountUsd: 10, status: 'recorded' }
].map(r => JSON.stringify(r)).join('\n') + '\n');

const reporter = new DailyMoneyReporter({
  env: { STORAGE_DIR: root, AUTONOMOS_PUBLIC_DIR: root },
  storageDir: root, logger: { error() {}, warn() {}, info() {} }
});
reporter.refresh();
reporter.stop?.();

const report = JSON.parse(fs.readFileSync(path.join(root, 'autonomos', 'money-report.json'), 'utf8'));

// 1) Every scope in the document is named, so no figure is ambiguous.
assert.equal(report.scope.money, 'lifetime');
assert.equal(report.scope.today, 'this_calendar_day_utc');
assert.equal(report.scope.bySource, 'this_calendar_day_utc');

// 2) The headline stays lifetime — both receipts.
assert.equal(report.money.grossRevenueUsd, 300, 'money is every settled receipt');

// 3) Today is reported separately and really is today only.
assert.equal(report.today.grossRevenueUsd, 100, 'today excludes the 5-day-old receipt');
assert.equal(report.today.toolAndInfraCostUsd, 10);
assert.equal(report.today.netProfitUsd, 90);
assert.equal(report.today.ownerShareUsd + report.today.agentTreasuryShareUsd, report.today.netProfitUsd,
  'the daily split must account for the whole daily net');

// 4) bySource shares the daily scope it is actually built from.
assert.equal(report.bySource.taskforce.revenueUsd, 100);
assert.equal(report.bySource.llm.costUsd, 10);

fs.rmSync(root, { recursive: true, force: true });
console.log('MONEY REPORT SCOPE: PASS');
