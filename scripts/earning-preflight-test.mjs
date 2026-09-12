import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The preflight is only worth anything if it is honest in both directions: red when a real
// precondition is missing, green only when they are genuinely satisfied. A check that is
// always red teaches the owner to ignore it, and one that is always green is worse.

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'earning-preflight.mjs');
const run = (env) => execFileSync(process.execPath, [script], {
  encoding: 'utf8',
  // A clean environment: inheriting the developer's own keys would make this test lie.
  env: { PATH: process.env.PATH, ...env }
});

// A storage dir with nothing configured.
const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-bare-'));
fs.mkdirSync(path.join(bare, 'autonomos'), { recursive: true });
const bareOut = run({ STORAGE_DIR: bare });
assert.match(bareOut, /precondition\(s\) block earning right now/, 'an unconfigured system must report blockers');
for (const expected of ['Runtime enabled', 'LLM key present', 'A crypto wallet is configured']) {
  assert.match(bareOut, new RegExp(`\\[FAIL\\] ${expected}`), `${expected} must fail when absent`);
}

// The same system, fully configured.
const ready = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-ready-'));
fs.mkdirSync(path.join(ready, 'autonomos'), { recursive: true });
fs.writeFileSync(path.join(ready, 'autonomos', 'config.json'), JSON.stringify({
  enabled: true, killSwitch: false, seedSpendBudgetUsd: 25, updatedAt: new Date().toISOString()
}));
fs.writeFileSync(path.join(ready, 'autonomos', 'global-work-hunter.json'), JSON.stringify({
  leads: { x: { id: 'x' } },
  freeSources: { 'github-bounties': { lastPollAt: new Date().toISOString(), emptyPolls: 0 } }
}));
const readyOut = run({
  STORAGE_DIR: ready,
  GITHUB_TOKEN: 'ghp_example', OPENAI_API_KEY: 'sk-example', E2B_API_KEY: 'e2b_example',
  AUTONOMOS_OWNER_WALLET: '0x1f674bf085f6fed36fa198287d51edf0fe0bb9e2',
  AUTONOMOS_PHANTOM_WALLET: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2'
});
assert.match(readyOut, /Every precondition this system can check is satisfied/, 'a configured system must pass');
assert.doesNotMatch(readyOut, /\[FAIL\]/, 'no check may fail once everything is configured');

// The one thing it must never claim to have verified: money actually arriving depends on an
// account on a third-party platform that nothing here can read.
assert.match(readyOut, /\[ \?\? \] Bounty platform payout account/, 'the unverifiable step must stay marked unverifiable');
assert.match(readyOut, /is not a promise of income/, 'a green report must not read as a guarantee');

// 5) The check that took two weeks to find by hand: a GitHub allowance spent on polling
// shuts the earning lane down invisibly. It must be red in the report, not inferred from
// logs. Written as the resource store really records it.
const drained = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-drained-'));
fs.mkdirSync(path.join(drained, 'autonomos'), { recursive: true });
fs.writeFileSync(path.join(drained, 'autonomos', 'resource-usage.json'), JSON.stringify({
  resources: { github: { period: new Date().toISOString().slice(0, 10), used: 4000, lastUseAt: new Date().toISOString() } },
  events: []
}));
const drainedOut = run({
  STORAGE_DIR: drained,
  GITHUB_TOKEN: 'x', OPENAI_API_KEY: 'x', E2B_API_KEY: 'x',
  AUTONOMOS_OWNER_WALLET: '0x1f674bf085f6fed36fa198287d51edf0fe0bb9e2'
});
assert.match(drainedOut, /\[FAIL\] GitHub allowance not exhausted: 4000\/4000/,
  'an exhausted allowance must be reported, not left to be found in the logs');
assert.match(drainedOut, /AUTONOMOS_FREE_RESOURCE_LIMITS_JSON/, 'and must name the fix');
fs.rmSync(drained, { recursive: true, force: true });

fs.rmSync(bare, { recursive: true, force: true });
fs.rmSync(ready, { recursive: true, force: true });
console.log('EARNING PREFLIGHT: PASS');
