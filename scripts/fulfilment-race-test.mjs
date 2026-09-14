// Stripe fulfilment reads a file to see whether a session was already fulfilled, writes the
// order, then writes the file back. Between the check and the write there is an await on a
// session lookup -- so two deliveries of the same payment (Stripe repeats events, pairs
// checkout.session.completed with async_payment_succeeded, and retries anything that answered
// 500) both saw "not fulfilled" and both appended an order. Single-threaded does not mean
// serialized: it only means two turns never run at the same instant.
//
// This reproduces the exact shape -- read, await, write -- and shows it doubling without the
// serializer and staying correct with it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serializeByKey, pendingKeyCount } from '../src/autonomos/serialize-by-key.js';

let checks = 0;
const ok = (condition, label) => { assert.ok(condition, label); checks++; };
const eq = (actual, expected, label) => { assert.equal(actual, expected, `${label} (got ${JSON.stringify(actual)})`); checks++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fulfil-race-'));
const ordersFile = path.join(dir, 'orders.ndjson');
const fulfilledFile = path.join(dir, 'fulfilled.json');

// The handler, with the same ordering the real one has.
async function fulfil(sessionId) {
  await new Promise(r => setTimeout(r, 5));          // the session lookup: this is the yield
  let fulfilled = {};
  try { fulfilled = JSON.parse(fs.readFileSync(fulfilledFile, 'utf8')); } catch {}
  if (fulfilled[sessionId]) return 'already';
  fs.appendFileSync(ordersFile, JSON.stringify({ sessionId, amountTotal: 14900 }) + '\n');
  await new Promise(r => setTimeout(r, 5));          // the ledger write: another yield
  fulfilled[sessionId] = { at: new Date().toISOString() };
  fs.writeFileSync(fulfilledFile, JSON.stringify(fulfilled));
  return 'fulfilled';
}
const orderCount = () => fs.readFileSync(ordersFile, 'utf8').split('\n').filter(Boolean).length;
const reset = () => { fs.writeFileSync(ordersFile, ''); try { fs.rmSync(fulfilledFile); } catch {} };

// Unserialized: the defect, reproduced.
reset();
await Promise.all([fulfil('cs_test_1'), fulfil('cs_test_1'), fulfil('cs_test_1')]);
eq(orderCount(), 3, 'unserialized, three deliveries of one payment write three orders');

// Serialized: one order, and the later callers are told it was already done.
reset();
const outcomes = await Promise.all([
  serializeByKey('cs_test_1', () => fulfil('cs_test_1')),
  serializeByKey('cs_test_1', () => fulfil('cs_test_1')),
  serializeByKey('cs_test_1', () => fulfil('cs_test_1'))
]);
eq(orderCount(), 1, 'serialized, the same three deliveries write exactly one order');
eq(outcomes.filter(x => x === 'fulfilled').length, 1, 'exactly one delivery did the work');
eq(outcomes.filter(x => x === 'already').length, 2, 'and the other two saw it was already done');

// Different payments must not queue behind each other.
reset();
const started = Date.now();
await Promise.all(['a', 'b', 'c', 'd'].map(id => serializeByKey(id, () => fulfil(id))));
eq(orderCount(), 4, 'four different payments all get fulfilled');
ok(Date.now() - started < 200, 'and they run concurrently rather than queueing behind one key');

// A failing call must not wedge the queue for that key forever.
reset();
const failed = serializeByKey('cs_boom', async () => { throw new Error('ledger unavailable'); });
await assert.rejects(failed, /ledger unavailable/, 'the caller still sees the real error');
checks++;
eq(await serializeByKey('cs_boom', () => fulfil('cs_boom')), 'fulfilled', 'and the next delivery for that key still runs');

// The map must not grow without bound: a key is dropped once its queue drains.
await new Promise(r => setTimeout(r, 20));
eq(pendingKeyCount(), 0, 'finished keys are released rather than accumulating');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`fulfilment-race-test OK (${checks} checks, race reproduced and closed)`);
