// Can this system actually earn money right now, and if not, what exactly is stopping it?
//
// The earning lanes are the workers started by scripts/start-autonomos.mjs. The runtime
// cycle now reads the same feed they fill — it used to read connectors/index.js, a stub
// returning an empty list, which is why its panels reported an empty scan for 31,951 cycles
// — but the workers are still the ones that apply, execute and deliver.
//
// This checks the real lane, against the real environment, and refuses to guess. Nothing here
// promises income; it reports which preconditions hold and names the owner action for each
// one that does not.
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { githubAvailable } from '../src/autonomos/github-transport.js';
import { paymentDestinations, selectPayoutRoute } from '../src/autonomos/payment-router.js';
import { computeEarnedSpendBudgetUsd } from '../src/autonomos/profit-engine.js';
import { normalizeConfig, DEFAULT_AUTONOMOS_CONFIG } from '../src/autonomos/policy-engine.js';
import { resourceAvailability } from '../src/autonomos/resource-control.js';

const env = process.env;
const storageDir = String(env.STORAGE_DIR || 'data');
const root = path.join(storageDir, 'autonomos');
const readJson = (name, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); } catch { return fallback; } };
const readLedger = () => { try { return fs.readFileSync(path.join(root, 'ledger.ndjson'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };

const checks = [];
const check = (stage, name, ok, detail, action = '') => checks.push({ stage, name, ok, detail, action });

const config = normalizeConfig(readJson('config.json', { ...DEFAULT_AUTONOMOS_CONFIG }));
const ledger = readLedger();

// ── 1. Is the engine even allowed to run ────────────────────────────────────────────────
check('RUN', 'Runtime enabled', config.enabled === true,
  `config.enabled = ${config.enabled}`,
  'Press Start on the admin dashboard, or set AUTONOMOS_ENABLED=true before boot.');
check('RUN', 'Emergency stop clear', config.killSwitch !== true,
  `config.killSwitch = ${config.killSwitch}`,
  'Press "Clear emergency stop" on the dashboard.');

// ── 2. Can it find paid work ────────────────────────────────────────────────────────────
// The GitHub bounty lane is the one where automated participation is permitted by the
// platform. loadGithubBounties() queries the public search API; a token raises the rate
// limit from 10 to 30 requests/minute and is required for every write that follows.
check('FIND', 'GitHub credential present', githubAvailable(env),
  githubAvailable(env) ? 'GITHUB_TOKEN or COMPOSIO_API_KEY is set' : 'neither GITHUB_TOKEN nor COMPOSIO_API_KEY is set',
  'Create a GitHub token with "public_repo" scope and set GITHUB_TOKEN. Without it the search is rate-limited to 10/min and no application can ever be posted.');

const hunter = readJson('global-work-hunter.json', {});
const leadCount = Object.keys(hunter.leads || {}).length;
const bountyState = hunter.freeSources?.['github-bounties'] || null;
check('FIND', 'Bounty search has run', Boolean(bountyState?.lastPollAt),
  bountyState ? `last polled ${bountyState.lastPollAt}${bountyState.error ? `, error: ${bountyState.error}` : ''}` : 'never polled',
  'Start the fleet: npm start. The lane polls every 15 minutes.');
check('FIND', 'Leads discovered', leadCount > 0,
  `${leadCount} lead(s) in global-work-hunter.json`,
  'If the search ran with no error and still found nothing, the queries returned no funded issues this cycle. This is normal; it retries.');

// ── 3. Can it do the work ───────────────────────────────────────────────────────────────
// Execution costs money. "Agents work for free" cannot be true of the LLM calls that solve
// the issue; the bounty has to exceed that cost, which is what the profit gate checks.
const hasLlm = Boolean(env.OPENAI_API_KEY || env.AUTONOMOS_LLM_API_KEY);
check('WORK', 'LLM key present', hasLlm,
  hasLlm ? 'OPENAI_API_KEY or AUTONOMOS_LLM_API_KEY is set' : 'no LLM key',
  'Set OPENAI_API_KEY. Solving an issue requires model calls; there is no free path to doing the work itself.');
check('WORK', 'Sandbox for running tests', Boolean(env.E2B_API_KEY),
  env.E2B_API_KEY ? 'E2B_API_KEY is set' : 'E2B_API_KEY is not set',
  'Set E2B_API_KEY. verified-github-pr.js will not open a PR without proof the tests pass on the fix and fail on the base, so without a sandbox the lane stops before delivery.');

const spendable = computeEarnedSpendBudgetUsd(ledger, config);
check('WORK', 'Agents have money to spend', spendable > 0,
  `$${spendable} available (seed $${config.seedSpendBudgetUsd} + earned share − costs)`,
  'Use "Fund agent treasury" on the dashboard. Every attempt books a cost, executors stop at zero, and a job must run to earn the revenue that refills it — so at zero nothing can start.');

// ── 4. Can the money reach the owner ────────────────────────────────────────────────────
const dest = paymentDestinations(env);
const wallets = Object.entries(dest.crypto.wallets).filter(([, w]) => w.configured).map(([k]) => k);
check('PAID', 'A crypto wallet is configured', wallets.length > 0,
  wallets.length ? `configured: ${wallets.join(', ')}` : 'no wallet configured',
  'Set AUTONOMOS_OWNER_WALLET (EVM) and/or AUTONOMOS_PHANTOM_WALLET (Solana).');

const baseRoute = selectPayoutRoute({ currency: 'USDC', network: 'base', supportedMethods: ['direct_crypto'], amountUsd: 100 }, env);
check('PAID', 'USDC on Base can be routed', baseRoute.ok,
  baseRoute.ok ? `-> ${baseRoute.destination}` : `refused: ${baseRoute.reason}`,
  'Set AUTONOMOS_OWNER_WALLET to your EVM address.');

const solRoute = selectPayoutRoute({ currency: 'USDC', network: 'solana', supportedMethods: ['direct_crypto'], amountUsd: 100 }, env);
check('PAID', 'USDC on Solana can be routed', solRoute.ok,
  solRoute.ok ? `-> ${solRoute.destination}` : `refused: ${solRoute.reason}`,
  'Set AUTONOMOS_PHANTOM_WALLET. TaskForce settles USDC on Solana, so without it those jobs are refused before they are claimed.');

// ── 4b. The allowance the earning lane runs on ──────────────────────────────────────────
// This is the check that took two weeks to find by hand. Everything above can be perfectly
// configured and the lane still earns nothing, because the daily GitHub allowance is spent
// on polling: discovery every 30s plus the PR monitor every 60s is ~4300 calls a day against
// a 4000 cap. When it runs out, hasGithubPrTool goes false and the capability probe that
// would re-enable it needs the same allowance, so it cannot recover until UTC midnight.
// None of that is visible in the repository — only in a running deployment.
{
  const earning = resourceAvailability('github', env, { purpose: 'earning' });
  const discovery = resourceAvailability('github', env, { purpose: 'opportunistic' });
  const used = Number(earning.used || 0);
  const limit = Number(earning.limit || 0);
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;

  check('FIND', 'GitHub allowance not exhausted', earning.allowed !== false,
    `${used}/${limit || '?'} used today (${pct}%)${earning.retryAt ? `, resets ${earning.retryAt}` : ''}`,
    'Raise the cap: AUTONOMOS_FREE_RESOURCE_LIMITS_JSON={"github":{"limit":60000}}. Ours defaults to 4000/day while GitHub allows an authenticated token 5000/hour, so the default throttles the earning lane to a few percent of what the token actually permits.');

  // A held reserve is the system working, not failing — say so rather than leaving the owner
  // to read "blocked" and start changing things.
  if (discovery.allowed === false && earning.allowed !== false) {
    check('FIND', 'Discovery paused to protect delivery', true,
      'the opportunistic share is spent; the earning reserve is intact',
      '');
  }
  if (limit > 0 && pct >= 70 && earning.allowed !== false) {
    check('FIND', 'GitHub allowance headroom', false,
      `${100 - pct}% left before the earning lane stops`,
      'Raise the cap before it runs out; polling alone consumes the default in under a day.');
  }
}

// ── 5. The part no code here can verify ─────────────────────────────────────────────────
// Bounty platforms pay the GitHub account that solved the issue, into the wallet connected
// to THAT platform account. Nothing in this repository can read or set that, and a merged PR
// with no wallet connected on Algora/Opire earns nothing.
check('PAID', 'Bounty platform payout account', null,
  'cannot be checked from here',
  'On Algora / Opire / IssueHunt: sign in with the same GitHub account the agent uses and connect your wallet there. A merged PR pays that account, not this server.');

// ── Report ──────────────────────────────────────────────────────────────────────────────
// Taskmarket is the one lane the suite proves end to end: claiming and submitting are free
// routes and it settles USDC on Base, so it satisfies the crypto-only payout policy. It
// ships disabled and needs its CLI installed, so name whichever of the two is missing.
const taskmarketOn = /^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_TASKMARKET_ENABLED || 'false'));
// An opt-in lane that is switched off is a choice, not a fault: reporting it as blocking
// would leave this permanently red for anyone who never wanted the lane. Only turning it on
// without its binary is a misconfiguration, and that is checked below.
check('WORK', 'Taskmarket lane', taskmarketOn ? true : null,
  taskmarketOn ? 'AUTONOMOS_TASKMARKET_ENABLED is on' : 'available but switched off, so no Taskmarket task is claimed',
  taskmarketOn ? '' : 'to use it: npm run taskmarket-install, then set AUTONOMOS_TASKMARKET_ENABLED=true');
if (taskmarketOn) {
  let binary = false;
  try {
    const { execFileSync } = await import('node:child_process');
    const { taskmarketBinary } = await import('../src/autonomos/taskmarket.js');
    execFileSync(taskmarketBinary(env), ['--version'], { stdio: 'ignore', timeout: 15000 });
    binary = true;
  } catch {}
  check('WORK', 'Taskmarket CLI installed', binary,
    binary ? 'the taskmarket binary answers' : 'the lane is on but its binary is missing, so every call fails',
    binary ? '' : 'run npm run taskmarket-install');
}

// The security research lane queues findings for the owner to submit by hand. An enabled
// lane with an empty program registry is a configuration that quietly does nothing.
const securityOn = /^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_SECURITY_RESEARCH_ENABLED || 'false'));
if (securityOn) {
  const programs = (readJson('security-programs.json', {}).programs || []).length;
  check('FIND', 'Security programs seeded', programs > 0,
    programs > 0 ? `${programs} bounty programs in scope` : 'the lane is on with no programs to scan',
    programs > 0 ? '' : 'run npm run security-seed');
}

