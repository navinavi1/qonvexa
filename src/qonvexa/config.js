export function config(env = process.env) {
  const number = (key, fallback, min, max) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  return Object.freeze({
    auditEnabled: env.QONVEXA_NEW_AUDIT_ENGINE !== 'false',
    implementations: env.QONVEXA_IMPLEMENTATIONS !== 'false',
    connectors: env.QONVEXA_CRM_CONNECTORS === 'true',
    outreach: env.QONVEXA_OUTREACH === 'true',
    aiVisibility: env.QONVEXA_AI_VISIBILITY !== 'false',
    // Live execution is deliberately not implemented in this release.
    implementationDryRun: true, outreachDryRun: true,
    scannerEnabled: env.QONVEXA_PUBLIC_FETCH_ENABLED === 'true',
    priceCents: number('AUDIT_PRICE_CENTS',14900,50,10000000),
    quoteDays: number('QONVEXA_QUOTE_DAYS',14,1,90),
    warrantyDays: number('QONVEXA_WARRANTY_DAYS',14,0,90),
    retentionDays: number('QONVEXA_RETENTION_DAYS',30,1,365),
    freeCap: number('QONVEXA_FREE_COST_CAP',0.10,0,10),
    auditCap: number('QONVEXA_AUDIT_COST_CAP',5,0,100),
    smallCap: number('QONVEXA_SMALL_COST_CAP',20,0,1000),
    largeCap: number('QONVEXA_LARGE_COST_CAP',50,0,1000),
    dailyScans: number('QONVEXA_DAILY_SCANS',25,1,1000),
    dailyDrafts: number('QONVEXA_DAILY_DRAFTS',10,1,100),
    workerUsdPerSecond: number('QONVEXA_WORKER_USD_PER_SECOND',0.00005,0,1),
    freePages: 2, paidPages: 10, maxBytes: 750000, timeoutMs: 7000,
    maxRedirects: 3, maxAttempts: 3, leaseMs: 900000, cacheMs: 86400000
  });
}
