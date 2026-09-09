import path from 'node:path';
import { ActionJournal, classifyFailure } from './action-journal.js';
import { githubRequest, githubPages } from './github-transport.js';
export function parseGithubIssue(url) {
  try { const u = new URL(url); const m = u.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?$/); return u.hostname === 'github.com' && m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null; } catch { return null; }
}
export const issueApi = i => `/repos/${i.owner}/${i.repo}/issues/${i.number}`;
export async function githubApplication(issue, { lead, proposal = '', payout = {}, env = process.env, reconcileOnly = false }) {
  const url = `https://github.com/${issue.owner}/${issue.repo}/issues/${issue.number}`;
  const journal = new ActionJournal(path.join(env.STORAGE_DIR || 'data', 'autonomos'));
  const key = journal.key('github', url, 'apply'), prior = journal.read()[key];
  if (prior?.status === 'confirmed') return { ok: true, commentId: prior.proof.externalId, url: prior.proof.url, login: prior.proof.login, recovered: true };
  const marker = `<!-- autonomos-application:${key} -->`;
  const who = await githubRequest('/user', { env });
  if (!who.ok || !who.value?.login) return { ok: false, error: who.error || 'github_identity_unverified', failure: classifyFailure(who.status) };
  const login = who.value.login;
  if (env.AUTONOMOS_GITHUB_EXPECTED_LOGIN && login.toLowerCase() !== env.AUTONOMOS_GITHUB_EXPECTED_LOGIN.toLowerCase()) return { ok: false, error: 'github_identity_mismatch' };
  const comments = await githubPages(issueApi(issue) + '/comments', { env });
  const found = comments.find(c => c.user?.login === login && String(c.body).includes(marker));
  if (found?.id && found.html_url) {
    if (!prior) journal.begin('github', url, 'apply');
    journal.finish(key, 'confirmed', { externalId: String(found.id), url: found.html_url, login });
    return { ok: true, commentId: found.id, url: found.html_url, login, recovered: true };
  }
  // A missing comment after a timed-out write is not proof that the server rejected it.
  if (prior && prior.status !== 'definite_failure') return { ok: false, uncertain: true, error: 'application_awaiting_external_reconciliation' };
  if (reconcileOnly) return { ok: false, error: 'application_not_found' };
  const detail = await githubRequest(issueApi(issue), { env });
  if (!detail.ok) return { ok: false, error: 'github_issue_http_' + detail.status, failure: classifyFailure(detail.status) };
  const d = detail.value;
  if (d.state !== 'open' || d.locked || d.pull_request) return { ok: false, error: 'github_issue_not_available' };
  if (d.assignees?.length && !d.assignees.some(a => a.login === login)) return { ok: false, error: 'github_issue_assigned_to_other' };
  const text = `${d.title}\n${d.body}\n${(d.labels || []).map(x => x.name).join(' ')}`;
  if(/proposed reward|no reward or assignment is assumed|please confirm.{0,80}(?:reward|bounty)|would.{0,80}(?:bounty|reward).{0,50}useful/i.test(text))return {ok:false,error:'reward_is_only_a_proposal'};
  if (!/\bbounty\b|\breward\b|\bpaid task\b|opire\.dev|algora\.io|issuehunt\.io/i.test(text)) return { ok: false, error: 'github_paid_task_not_verified' };
  if(/(?:must|required to|first).{0,60}(?:fund a bounty|pay a deposit|send.{0,30}(?:USDC|USDT)|buy tokens)/i.test(text))return {ok:false,error:'upfront_funding_not_authorized'};
  const rewardBot=comments.some(c=>c.user?.type==='Bot'&&/^(?:opire|algora|issuehunt)(?:\[bot\])?$/i.test(c.user?.login||'')&&/reward|bounty|funded/i.test(c.body||''));
  if(!['OWNER','MEMBER','COLLABORATOR'].includes(d.author_association)&&!rewardBot)return {ok:false,error:'reward_authority_unverified'};
  const intent = journal.begin('github', url, 'apply');
  if (!intent.ok) return { ok: false, uncertain: true, error: 'application_intent_exists' };
  const opire = /opire\.dev|\bopire\b/i.test(text);
  if(opire&&!comments.some(c=>c.user?.type==='Bot'&&/opire/i.test(c.user?.login||''))){journal.finish(key,'definite_failure',{reason:'opire_bot_not_verified'});return {ok:false,error:'opire_bot_not_verified'};}
  const body = [opire ? '/try' : '', proposal, '', 'AutonomOS is an AI-assisted digital-services agency. This is an application, not a claim of assignment or completed work. We can provide a tested pull request after assignment.', '', marker].filter(Boolean).join('\n').slice(0,6500);
  try {
    const r = await githubRequest(issueApi(issue) + '/comments', { method: 'POST', body: { body }, env });
    if (r.ok && r.value?.id && r.value.html_url) {
      journal.finish(key, 'confirmed', { externalId: String(r.value.id), url: r.value.html_url, login });
      return { ok: true, commentId: r.value.id, url: r.value.html_url, login };
    }
    const definite = [400,401,403,404,410,422,429].includes(r.status);
    journal.finish(key, definite ? 'definite_failure' : 'uncertain', { httpStatus: r.status });
    return { ok: false, uncertain: !definite, error: 'github_application_http_' + r.status, failure: classifyFailure(r.status) };
  } catch { journal.finish(key, 'uncertain'); return { ok: false, uncertain: true, error: 'github_application_response_lost' }; }
}
