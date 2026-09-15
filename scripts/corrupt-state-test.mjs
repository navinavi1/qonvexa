// The disk fills, or the process is killed mid-write, and a state file is left half-written.
// Every one of these files is read on the next boot, and a single unguarded JSON.parse among
// them takes down the whole fleet -- the cycle, the workers, the dashboard, all of it -- with
// an error nobody connects to "the disk was full for one second last night".
//
// This is the shape those files actually take when a write is interrupted: truncated mid-key,
// empty, a good line followed by a torn one, binary noise, or valid JSON of the wrong type.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutonomOS } from '../src/autonomos/runtime.js';
import { AutonomOSStore } from '../src/autonomos/store.js';

let checks = 0;
const ok = (condition, label) => { assert.ok(condition, label); checks++; };
const eq = (actual, expected, label) => { assert.equal(actual, expected, `${label} (got ${JSON.stringify(actual)})`); checks++; };

const CORRUPTIONS = {
  'config.json': '{"enabled":true,',
  'state.json': '',
  'jobs.ndjson': '{"id":"a"}\n{"id":"b"  \n{"id":"c"}\n',
  'ledger.ndjson': '{"id":"r1","type":"revenue","amountUsd":10,"netUsd":10}\n\x00\x00garbage\n',
  'global-work-hunter.json': 'not json at all',
  'job-registry.json': '[]',
  'agents.json': 'null',
  'children.json': '{"a":1}',
  'learning.json': '{"sampleSize":"lots"}',
  'dynamic-market-registry.json': '{"x":{"evidence":',
  'external-actions.json': '{"a":{"status":',
  'opportunities.ndjson': '\n\n{"broken"\n',
  'money-report.json': '{{{',
  'taskmarket-jobs.json': '[1,2,3]'
};

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'corrupt-state-'));
const root = path.join(storage, 'autonomos');
fs.mkdirSync(root, { recursive: true });
for (const [name, body] of Object.entries(CORRUPTIONS)) fs.writeFileSync(path.join(root, name), body);

// 1. The store itself: every reader returns its fallback instead of throwing.
const store = new AutonomOSStore(root);
for (const name of ['config.json', 'global-work-hunter.json', 'dynamic-market-registry.json', 'money-report.json']) {
  const fallback = { untouched: true };
  const value = store.readJson(name, fallback);
  ok(value && typeof value === 'object', `${name} reads back as an object rather than throwing`);
}
for (const name of ['jobs.ndjson', 'ledger.ndjson', 'opportunities.ndjson']) {
  const rows = store.readNdjson(name, -1);
  ok(Array.isArray(rows), `${name} reads back as a list`);
}
// A torn line is skipped; the intact ones around it are kept. Losing the whole journal because
// one line was cut in half would throw away every settled payment before it.
const ledger = store.readNdjson('ledger.ndjson', -1);
eq(ledger.length, 1, 'the intact ledger row survives beside the torn one');
eq(ledger[0].amountUsd, 10, 'and keeps its amount');
eq(store.readNdjson('jobs.ndjson', -1).length, 2, 'two of three job rows survive a torn middle line');

// 2. The runtime boots, runs a full cycle and answers a snapshot on top of all of it.
const runtime = createAutonomOS({
  storageDir: storage,
  siteUrl: 'http://127.0.0.1:1',
  ownerWallet: '0x' + '1'.repeat(40),
  env: { STORAGE_DIR: storage, AUTONOMOS_ENABLED: 'true', npm_lifecycle_event: '' },
  logger: { info() {}, warn() {}, error() {}, debug() {} }
});
const cycle = await runtime.runCycle();
ok(cycle && cycle.ok !== false, `a cycle completes on corrupted state: ${JSON.stringify(cycle).slice(0, 160)}`);
const snapshot = await runtime.snapshot();
ok(Object.keys(snapshot).length > 15, 'the dashboard still has something to render');
ok(snapshot.config, 'a usable config was rebuilt from the defaults');
eq(snapshot.config.ownerRevenuePercent + snapshot.config.agentTreasuryPercent, 100, 'and the split is still whole');

// 3. Nothing that survived was invented: a corrupted ledger must not become revenue.
ok(!(Number(snapshot.runtime?.earnedSpendBudgetUsd) > 100), 'no money is conjured out of a damaged journal');

fs.rmSync(storage, { recursive: true, force: true });
console.log(`corrupt-state-test OK (${checks} checks, ${Object.keys(CORRUPTIONS).length} damaged files, live cycle)`);
