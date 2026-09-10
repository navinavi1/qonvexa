import crypto from 'node:crypto';
import { runAcceptedJob } from './accepted-job-engine.js';
import { openVerifiedPullRequest, updateVerifiedPullRequest } from './verified-github-pr.js';
import { createJobBudget } from './job-budget.js';
import { computeEarnedSpendBudgetUsd } from './profit-engine.js';
import { coordinateExecution } from './execution-coordinator.js';
import { githubAvailable, githubRequest, githubPages } from './github-transport.js';
import { githubApplication, parseGithubIssue, issueApi } from './github-application.js';
import { DynamicMarketRegistry } from './dynamic-market-registry.js';
const stamp=()=>new Date().toISOString();
const due=ms=>new Date(Date.now()+ms).toISOString();
const branchFor=id=>'autonomos/'+crypto.createHash('sha256').update(id).digest('hex').slice(0,24);
export class GithubJobMonitor {
  constructor(actioner){this.actioner=actioner;this.env=actioner.env;this.running=false;this.timer=null;}
  start(){if(this.timer)return;this.timer=setInterval(()=>this.tick().catch(e=>this.actioner.event('github_monitor_error',{error:String(e.message).slice(0,200)})),60000);this.timer.unref?.();}
  stop(){clearInterval(this.timer);this.timer=null;}
  async tick(){
    const a=this.actioner,c=a.currentConfig();if(this.running||!c.enabled||c.killSwitch||!githubAvailable(this.env))return;
    this.running=true;
    try{
      const rows=Object.entries(a.state.actions).filter(([,r])=>r.route==='github_issue_comment'&&(r.commentId||r.acceptedAt||r.status==='application_uncertain')&&!['paid','github_closed','github_rejected'].includes(r.status)&&(!r.nextCheckAt||Date.parse(r.nextCheckAt)<=Date.now()));
      rows.sort(([,a],[,b])=>Number(Boolean(b.acceptedAt))-Number(Boolean(a.acceptedAt))||Date.parse(a.deadline||'9999-01-01')-Date.parse(b.deadline||'9999-01-01'));
      await Promise.allSettled(rows.slice(0,10).map(([id,row])=>this.check(id,row).catch(e=>a.setAction(id,{reason:String(e.message).slice(0,200),nextCheckAt:e.retryAt||due(900000)}))));
    }finally{this.running=false;}
  }
  async check(id,row){
    const a=this.actioner,env=this.env,issue=parseGithubIssue(row.applicationUrl||row.url);if(!issue)return;
    if(!row.commentId){
      const proof=await githubApplication(issue,{lead:row,env,reconcileOnly:true});
      if(!proof.ok){a.setAction(id,{reason:proof.error,nextCheckAt:proof.retryAt||due(1800000)});return;}
      a.setAction(id,{status:'applied',commentId:String(proof.commentId),githubLogin:proof.login,appliedAt:row.appliedAt||stamp()});row=a.state.actions[id];
    }
    const issueResult=await githubRequest(issueApi(issue),{env});if(!issueResult.ok)throw Object.assign(Error('github_status_http_'+issueResult.status),{retryAt:issueResult.retryAt});
    const detail=issueResult.value,jobId='github_'+id;
    // Recover by stable job branch even if the process died after creating the PR.
    let pr=null;
    if(row.deliveryUrl){const m=row.deliveryUrl.match(/\/pull\/(\d+)$/);if(m){const r=await githubRequest(`/repos/${issue.owner}/${issue.repo}/pulls/${m[1]}`,{env});if(r.ok)pr=r.value;}}
    else if(row.githubLogin){const prs=await githubPages(`/repos/${issue.owner}/${issue.repo}/pulls?state=all&head=${encodeURIComponent(row.githubLogin+':'+branchFor(jobId))}`,{env});pr=prs.find(p=>p.head?.ref===branchFor(jobId)&&p.user?.login===row.githubLogin);}
    if(pr){
      const proof=a.store.readJson('github-proof-'+id+'.json',null);
      if(!proof?.evidence?.repositoryVerification?.ok){a.setAction(id,{status:'github_execution_uncertain',reason:'existing_pr_requires_local_test_proof',deliveryUrl:pr.html_url,nextCheckAt:due(1800000)});return;}
      if(proof.revisionKey==='initial'&&!String(pr.body||'').includes('AutonomOS verification: '+proof.evidence.repositoryVerification.patchSha256)){a.setAction(id,{status:'github_execution_uncertain',reason:'existing_pr_verification_mismatch',nextCheckAt:due(1800000)});return;}
      if(proof.revisionKey!=='initial'&&proof.revisionKey!==row.lastRevisionId){const recovered=await updateVerifiedPullRequest(proof.evidence.repositoryVerification,pr,{env});if(recovered.ok){a.setAction(id,{lastRevisionId:proof.revisionKey,status:'submitted',nextCheckAt:due(900000)});return;}}
      a.setAction(id,{deliveryUrl:pr.html_url,submittedAt:row.submittedAt||stamp(),status:pr.merged_at?'client_accepted':'submitted',clientAcceptedAt:pr.merged_at||'',payoutStatus:'PAYOUT_PENDING'});
      // Match on any identifier that can carry this bounty, not on jobId alone. Nothing in
      // the repository ever wrote a revenue row with jobId 'github_<id>' — bounty platforms
      // settle on-chain or through their own rail, so the receipt arrives via
      // inbound-receipt/recordExternalRevenue carrying the issue id or its URL instead. A
      // merged, paid PR therefore sat in PAYOUT_PENDING forever.
      const bountyRefs=new Set([jobId,String(id),String(row.url||''),String(row.externalId||'')].filter(Boolean));
      const ledger=a.store.readNdjson('ledger.ndjson',-1).find(x=>x.type==='revenue'&&!x.testnet&&['settled','paid','confirmed','released'].includes(x.status)&&Number(x.amountUsd)>0&&(x.externalTransactionId||x.txId)&&(bountyRefs.has(String(x.jobId||''))||bountyRefs.has(String(x.externalId||''))||bountyRefs.has(String(x.registryIdentity||''))));
      if(ledger){a.setAction(id,{status:'paid',payoutStatus:'SETTLED',payoutEvidenceId:ledger.externalTransactionId||ledger.txId,paidAt:stamp()});return;}
      if(pr.merged_at){a.setAction(id,{nextCheckAt:due(1800000)});return;}
      if(pr.state==='closed'){a.setAction(id,{status:'github_rejected',reason:'pr_closed_without_merge_or_verified_payment'});return;}
      const reviews=await githubPages(`/repos/${issue.owner}/${issue.repo}/pulls/${pr.number}/reviews`,{env});
      const latest=new Map();for(const review of reviews)if(review.state!=='COMMENTED')latest.set(review.user?.login,review);
      const revision=[...latest.values()].filter(x=>x.state==='CHANGES_REQUESTED'&&['OWNER','MEMBER','COLLABORATOR'].includes(x.author_association)).sort((x,y)=>Date.parse(y.submitted_at)-Date.parse(x.submitted_at))[0];
      if(!revision||String(revision.id)===String(row.lastRevisionId)){a.setAction(id,{nextCheckAt:due(900000)});return;}
      const notes=await githubPages(`/repos/${issue.owner}/${issue.repo}/pulls/${pr.number}/comments`,{env});
      row={...row,revisionId:String(revision.id),qaRepair:[revision.body,...notes.filter(x=>x.pull_request_review_id===revision.id).map(x=>`${x.path}: ${x.body}`)].join('\n').slice(0,12000)};a.setAction(id,{revisionId:row.revisionId,qaRepair:row.qaRepair,revisionRequestedAt:stamp()});
    }else if(detail.state!=='open'){a.setAction(id,{status:'github_closed',reason:'issue_closed_without_delivery'});return;}
    if(!pr&&(!row.githubLogin||!(detail.assignees||[]).some(x=>x.login===row.githubLogin))){a.setAction(id,{reason:'awaiting_maintainer_assignment',nextCheckAt:due(900000)});return;}
    const c=a.currentConfig(),available=computeEarnedSpendBudgetUsd(a.store.readNdjson('ledger.ndjson',-1),c),limit=Math.min(available,Number(row.payout?.amountUsd||0)*.35,Number(c.maxPaidProcurementUsd||3));
    if(!(limit>0)){a.setAction(id,{status:'accepted_github',acceptedAt:row.acceptedAt||stamp(),reason:'execution_budget_unavailable',nextCheckAt:due(900000)});return;}
    const revisionKey=row.revisionId||'initial',file='github-proof-'+id+'.json';
    a.setAction(id,{status:'executing_github',acceptedAt:row.acceptedAt||stamp(),acceptedEvidenceUrl:detail.html_url,nextCheckAt:due(1800000)});
    const budget=createJobBudget(limit,{env,jobId,onCost:n=>a.recordCost(jobId,n)});
    const op={source:'github-bounties',externalId:id,jobId,deadline:detail.due_on||'',budgetUsd:Number(row.payout?.amountUsd||0)};
    await coordinateExecution(op,env,async()=>{
      let deliverable=a.store.readJson(file,null);
      if(!deliverable||deliverable.revisionKey!==revisionKey){
        ({deliverable}=await runAcceptedJob({opportunity:{...op,title:detail.title,description:detail.body||'',claimMode:'already_assigned',executionKind:'repository',repoUrl:pr?pr.head.repo.html_url:`https://github.com/${issue.owner}/${issue.repo}`,ref:pr?.head?.ref},capability:{skill:'code-analysis'},env,llm:budget.llm(a.llm),budget,store:a.store,config:c,revision:revisionKey,feedback:row.qaRepair||'',onPhase:phase=>a.setAction(id,{status:phase})}));
        deliverable.revisionKey=revisionKey;a.store.writeJson(file,deliverable);
      }
      // Deterministic QA is in the proof: complete project suite and failing base regression.
      const proof=deliverable.evidence?.repositoryVerification;
      if(!proof?.ok||!proof.testsPassOnFix||!proof.regressionFailsOnBase)throw Error('repository_QA_failed');
      a.setAction(id,{status:'qa',qaScore:1,proofFile:file});
      const result=pr?await updateVerifiedPullRequest(proof,pr,{env}):await openVerifiedPullRequest(proof,{env,jobId,issueNumber:issue.number,opire:/\bopire\b|\balgora\b|\/bounty/i.test(detail.body||'')});
      if(!result.ok){a.setAction(id,{status:'github_execution_uncertain',reason:result.reason,nextCheckAt:due(900000)});return;}
      a.setAction(id,{status:'submitted',submittedAt:stamp(),deliveryUrl:result.prUrl,qaScore:1,lastRevisionId:row.revisionId||'',payoutStatus:'PAYOUT_PENDING',nextCheckAt:due(900000)});
      new DynamicMarketRegistry(a.root).observe('github-bounties',{name:'GitHub paid issues',evidence:{authentication:{verified:true,externalId:row.githubLogin,verifiedAt:stamp()},application:{verified:true,externalId:row.commentId,verifiedAt:stamp()},execution:{verified:true,externalId:proof.patchSha256,verifiedAt:stamp()},delivery:{verified:true,url:result.prUrl,verifiedAt:stamp()}}});
      a.event('github_work_delivered',{id,deliveryUrl:result.prUrl});
    });
  }
}
