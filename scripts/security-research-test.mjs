import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as model from '../src/autonomos/security-research.js';
import { SecurityResearchWorker } from '../src/autonomos/security-research-worker.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'secresearch-test-'));
let checks=0;
const ok=(cond,label)=>{assert.ok(cond,label);checks++;};
const eq=(a,b,label)=>{assert.deepEqual(a,b,label+' (got '+JSON.stringify(a)+')');checks++;};

// 1. Nothing in this lane can send a finding to a platform.
eq(model.SUBMISSION_IS_MANUAL,true,'submission is declared manual');
const worker=new SecurityResearchWorker(null,{env:{},storageDir:root,logger:{info(){},warn(){}}});
const methods=[...Object.getOwnPropertyNames(Object.getPrototypeOf(worker)),...Object.keys(model)];
for(const name of methods){
  const sends=/^(submit|post|send|publish|report)[A-Z_]?/.test(name);
  ok(!sends,'no outbound sender named '+name);
}
ok(typeof worker.markSubmitted==='function','owner can record a submission they made by hand');
ok(!('submitFinding' in worker)&&!('submitToImmunefi' in worker),'no platform submit method exists');

// 2. Vault money and advertised ceiling stay separate and are never summed.
const ethena=model.normalizeProgram({name:'Ethena',scopeRepos:['ethena-labs/ethena'],vaultUsd:12400,maxBountyUsd:3000000});
eq(ethena.vaultUsd,12400,'vault kept as escrowed amount');
eq(ethena.maxBountyUsd,3000000,'max bounty kept separate');
eq(ethena.programId,'ethena','program id slugified');
ok(!('availableUsd' in ethena),'vault and ceiling are never merged into one number');

// 3. Expected value is the pessimistic band end, discounted by confidence.
eq(model.expectedValueUsd({severity:'critical',confidence:1},ethena),300000,'critical at full confidence is 10% of max');
eq(model.expectedValueUsd({severity:'critical',confidence:0.2},ethena),60000,'confidence scales the estimate down');
eq(model.expectedValueUsd({severity:'informational',confidence:1},ethena),0,'informational is worth nothing');
eq(model.expectedValueUsd({severity:'high',confidence:1},{maxBountyUsd:0}),0,'no ceiling means no estimate');
ok(model.expectedValueUsd({severity:'medium',confidence:1},ethena)<model.expectedValueUsd({severity:'high',confidence:1},ethena),'severity ordering holds');

// 4. Registry rejects unusable rows instead of scanning nothing.
const programs=model.programsFromRegistry({programs:[
  {name:'Ethena',scopeRepos:['a/b'],maxBountyUsd:3000000},
  {name:'No Scope',scopeRepos:[]},
  {name:'Ethena',scopeRepos:['a/b']},
  {name:'Disabled',scopeRepos:['c/d'],enabled:false}
]});
eq(programs.length,2,'scopeless row and duplicate dropped; Ethena and Disabled remain');
eq(programs.filter(p=>p.enabled).length,1,'disabled program is kept in the registry but not enabled');

// 5. File selection skips tests, mocks and vendored code.
const picked=model.reviewableFiles([
  'src/Vault.sol','test/Vault.t.sol','node_modules/x/Evil.sol','README.md',
  'contracts/Token.sol','scripts/deploy.sol','lib/forge-std/Test.sol','programs/lender.rs'
]);
eq(picked,['src/Vault.sol','contracts/Token.sol','programs/lender.rs'],'only in-scope source files chosen');
eq(model.reviewableFiles(['a.sol','b.sol','c.sol'],{limit:2}).length,2,'limit respected');
eq(model.reviewableFiles(null).length,0,'null input does not throw');

// 6. Finding identity is stable and dedupes a re-scan.
const key={programId:'ethena',repo:'a/b',file:'src/Vault.sol',line:42,vulnerabilityClass:'reentrancy'};
eq(model.findingId(key),model.findingId({...key}),'same finding hashes the same');
ok(model.findingId(key)!==model.findingId({...key,line:43}),'different line is a different finding');

