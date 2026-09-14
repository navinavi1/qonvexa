// Run async work one-at-a-time per key.
//
// The pattern this exists for: read a file to see whether something was already done, do it,
// then write the file to say it was. That is safe only while nothing yields in between --
// and Stripe fulfilment awaits a session lookup before the check, so two deliveries of the
// same payment (Stripe repeats events, pairs completed with async_payment_succeeded, and
// retries anything that answered 500) both saw "not done yet" and both wrote the order.
//
// Single-threaded is not the same as serialized: it only means two turns cannot run at the
// same instant, not that one finishes before the other starts.
const chains = new Map();

export function serializeByKey(key, work) {
  const id = String(key ?? '');
  const previous = chains.get(id) || Promise.resolve();
  // Failures must not poison the queue: the next caller runs regardless of how this one ended.
  const run = previous.then(() => work(), () => work());
  // The stored link swallows rejections so an unhandled one cannot escape from the chain
  // itself; the caller still receives the real result or the real error through `run`.
  const link = run.then(() => {}, () => {});
  chains.set(id, link);
  link.then(() => { if (chains.get(id) === link) chains.delete(id); });
  return run;
}

export function pendingKeyCount() {
  return chains.size;
}
