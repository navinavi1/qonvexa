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
const op={source:'dealwork',externalId:'stable-1',title:'Build and research an API',description:'Research current sources, implement the API, run tests, and deliver a repository.',budgetUsd:150,currency:'USD',claimMode:'open'};
registry.observe(op);
registry.markPermanent(op,{owner:'market',reasonCode:'already_claimed',reason:'taken elsewhere'});
registry.observe({...op,title:'Updated title',budgetUsd:250,deadline:new Date(Date.now()+86400000).toISOString()});
assert.equal(registry.get(op).status,'graveyard','same marketplace+externalId must remain permanently blocked after metadata changes');
assert.equal(registry.summary().graveyard,1);

const hold={...op,externalId:'hold-1'};
registry.observe(hold);
registry.markSystemBlocked(hold,{reasonCode:'execution_or_capability_failure',capabilityVersion:'cap-v1'});
assert.equal(registry.releaseSystemBlocked(hold,{capabilityVersion:'cap-v1'}).released,false,'same capability version must not release a held job');
assert.equal(registry.releaseSystemBlocked(hold,{capabilityVersion:'cap-v2'}).released,true,'new capability version may release a held job');

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

const policyOp={source:'dealwork',externalId:'policy-rescue-1',title:'Research report',description:'Research and deliver a report',budgetUsd:50,currency:'USD',claimMode:'bid'};
registry.observe(policyOp);
registry.markPermanent(policyOp,{owner:'policy',reasonCode:'discovery_policy_rejection',reason:'status_not_open:error'});
assert.equal(registry.summary().graveyard,2);
const rescued=registry.rescueOverbroadPolicyTombstones();
assert.equal(rescued.rescued,1,'non-final policy tombstones must be rescued for re-evaluation');
assert.equal(registry.get(policyOp).status,'policy_hold');
assert.equal(registry.summary().policyHold,1);
assert.equal(registry.summary().graveyard,1);

const migrated=normalizeConfig({platformGeneration:5,minJobPayoutUsd:25,clawlancerMinJobPayoutUsd:25,dealworkMinJobPayoutUsd:25,superteamMinJobPayoutUsd:25,t2000MinOpenJobPayoutUsd:35,minMarginPercent:35,maxApiCostPercentOfPayout:25});
assert.equal(migrated.platformGeneration,7,'v5 policy config must migrate to current generation');
assert.equal(migrated.minJobPayoutUsd,10,'v5 $25 global floor must relax to the $10 production floor');
assert.equal(migrated.clawlancerMinJobPayoutUsd,10);
assert.equal(migrated.dealworkMinJobPayoutUsd,10);
assert.equal(migrated.t2000MinOpenJobPayoutUsd,10);
assert.equal(migrated.minMarginPercent,20);
assert.equal(migrated.maxApiCostPercentOfPayout,35);
assert.equal(migrated.autoCompetitiveSubmissions,false,'competitive auto-submit must default off');
assert.equal(migrated.commissioningMode,true,'commissioning lane should default on for controlled crypto canaries');
assert.equal(migrated.commissioningMinPayoutUsd,0.5);
assert.equal(migrated.cryptoOnlyEarnings,true,'automatic work should default to crypto-native earnings in the current deployment');
assert.equal(migrated.maxChildren,20,'dynamic specialist pool should allow up to twenty workers');

const buyerUnfunded=classifyFailure('http_422:INSUFFICIENT_BALANCE:Job poster wallet insufficient funds, available 0.00',{phase:'claim'});
assert.equal(buyerUnfunded.reasonCode,'buyer_funding_unavailable');
assert.equal(buyerUnfunded.permanent,false,'buyer funding can change, so it must not create a permanent tombstone');
const invalidDealwork=classifyFailure('http_400:BAD_REQUEST:budgetMax (50.0000) is less than fixedPrice x maxConcurrent (75.00). Job is under-funded',{phase:'claim'});
assert.equal(invalidDealwork.reasonCode,'market_job_configuration_invalid');
assert.equal(invalidDealwork.permanent,false);

const claimNoise=Array.from({length:100},(_,i)=>({id:`claim-${i}`,source:'dealwork',status:'claim_failed',error:'INSUFFICIENT_BALANCE'}));
const outcome=estimateOutcomeProbability({source:'dealwork',claimMode:'bid',escrowed:false},{executable:true,missingTools:[]},claimNoise);
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

const dispatchOp={source:'t2000',externalId:'dispatch-1',title:'Tiny crypto job',description:'Summarize this public text',budgetUsd:1,currency:'USDC',claimMode:'automatic'};
registry.observe(dispatchOp);
registry.markDispatchPending(dispatchOp,{provider:'trigger',runId:'run-1',leaseId:'lease-new',retryAfter:new Date(Date.now()+60000).toISOString()});
assert.equal(registry.blockReason(dispatchOp)?.status,'dispatch_pending','a durable-dispatched job must not be redispatched while its callback is pending');
assert.equal(registry.releaseDispatchPending(dispatchOp,{leaseId:'lease-old'}).stale,true,'an old delayed callback must not release a newer durable reservation');
assert.equal(registry.blockReason(dispatchOp)?.status,'dispatch_pending','stale callback must leave the current reservation intact');
assert.equal(registry.releaseDispatchPending(dispatchOp,{leaseId:'lease-new'}).released,true);
assert.equal(registry.blockReason(dispatchOp),null,'matching durable worker callback must release only the dispatch reservation before fresh preclaim checks');

