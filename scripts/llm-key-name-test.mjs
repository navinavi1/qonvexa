import assert from 'node:assert/strict';
import { freeCapabilityContext } from '../src/autonomos/free-capability-layer.js';
import { unifiedCapabilityContext } from '../src/autonomos/capability-registry.js';
import { classifyOpportunity } from '../src/autonomos/capabilities.js';
import { resolveLlmEndpoint } from '../src/autonomos/llm-router.js';

// llm-router.js accepts AUTONOMOS_LLM_API_KEY or OPENAI_API_KEY and will make real model
// calls with either. capability-registry.js, on the branch taken when no llm object is
// passed, used to read OPENAI_API_KEY alone. FreeRevenueLeadActioner takes that branch, and
// the running fleet is built on it (start-autonomos.mjs), so a deployment configured only
// with AUTONOMOS_LLM_API_KEY had a working key and still classified every non-deterministic
// job 'unsupported_without_llm'. The two files must agree on the key names.

const base = { STORAGE_DIR: '/tmp/llm-key-name-test' };
// A job that needs no sandbox, so llmEnabled is the only variable under test.
const job = { source: 'direct', externalId: '1', title: 'Write product description copy',
  description: 'Write 5 short marketing descriptions for our product page.', budgetUsd: 80, currency: 'USD' };

for (const key of ['AUTONOMOS_LLM_API_KEY', 'OPENAI_API_KEY']) {
  const env = { ...base, [key]: 'sk-test' };

  // 1) The router accepts it — this is what actually calls the model.
  assert.equal(resolveLlmEndpoint(env, { task: 'execution' }).apiKey, 'sk-test', `llm-router must accept ${key}`);

  // 2) And the capability gate must agree, on the branch that passes no llm object.
  assert.equal(freeCapabilityContext(env).llmEnabled, true, `${key} alone must enable the LLM capability`);
  assert.equal(unifiedCapabilityContext(env).llmEnabled, true, `${key} alone must enable the LLM capability`);

  // 3) The consequence the fleet actually depends on.
  const verdict = classifyOpportunity(job, freeCapabilityContext(env));
  assert.equal(verdict.executable, true, `${key} alone must leave an LLM job executable`);
  assert.equal(verdict.mode, 'llm_with_tools');
  assert.ok(verdict.estimatedModelCostUsd > 0, 'a priced LLM job must carry a cost estimate');
}

// 4) With no key at all, nothing is pretended to work.
const none = freeCapabilityContext({ ...base });
assert.equal(none.llmEnabled, false, 'no key must stay disabled');
assert.equal(classifyOpportunity(job, none).mode, 'unsupported_without_llm');

// 5) An explicit llm object still wins over the environment — that path is unchanged.
assert.equal(unifiedCapabilityContext({ ...base }, { llm: { available: true } }).llmEnabled, true);
assert.equal(unifiedCapabilityContext({ ...base, OPENAI_API_KEY: 'sk-test' }, { llm: { available: false } }).llmEnabled, false);

console.log('LLM KEY NAME: PASS');
