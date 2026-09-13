// A size cap that is applied AFTER the body is already in memory is not a cap.
//
// Every one of these call sites fetches a third-party URL discovered from a search result,
// checks content-length, and then does `(await response.text()).slice(0, MAX)`. A response
// sent with chunked transfer-encoding carries no content-length, so the check passes, and
// .text() buffers the entire body before a single byte is discarded. The service runs on a
// 512MB instance with about fifteen background workers on one thread: one oversized page --
// hostile or merely a large export -- is an out-of-memory kill, and the whole agent fleet
// goes down with it.
//
// Read through the stream instead and stop pulling once the budget is spent, so memory is
// bounded by the cap rather than by whatever the far end decides to send.
export async function readBodyCapped(response, maxBytes) {
  const limit = Math.max(1, Number(maxBytes) || 0);
  // Some transports and test doubles hand back a response with no readable stream. Falling
  // back to .text() keeps those working; it is the streaming case that needed bounding.
  if (!response?.body?.getReader) {
    const text = String(await response.text());
    return { text: text.slice(0, limit), truncated: text.length > limit };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0, truncated = false;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      total += value.byteLength;
    }
    // Stopping early is the whole point, but the caller still deserves to know the page was
    // longer than what it is about to parse.
    if (total >= limit) truncated = true;
  } finally {
    // Release the connection rather than leaving the far end streaming into a dropped reader.
    try { await reader.cancel(); } catch {}
  }
  return { text: Buffer.concat(chunks).subarray(0, limit).toString('utf8'), truncated };
}