const originalFetch=global.fetch;
try{
  const calls=[];
  global.fetch=async (url,opts={})=>{
    calls.push({url:String(url),method:String(opts.method||'GET')});
    if(String(url).includes('/api/jobs?'))return new Response(JSON.stringify({jobs:[{id:'wp-job-1',title:'Summarize release notes',description:'Create a concise summary and deliver it as a URL',category:'content',paymentAmount:'2.50',paymentCurrency:'USDC',paymentRail:'base',status:'open'}]}),{status:200,headers:{'content-type':'application/json'}});
    if(String(url).endsWith('/api/jobs/wp-job-1/claim'))return new Response(JSON.stringify({claim:{id:'claim-wp-1',status:'claimed'}}),{status:200,headers:{'content-type':'application/json'}});
    if(String(url).endsWith('/api/jobs/wp-job-1/deliver'))return new Response(JSON.stringify({claim:{id:'claim-wp-1',status:'delivered'}}),{status:200,headers:{'content-type':'application/json'}});
    if(String(url).endsWith('/api/jobs/wp-job-1'))return new Response(JSON.stringify({job:{id:'wp-job-1',status:'completed',paymentAmount:'2.50',paymentCurrency:'USDC',paymentRail:'base'},claims:[{id:'claim-wp-1',agentId:'agent-wp'}],payments:[{id:'pay-wp-1',claimId:'claim-wp-1',status:'released',amount:'2.50',currency:'USDC',txHash:'0xabc'}]}),{status:200,headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify({data:[]}),{status:200,headers:{'content-type':'application/json'}});
  };
  const wpEnv={WORKPROTOCOL_API_KEY:'wp_test',WORKPROTOCOL_AGENT_ID:'agent-wp',WORKPROTOCOL_API_URL:'https://workprotocol.test'};
  const discovered=await discoverMarketOpportunities({env:wpEnv,credentials:{},limit:10,sources:['workprotocol']});
  assert.equal(discovered.signals.length,1,'WorkProtocol discovery must normalize open escrow work');
  assert.equal(discovered.signals[0].escrowed,true);
  const wpClaim=await claimMarketplaceJob(discovered.signals[0],{env:wpEnv,credentials:{}});
  assert.equal(wpClaim.ok,true);
  const wpDeliver=await deliverMarketplaceJob(discovered.signals[0],wpClaim,{content:'done',format:'text/markdown',evidence:{artifactUrl:'https://artifacts.test/job.md'}},{env:wpEnv,credentials:{}});
  assert.equal(wpDeliver.ok,true);
  const wpSync=await syncMarketplaceTransactions({env:wpEnv,credentials:{},knownJobs:[{source:'workprotocol',externalId:'wp-job-1',status:'delivered'}]});
  assert.equal(wpSync.transactions.find(x=>x.source==='workprotocol')?.amountUsd,2.5,'released WorkProtocol USDC must reconcile into the settlement feed');
} finally { global.fetch=originalFetch; }


// Marketplace lifecycle truth: discovery-only connectors must never enter autonomous claim.
{
  const runtimeSource=fs.readFileSync(path.join(process.cwd(),'src/autonomos/runtime.js'),'utf8');
  assert.match(runtimeSource,/return \['clawlancer','t2000','dealwork','workprotocol','superteam'\]\.includes\(source\)/,'auto-claim allowlist must exclude ClawJobs and MoltJobs until their full lifecycle exists');
  assert.match(runtimeSource,/clawjobs:\{discover:true,claim:false/,'ClawJobs must be explicitly discovery-only in lifecycle truth');
  assert.match(runtimeSource,/moltjobs:\{discover:true,claim:false/,'MoltJobs must be explicitly discovery-only until certified bid lifecycle is implemented');
  assert.match(runtimeSource,/marketplace_lifecycle_not_auto_ready/,'incomplete marketplace lifecycle must be a visible candidacy blocker');
  assert.match(runtimeSource,/config\.cryptoOnlyEarnings\?\['clawlancer','t2000','workprotocol'\]:\['clawlancer','t2000','dealwork','workprotocol'\]/,'fast lane must exclude Dealwork in crypto-only mode and include WorkProtocol');
  assert.match(runtimeSource,/source==='clawlancer'\)return\['direct_crypto'\]/,'Clawlancer payout must be represented as direct crypto, not a generic marketplace balance');
  assert.match(runtimeSource,/function buildEarningReadiness\(/,'runtime must produce one owner-facing earning readiness diagnosis per cycle');
  assert.match(runtimeSource,/cashout_action_required/,'earning readiness must distinguish settled marketplace money from owner-wallet cashout');
  assert.match(runtimeSource,/waiting_for_eligible_job/,'earning readiness must explicitly represent no eligible job instead of generic Ready/0');
  assert.match(runtimeSource,/workAutonomousReady:claimReadySources\.length>0/,'live self-test must distinguish autonomous work readiness from complete owner-wallet cashout readiness');
  assert.match(runtimeSource,/autonomousReady:fullAutoSources\.length>0/,'live self-test autonomousReady must mean the full work-to-owner-wallet lifecycle, not merely claimable work');
  const adminSource=fs.readFileSync(path.join(process.cwd(),'public/admin.js'),'utf8');
  assert.match(adminSource,/Why AutonomOS is \/ is not earning now/,'Mission Control must display the primary earning diagnosis');
  assert.match(adminSource,/FULL AUTO.*AUTO WORK · CASHOUT ACTION.*DISCOVERY ONLY/s,'connector UI must show lifecycle truth instead of a generic Ready badge');
}

console.log('AUTONOMOS 7.6 REGRESSION: PASS');
