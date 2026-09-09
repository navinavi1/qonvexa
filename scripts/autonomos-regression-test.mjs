import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobRegistry, classifyFailure } from '../src/autonomos/job-registry.js';
import { buildAcceptanceContract, buildPhaseAcceptanceContract } from '../src/autonomos/acceptance-engine.js';
import { runHandoffChain } from '../src/autonomos/orchestration.js';
import { normalizeConfig } from '../src/autonomos/policy-engine.js';
import { estimateOutcomeProbability } from '../src/autonomos/outcome-model.js';
import { classifyOpportunity } from '../src/autonomos/capabilities.js';
import { discoverMarketOpportunities, claimMarketplaceJob, deliverMarketplaceJob, syncMarketplaceTransactions } from '../src/autonomos/connectors/index.js';

class JsonStore {
  constructor(dir){this.dir=dir;fs.mkdirSync(dir,{recursive:true});}
  readJson(name,fallback){try{return JSON.parse(fs.readFileSync(path.join(this.dir,name),'utf8'));}catch{return fallback;}}
  writeJson(name,value){fs.writeFileSync(path.join(this.dir,name),JSON.stringify(value,null,2));}
}

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autonomos71-'));
const store=new JsonStore(dir);
const registry=new JobRegistry({store,maxRecords:1000});
const op={source:'retained-fixture',externalId:'stable-1',title:'Build and research an API',description:'Research current sources, implement the API, run tests, and deliver a repository.',budgetUsd:150,currency:'USD',claimMode:'open'};
registry.observe(op);
registry.markPermanent(op,{owner:'market',reasonCode:'already_claimed',reason:'taken elsewhere'});
registry.observe({...op,title:'Updated title',budgetUsd:250,deadline:new Date(Date.now()+86400000).toISOString()});
assert.equal(registry.get(op).status,'graveyard','same marketplace+externalId must remain permanently blocked after metadata changes');
assert.equal(registry.summary().graveyard,1);

const hold={...op,externalId:'hold-1'};
registry.observe(hold);
registry.markSystemBlocked(hold,{reasonCode:'execution_or_capability_failure',capabilityVersion:'cap-v1'});
assert.equal(registry.releaseSystemBlocked(hold,{capabilityVersion:'cap-v1'}).released,false,'same capability version must not release an execution failure');
assert.equal(registry.releaseSystemBlocked(hold,{capabilityVersion:'cap-v2'}).released,false,'capability-version changes must not revive execution/QA failures');
const preflightHold={...op,externalId:'preflight-hold-1'};
registry.observe(preflightHold);
registry.markSystemBlocked(preflightHold,{reasonCode:'preflight_or_internal_capability_hold',capabilityVersion:'cap-v1'});
assert.equal(registry.releaseSystemBlocked(preflightHold,{capabilityVersion:'cap-v1'}).released,true,'fresh live preflight may release only an explicitly reversible pre-claim hold');

const contract=buildAcceptanceContract({...op,capability:{skill:'code-analysis',requiresArtifact:true}});
const research=buildPhaseAcceptanceContract(contract,'research-worker');
const code=buildPhaseAcceptanceContract(contract,'code-worker');
assert.ok(research.requirements.some(x=>x.id==='research-grounded'),'research phase must own research requirement');
assert.ok(!research.requirements.some(x=>x.id==='implementation'),'research phase must not be required to finish implementation');
assert.ok(code.requirements.some(x=>x.id==='implementation'),'code phase must own implementation requirement');

const seenContracts=[];
const result=await runHandoffChain(['research-worker','code-worker'],{...op,acceptanceContract:contract},{steps:[{role:'research-worker'},{role:'code-worker'}]}, {
  jobId:'job-regression',
  taskAgents:{markJobPhase(){}},
  onEvent(){},
  execute:async (phaseOp,{phaseRole})=>{
    seenContracts.push({role:phaseRole,ids:(phaseOp.acceptanceContract?.requirements||[]).map(x=>x.id)});
    return {content:`${phaseRole} completed`,hash:phaseRole,evidence:{toolCalls:[{tool:phaseRole==='research-worker'?'web_search':'run_shell',ok:true}],usage:{prompt_tokens:10,completion_tokens:5},toolCostUsd:0.01,acceptance:{ok:true}}};
  }
});
assert.equal(seenContracts.length,2);
assert.equal(result.evidence.phases.length,2,'handoff must preserve both specialist phases');
assert.equal(result.evidence.toolCalls.length,2,'handoff must aggregate tool evidence from all phases');
assert.equal(result.evidence.usage.prompt_tokens,20);
assert.equal(result.evidence.toolCostUsd,0.02);
assert.ok(result.evidence.evidencePack,'canonical final evidence pack must be created after all phases');

