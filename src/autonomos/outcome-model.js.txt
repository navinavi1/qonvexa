const PRIORS = Object.freeze({
  't2000:already_assigned': { win:1, completion:.94, acceptance:.92, payment:.99 },
  't2000:open': { win:.40, completion:.92, acceptance:.90, payment:.99 },
  clawlancer: { win:.48, completion:.90, acceptance:.88, payment:.98 },
  'dealwork:bid': { win:.22, completion:.90, acceptance:.86, payment:.96 },
  dealwork: { win:.45, completion:.90, acceptance:.86, payment:.96 },
  superteam: { win:.10, completion:.90, acceptance:.35, payment:.96 },
  default: { win:.25, completion:.82, acceptance:.75, payment:.90 }
});

/**
 * Estimate the probability that a discovered opportunity turns into paid revenue.
 * This is deliberately separate from capability.classifier confidence: keyword
 * classification confidence says how sure we are about the *kind* of work, not
 * how likely the marketplace outcome is.
 */
export function estimateOutcomeProbability(opportunity={}, capability={}, jobRows=[]) {
  const prior = priorFor(opportunity);
  const history = historicalSourceRate(String(opportunity.source||''), jobRows);
  const readiness = capability.executable ? 1 : 0.05;
  const toolingPenalty = Array.isArray(capability.missingTools) && capability.missingTools.length ? 0.25 : 1;
  const escrowBoost = opportunity.escrowed ? 1 : 0.94;

  // Blend a marketplace prior with observed local history, but avoid overreacting
  // to the first few jobs. 12 pseudo-observations keeps early estimates stable.
  const localOutcome = history.samples
    ? ((history.successes + 12 * prior.acceptance) / (history.samples + 12))
    : prior.acceptance;

  const probability = clamp(
    prior.win * prior.completion * localOutcome * prior.payment * readiness * toolingPenalty * escrowBoost,
    0.005,
    0.995
  );

  return {
    probability: round6(probability),
    components: {
      win: prior.win,
      completion: prior.completion,
      acceptance: round6(localOutcome),
      payment: prior.payment,
      readiness: round6(readiness * toolingPenalty),
      escrowFactor: escrowBoost
    },
    history
  };
}

function priorFor(op={}) {
  if (op.source === 't2000' && op.claimMode === 'already_assigned') return PRIORS['t2000:already_assigned'];
  if (op.source === 't2000') return PRIORS['t2000:open'];
  if (op.source === 'dealwork' && op.claimMode === 'bid') return PRIORS['dealwork:bid'];
  return PRIORS[op.source] || PRIORS.default;
}

function historicalSourceRate(source, rows=[]) {
  const latest = new Map();
  // NDJSON readers in this project generally return chronological rows. Last row wins.
  for (const row of rows || []) {
    if (String(row?.source||'') !== source) continue;
    const key = String(row?.id || row?.externalId || '');
    if (!key) continue;
    latest.set(key, row);
  }
  let successes=0, failures=0;
  for (const row of latest.values()) {
    const status=String(row.status||'').toLowerCase();
    if (/paid|settled|delivered|completed/.test(status)) successes++;
    else if (/failed|rejected|expired|cancelled/.test(status)) failures++;
  }
  const samples=successes+failures;
  return {samples,successes,failures,observedRate:samples?round6(successes/samples):null};
}

function clamp(v,min,max){return Math.min(max,Math.max(min,Number(v)||0));}
function round6(v){return Math.round((Number(v||0)+Number.EPSILON)*1e6)/1e6;}
