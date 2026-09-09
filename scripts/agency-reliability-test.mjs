import assert from 'node:assert/strict';
import { buildAcceptanceContract, validateAcceptanceContract } from '../src/autonomos/acceptance-engine.js';
import { canTransition, createJobIdentity } from '../src/autonomos/agency-intelligence.js';
import { normalizeConfig, validateAction } from '../src/autonomos/policy-engine.js';
import { runTool, estimateToolCostUsd } from '../src/autonomos/tools.js';

const contract=buildAcceptanceContract({
  source:'workprotocol',
  title:'Build API and provide tests',
  description:'Build a working API, run tests and provide a downloadable report.',
  capability:{skill:'code-analysis',requiresArtifact:true,executable:true}
});
assert.equal(contract.source,'workprotocol');
assert.ok(contract.requirements.some(x=>x.id==='implementation'));
assert.ok(contract.artifacts.some(x=>x.required));
assert.equal(validateAcceptanceContract(contract,{content:'plan only',evidence:{toolCalls:[]}}).ok,false);

assert.equal(canTransition('claiming','claimed'),true);
assert.equal(canTransition('claim_failed','claiming'),true);
assert.equal(canTransition('claimed','claimed'),true);
assert.equal(canTransition('delivered','claiming'),false);

const a=createJobIdentity({source:'a:b',externalId:'c'});
const b=createJobIdentity({source:'a',externalId:'b:c'});
assert.notEqual(a.idempotencyKey,b.idempotencyKey);
assert.notEqual(a.id,b.id);

const cfg=normalizeConfig({enabled:true,zeroSpendMode:false,earnedFundsOnly:true,allowExternalSpending:false,maxPaidProcurementUsd:0.02});
assert.equal(validateAction({kind:'spend',amountUsd:0.01},cfg).allowed,true);

// This file used to assert that web_search is refused under a tiny budget. Search moved to
// the free provider (TOOL_COST_ESTIMATES_USD.web_search === 0), so that assertion pinned a
// reality that no longer exists and the script was left out of `npm run verify` instead of
// being updated — which hid every other check in here. The budget gate is asserted against
// a tool that really does cost money, and the free lane is asserted to stay usable.
const paidBlocked=await runTool('run_python',{code:'print(1)'},{E2B_API_KEY:'not-used'},
  {config:{...cfg,enabled:true},validateAction,remainingBudgetUsd:0.001});
assert.equal(paidBlocked.ok,false);
assert.match(String(paidBlocked.error),/job_budget_exceeded/);

const freeAllowed=estimateToolCostUsd('web_search',{query:'test'},{});
assert.equal(freeAllowed,0,'free-first search must not consume the earned-spend budget');

console.log('Agency reliability test PASS');
