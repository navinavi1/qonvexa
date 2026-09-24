// One open dashboard used to make the public site 131x slower for paying visitors. Every GET
// /api/admin/autonomos re-derived the whole business picture -- reading eight state files and
// classifying every discovered lead -- on the same thread that serves the landing page, and
// the answer was byte-identical nearly every time. At five thousand leads that was 532ms of
// synchronous work per poll, of which 388ms was compiling the same 130 constant regexes over
// and over: 650,000 RegExp compilations per request.
//
// Both halves are cached now, and a cache over the owner's money is only safe while two things
// hold: a state change must be visible on the very next call, and a caller must not be able to
// see or corrupt the cache. Neither is visible from the outside, so both are held here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyOpportunity } from '../src/autonomos/capabilities.js';
import { businessSnapshot } from '../src/autonomos/business-snapshot.js';
import { GlobalWorkHunter } from '../src/autonomos/global-work-hunter.js';
import { AutonomOSStore } from '../src/autonomos/store.js';
import { ledgerEntry, appendUniqueLedgerEntry } from '../src/autonomos/financial-ledger.js';

let checks = 0;
const ok = (condition, label) => { assert.ok(condition, label); checks++; };
const eq = (actual, expected, label) => { assert.equal(actual, expected, `${label} (got ${JSON.stringify(actual)})`); checks++; };

// ── 1. The classifier's memo must not serve a verdict for a different job ───────────────
// The key must cover every field the classifier reads. If one is missing, changing it alone
// returns the previous job's verdict -- a logo brief answered with a code verdict, silently.
// Each pair below differs in exactly one field and must classify differently.
const context = { llmEnabled: true, hasShellTool: true, hasWebSearchTool: true };
const base = { category: 'coding', title: 'Fix the bug', description: 'Fix it', skills: ['node'] };
const varied = [
  ['category', { ...base, category: 'translation' }],
  ['title', { ...base, title: 'Translate "hello world" to spanish' }],
  ['description', { ...base, description: 'Visit the store and take a photo of the receipt' }],
  ['skills', { ...base, skills: ['figma', 'canva', 'logo'] }]
];
const baseVerdict = JSON.stringify(classifyOpportunity(base, context));
for (const [field, opportunity] of varied) {
  ok(JSON.stringify(classifyOpportunity(opportunity, context)) !== baseVerdict,
    `changing ${field} alone changes the verdict, so ${field} is in the memo key`);
}
// The tool context is in the key too: the same job with and without a tool differs.
ok(JSON.stringify(classifyOpportunity(base, context)) !== JSON.stringify(classifyOpportunity(base, {})),
  'the tool context is part of the memo key');
// And a repeat is genuinely equal, not merely similar.
assert.deepEqual(classifyOpportunity(base, context), classifyOpportunity(base, context),
  'a repeated classification returns an equal verdict'); checks++;

// A caller that mutates its verdict must not corrupt what the next caller is handed. The
// hunter stores capability.missingTools straight into persisted state, so this is not theoretical.
const first = classifyOpportunity({ ...base, title: 'Browser automation: fill out the form' }, {});
first.missingTools.push('POISON'); first.skill = 'POISON'; first.freeFallbacks.browser = 'POISON';
const second = classifyOpportunity({ ...base, title: 'Browser automation: fill out the form' }, {});
ok(!second.missingTools.includes('POISON'), 'a mutated verdict does not poison the next caller');
ok(second.skill !== 'POISON' && second.freeFallbacks.browser !== 'POISON', 'nor its scalars or nested objects');

// ── 2. The business snapshot: fresh money, fresh work, and a real speed-up ──────────────
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-latency-'));
const env = { STORAGE_DIR: storage, npm_lifecycle_event: '' };
const hunter = new GlobalWorkHunter({ env, storageDir: storage, logger: { info() {}, warn() {}, error() {} } });
const LEADS = 1200;
for (let i = 0; i < LEADS; i++) {
  const lead = hunter.classifyWebLead({
    url: `https://example${i}.com/job/${i}`,
    title: `Remote freelance contract: build a landing page ${i}`,
    snippet: 'Paid freelance digital project, remote, fixed price $250.'
  }, 'freelance job');
  if (lead) hunter.state.leads[lead.id] = { ...lead, budgetUsd: 250, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
}
hunter.persist();
const store = new AutonomOSStore(path.join(storage, 'autonomos'));

const coldStart = performance.now();
const cold = businessSnapshot(storage, env);
const coldMs = performance.now() - coldStart;
const warmStart = performance.now();
const warm = businessSnapshot(storage, env);
const warmMs = performance.now() - warmStart;

const withoutTimestamp = (snapshot) => { const copy = structuredClone(snapshot); delete copy.generatedAt; return JSON.stringify(copy); };
eq(withoutTimestamp(warm), withoutTimestamp(cold), 'a cached answer is the answer, not an approximation of it');
ok(warm.generatedAt, 'and still carries a timestamp');
// A generous ratio: the point is that the work is skipped, not that a machine hits a number.
ok(warmMs * 5 < coldMs, `a repeat poll skips the work: ${coldMs.toFixed(0)}ms cold vs ${warmMs.toFixed(1)}ms warm`);

// Settled money must appear on the very next call. A dashboard that is fast and wrong about
// the owner's money is worse than one that is slow.
eq(warm.money.grossRevenueUsd, 0, 'no revenue before the receipt');
appendUniqueLedgerEntry(store, ledgerEntry({
  id: 'latency-receipt', type: 'revenue', source: 'taskmarket.dev', amountUsd: 137, feeUsd: 0,
  currency: 'USDC', status: 'settled', externalTransactionId: '0x' + 'a'.repeat(64), network: 'eip155:8453'
}));
eq(businessSnapshot(storage, env).money.grossRevenueUsd, 137, 'a settled receipt is visible on the very next call');

// So must new work.
const discoveredBefore = businessSnapshot(storage, env).counts.discovered;
const fresh = hunter.classifyWebLead({
  url: 'https://brand-new-client.com/job/1',
  title: 'Remote freelance contract: translate a document to spanish',
  snippet: 'Paid freelance digital project, remote, fixed price $900.'
}, 'freelance job');
hunter.state.leads[fresh.id] = { ...fresh, budgetUsd: 900, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
hunter.persist();
eq(businessSnapshot(storage, env).counts.discovered, discoveredBefore + 1, 'a newly discovered lead is visible on the very next call');

// And the caller's copy is its own.
const handed = businessSnapshot(storage, env);
handed.counts.discovered = 999999;
handed.money.grossRevenueUsd = -1;
const next = businessSnapshot(storage, env);
ok(next.counts.discovered !== 999999 && next.money.grossRevenueUsd === 137,
  'a caller mutating its snapshot cannot poison the cache');

fs.rmSync(storage, { recursive: true, force: true });
console.log(`DASHBOARD LATENCY: PASS (${checks} checks, ${LEADS} leads, ${coldMs.toFixed(0)}ms cold -> ${warmMs.toFixed(1)}ms warm)`);