const policyOp={source:'retained-fixture',externalId:'policy-rescue-1',title:'Research report',description:'Research and deliver a report',budgetUsd:50,currency:'USD',claimMode:'bid'};
registry.observe(policyOp);
registry.markPermanent(policyOp,{owner:'policy',reasonCode:'discovery_policy_rejection',reason:'status_not_open:error'});
assert.equal(registry.summary().graveyard,2);
const rescued=registry.rescueOverbroadPolicyTombstones();
assert.equal(rescued.rescued,1,'non-final policy tombstones must be rescued for re-evaluation');
assert.equal(registry.get(policyOp).status,'policy_hold');
assert.equal(registry.summary().policyHold,1);
assert.equal(registry.summary().graveyard,1);

const current=normalizeConfig({enabled:true,minJobPayoutUsd:0.5,clawlancerMinJobPayoutUsd:0.5,dealworkMinJobPayoutUsd:0.5,minMarginPercent:20,maxApiCostPercentOfPayout:60,maxChildren:50,maxConcurrentJobs:6,maxJobsPerCycle:10,maxPaidProcurementUsd:10});
assert.equal(current.platformGeneration,9,'current clean policy generation is fixed');
assert.equal(current.earningProfileVersion,18,'current clean earning profile is fixed');
assert.equal(current.minJobPayoutUsd,5);
assert.equal(current.clawlancerMinJobPayoutUsd,undefined);
assert.equal(current.dealworkMinJobPayoutUsd,undefined);
assert.equal(current.minMarginPercent,20);
assert.equal(current.maxApiCostPercentOfPayout,60);
assert.equal(current.autoCompetitiveSubmissions,false,'competitive auto-submit remains opt-in');
assert.equal(current.commissioningMode,true);
assert.equal(current.commissioningMinPayoutUsd,5);
assert.equal(current.cryptoOnlyEarnings,true);
assert.equal(current.maxChildren,50);
assert.equal(current.maxConcurrentJobs,6);
assert.equal(current.maxJobsPerCycle,10);
assert.equal(current.maxPaidProcurementUsd,10);

const buyerUnfunded=classifyFailure('http_422:INSUFFICIENT_BALANCE:Job poster wallet insufficient funds, available 0.00',{phase:'claim'});
assert.equal(buyerUnfunded.reasonCode,'buyer_funding_unavailable');
assert.equal(buyerUnfunded.permanent,false,'buyer funding can change, so it must not create a permanent tombstone');
const invalidDealwork=classifyFailure('http_400:BAD_REQUEST:budgetMax (50.0000) is less than fixedPrice x maxConcurrent (75.00). Job is under-funded',{phase:'claim'});
assert.equal(invalidDealwork.reasonCode,'market_job_configuration_invalid');
assert.equal(invalidDealwork.permanent,false);

const claimNoise=Array.from({length:100},(_,i)=>({id:`claim-${i}`,source:'retained-fixture',status:'claim_failed',error:'INSUFFICIENT_BALANCE'}));
const outcome=estimateOutcomeProbability({source:'retained-fixture',claimMode:'bid',escrowed:false},{executable:true,missingTools:[]},claimNoise);
assert.equal(outcome.history.samples,0,'buyer-side claim failures must not poison worker completion/acceptance history');

const procurement=classifyOpportunity({title:'Job loop — post, hire, settle a peer',description:'Hire another service and pay the provider'},{llmEnabled:true,hasWebSearchTool:true,hasAppTool:true,hasShellTool:true,hasArtifactTool:true});
assert.equal(procurement.executable,false,'earning jobs that require us to spend money hiring another provider must fail preflight until price-aware procurement is implemented');
assert.ok(procurement.missingTools.includes('external_procurement'));

const solanaDapp=classifyOpportunity({title:'Build a Solana dApp',description:'Create a working dApp on Solana and submit the deployed application'},{llmEnabled:true,hasShellTool:true,hasArtifactTool:true,hasDeployTool:true,hasWebSearchTool:true});
assert.equal(solanaDapp.executable,false,'Solana dApp work requiring on-chain deployment must not be accepted without signing capability');
assert.ok(solanaDapp.missingTools.includes('signed_onchain_transaction'));

