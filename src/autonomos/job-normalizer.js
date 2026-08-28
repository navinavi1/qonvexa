function num(v, fallback=0){ const n=Number(v); return Number.isFinite(n)?n:fallback; }
function text(v, max=4000){ return String(v ?? '').trim().slice(0,max); }
function idOf(source, raw){ return text(raw.id || raw.listing_id || raw.listingId || raw.job_id || raw.jobId || raw.openingId || raw.externalId || `${source}:${raw.title || raw.name || ''}`, 240); }

export function normalizeOpportunity(source, raw = {}, defaults = {}) {
  const priceAtomic = raw.price_usdc_wei ?? raw.price_wei ?? raw.amount_wei;
  const budgetUsd = num(raw.budgetUsd ?? raw.priceUsd ?? raw.rewardUsd ?? raw.reward ?? raw.budget ?? raw.price ?? (priceAtomic != null ? num(priceAtomic)/1_000_000 : 0));
  const feePercent = num(raw.feePercent ?? defaults.feePercent, 0);
  const title = text(raw.title || raw.name || raw.summary || raw.description || 'Untitled opportunity', 300);
  const description = text(raw.description || raw.brief || raw.instructions || raw.task || raw.prompt || title, 12000);
  const category = text(raw.category || raw.skill || raw.type || raw.listing_type || defaults.category || 'general', 80).toLowerCase();
  const currency = text(raw.currency || raw.asset || defaults.currency || 'USDC', 24).toUpperCase();
  const tags = Array.isArray(raw.tags) ? raw.tags.map(x=>text(x,60)).filter(Boolean).slice(0,20) : [];
  const network = text(raw.network || raw.chain || defaults.network || '', 80);
  const status = text(raw.status || raw.state || defaults.status || 'open', 60).toLowerCase();
  const externalId = idOf(source, raw);
  return {
    source,
    externalId,
    title,
    description,
    category, tags,
    budgetUsd:Math.max(0,budgetUsd),
    currency,
    network,
    feePercent:Math.max(0,feePercent),
    escrowed:Boolean(raw.escrowed ?? defaults.escrowed ?? false),
    claimMode:text(raw.claimMode || defaults.claimMode || 'manual', 40),
    deadline:text(raw.deadline || raw.due_at || raw.expires_at || '', 120),
    url:text(raw.url || raw.href || defaults.url || '', 1000),
    status,
    raw,
    observedAt:new Date().toISOString()
  };
}

export function opportunityKey(opportunity){
  return `${opportunity.source}:${opportunity.externalId}`;
}
