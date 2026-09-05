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
  const registry=new JobRegistry({store,maxRecords:1000});
  registry.observe(job);assert.equal(registry.get(job).status,'new');
  registry.setState(job,'ready',{reasonCode:'qualified_ready'});
  registry.markPermanent(job,{owner:'market',reasonCode:'market_job_no_longer_available',reason:'already claimed'});
  assert.equal(registry.blockReason(job)?.status,'graveyard');

  // Restart + mutable marketplace metadata must never resurrect the same external job ID.
  const restarted=new JobRegistry({store,maxRecords:1000});
  assert.equal(restarted.blockReason(job)?.status,'graveyard');
  const changed={...job,title:'Paid research — expanded scope',budgetUsd:120,deadline:'2026-09-12T12:00:00Z'};
  restarted.observe(changed);
  assert.equal(restarted.get(changed).status,'graveyard');
  assert.equal(restarted.blockReason(changed)?.status,'graveyard');

  // Our failures are held separately from permanent market/policy tombstones.
  const ours={source:'dealwork',externalId:'job-2',title:'Build API',description:'Build and test API',budgetUsd:100,currency:'USD',claimMode:'automatic'};
  restarted.observe(ours);
  restarted.markSystemBlocked(ours,{reasonCode:'execution_or_capability_failure',reason:'llm_empty_response',attempts:3,capabilityVersion:'abc'});
  assert.equal(restarted.blockReason(ours)?.status,'system_blocked');
  assert.equal(restarted.summary().systemBlocked,1);

  // Transient claim retry can be released, execution-owned retry cannot be reclaimed.
  const transient={source:'dealwork',externalId:'job-3',title:'Research',description:'Research',budgetUsd:60,currency:'USD',claimMode:'automatic'};
  restarted.observe(transient);
  restarted.markRetry(transient,{owner:'transient',reasonCode:'network_timeout',reason:'timeout',retryAfter:'2099-01-01T00:00:00Z'});
  assert.equal(restarted.blockReason(transient)?.status,'retry_wait');
  assert.equal(restarted.releaseTransientRetries().released,1);
  assert.equal(restarted.get(transient).status,'new');
  restarted.setState(transient,'executing',{jobId:'owned-1'});
  restarted.markRetry(transient,{owner:'transient',reasonCode:'delivery_timeout',reason:'timeout',retryAfter:'2000-01-01T00:00:00Z',phase:'execution'});
  assert.equal(restarted.blockReason(transient)?.status,'retry_execution_owned');
  restarted.releaseTransientRetries();
  assert.equal(restarted.blockReason(transient)?.status,'retry_execution_owned');

  // Legacy migration keeps completed/claimed jobs permanently out of discovery and
  // classifies our old execution failures into System Blocked rather than Graveyard.
  const migrationStore=new AutonomOSStore(path.join(root,'migration'));
  const migrationRegistry=new JobRegistry({store:migrationStore});
  const migration=migrationRegistry.migrateLegacy({
    handledKeys:['dealwork:done-1','superteam:ours-1'],
    jobs:[
      {source:'dealwork',externalId:'done-1',title:'Done',status:'delivered',at:'2026-09-01T10:00:00Z'},
      {source:'superteam',externalId:'ours-1',title:'Failed',status:'execution_failed',error:'llm_empty_response',at:'2026-09-01T11:00:00Z'}
    ]
  });
  assert.equal(migration.tombstoned,1);assert.equal(migration.systemBlocked,1);
  assert.equal(migrationRegistry.blockReason({source:'dealwork',externalId:'done-1'})?.status,'graveyard');
  assert.equal(migrationRegistry.blockReason({source:'superteam',externalId:'ours-1'})?.status,'system_blocked');

  // v7.6 production repair removes old x402 discovery pollution and rescues Dealwork
  // buyer-funding/configuration failures from permanent Graveyard into timed Market Hold.
  const repairStore=new AutonomOSStore(path.join(root,'repair-v76'));
  const repairRegistry=new JobRegistry({store:repairStore});
  const x402={source:'x402-bazaar',externalId:'https://buyer.example/tool',title:'Buyer API',budgetUsd:0.001,currency:'USDC'};
  repairRegistry.observe(x402);repairRegistry.markSystemBlocked(x402,{reasonCode:'unsupported_unrecognized',reason:'old pollution'});
  const unfunded={source:'dealwork',externalId:'unfunded-1',title:'Open job',budgetUsd:25,currency:'USD'};
  repairRegistry.observe(unfunded);repairRegistry.markPermanent(unfunded,{owner:'market',reasonCode:'old_claim_failure',reason:"http_422:INSUFFICIENT_BALANCE: Job poster's wallet has insufficient funds (available 0.00)"});
  const repaired=repairRegistry.repairV76LegacyPollution();
  assert.ok(repaired.removedSignals>=1);assert.equal(repaired.rescuedDealwork,1);
  assert.equal(repairRegistry.get(x402),null);
  assert.equal(repairRegistry.get(unfunded)?.status,'policy_hold');
  assert.equal(repairRegistry.get(unfunded)?.reasonCode,'buyer_funding_unavailable');
  assert.equal(repairRegistry.blockReason(unfunded)?.status,'policy_hold');

  // Authoritative settlement must override stale tombstones: once the marketplace
  // proves the job paid, the registry can never rediscover it as Graveyard.
  const paid={source:'t2000',externalId:'paid-1',title:'Settled proof',budgetUsd:0.5,currency:'USDC'};
  repairRegistry.observe(paid);repairRegistry.markPermanent(paid,{owner:'market',reasonCode:'stale_failure',reason:'legacy stale classification'});
  repairRegistry.markPaid(paid,{transactionId:'tx-paid-1',amountUsd:0.5,currency:'USDC'});
  assert.equal(repairRegistry.get(paid)?.status,'paid');
  assert.equal(repairRegistry.blockReason(paid)?.status,'paid');
  const paidRestarted=new JobRegistry({store:repairStore});
  assert.equal(paidRestarted.get(paid)?.status,'paid','paid state must survive restart without a stale tombstone overriding it');

  assert.deepEqual(classifyFailure('http_409 already claimed',{phase:'claim'}),{owner:'market',permanent:true,reasonCode:'market_job_no_longer_available'});
  assert.equal(classifyFailure('llm_empty_response',{phase:'execution'}).owner,'our_system');
  assert.equal(classifyFailure('network timeout',{phase:'claim'}).permanent,false);
  console.log('job-registry-test: PASS');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