// 7. End-to-end scan with an injected checkout and an injected reviewer.
const fakeRepo=path.join(root,'fake-scope');
fs.mkdirSync(path.join(fakeRepo,'src'),{recursive:true});
fs.mkdirSync(path.join(fakeRepo,'test'),{recursive:true});
fs.writeFileSync(path.join(fakeRepo,'src','Vault.sol'),'contract Vault { function withdraw() external { msg.sender.call(""); balance=0; } }');
fs.writeFileSync(path.join(fakeRepo,'test','Vault.t.sol'),'contract T {}');
let reviewedPaths=null;
const scanWorker=new SecurityResearchWorker(null,{
  env:{AUTONOMOS_SECURITY_RESEARCH_ENABLED:'true'},storageDir:root,logger:{info(){},warn(){}},
  clone:async()=>fakeRepo,
  review:async({files})=>{reviewedPaths=files.map(f=>f.path);return{findings:[
    {file:'src/Vault.sol',line:1,vulnerabilityClass:'reentrancy',severity:'critical',confidence:0.6,summary:'State written after external call',impact:'Drains the vault'},
    {file:'src/Vault.sol',line:1,vulnerabilityClass:'style',severity:'informational',confidence:0.9,summary:'naming'},
    {file:'src/Vault.sol',line:9,vulnerabilityClass:'access-control',severity:'medium',confidence:0.5,summary:'Missing owner check',impact:'Config change'}
  ]};}
});
scanWorker.store.writeJson(model.PROGRAM_FILE,{programs:[{name:'Ethena',scopeRepos:['ethena-labs/ethena'],maxBountyUsd:3000000,vaultUsd:12400}]});
await scanWorker.scan(scanWorker.programs()[0],1);
eq(reviewedPaths,['src/Vault.sol'],'test file was not sent to the reviewer');
const queue=scanWorker.store.readJson(model.FINDING_FILE,{});
eq(Object.keys(queue).length,2,'informational finding dropped, two real ones kept');
const ranked=scanWorker.review_queue();
eq(ranked[0].vulnerabilityClass,'reentrancy','highest expected value ranks first');
eq(ranked[0].expectedValueUsd,180000,'critical at 0.6 confidence on a $3M ceiling');
eq(ranked[0].status,'awaiting_human_review','findings wait for a human, never auto-send');

// 8. A re-scan does not resurrect what the owner already handled.
const criticalId=ranked[0].id;
eq(scanWorker.dismiss(criticalId,'duplicate of a known report'),true,'owner can dismiss');
await scanWorker.scan(scanWorker.programs()[0],1);
eq(scanWorker.store.readJson(model.FINDING_FILE,{})[criticalId].status,'dismissed','re-scan did not resurrect a dismissed finding');
eq(scanWorker.review_queue().length,1,'dismissed finding left the review queue');
eq(scanWorker.markSubmitted(scanWorker.review_queue()[0].id,'IMM-123'),true,'owner records their own submission');
eq(scanWorker.review_queue().length,0,'submitted finding left the review queue');
eq(scanWorker.markSubmitted('does-not-exist','x'),false,'unknown id is refused');

// 9. Summary keeps vault-style honesty: only pending work is counted.
const summary=model.queueSummary(scanWorker.store.readJson(model.FINDING_FILE,{}));
eq(summary.total,2,'both findings retained for the record');
eq(summary.awaitingReview,0,'nothing awaiting review');
eq(summary.submittedByOwner,1,'one submitted');
eq(summary.dismissed,1,'one dismissed');
eq(summary.estimatedValueUsd,0,'handled findings are not counted as pending value');

// 10. Disabled lane starts nothing and survives a tick.
let logged=false;
const offWorker=new SecurityResearchWorker(null,{env:{},storageDir:root,logger:{info(){logged=true;},warn(){}}});
offWorker.start();
ok(logged&&!offWorker.timer,'disabled lane logs and schedules nothing');
await offWorker.tick();
ok(true,'disabled tick survived');
offWorker.stop();

fs.rmSync(root,{recursive:true,force:true});
console.log('security-research-test OK ('+checks+' checks)');
