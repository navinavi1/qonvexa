import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every worker in the fleet is constructed and given one tick against a throwaway storage
// directory with no credentials. Nothing here asserts that a lane earns anything — the point
// is narrower and was missing entirely: no test in this repository had ever *instantiated*
// most of these classes, so a module could reference an identifier that does not exist and
// `npm run verify` stayed green.
//
// That is not hypothetical. A helper import was once inserted into the middle of a Python
// heredoc inside a template literal in adaptive-skill-acquirer.js. The file still parsed,
// `node --check` was happy, the whole suite passed — and the skill-acquisition worker threw
// ReferenceError on every run, swallowed by its own .catch() in start(). This test fails on
// exactly that.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-smoke-'));
const env = {
  STORAGE_DIR: root,
  // No API keys on purpose: every lane must park cleanly rather than throw.
  AUTONOMOS_ENABLED: 'false',
  AUTONOMOS_X402_ENABLED: 'false',
  AUTONOMOS_OWNER_WALLET: '0x1f674bf085f6fed36fa198287d51edf0fe0bb9e2'
};
const logger = { info() {}, warn() {}, error() {}, log() {} };

// A worker that cannot reach the network must not be the thing under test, so fetch is
// stubbed to a plain refusal rather than left to hit the sandbox proxy.
globalThis.fetch = async () => ({
  ok: false, status: 503, headers: { get: () => null },
  json: async () => ({}), text: async () => ''
});

const workers = [
  ['LeanInternetHunter', '../src/autonomos/lean-internet-hunter.js', 'scan'],
  ['ProfitFirstGlobalWorkHunter', '../src/autonomos/profit-first-global-work-hunter.js', 'cycle'],
  ['FreeAgrentingLiveWorker', '../src/autonomos/free-agrenting-live-worker.js', 'tick'],
  ['FreeMarketScout', '../src/autonomos/free-market-scout.js', 'scan'],
  ['MarketExpansionEngine', '../src/autonomos/market-expansion-engine.js', 'tick'],
  ['SkillLibraryWorker', '../src/autonomos/skill-library-worker.js', 'refresh'],
  ['AdaptiveSkillAcquirer', '../src/autonomos/adaptive-skill-acquirer.js', 'tick'],
  ['DailyMoneyReporter', '../src/autonomos/daily-money-reporter.js', 'refresh'],
  ['FiatCryptoRoutePlanner', '../src/autonomos/fiat-crypto-route-planner.js', 'refresh'],
  ['FreeRevenueLeadActioner', '../src/autonomos/free-revenue-lead-actioner.js', 'tick'],
  ['TaskForceVerifier', '../src/autonomos/taskforce-verifier.js', 'tick'],
  ['TaskForceWorker', '../src/autonomos/taskforce-worker.js', 'tick'],
  ['GlobalFeedPublisher', '../src/autonomos/global-feed-publisher.js', 'publish']
];

let checked = 0;
for (const [name, modulePath, method] of workers) {
  const module = await import(modulePath);
  const Worker = module[name];
  assert(typeof Worker === 'function', `${name} is not exported by ${modulePath}`);

  const worker = new Worker({ env, storageDir: root, logger });
  if (typeof worker[method] !== 'function') {
    assert.fail(`${name}.${method}() is missing — the fleet calls it`);
  }

  try {
    await worker[method]();
  } catch (error) {
    // A lane refusing to work without credentials is the expected outcome. A missing
    // identifier or a bad call signature is a defect, and those are the two this catches.
    if (error instanceof ReferenceError || error instanceof SyntaxError) {
      assert.fail(`${name}.${method}() threw ${error.constructor.name}: ${error.message}`);
    }
    if (error instanceof TypeError && /is not a function|of undefined|of null/.test(error.message)) {
      assert.fail(`${name}.${method}() threw TypeError: ${error.message}`);
    }
  } finally {
    worker.stop?.();
  }
  checked++;
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`WORKER SMOKE: PASS (${checked} workers constructed and ticked)`);
