import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The audit is only useful if it separates the kinds of dead variable, because they need
// different actions: a retired market's credential is a leftover to delete, a config field
// with no env reader has to be set on the dashboard instead, and an unused API key may still
// be billing every month. Lumping them into one list would leave the owner guessing.

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'env-audit.mjs');
// A clean environment: inheriting the developer's own variables would make this test lie.
const run = (env) => execFileSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

const out = run({
  AGENTHANSA_API_KEY: 'x', TASKBOUNTY_PAYOUT_ADDRESS: 'x',   // retired markets
  AUTONOMOS_KILL_SWITCH: 'false', AUTONOMOS_AUTO_CLAIM_JOBS: 'true', // dashboard-owned
  FIRECRAWL_API_KEY: 'x', TAVILY_API_KEY: 'x',               // unused paid credentials
  GITHUB_TOKEN: 'x', OPENAI_API_KEY: 'x', E2B_API_KEY: 'x',  // live and read
  AUTONOMOS_OWNER_WALLET: '0x1', AUTONOMOS_ENABLED: 'true'
});

const section = (heading) => {
  const start = out.indexOf(heading);
  assert.ok(start >= 0, `missing section: ${heading}`);
  const rest = out.slice(start);
  const end = rest.indexOf('\n\n');
  return end < 0 ? rest : rest.slice(0, end);
};

// 1) A retired market's credential is named, with the retirement that explains it.
const retired = section('RETIRED');
assert.match(retired, /AGENTHANSA_API_KEY\s+\(retired: agenthansa\)/);
assert.match(retired, /TASKBOUNTY_PAYOUT_ADDRESS\s+\(retired: taskbounty\)/);

// 2) A real config field that the environment cannot set is called out as such, not as junk.
// This is the one that matters for safety: AUTONOMOS_KILL_SWITCH set here does nothing.
const dashboard = section('NO EFFECT FROM HERE');
assert.match(dashboard, /AUTONOMOS_KILL_SWITCH/);
assert.match(dashboard, /AUTONOMOS_AUTO_CLAIM_JOBS/);

// 3) An unused credential is reported even though no manifest ever mentioned it — these
// were added straight to the deployment and are the ones that can still be charging.
const creds = section('UNUSED CREDENTIALS');
assert.match(creds, /FIRECRAWL_API_KEY/);
assert.match(creds, /TAVILY_API_KEY/);

// 4) Variables that ARE read must never be listed. A false positive here costs the owner a
// working deployment.
for (const live of ['GITHUB_TOKEN', 'OPENAI_API_KEY', 'E2B_API_KEY', 'AUTONOMOS_OWNER_WALLET', 'AUTONOMOS_ENABLED']) {
  assert.doesNotMatch(out, new RegExp(`^\\s+${live}\\b`, 'm'), `${live} is read by the code and must not be reported dead`);
}

// 5) Someone else's variables are not this audit's business.
const foreign = run({ SOME_OTHER_TOOL_HOME: '/x', LC_ALL: 'C', GITHUB_TOKEN: 'x' });
assert.doesNotMatch(foreign, /SOME_OTHER_TOOL_HOME|LC_ALL/, 'foreign variables must be left alone');

console.log('ENV AUDIT: PASS');
