import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeConfig } from '../src/autonomos/policy-engine.js';
import { allocateRevenue, computeEarnedSpendBudgetUsd, evaluateOpportunity } from '../src/autonomos/profit-engine.js';
import { paymentDestinations, selectPayoutRoute, planRevenueSplit } from '../src/autonomos/payment-router.js';
import { releaseStaleDispatchReservations } from '../src/autonomos/store.js';
import { TaskAgentRuntime } from '../src/autonomos/task-agent-runtime.js';

const cfg=normalizeConfig({platformGeneration:8,earningProfileVersion:15,maxChildren:20,maxConcurrentJobs:4,maxJobsPerCycle:6,maxApiCostPercentOfPayout:35,maxPaidProcurementUsd:3,enabled:true,zeroSpendMode:false,earnedFundsOnly:true});
assert.equal(cfg.survivalMode,true);
assert.equal(cfg.ownerRevenuePercent,50);
assert.equal(cfg.agentTreasuryPercent,50);
assert.equal(cfg.reservePercent,50);
assert.equal(cfg.growthPercent+cfg.experimentPercent,50);
assert.equal(cfg.maxChildren,50);
assert.equal(cfg.maxConcurrentJobs,6);
assert.equal(cfg.maxJobsPerCycle,10);
assert.equal(cfg.maxApiCostPercentOfPayout,60);
assert.equal(cfg.maxPaidProcurementUsd,10);
assert.equal(cfg.noAbandonAcceptedJobs,true);
assert.equal(cfg.emergencyFinishMode,true);
assert.equal(cfg.skillAcquisitionMode,true);

const allocation=allocateRevenue(100,cfg);
assert.equal(allocation.ownerUsd,50);
assert.equal(allocation.treasuryUsd,50);
assert.equal(allocation.reserveUsd,50);
assert.equal(allocation.growthUsd+allocation.experimentUsd,50);
assert.equal(allocation.mode,'survival_50_50');

const spendable=computeEarnedSpendBudgetUsd([{type:'revenue',amountUsd:100,status:'settled'}],{...cfg,seedSpendBudgetUsd:3});
assert.equal(spendable,53,'owner half must never enter the agent spend pool');
const afterCost=computeEarnedSpendBudgetUsd([{type:'revenue',amountUsd:100,status:'settled'},{type:'cost',amountUsd:8}],{...cfg,seedSpendBudgetUsd:3});
assert.equal(afterCost,45);

const economics=evaluateOpportunity({expectedRevenueUsd:20,successProbability:1,modelCostUsd:1},{...cfg,availableSpendUsd:20});
assert.equal(economics.allowed,true);
assert.ok(economics.completionReserveUsd>0,'accepted work must reserve finish capacity');
assert.ok(economics.outOfPocketCostUsd>economics.estimatedExecutionSpendUsd);
const insufficient=evaluateOpportunity({expectedRevenueUsd:20,successProbability:1,modelCostUsd:1},{...cfg,availableSpendUsd:0.5});
assert.equal(insufficient.allowed,false);
assert.equal(insufficient.reason,'blocked_by_earned_funds_cap');

const env={AUTONOMOS_OWNER_WALLET:'0x1111111111111111111111111111111111111111',AUTONOMOS_PHANTOM_WALLET:'11111111111111111111111111111111'};
const destinations=paymentDestinations(env);
assert.equal(destinations.crypto.wallets.evm.id,'rabby');
assert.equal(destinations.crypto.wallets.evm.configured,true);
assert.equal(destinations.crypto.wallets.solana.id,'phantom');
assert.equal(destinations.crypto.wallets.solana.configured,true);
const solanaUsdt=selectPayoutRoute({currency:'USDT',network:'solana',supportedMethods:['direct_crypto'],amountUsd:10},env);
assert.equal(solanaUsdt.ok,true);assert.equal(solanaUsdt.destinationWallet,'phantom');
const eth=selectPayoutRoute({currency:'ETH',network:'ethereum',supportedMethods:['direct_crypto'],amountUsd:10},env);
assert.equal(eth.ok,true);assert.equal(eth.destinationWallet,'rabby');
const btc=selectPayoutRoute({currency:'BTC',network:'bitcoin',supportedMethods:['direct_crypto'],amountUsd:10},env);
assert.equal(btc.ok,false,'BTC must not be routed to Rabby/Phantom without an explicit compatible BTC address');
const splitPlan=planRevenueSplit({amountUsd:40,currency:'USDC',network:'base',marketplace:'workprotocol'},cfg,env);
assert.equal(splitPlan.ownerUsd,20);assert.equal(splitPlan.treasuryUsd,20);assert.equal(splitPlan.destination.wallet,'rabby');

const registry={'t2000:lost':{identity:'t2000:lost',source:'t2000',externalId:'lost',status:'dispatch_pending',everOwned:false,lastStateAt:'2026-09-07T12:00:00.000Z',retryAfter:'2099-01-01T00:00:00Z',dispatchLeaseId:'old'}};
releaseStaleDispatchReservations(registry,{now:Date.parse('2026-09-07T12:16:00.000Z')});
assert.equal(registry['t2000:lost'].status,'new');
assert.equal(registry['t2000:lost'].reasonCode,'durable_dispatch_lease_expired');
const owned={'t2000:owned':{status:'dispatch_pending',everOwned:true,lastStateAt:'2026-09-07T12:00:00.000Z'}};
releaseStaleDispatchReservations(owned,{now:Date.parse('2026-09-07T13:00:00.000Z')});
assert.equal(owned['t2000:owned'].status,'dispatch_pending','accepted/owned work must never be reset by lease cleanup');

const events=[];const workforce=new TaskAgentRuntime({env:{AUTONOMOS_MAX_TASK_AGENTS:'50',AUTONOMOS_MAX_TASK_AGENTS_PER_JOB:'8'},onEvent:(type,d)=>events.push({type,...d})});
const team=workforce.spawnForPlan({jobId:'survival-1',opportunity:{title:'Research and build API'},plan:{steps:[{role:'research-worker',id:'r'},{role:'code-worker',id:'c'},{role:'automation-worker',id:'a'},{role:'content-worker',id:'d'}]},maxAgents:50});
assert.equal(team.length,4);assert.equal(workforce.summary().capacity,50);assert.equal(workforce.summary().perJobCapacity,8);
const helpers=workforce.spawnHelpers({jobId:'survival-1',roles:['research-worker','qa-browser-worker'],opportunity:{title:'API'},maxAgents:50});
assert.ok(helpers.some(x=>x.role==='qa-browser-worker'),'accepted jobs may add a missing helper role');

const orchestration=fs.readFileSync(path.join(process.cwd(),'src/autonomos/orchestration.js'),'utf8');
assert.match(orchestration,/AUTONOMOS_QA_REPAIR_ATTEMPTS\|\|3/,'Emergency Finish must default to three bounded QA repair passes');
const trigger=fs.readFileSync(path.join(process.cwd(),'src/autonomos/trigger-client.js'),'utf8');
assert.match(trigger,/AUTONOMOS_TRIGGER_IDEMPOTENCY_TTL\|\|'15m'/,'lost durable dispatches must self-heal on a short bounded lease');

console.log('SURVIVAL SWARM 50/50: PASS');
