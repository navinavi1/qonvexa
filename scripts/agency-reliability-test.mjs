import assert from 'node:assert/strict';
import { buildAcceptanceContract, validateAcceptanceContract } from '../src/autonomos/acceptance-engine.js';
import { canTransition, createJobIdentity } from '../src/autonomos/agency-intelligence.js';
import { normalizeConfig, validateAction } from '../src/autonomos/policy-engine.js';
import { runTool } from '../src/autonomos/tools.js';

const contract=buildAcceptanceContract({
  source:'t2000',
  title:'Build API and provide tests',
  description:'Build a working API, run tests and provide a downloadable report.',
  capability:{skill:'code-analysis',requiresArtifact:true,executable:true}
});
assert.equal(contract.source,'t2000');
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
const blocked=await runTool('web_search',{query:'test'},{FIRECRAWL_API_KEY:'not-used'},
  {config:{...cfg,enabled:true},validateAction,remainingBudgetUsd:0.001});
assert.equal(blocked.ok,false);
assert.match(String(blocked.error),/job_budget_exceeded/);

console.log('Agency reliability test PASS');
