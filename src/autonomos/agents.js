// Control-plane roles only. Execution workers are NOT permanent agents; they are
// created per accepted job by TaskAgentRuntime and retired when that job ends.
export const CORE_AGENTS = Object.freeze([
  { id:'prime-governor', name:'Orchestrator', swarm:'control', purpose:'Owns the company loop, prioritizes work and coordinates the deterministic workflow.', kpi:'net_profit_usd' },
  { id:'policy-agent', name:'Policy & Guardrails', swarm:'control', purpose:'Enforces permissions, marketplace rules, spend limits and safety gates before action.', kpi:'policy_violations' },
  { id:'opportunity-radar', name:'Opportunity Radar', swarm:'market', purpose:'Scans configured earning rails and normalizes live paid opportunities.', kpi:'qualified_opportunities' },
  { id:'economics-agent', name:'Economics Gate', swarm:'finance', purpose:'Rejects work whose expected payout, success probability or tool cost is unattractive.', kpi:'expected_margin' },
  { id:'job-router', name:'Job Router', swarm:'execution', purpose:'Claims eligible work and hands accepted jobs to an ephemeral specialist team.', kpi:'fulfillment_latency_ms' },
  { id:'qa-evaluator', name:'QA Gate', swarm:'execution', purpose:'Validates evidence and deliverables before marketplace submission.', kpi:'acceptance_rate' },
  { id:'treasury-cfo', name:'Treasury & Ledger', swarm:'finance', purpose:'Tracks settled revenue, real costs, reserves and earned spend budget.', kpi:'treasury_growth' },
  { id:'security-sentinel', name:'Security Sentinel', swarm:'control', purpose:'Blocks SSRF, unsafe actions, secret exposure and suspicious tool input.', kpi:'security_incidents' },
  { id:'evolution-agent', name:'Learning Loop', swarm:'evolution', purpose:'Stores outcomes and promotes only bounded changes supported by measured results.', kpi:'profit_uplift' }
]);

export function buildAgentState(previous = {}) {
  const now = new Date().toISOString();
  return CORE_AGENTS.map(agent => {
    const old = previous[agent.id] || {};
    return {...agent,status:old.status||'idle',tasksCompleted:Number(old.tasksCompleted||0),revenueUsd:Number(old.revenueUsd||0),costUsd:Number(old.costUsd||0),errors:Number(old.errors||0),lastActiveAt:old.lastActiveAt||'',createdAt:old.createdAt||now};
  });
}
export function agentMap(agents) {return Object.fromEntries((agents || []).map(agent => [agent.id, agent]));}
