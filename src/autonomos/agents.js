export const CORE_AGENTS = Object.freeze([
  { id:'prime-governor', name:'Prime Governor', swarm:'governance', purpose:'Runs the company loop, prioritizes work and enforces the genesis objective.', kpi:'net_profit_usd' },
  { id:'policy-agent', name:'Policy Agent', swarm:'governance', purpose:'Checks policies, permissions, marketplace rules and safety constraints.', kpi:'policy_violations' },
  { id:'treasury-cfo', name:'Treasury CFO', swarm:'finance', purpose:'Tracks balances, revenue, costs, reserves and reinvestment budgets.', kpi:'treasury_growth' },
  { id:'security-sentinel', name:'Security Sentinel', swarm:'governance', purpose:'Blocks SSRF, unsafe network actions, secret exposure and suspicious inputs.', kpi:'security_incidents' },
  { id:'opportunity-radar', name:'Opportunity Radar', swarm:'market', purpose:'Scans configured machine marketplaces and public discovery feeds.', kpi:'opportunities_per_cycle' },
  { id:'demand-analyst', name:'Demand Analyst', swarm:'market', purpose:'Scores observed demand and identifies repeatable machine-service niches.', kpi:'qualified_demand_rate' },
  { id:'competition-agent', name:'Competition Agent', swarm:'market', purpose:'Compares competing services, price bands and discoverability.', kpi:'competitive_win_rate' },
  { id:'economics-agent', name:'Economics Agent', swarm:'finance', purpose:'Calculates expected margin before work or procurement is allowed.', kpi:'contribution_margin' },
  { id:'offer-architect', name:'Offer Architect', swarm:'market', purpose:'Maps safe internal capabilities into machine-purchasable products.', kpi:'revenue_per_offer' },
  { id:'pricing-agent', name:'Pricing Agent', swarm:'market', purpose:'Maintains prices within configured floors, ceilings and margin rules.', kpi:'profit_per_job' },
  { id:'distribution-agent', name:'Distribution Agent', swarm:'market', purpose:'Publishes machine-readable catalogs and connector-ready offerings.', kpi:'marketplace_reach' },
  { id:'job-router', name:'Job Router', swarm:'execution', purpose:'Routes accepted work to the best available worker or child agent.', kpi:'fulfillment_latency_ms' },
  { id:'research-worker', name:'Research Worker', swarm:'execution', purpose:'Executes bounded public-web research and structured data extraction.', kpi:'task_quality' },
  { id:'code-worker', name:'Code Worker', swarm:'execution', purpose:'Handles approved code-analysis and deterministic transformation jobs.', kpi:'tests_passed' },
  { id:'automation-worker', name:'Automation Worker', swarm:'execution', purpose:'Executes API and workflow jobs through allowlisted connectors.', kpi:'workflow_success_rate' },
  { id:'content-worker', name:'Content Worker', swarm:'execution', purpose:'Creates structured content outputs when a configured model is available.', kpi:'acceptance_rate' },
  { id:'qa-evaluator', name:'QA / Evaluator', swarm:'execution', purpose:'Validates deliverables before a payment is settled or job is completed.', kpi:'rejection_rate' },
  { id:'evolution-agent', name:'Evolution Agent', swarm:'evolution', purpose:'Runs bounded pricing/capability experiments and promotes only positive results.', kpi:'profit_uplift' },
  { id:'replication-manager', name:'Replication Manager', swarm:'evolution', purpose:'Creates temporary child workers only after demand and economics justify it.', kpi:'child_roi' }
]);

export function buildAgentState(previous = {}) {
  const now = new Date().toISOString();
  return CORE_AGENTS.map(agent => {
    const old = previous[agent.id] || {};
    return {
      ...agent,
      status: old.status || 'idle',
      tasksCompleted: Number(old.tasksCompleted || 0),
      revenueUsd: Number(old.revenueUsd || 0),
      costUsd: Number(old.costUsd || 0),
      errors: Number(old.errors || 0),
      lastActiveAt: old.lastActiveAt || '',
      createdAt: old.createdAt || now
    };
  });
}

export function agentMap(agents) {
  return Object.fromEntries((agents || []).map(agent => [agent.id, agent]));
}
