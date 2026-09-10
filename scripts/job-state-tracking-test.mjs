import assert from 'node:assert/strict';
import { canTransition, nextTrackedJobStatus, JOB_STATES } from '../src/autonomos/agency-intelligence.js';

// jobs.ndjson is append-only telemetry. appendJobStatus() deliberately never throws on an
// unrecognized transition — an earlier version did, and one anomalous row aborted the whole
// heartbeat. But "record it anyway" quietly created a second, worse problem: the anomalous
// status was still adopted as the job's tracked state, and settlement reconciliation gates
// on that tracked state:
//
//   runtime.js: canTransition(latestForJob,'delivered')   -> writes the delivered row
//   runtime.js: canTransition(nowLatest,'settled')        -> writes the settled row
//
// canTransition() refuses every target from a source it does not recognize, so one stray row
// permanently blocked both. Money that really arrived stopped being booked against the job.

// 1) The blocking scenario, spelled out, so the reason this function exists stays visible.
assert.equal(canTransition('settled', 'claiming'), false, 'the anomaly really is unrecognized');
assert.equal(canTransition('claiming', 'delivered'), false, 'adopting it blocks the delivered row');
assert.equal(canTransition('claiming', 'settled'), false, 'and blocks the settled row');
assert.equal(canTransition('delivered', 'settled'), true, 'while the last VALID state still settles');

// 2) So an unrecognized transition must leave the tracked state alone.
assert.equal(nextTrackedJobStatus('delivered', 'claiming'), 'delivered');
assert.equal(nextTrackedJobStatus('settled', 'claiming'), 'settled');

// 3) A status the machine has never heard of is not a state either, whatever it came from.
// 'paid' is written by the GitHub lane's action store, not by the job machine, and legacy
// jobs.ndjson rows carry statuses from lanes that no longer exist.
assert.ok(!JOB_STATES.includes('paid'));
assert.equal(nextTrackedJobStatus('delivered', 'paid'), 'delivered');
assert.equal(nextTrackedJobStatus('', 'discovered'), '', 'an unknown seed must not become the baseline');
assert.equal(nextTrackedJobStatus('claimed', ''), 'claimed');
assert.equal(nextTrackedJobStatus('claimed', null), 'claimed');

// 4) Real progress is still tracked — the fix must not freeze the state machine.
assert.equal(nextTrackedJobStatus('claiming', 'claimed'), 'claimed');
assert.equal(nextTrackedJobStatus('claimed', 'delivered'), 'delivered');
assert.equal(nextTrackedJobStatus('delivered', 'settled'), 'settled');
assert.equal(nextTrackedJobStatus('execution_failed', 'claiming'), 'claiming', 'retries still re-enter');
assert.equal(nextTrackedJobStatus('claimed', 'claimed'), 'claimed', 'a repeated row is not an anomaly');

// 5) With no previous state, any known status is accepted as the baseline.
for (const state of JOB_STATES) assert.equal(nextTrackedJobStatus('', state), state);

// 6) The end-to-end consequence: an anomalous row lands between delivery and payment, and
// the settlement gates must still be open afterwards.
let tracked = '';
for (const row of ['claiming', 'claimed', 'delivered', 'claiming' /* the anomaly */]) {
  tracked = nextTrackedJobStatus(tracked, row);
}
assert.equal(tracked, 'delivered', 'the anomaly is journalled, not adopted');
assert.equal(canTransition(tracked, 'settled'), true, 'payment can still be recorded');

console.log('JOB STATE TRACKING: PASS');
