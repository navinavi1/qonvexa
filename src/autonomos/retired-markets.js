// Owner-approved removals after live checks on 2026-09-09.
// This list governs new discovery/actions; it must never erase ledgers or receipts.
export const RETIRED_MARKET_SOURCES = Object.freeze(['agenthansa', 'taskbounty']);
const HOSTS = ['agenthansa.com', 'task-bounty.com'];
const sourceKey = value => String(value || '').toLowerCase().replace(/[\s_-]/g, '');

export function isRetiredMarket(value) {
  const row = typeof value === 'string' ? {source:value, url:value} : (value || {});
  if ([row.source, row.marketId, row.marketName].some(v => RETIRED_MARKET_SOURCES.includes(sourceKey(v)))) return true;
  return [row.url, row.sourceUrl, row.homepage, row.host, row.marketHost].some(value => {
    if (!value) return false;
    try {
      const raw = String(value);
      const host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase().replace(/\.$/, '');
      return HOSTS.some(retired => host === retired || host.endsWith('.' + retired));
    } catch { return false; }
  });
}
