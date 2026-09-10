import fs from 'node:fs';

// Full-journal reads are unavoidable for accounting: computeEarnedSpendBudgetUsd() and the
// business snapshot both have to sum every row, so the tail optimisation in
// AutonomOSStore.readNdjson does not apply to them. A single /api/admin/autonomos request
// parsed ledger.ndjson twice — once through the store and once directly in
// business-snapshot.js — and both reads are synchronous, on the same thread that serves
// HTTP and runs about fifteen background workers.
//
// These journals are append-only, so every write changes the file size. Keying the cache on
// (size, mtimeMs) therefore cannot return content that has been superseded, which matters
// because one of the callers is the spend gate.

const cache = new Map();
const MAX_ENTRIES = 16;

export function readNdjsonCached(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return []; }
  const hit = cache.get(file);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.rows;

  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, rows });
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return rows;
}

export function invalidateNdjsonCache(file) {
  if (file) cache.delete(file); else cache.clear();
}