const STAGES = { RUN: 'Engine running', FIND: 'Finding paid work', WORK: 'Doing the work', PAID: 'Getting paid' };
let blocking = 0, unknown = 0;
for (const [stage, title] of Object.entries(STAGES)) {
  console.log(`\n${title}`);
  for (const c of checks.filter(x => x.stage === stage)) {
    const mark = c.ok === true ? ' OK ' : c.ok === null ? ' ?? ' : 'FAIL';
    if (c.ok === false) blocking++;
    if (c.ok === null) unknown++;
    console.log(`  [${mark}] ${c.name}: ${c.detail}`);
    if (c.ok !== true && c.action) console.log(`         -> ${c.action}`);
  }
}

console.log(`\n${'-'.repeat(76)}`);
if (blocking === 0) {
  console.log('Every precondition this system can check is satisfied.');
  console.log('That is not a promise of income: whether a bounty is won depends on the work,');
  console.log('and on the payout account named above, which no code here can verify.');
} else {
  console.log(`${blocking} precondition(s) block earning right now. Each one is listed above with`);
  console.log('the action that clears it. Until they are clear, no amount of running earns anything.');
}
if (unknown) console.log(`${unknown} item(s) cannot be checked from inside this system and are the owner's to confirm.`);
process.exitCode = 0; // a report, never a build failure
