import assert from 'node:assert/strict';
import { infrastructureStatus } from '../src/autonomos/infrastructure.js';
import { paymentDestinations, selectPayoutRoute } from '../src/autonomos/payment-router.js';
import { classifyOpportunity } from '../src/autonomos/capabilities.js';
import { TOOL_SCHEMAS } from '../src/autonomos/tools.js';

const infra=infrastructureStatus({DATABASE_URL:'postgresql://x',REDIS_URL:'redis://x',OPENAI_API_KEY:'x'});
assert.equal(infra.find(x=>x.id==='memory').configured,true);
assert.equal(infra.some(x=>x.id==='browserhelper'),false);
assert.equal(infra.find(x=>x.id==='openai_agents').configured,true);
assert.equal(infra.some(x=>x.id==='secretlegacy'),false);

const env={AUTONOMOS_OWNER_WALLET:'0x1111111111111111111111111111111111111111',BANK_BENEFICIARY:'FOP TEST',BANK_IBAN:'UA123',BANK_SWIFT:'TESTUA22',BANK_CURRENCY:'USD'};
assert.equal(paymentDestinations(env).fop.configured,true);
assert.equal(selectPayoutRoute({currency:'USD',supportedMethods:['swift'],amountUsd:100},env).rail,'fop_swift');
assert.equal(selectPayoutRoute({currency:'USDC',supportedMethods:['crypto'],amountUsd:100},env).rail,'crypto');
assert.equal(selectPayoutRoute({currency:'USDC',marketplace:'clawlancer',supportedMethods:['direct_crypto','marketplace'],amountUsd:5},env).rail,'crypto','explicit direct crypto must beat marketplace-managed balance');
assert.equal(selectPayoutRoute({currency:'USDC',marketplace:'dealwork',supportedMethods:['marketplace'],amountUsd:5},env).rail,'marketplace_managed','marketplace balance must not be mislabeled as direct owner payout');

const multiEnv={AUTONOMOS_FOP_ACCOUNTS_JSON:JSON.stringify([
  {beneficiary:'FOP TEST',bank:'Bank',iban:'UA111',swift:'TESTUA22',currency:'USD'},
  {beneficiary:'FOP TEST',bank:'Bank',iban:'UA222',swift:'TESTUA22',currency:'EUR'}
])};
assert.equal(selectPayoutRoute({currency:'EUR',supportedMethods:['swift'],amountUsd:100},multiEnv).destination,'UA222');
assert.equal(selectPayoutRoute({currency:'GBP',supportedMethods:['swift'],amountUsd:100},multiEnv).ok,false);

const cap=classifyOpportunity({category:'coding',title:'Build app and run tests',description:'npm install, run tests and open a pull request'},{llmEnabled:true,hasGithubPrTool:true,hasShellTool:true});
assert.equal(cap.executable,true);
assert.ok(TOOL_SCHEMAS.some(x=>x.function.name==='run_shell'));
assert.equal(TOOL_SCHEMAS.some(x=>x.function.name==='browser_task'),false);
console.log('AutonomOS platform test PASS');