const genericDigital=classifyOpportunity({title:'Evaluate supplied materials',description:'Produce prioritized conclusions and a concise decision memo from the supplied materials.'},{llmEnabled:true,hasWebSearchTool:true});
assert.equal(genericDigital.executable,true,'safe digital work must not be rejected merely because its title misses a hand-written keyword rule');
assert.equal(genericDigital.mode,'llm_general_digital');
const physical=classifyOpportunity({title:'Mystery shop a store',description:'Visit the physical location and take a photo of the sign.'},{llmEnabled:true,hasWebSearchTool:true});
assert.equal(physical.executable,false,'physical-world tasks must be rejected by preflight');
assert.ok(physical.missingTools.includes('physical_world_action'));
const identityJob=classifyOpportunity({title:'Post from your Reddit account',description:'Use your Reddit account with 500+ karma to publish the post.'},{llmEnabled:true,hasAppTool:true});
assert.equal(identityJob.executable,false,'jobs requiring operator identity/reputation must not be auto-accepted');
assert.ok(identityJob.missingTools.includes('human_identity_or_reputation'));

const dispatchOp={source:'workprotocol',externalId:'dispatch-1',title:'Tiny crypto job',description:'Summarize this public text',budgetUsd:1,currency:'USDC',claimMode:'automatic'};
registry.observe(dispatchOp);
registry.markDispatchPending(dispatchOp,{provider:'trigger',runId:'run-1',leaseId:'lease-new',retryAfter:new Date(Date.now()+60000).toISOString()});
assert.equal(registry.blockReason(dispatchOp)?.status,'dispatch_pending','a durable-dispatched job must not be redispatched while its callback is pending');
assert.equal(registry.releaseDispatchPending(dispatchOp,{leaseId:'lease-old'}).stale,true,'an old delayed callback must not release a newer durable reservation');
assert.equal(registry.blockReason(dispatchOp)?.status,'dispatch_pending','stale callback must leave the current reservation intact');
assert.equal(registry.releaseDispatchPending(dispatchOp,{leaseId:'lease-new'}).released,true);
assert.equal(registry.blockReason(dispatchOp),null,'matching durable worker callback must release only the dispatch reservation before fresh preclaim checks');

// Marketplace lifecycle truth: discovery-only connectors must never enter autonomous claim.
{
  const runtimeSource=fs.readFileSync(path.join(process.cwd(),'src/autonomos/runtime.js'),'utf8');
  assert.doesNotMatch(runtimeSource,/oldsourcea:\{discover:/i,'retired OldSourceA lifecycle must be absent');
  assert.doesNotMatch(runtimeSource,/oldsourceb:\{discover:/i,'retired OldSourceB lifecycle must be absent');
  assert.match(runtimeSource,/marketplace_lifecycle_not_auto_ready/,'incomplete marketplace lifecycle must be a visible candidacy blocker');
  assert.match(runtimeSource,/function buildEarningReadiness\(/,'runtime must produce one owner-facing earning readiness diagnosis per cycle');
  assert.match(runtimeSource,/cashout_action_required/,'earning readiness must distinguish settled marketplace money from owner-wallet cashout');
  assert.match(runtimeSource,/waiting_for_eligible_job/,'earning readiness must explicitly represent no eligible job instead of generic Ready/0');
  assert.match(runtimeSource,/workAutonomousReady:claimReadySources\.length>0/,'live self-test must distinguish autonomous work readiness from complete owner-wallet cashout readiness');
  assert.match(runtimeSource,/autonomousReady:fullAutoSources\.length>0/,'live self-test autonomousReady must mean the full work-to-owner-wallet lifecycle, not merely claimable work');
  const adminSource=fs.readFileSync(path.join(process.cwd(),'public/admin.js'),'utf8');
  assert.match(adminSource,/Why AutonomOS is \/ is not earning now/,'Mission Control must display the primary earning diagnosis');
  assert.match(adminSource,/FULL AUTO.*AUTO WORK · CASHOUT ACTION.*DISCOVERY ONLY/s,'connector UI must show lifecycle truth instead of a generic Ready badge');
}

const passportBuy=classifyOpportunity({title:'Buy MANIFEST via Passport Connect',description:'Use Passport Connect to buy MANIFEST and return proof.'},{llmEnabled:true,hasWebSearchTool:true});
assert.equal(passportBuy.executable,false,'paid jobs that require buying/swapping through Passport must be rejected before claim');
assert.ok(passportBuy.missingTools.includes('external_procurement'));
const xPost=classifyOpportunity({title:'Hunter UA post — X → $0.50',description:'Publish the required post.'},{llmEnabled:true,hasAppTool:true,connectedApps:[]});
assert.equal(xPost.executable,false,'X posting must require an actually connected X app, not only a generic Composio key');
assert.ok(xPost.missingTools.includes('connected_app:x'));
const inviteAgent=classifyOpportunity({title:'Invite new agent — first settlement → $0.50',description:'Invite a new agent and provide its identity.'},{llmEnabled:true});
assert.equal(inviteAgent.executable,false,'external-agent referral/identity tasks must not be blindly claimed');

console.log('AUTONOMOS 7.7 REGRESSION: PASS');