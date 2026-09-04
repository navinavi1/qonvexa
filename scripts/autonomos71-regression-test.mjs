import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobRegistry } from '../src/autonomos/job-registry.js';
import { buildAcceptanceContract, buildPhaseAcceptanceContract } from '../src/autonomos/acceptance-engine.js';
import { runHandoffChain } from '../src/autonomos/orchestration.js';
import { normalizeConfig } from '../src/autonomos/policy-engine.js';

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
assert.equal(migrated.platformGeneration,6,'v5 policy config must migrate to current generation');
assert.equal(migrated.minJobPayoutUsd,10,'v5 $25 global floor must relax to the $10 production floor');
assert.equal(migrated.clawlancerMinJobPayoutUsd,10);
assert.equal(migrated.dealworkMinJobPayoutUsd,10);
assert.equal(migrated.t2000MinOpenJobPayoutUsd,10);
assert.equal(migrated.minMarginPercent,20);
assert.equal(migrated.maxApiCostPercentOfPayout,35);
assert.equal(migrated.autoCompetitiveSubmissions,false,'competitive auto-submit must default off');

console.log('AUTONOMOS 7.1 REGRESSION: PASS');
