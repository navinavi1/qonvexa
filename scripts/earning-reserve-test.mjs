import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reserveResource, resourceAvailability } from '../src/autonomos/resource-control.js';

// Measured in production before this existed: github 4000/4000 used, hasGithubPrTool false.
// Discovery scans every 30s and the PR monitor every 60s together spend ~4300 calls a day
// against a 4000 cap, so polling drank the whole allowance and the lane that actually earns
// was shut down until the next UTC midnight — and could not recover, because the capability
// probe that re-enables it also needs quota.
//
// A quarter of the allowance is now reachable only by earning-path calls: claiming a bounty,
// opening the pull request, checking that it was paid. Those are the calls where the model
// and sandbox cost is already sunk, so refusing them wastes money that was already spent.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'earning-reserve-'));
// A small limit keeps the test fast; the reserve is a fraction, so the arithmetic is the same.
const env = { STORAGE_DIR: root, AUTONOMOS_FREE_RESOURCE_LIMITS_JSON: JSON.stringify({ github: { limit: 100 } }) };

// 1) Discovery sees the allowance minus the reserve; earning sees all of it.
assert.equal(resourceAvailability('github', env, { purpose: 'opportunistic' }).limit, 75);
assert.equal(resourceAvailability('github', env, { purpose: 'earning' }).limit, 100);
assert.equal(resourceAvailability('github', env).limit, 100, 'an unmarked caller is treated as earning');

// 2) Spend the whole opportunistic share.
for (let i = 0; i < 75; i++) {
  const r = await reserveResource('github', 1, env, { purpose: 'opportunistic' });
  assert.equal(r.ok, true, `opportunistic call ${i + 1} must be allowed`);
}

// 3) Discovery is now held off — and says so distinctly. Reporting this as an exhausted
// allowance would make a healthy reserve look like an outage.
const blocked = await reserveResource('github', 1, env, { purpose: 'opportunistic' });
assert.equal(blocked.ok, false);
assert.equal(blocked.error, 'earning_reserve_protected');

// 4) The point of the whole thing: earning work still goes through.
for (let i = 0; i < 25; i++) {
  const r = await reserveResource('github', 1, env, { purpose: 'earning' });
  assert.equal(r.ok, true, `earning call ${i + 1} must survive a drained discovery budget`);
}

// 5) Once the real allowance is gone, everything stops, and now it IS an exhaustion.
const exhausted = await reserveResource('github', 1, env, { purpose: 'earning' });
assert.equal(exhausted.ok, false);
assert.equal(exhausted.error, 'free_resource_limit_reached');

// 6) A provider with no reserve configured is untouched — this must not change gmail, drive
// or anything else that was working.
const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'no-reserve-'));
const plainEnv = { STORAGE_DIR: plain, AUTONOMOS_FREE_RESOURCE_LIMITS_JSON: JSON.stringify({ gmail: { limit: 10 } }) };
assert.equal(resourceAvailability('gmail', plainEnv, { purpose: 'opportunistic' }).limit, 10);
assert.equal(resourceAvailability('gmail', plainEnv, { purpose: 'earning' }).limit, 10);

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(plain, { recursive: true, force: true });
console.log('EARNING RESERVE: PASS');
