import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomOSStore } from '../src/autonomos/store.js';
import { JobRegistry, classifyFailure } from '../src/autonomos/job-registry.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'autonomos-job-registry-'));
try{
  const store=new AutonomOSStore(root);
  const job={source:'dealwork',externalId:'job-1',title:'Paid research',description:'Research 20 companies',budgetUsd:80,currency:'USD',deadline:'2026-09-10T12:00:00Z',claimMode:'automatic'};
  const registry=new JobRegistry({store});
  registry.observe(job);
  assert.equal(registry.get(job).status,'new');
  registry.setState(job,'ready',{reasonCode:'qualified_ready'});
  registry.markPermanent(job,{owner:'market',reasonCode:'market_job_no_longer_available',reason:'already claimed'});
  assert.equal(registry.blockReason(job)?.status,'graveyard');

  // Simulate a process restart: permanent decisions survive disk/redeploy state.
  const restarted=new JobRegistry({store});
  assert.equal(restarted.blockReason(job)?.status,'graveyard');

  // Same external ID with materially changed content is a new job version, not an old retry.
  const changed={...job,title:'Paid research — expanded scope',budgetUsd:120};
  restarted.observe(changed);
  assert.equal(restarted.get(changed).status,'new');
  assert.equal(restarted.get(changed).version,2);
  assert.equal(restarted.blockReason(changed),null);

  // Transient retry can be released; permanent Graveyard cannot.
  restarted.markRetry(changed,{owner:'transient',reasonCode:'network_timeout',reason:'timeout',retryAfter:'2099-01-01T00:00:00Z'});
  assert.equal(restarted.blockReason(changed)?.status,'retry_wait');
  assert.equal(restarted.releaseTransientRetries().released,1);
  assert.equal(restarted.get(changed).status,'new');

  restarted.setState(changed,'executing',{jobId:'owned-1'});
  restarted.markRetry(changed,{owner:'transient',reasonCode:'delivery_timeout',reason:'timeout',retryAfter:'2000-01-01T00:00:00Z',phase:'execution'});
  assert.equal(restarted.blockReason(changed)?.status,'retry_execution_owned');
  restarted.releaseTransientRetries();
  assert.equal(restarted.blockReason(changed)?.status,'retry_execution_owned');

  assert.deepEqual(classifyFailure('http_409 already claimed',{phase:'claim'}),{owner:'market',permanent:true,reasonCode:'market_job_no_longer_available'});
  assert.equal(classifyFailure('llm_empty_response',{phase:'execution'}).owner,'our_system');
  assert.equal(classifyFailure('network timeout',{phase:'claim'}).permanent,false);
  console.log('job-registry-test: PASS');
} finally {
  fs.rmSync(root,{recursive:true,force:true});
}
