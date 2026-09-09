import { classifyOpportunity } from './capabilities.js';
import { executeExternalOpportunity } from './job-executor.js';
import { evaluateDeliverable } from './qa-engine.js';
import { createJobBudget } from './job-budget.js';
import { computeEarnedSpendBudgetUsd } from './profit-engine.js';
// An issue comment is an application, never acceptance. Only the issue's actual
// assignee may start this path; payout remains pending until a payment rail verifies it.
export class GithubJobMonitor {
 constructor(actioner){this.actioner=actioner;this.env=actioner.env;this.running=false;this.timer=null;}
 start(){this.timer=setInterval(()=>this.tick().catch(e=>this.actioner.event('github_monitor_error',{error:String(e.message).slice(0,200)})),60000);this.timer.unref?.();}
 stop(){clearInterval(this.timer);}
 async tick(){
  const a=this.actioner,c=a.currentConfig();if(this.running||!c.enabled||c.killSwitch||!this.env.GITHUB_TOKEN)return;
  this.running=true;
  try{for(const [id,row]of Object.entries(a.state.actions).filter(([,r])=>r.route==='github_issue_comment'&&['applied','accepted_github','executing_github','github_qa_failed'].includes(r.status)&&(!r.nextCheckAt||Date.parse(r.nextCheckAt)<=Date.now())).slice(0,10)){
   if(row.status==='executing_github'){a.setAction(id,{status:'github_execution_uncertain',reason:'restart_requires_existing_pr_reconciliation'});continue;}
   const u=new URL(row.applicationUrl||row.url),match=u.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/);if(u.hostname!=='github.com'||!match)continue;
   const headers={accept:'application/vnd.github+json',authorization:'Bearer '+this.env.GITHUB_TOKEN};
   const response=await fetch('https://api.github.com/repos/'+match[1]+'/'+match[2]+'/issues/'+match[3],{headers,signal:AbortSignal.timeout(15000)});if(!response.ok){a.setAction(id,{nextCheckAt:new Date(Date.now()+1800000).toISOString(),reason:'github_status_http_'+response.status});continue;}
   const issue=await response.json();if(issue.state!=='open'){a.setAction(id,{status:'github_closed',reason:'issue_closed_without_confirmed_payout'});continue;}
   if(!row.githubLogin||!(issue.assignees||[]).some(x=>x.login===row.githubLogin)){a.setAction(id,{nextCheckAt:new Date(Date.now()+1800000).toISOString(),reason:'awaiting_maintainer_assignment'});continue;}
   const lead=a.read(a.hunterFile,{}).leads?.[id]||row;
   const op={...a.toOpportunity(lead,issue.body),source:'github-bounties',jobId:'github_'+id,claimMode:'already_assigned',status:'active',description:`${issue.body}\nRepository: https://github.com/${match[1]}/${match[2]}\nDeliver a tested pull request fixing issue #${match[3]}.`,budgetUsd:Number(row.payout?.amountUsd||0)};
   const capability=classifyOpportunity(op,a.capabilityContext());if(!capability.executable){a.setAction(id,{status:'accepted_github',reason:'CAPABILITY_MISSING',nextCheckAt:new Date(Date.now()+900000).toISOString()});continue;}
   const available=computeEarnedSpendBudgetUsd(a.store.readNdjson('ledger.ndjson',-1),c);
   const limit=Math.min(available,op.budgetUsd*.35,Number(c.maxPaidProcurementUsd||3));if(!(limit>0)){a.setAction(id,{status:'accepted_github',reason:'execution_budget_unavailable',nextCheckAt:new Date(Date.now()+900000).toISOString()});continue;}
   a.setAction(id,{status:'executing_github',acceptedAt:row.acceptedAt||new Date().toISOString(),acceptedEvidenceUrl:issue.html_url,nextCheckAt:new Date(Date.now()+1800000).toISOString()});
   const budget=createJobBudget(limit,{env:this.env,onCost:n=>a.recordCost(id,n)}),llm=budget.llm(a.llm);
   try{const d=await executeExternalOpportunity(op,capability,{env:this.env,llm,config:{...c,availableSpendUsd:limit},budget,briefing:String(row.qaRepair||'')});const qa=await evaluateDeliverable(op,d,{env:this.env,llm});
    const urls=JSON.stringify(d.evidence||{}).match(/https:\/\/github\.com\/[^/"\s]+\/[^/"\s]+\/pull\/\d+/g)||[];
    const pr=urls.find(url=>url.startsWith(`https://github.com/${match[1]}/${match[2]}/pull/`));
    if(qa.ok&&pr){a.setAction(id,{status:'submitted',submittedAt:new Date().toISOString(),deliveryUrl:pr,qaScore:qa.score,payoutStatus:'PAYOUT_PENDING'});a.event('github_work_delivered',{id,deliveryUrl:pr});}
    else a.setAction(id,{status:'github_qa_failed',qaRepair:'Repair: '+(qa.reasons||[]).join('; ')+(pr?'':'; verified PR URL missing'),nextCheckAt:new Date(Date.now()+1800000).toISOString()});
   }catch(e){a.setAction(id,{status:e.safeToRetry?'accepted_github':'github_execution_uncertain',reason:String(e.message).slice(0,200),nextCheckAt:new Date(Date.now()+1800000).toISOString()});}
  }}finally{this.running=false;}
 }
}
