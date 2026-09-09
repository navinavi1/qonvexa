import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomOSStore } from '../src/autonomos/store.js';
import { JobRegistry, classifyFailure } from '../src/autonomos/job-registry.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'autonomos-job-registry-'));
try{
  const store=new AutonomOSStore(root);
  const job={source:'retained-fixture',externalId:'job-1',title:'Paid research',description:'Research 20 companies',budgetUsd:80,currency:'USD',deadline:'2026-09-10T12:00:00Z',claimMode:'automatic'};
  const registry=new JobRegistry({store,maxRecords:1000});
  registry.observe(job);assert.equal(registry.get(job).status,'new');
  registry.setState(job,'ready',{reasonCode:'qualified_ready'});
  registry.markPermanent(job,{owner:'market',reasonCode:'market_job_no_longer_available',reason:'already claimed'});
  assert.equal(registry.blockReason(job)?.status,'graveyard');

  const restarted=new JobRegistry({store,maxRecords:1000});
  assert.equal(restarted.blockReason(job)?.status,'graveyard');
  const changed={...job,title:'Paid research — expanded scope',budgetUsd:120,deadline:'2026-09-12T12:00:00Z'};
  restarted.observe(changed);
  assert.equal(restarted.get(changed).status,'graveyard');
  assert.equal(restarted.blockReason(changed)?.status,'graveyard');

  const ours={source:'retained-fixture',externalId:'job-2',title:'Build API',description:'Build and test API',budgetUsd:100,currency:'USD',claimMode:'automatic'};
  restarted.observe(ours);
  restarted.markSystemBlocked(ours,{reasonCode:'execution_or_capability_failure',reason:'llm_empty_response',attempts:3,capabilityVersion:'abc'});
  assert.equal(restarted.blockReason(ours)?.status,'system_blocked');
  assert.equal(restarted.summary().systemBlocked,1);
  // Execution/QA failure can never be auto-released by a static capability-version bump.
  assert.equal(restarted.releaseSystemBlocked(ours,{capabilityVersion:'abc'}).released,false);
  assert.equal(restarted.releaseSystemBlocked(ours,{capabilityVersion:'different-version'}).released,false);
  assert.equal(restarted.blockReason(ours)?.status,'system_blocked');

  // Fresh pre-claim capability/auth holds are reversible after a successful live preflight.
  const stalePreflight={source:'workprotocol',externalId:'open-reconnected',title:'Research job',description:'Research current sources',budgetUsd:0.5,currency:'USDC',claimMode:'automatic_mcp'};
  restarted.observe(stalePreflight);
  restarted.markSystemBlocked(stalePreflight,{reasonCode:'preflight_or_internal_capability_hold',reason:'connector was temporarily unavailable',capabilityVersion:'same-v1'});
  const liveRelease=restarted.releaseSystemBlocked(stalePreflight,{capabilityVersion:'same-v1'});
  assert.equal(liveRelease.released,true);
  assert.equal(restarted.get(stalePreflight)?.status,'new');
  assert.equal(restarted.get(stalePreflight)?.reasonCode,'live_preflight_revalidated');

  const staleAuth={source:'workprotocol',externalId:'open-reauthed',title:'Research job 2',description:'Research current sources',budgetUsd:0.5,currency:'USDC',claimMode:'automatic_mcp'};
  restarted.observe(staleAuth);
  restarted.markSystemBlocked(staleAuth,{reasonCode:'connector_credentials_or_auth_failure',reason:'oauth expired before claim',capabilityVersion:'same-v1'});
  assert.equal(restarted.releaseSystemBlocked(staleAuth,{capabilityVersion:'same-v1'}).released,true);
  assert.equal(restarted.get(staleAuth)?.status,'new');

  // Once a marketplace side effect happened, ownership is sticky forever. Even if the
  // later failure happens to be classified as a normally-reversible auth/preflight hold,
  // the normal discovery loop must not get another chance to claim it.
  const owned={source:'workprotocol',externalId:'already-claimed',title:'Claimed task',description:'Do work',budgetUsd:0.5,currency:'USDC',claimMode:'automatic_mcp'};
  restarted.observe(owned);
  restarted.setState(owned,'claimed',{jobId:'owned-market-job'});
  assert.equal(restarted.get(owned)?.everOwned,true);
  restarted.markSystemBlocked(owned,{reasonCode:'connector_credentials_or_auth_failure',reason:'token expired after claim',capabilityVersion:'v1'});
  assert.equal(restarted.releaseSystemBlocked(owned,{capabilityVersion:'v2'}).released,false);
  assert.equal(restarted.blockReason(owned)?.status,'system_blocked');

  // Durable dispatch itself is only a lease, not an irreversible marketplace side effect.
  // Its callback must be able to release the lease and continue toward the first claim.
  const dispatched={source:'workprotocol',externalId:'dispatch-only',title:'Fresh task',description:'Do research',budgetUsd:0.5,currency:'USDC',claimMode:'automatic_mcp'};
  restarted.observe(dispatched);
  restarted.markDispatchPending(dispatched,{provider:'trigger',runId:'run-1',leaseId:'lease-1'});
  assert.equal(restarted.get(dispatched)?.everOwned,false);
  assert.equal(restarted.blockReason(dispatched)?.status,'dispatch_pending');
  assert.equal(restarted.releaseDispatchPending(dispatched,{leaseId:'lease-1'}).released,true);
  assert.equal(restarted.get(dispatched)?.everOwned,false);
  assert.equal(restarted.blockReason(dispatched),null);

  // Transient claim retry can be released. Once execution has begun, everOwned keeps the
  // retry blocked from normal discovery even though its public block label is simply retry.
  const transient={source:'retained-fixture',externalId:'job-3',title:'Research',description:'Research',budgetUsd:60,currency:'USD',claimMode:'automatic'};
  restarted.observe(transient);
  restarted.markRetry(transient,{owner:'transient',reasonCode:'network_timeout',reason:'timeout',retryAfter:'2099-01-01T00:00:00Z'});
  assert.equal(restarted.blockReason(transient)?.status,'retry_wait');
  assert.equal(restarted.releaseTransientRetries().released,1);
  assert.equal(restarted.get(transient).status,'new');
  restarted.setState(transient,'executing',{jobId:'owned-1'});
  restarted.markRetry(transient,{owner:'transient',reasonCode:'delivery_timeout',reason:'timeout',retryAfter:'2000-01-01T00:00:00Z',phase:'execution'});
  assert.equal(restarted.blockReason(transient)?.status,'retry');
  restarted.releaseTransientRetries();
  assert.equal(restarted.blockReason(transient)?.status,'retry');
  assert.equal(restarted.get(transient)?.everOwned,true);

  const migrationStore=new AutonomOSStore(path.join(root,'migration'));
  const migrationRegistry=new JobRegistry({store:migrationStore});
  const migration=migrationRegistry.migrateLegacy({
    handledKeys:['retained-fixture:done-1','retained-second:ours-1'],
    jobs:[
      {source:'retained-fixture',externalId:'done-1',title:'Done',status:'delivered',at:'2026-09-01T10:00:00Z'},
      {source:'retained-second',externalId:'ours-1',title:'Failed',status:'execution_failed',error:'llm_empty_response',at:'2026-09-01T11:00:00Z'}
    ]
  });
  assert.equal(migration.tombstoned,0);assert.equal(migration.systemBlocked,1);
  assert.equal(migrationRegistry.blockReason({source:'retained-fixture',externalId:'done-1'})?.status,'delivered');
  assert.equal(migrationRegistry.get({source:'retained-fixture',externalId:'done-1'})?.everOwned,true);
  assert.equal(migrationRegistry.blockReason({source:'retained-second',externalId:'ours-1'})?.status,'system_blocked');

  const repairStore=new AutonomOSStore(path.join(root,'repair-v76'));
  const repairRegistry=new JobRegistry({store:repairStore});
  const x402={source:'x402-bazaar',externalId:'https://buyer.example/tool',title:'Buyer API',budgetUsd:0.001,currency:'USDC'};
  repairRegistry.observe(x402);repairRegistry.markSystemBlocked(x402,{reasonCode:'unsupported_unrecognized',reason:'old pollution'});
  const unfunded={source:'retained-fixture',externalId:'unfunded-1',title:'Open job',budgetUsd:25,currency:'USD'};
  repairRegistry.observe(unfunded);repairRegistry.markPermanent(unfunded,{owner:'market',reasonCode:'old_claim_failure',reason:"http_422:INSUFFICIENT_BALANCE: Job poster's wallet has insufficient funds (available 0.00)"});
  const repaired=repairRegistry.repairV76LegacyPollution();
  assert.ok(repaired.removedSignals>=1);
  assert.equal(repairRegistry.get(x402),null);
  assert.equal(repairRegistry.get(unfunded)?.status,'graveyard');
  assert.equal(repairRegistry.get(unfunded)?.reasonCode,'old_claim_failure');
  assert.equal(repairRegistry.blockReason(unfunded)?.status,'graveyard');

  const paid={source:'workprotocol',externalId:'paid-1',title:'Settled proof',budgetUsd:0.5,currency:'USDC'};
  repairRegistry.observe(paid);repairRegistry.markPermanent(paid,{owner:'market',reasonCode:'stale_failure',reason:'legacy stale classification'});
  repairRegistry.markPaid(paid,{transactionId:'tx-paid-1',amountUsd:0.5,currency:'USDC'});
  assert.equal(repairRegistry.get(paid)?.status,'paid');
  assert.equal(repairRegistry.get(paid)?.everOwned,true);
  assert.equal(repairRegistry.blockReason(paid)?.status,'paid');
  const paidRestarted=new JobRegistry({store:repairStore});
  assert.equal(paidRestarted.get(paid)?.status,'paid','paid state must survive restart without a stale tombstone overriding it');

  assert.deepEqual(classifyFailure('http_409 already claimed',{phase:'claim'}),{owner:'market',permanent:true,reasonCode:'market_job_no_longer_available'});
  assert.equal(classifyFailure('llm_empty_response',{phase:'execution'}).owner,'our_system');
  assert.equal(classifyFailure('network timeout',{phase:'claim'}).permanent,false);
  console.log('job-registry-test: PASS');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
