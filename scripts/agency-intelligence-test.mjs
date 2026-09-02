import assert from 'node:assert/strict';
import {
  JOB_STATES, canTransition, transitionJob, createJobIdentity,
  scoreOpportunity, buildLearningSnapshot, recommendActions
} from '../src/autonomos/agency-intelligence.js';

assert.equal(canTransition('discovered','qualified'),true);
assert.equal(canTransition('delivered','executing'),false);
assert.throws(()=>transitionJob({state:'delivered'},'executing'),/invalid_job_transition/);
const transitioned=transitionJob({state:'qualified',id:'job-1'},'selected',{reason:'best economics'});
assert.equal(transitioned.state,'selected');
assert.equal(transitioned.previousState,'qualified');

const id1=createJobIdentity({source:'t2000',externalId:'job-42'});
const id2=createJobIdentity({source:'t2000',externalId:'job-42'});
assert.equal(id1.id,id2.id);
assert.equal(id1.idempotencyKey,'t2000:job-42');

const learning=buildLearningSnapshot([
  {source:'t2000',externalId:'a',status:'settled',budgetUsd:100,costUsd:4,skill:'research-worker',at:'2026-09-01T10:00:00Z'},
  {source:'t2000',externalId:'b',status:'failed',budgetUsd:80,costUsd:2,skill:'research-worker',at:'2026-09-01T11:00:00Z'},
  {source:'clawlancer',externalId:'c',status:'delivered',budgetUsd:50,costUsd:1,skill:'translation',at:'2026-09-01T12:00:00Z'}
],[]);
assert.equal(learning.sampleSize,3);
assert.equal(learning.sources.t2000.acceptanceRate,.5);
assert.equal(learning.skills.translation.acceptanceRate,1);

const scored=scoreOpportunity({
  source:'t2000',externalId:'x',budgetUsd:100,feePercent:2,escrowed:true,deadline:'2026-09-04T12:00:00Z',
  capability:{skill:'research-worker',executable:true,estimatedModelCostUsd:1},
  outcome:{probability:.8},economics:{expectedProfitUsd:80}
},learning,Date.parse('2026-09-02T12:00:00Z'));
assert.ok(scored.score>0 && scored.score<=100);
assert.equal(scored.factors.capability,1);

const recommendations=recommendActions(learning);
assert.ok(Array.isArray(recommendations) && recommendations.length>0);
console.log('Agency Intelligence 4.0 test PASS');
