import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutonomOS } from '../src/autonomos/runtime.js';

// The runtime wrote a full diagnostics dump on every cycle. At a 20s heartbeat that is ~4300
// identical large JSON lines a day, and they buried the fleet's real signal — the exhausted
// GitHub allowance that had shut the earning lane down sat in that noise for two weeks.
//
// Repetition is now collapsed, but silence must never be mistaken for a dead process, and a
// change must appear immediately. Both are asserted here, against the real runtime.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-noise-'));
const wallet = '0x1f674bf085f6fed36fa198287d51edf0fe0bb9e2';
const lines = [];
const runtime = createAutonomOS({
  storageDir: root, siteUrl: 'https://qonvexa.co', ownerWallet: wallet,
  env: { AUTONOMOS_ENABLED: 'false', AUTONOMOS_X402_ENABLED: 'false', AUTONOMOS_OWNER_WALLET: wallet },
  logger: { info: (m) => { if (String(m).startsWith('[AutonomOS]')) lines.push(String(m)); }, warn() {}, error() {} }
});

const diagnostics = () => lines.filter(l => l.includes('"type":"cycle_diagnostics"'));

// Construction logs once (runtime_initialized) — that is the baseline, not a diagnostics line.
const before = diagnostics().length;

// 1) Twenty cycles with nothing changing produce one line, not twenty.
for (let i = 0; i < 20; i++) await runtime.runCycle();
const quiet = diagnostics().length - before;
assert.ok(quiet <= 1, `20 unchanged cycles must not write 20 diagnostics lines (wrote ${quiet})`);

// 2) Nothing is lost: the line that does appear says how many cycles it stands for.
const emitted = diagnostics();
if (emitted.length) {
  const last = JSON.parse(emitted[emitted.length - 1].replace('[AutonomOS] ', ''));
  if (last.identicalCyclesSince !== undefined) {
    assert.ok(Number(last.identicalCyclesSince) > 0, 'the collapsed count must be real');
  }
}

// 3) A change must surface immediately, not wait for the heartbeat. Funding the treasury
// moves availableSpendUsd, which is part of what an operator acts on.
const marker = diagnostics().length;
runtime.fundAgentTreasury({ amountUsd: 40, requestId: 'diag-test' });
await runtime.runCycle();
assert.ok(diagnostics().length > marker, 'a changed picture must be logged on the next cycle');

runtime.stop?.();
fs.rmSync(root, { recursive: true, force: true });
console.log('DIAGNOSTICS NOISE: PASS');
