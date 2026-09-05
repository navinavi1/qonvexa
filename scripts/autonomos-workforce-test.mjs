import assert from 'node:assert/strict';
import { TaskAgentRuntime, collapseWorkerSteps } from '../src/autonomos/task-agent-runtime.js';
import { orchestrateJob, distinctExecutionRoles, runHandoffChain } from '../src/autonomos/orchestration.js';
import { createLlmClient } from '../src/autonomos/llm.js';
import { exceedsJobSpendCeiling } from '../src/autonomos/job-executor.js';
import { deliverMarketplaceJob } from '../src/autonomos/connectors/index.js';
import { classifyOpportunity } from '../src/autonomos/capabilities.js';
import { McpHttpClient } from '../src/autonomos/mcp-client.js';
import { estimateOutcomeProbability } from '../src/autonomos/outcome-model.js';
import { buildProofLog, evaluateDeliverable } from '../src/autonomos/qa-engine.js';
import { shouldReportSuccessToDurableDispatcher, latestStatuses, selectBudgetAwareCandidates, applyCommissioningCandidateGate, revalidateClaimedCapability, resolveSettlementJobIdentity, settlementLedgerId, settlementPayoutTruth } from '../src/autonomos/runtime.js';

// Same class of bug as the capabilities.js fix below, in the dashboard worker-role
// fallback: the alternation regex had no word boundaries, so 'rust' matched inside
// 'trust'/'robust' and 'repo' inside 'report', mislabeling ordinary research work as a
// Code Worker on the dashboard.
assert.notEqual(collapseWorkerSteps([],{title:'Ensure robust and trustworthy conclusions'})[0].role,'code-worker','"robust"/"trustworthy" must not spuriously match the "rust" keyword');
assert.equal(collapseWorkerSteps([],{title:'Generate a market report on trends'})[0].role,'research-worker','"report" must not spuriously match the "repo" keyword');
assert.equal(collapseWorkerSteps([],{title:'Fix an issue in our repo'})[0].role,'code-worker','a real standalone "repo" mention must still match');

// Naive substring matching let the keyword 'test' match inside 'latest', silently
// misclassifying research/writing tasks as code-analysis work whenever they happened to
// mention "the latest [something]". Word-boundary matching must not do this.
assert.equal(classifyOpportunity({title:'Research current AI trends',description:'Research and summarize the latest AI agent developments.'},{llmEnabled:true}).skill,'web-research','"latest" must not spuriously match the "test" keyword');
// 'translate this document' scores one word-match for both translation and
// document-generation; translation must win the tie since document-generation wrongly
// requires shell/artifact-storage tooling that a plain translation task doesn't need.
assert.equal(classifyOpportunity({title:'Translate this document to Spanish.',description:''},{llmEnabled:true}).skill,'translation','an explicit "translate" mention must win over a generic "document" tie');


const claimedImpossible=revalidateClaimedCapability({title:'Buy MANIFEST via Passport Connect',description:'Swap USDC through Passport Connect and return proof.'},{llmEnabled:true});
assert.equal(claimedImpossible.ok,false,'recovery must stop retrying already-claimed work that current capability rules prove impossible');

// A failed optional tool attempt must not deterministically poison an otherwise valid
// deliverable. The independent QA model still sees the failed evidence and decides whether
// it matters to the paid acceptance contract.
{
  const qaLlm={enabled:true,complete:async()=>({ok:true,text:JSON.stringify({score:.94,pass:true,reasons:[]})})};
  const qa=await evaluateDeliverable({title:'Research result',description:'Return a verified summary.'},{content:'Verified final summary with successful source evidence.',evidence:{toolCalls:[{tool:'browser',ok:false,error:'transient timeout'},{tool:'web_search',ok:true}] }},{llm:qaLlm,env:{}});
  assert.equal(qa.ok,true,'an optional failed tool attempt must be evaluated contextually instead of causing automatic QA failure');
}

// The MCP 2025-06-18 spec requires the MCP-Protocol-Version header on every HTTP
// request, not just initialize — without it a compliant server should silently fall
// back to 2025-03-26 behavior for that request, a real risk for the one live
// marketplace connector (t2000) built on this client.
assert.equal(new McpHttpClient({url:'https://mcp.t2000.ai/mcp'}).headers()['mcp-protocol-version'],'2025-06-18','every request must carry the negotiated protocol version header');

// Same class of bug as the learning fix in agency-intelligence.js, in a different file:
// 'delivered' alone must not count as a confirmed success when estimating win probability,
// or one real settlement plus several merely-submitted (never confirmed) Superteam jobs
// would look like a 100% success rate and inflate the estimated probability for that source.
{
  const rows=[
    {source:'superteam',id:'a',status:'settled'},
    {source:'superteam',id:'b',status:'delivered'},
    {source:'superteam',id:'c',status:'delivered'},
  ];
  const result=estimateOutcomeProbability({source:'superteam',budgetUsd:500},{executable:true,missingTools:[]},rows);
  assert.equal(result.history.samples,1,'only the confirmed settlement counts as a sample');
  assert.equal(result.history.pending,2,'unconfirmed deliveries must be tracked separately, not folded into successes');
}

// Per superteam.fun/earn/agents, telegram is REQUIRED for project-type listing
// submissions. SUPERTEAM_HUMAN_TELEGRAM was declared as a connector option but never
// actually read anywhere — configuring it had zero effect and any project-type
// submission was guaranteed to fail. Prove the env var now really reaches the payload.
{
  const originalFetch=globalThis.fetch;
  let sentPayload=null;
  globalThis.fetch=async(_url,opts)=>{sentPayload=JSON.parse(opts.body);return{ok:true,json:async()=>({id:'sub_test'})};};
  try{
    const opportunity={source:'superteam',externalId:'listing-test',title:'Test listing'};
    const deliverable={content:'work done',evidence:{toolCalls:[]}};
    const credentials={superteam:{apiKey:'sk_test'}};
    await deliverMarketplaceJob(opportunity,{ok:true},deliverable,{env:{SUPERTEAM_HUMAN_TELEGRAM:'http://t.me/operator'},credentials});
    assert.equal(sentPayload.telegram,'http://t.me/operator','the configured telegram env var must reach the actual submission payload');
    await deliverMarketplaceJob(opportunity,{ok:true},deliverable,{env:{},credentials});
    assert.equal('telegram' in sentPayload,false,'telegram must be omitted, not sent empty, when not configured');
  }finally{globalThis.fetch=originalFetch;}
}

// Each candidate's cost was only ever checked individually against the same earned-budget
// snapshot — nothing stopped several selected together in one cycle from jointly spending
// several times that budget. $2.43 budget, 6 candidates at $0.60 each: only 4 must fit
// (4×0.60=2.40 ≤ 2.43; a 5th would push it to 3.00).
{
  const rows=Array.from({length:6},(_,i)=>({source:'t2000',externalId:`job${i}`,economics:{outOfPocketCostUsd:0.60}}));
  const cfg={zeroSpendMode:false,earnedFundsOnly:true,allowExternalSpending:false,maxJobsPerCycle:6};
  assert.equal(selectBudgetAwareCandidates(rows,cfg,2.43).length,4,'must stop once cumulative cost would exceed the earned budget');
  assert.equal(selectBudgetAwareCandidates(rows,{...cfg,zeroSpendMode:true},0).length,6,'zero-spend mode already blocks all spend elsewhere — this check must not double-restrict');
  assert.equal(selectBudgetAwareCandidates(rows,{zeroSpendMode:false,earnedFundsOnly:false,allowExternalSpending:true,maxJobsPerCycle:6},0).length,6,'unrestricted spending must not be capped by the earned budget');
  const mixed=[{source:'a',externalId:'expensive',economics:{outOfPocketCostUsd:5}},{source:'b',externalId:'cheap',economics:{outOfPocketCostUsd:0.10}}];
  assert.deepEqual(selectBudgetAwareCandidates(mixed,cfg,1).map(r=>r.externalId),['cheap'],'a candidate that does not fit must be skipped, not stop the whole selection — a cheaper one further down must still be picked');
}

// The exact production pattern this fixes: a deliverable claims a tool was run, but the
// real tool log is empty. QA previously had to infer fabrication purely from the wording
// of the claim; now the mismatch between claim and proof is explicit and checkable.
assert.match(buildProofLog([]),/no tools were called/i);
assert.match(buildProofLog([{tool:'run_python',ok:true,artifacts:[{ok:true,url:'https://s3.example.com/out.txt'}]}]),/tool=run_python success=true/);
assert.match(buildProofLog([{tool:'web_search',ok:false,error:'timeout'}]),/success=false/);

// The correct "latest status per job" must not depend on which order the rows arrive in —
// oldest-first, newest-first, or shuffled must all agree on the same true latest row.
{
  const rows=[
    {id:'job-1',source:'t2000',externalId:'a',status:'claiming',startedAt:'2026-09-01T10:00:00.000Z'},
    {id:'job-1',source:'t2000',externalId:'a',status:'claimed',at:'2026-09-01T10:00:05.000Z'},
    {id:'job-1',source:'t2000',externalId:'a',status:'delivered',at:'2026-09-01T10:00:20.000Z'},
  ];
  const oldestFirst=latestStatuses(rows);
  const newestFirst=latestStatuses([...rows].reverse());
  const shuffled=latestStatuses([rows[1],rows[2],rows[0]]);
  assert.equal(oldestFirst['job-1'].status,'delivered','oldest-first input must resolve to the truly latest row');
  assert.equal(newestFirst['job-1'].status,'delivered','newest-first input must agree');
  assert.equal(shuffled['job-1'].status,'delivered','shuffled input must agree too — order must not matter');
}

// A $1 job with the default 25%-of-payout ceiling can spend at most $0.25 in tool calls
// across the whole execution loop — previously nothing enforced this during execution,
// only the flat, job-agnostic per-call limit (maxPaidProcurementUsd).
assert.equal(exceedsJobSpendCeiling(0.20,0.25),false,'under the ceiling must be allowed to continue');
assert.equal(exceedsJobSpendCeiling(0.25,0.25),false,'exactly at the ceiling must not itself trip it');
assert.equal(exceedsJobSpendCeiling(0.26,0.25),true,'over the ceiling must stop the job');
assert.equal(exceedsJobSpendCeiling(5,0),false,'a zero/unknown ceiling must not block (economics gate already rejects $0-budget jobs upstream)');

// Reproduce the production symptom: a durable dispatcher (Trigger.dev/Temporal) only
// retries when it sees ok:false. A job that failed to claim/bid anything must be
// reported as a failure so the dispatcher's own retry kicks in; a job that already
// claimed/bid/delivered must be reported as ok so the dispatcher never re-invokes the
// whole opportunity from scratch and risks a double claim/bid.
assert.equal(shouldReportSuccessToDurableDispatcher({claimed:false,delivered:false}),false,'an unclassified transport-level failure may be retried by the dispatcher');
assert.equal(shouldReportSuccessToDurableDispatcher({claimed:false,delivered:false,preclaimRejected:true}),true,'deterministic business rejection is already handled and must not trigger durable retries');
assert.equal(shouldReportSuccessToDurableDispatcher({claimed:false,delivered:false,handledByRuntime:true,retryScheduled:true}),true,'registry-owned claim retry must not compete with Trigger retries');
assert.equal(shouldReportSuccessToDurableDispatcher({claimed:false,delivered:false,bidSubmitted:true}),true,'a submitted bid must not be re-attempted');
assert.equal(shouldReportSuccessToDurableDispatcher({claimed:true,delivered:false,retryScheduled:true}),true,'an already-claimed job must recover via recoverInFlightJobs, not a fresh re-claim');
assert.equal(shouldReportSuccessToDurableDispatcher({claimed:true,delivered:true}),true,'full success');

const commissioningRows=[
  {source:'t2000',externalId:'hard',budgetUsd:10,capability:{skill:'code-analysis',estimatedModelCostUsd:0.3},economics:{outOfPocketCostUsd:0.3,expectedProfitUsd:8.7},outcome:{probability:.9}},
  {source:'clawlancer',externalId:'simple',budgetUsd:.5,capability:{skill:'translation',estimatedModelCostUsd:0.01},economics:{outOfPocketCostUsd:0.01,expectedProfitUsd:.36},outcome:{probability:.75}},
  {source:'dealwork',externalId:'usd',budgetUsd:50,capability:{skill:'translation',estimatedModelCostUsd:0.01},economics:{outOfPocketCostUsd:0.01,expectedProfitUsd:45},outcome:{probability:.95}}
];
const commissioningPicked=applyCommissioningCandidateGate(commissioningRows,{commissioningMode:true},{ledger:[],activeCount:0});
assert.equal(commissioningPicked.length,1,'before first crypto payment commissioning must run one job at a time');
assert.equal(commissioningPicked[0].externalId,'hard','commissioning must treat $0.50 as a floor, not a target, and prefer the stronger higher-value crypto candidate');
assert.equal(applyCommissioningCandidateGate(commissioningRows,{commissioningMode:true},{ledger:[],activeCount:1}).length,0,'a commissioning job already in flight must block a second claim');
assert.equal(applyCommissioningCandidateGate(commissioningRows,{commissioningMode:true},{ledger:[{type:'revenue',source:'t2000',amountUsd:.5,status:'settled'}],activeCount:0}).length,3,'after a real crypto settlement normal concurrency may resume');

const events=[];
const workforce=new TaskAgentRuntime({env:{AUTONOMOS_MAX_TASK_AGENTS_PER_JOB:'4'},onEvent:(type,detail)=>events.push({type,detail})});
const plan={steps:[
  {id:'r1',role:'research-worker',action:'research'},
  {id:'c1',role:'code-worker',action:'write module'},
  {id:'c2',role:'code-worker',action:'write tests'},
  {id:'c3',role:'code-worker',action:'build'},
  {id:'a1',role:'automation-worker',action:'deploy'},
  {id:'q',role:'qa-evaluator',action:'review'}
]};
assert.deepEqual(collapseWorkerSteps(plan.steps,{}).map(x=>x.role),['research-worker','code-worker','automation-worker']);
const first=workforce.spawnForPlan({jobId:'job-1',opportunity:{title:'Build API'},plan,maxAgents:12});
assert.equal(first.length,3,'steps must collapse to unique specialist roles');
const again=workforce.spawnForPlan({jobId:'job-1',opportunity:{title:'Build API'},plan,maxAgents:12});
assert.equal(again.length,3,'same job must reuse its workforce');
assert.equal(workforce.summary().active,3,'duplicate spawn must not create duplicate workers');
workforce.retireJob('job-1',{ok:true});
assert.equal(workforce.summary().active,0,'finished job must have zero active workers');

// An execution error must never trigger a second execution through a graph fallback and
// must always retire the task team.
let executeCalls=0;
const failingWorkforce=new TaskAgentRuntime({env:{},onEvent:()=>{}});
await assert.rejects(()=>orchestrateJob({source:'test',externalId:'one',title:'Write code',description:'Do work'}, {
  jobId:'job-fail', env:{}, taskAgents:failingWorkforce,
  llm:{enabled:false},
  execute:async()=>{executeCalls++;throw new Error('simulated_execution_failure');},
  onEvent:()=>{}
}),/simulated_execution_failure/);
assert.equal(executeCalls,1,'failed execution must never be replayed by orchestration fallback');
assert.equal(failingWorkforce.summary().active,0,'failed job must retire all task agents');

// A plan naming only one execution role must NOT trigger a handoff — the common case
// (most jobs need one specialist) must keep the exact original single-call behavior.
assert.deepEqual(distinctExecutionRoles({steps:[{role:'planner'},{role:'code-worker'},{role:'qa-evaluator'}]}),['code-worker'],'a single execution role must not be treated as a handoff');
assert.deepEqual(distinctExecutionRoles({steps:[{role:'code-worker'},{role:'research-worker'}]}),['research-worker','code-worker'],'research must always precede code in the handoff order, regardless of plan order');

// The actual handoff: a real supervisor+handoff run must call execute() once per named
// specialist, each scoped to ONLY that specialist's own tools (a research specialist
// must never see run_python; a build specialist must never see web_search), and each
// later specialist must receive the previous one's real output as briefing — proving
// this is genuine work handed forward, not just two calls with everything available.
{
  const calls=[];
  const mockExecute=async(op,execOpts={})=>{
    calls.push({toolFilter:execOpts.toolFilter,briefing:execOpts.briefing});
    if(calls.length===1)return{content:'Found that the API rate limit is 100 req/min.',evidence:{toolCalls:[{tool:'web_search',ok:true}]}};
    return{content:'Implemented client respecting the 100 req/min limit.',evidence:{toolCalls:[{tool:'run_python',ok:true}]}};
  };
  const result=await runHandoffChain(['research-worker','code-worker'],{title:'test'},{steps:[]},{execute:mockExecute,taskAgents:null,jobId:'job-handoff',onEvent:()=>{}});
  assert.equal(calls.length,2,'one execute() call per named specialist');
  assert.deepEqual(calls[0].toolFilter,['web_search','web_scrape','browser_task'],'research specialist must be scoped to research tools only');
  assert.deepEqual(calls[1].toolFilter,['run_python','run_shell','open_pull_request','store_artifact','coderabbit_review','deploy_webhook'],'build specialist must be scoped to build tools only, never web_search');
  assert.equal(calls[0].briefing,'','the first specialist has no earlier teammate to build on');
  assert.match(calls[1].briefing,/100 req\/min/,'the second specialist must receive the first specialist'+String.fromCharCode(39)+'s real output as briefing, not a generic hint');
  assert.equal(result.content,'Implemented client respecting the 100 req/min limit.','final content is the last specialist'+String.fromCharCode(39)+'s work, built on the handoff');
  assert.equal(result.evidence.toolCalls.length,2,'QA must see every phase'+String.fromCharCode(39)+'s tool calls combined, not just the last phase'+String.fromCharCode(39)+'s');
}

// A 3-way handoff (research + code + automation, named out of order in the plan) must
// still resolve to the correct fixed order and chain correctly through all three.
{
  const roles=distinctExecutionRoles({steps:[{role:'automation-worker'},{role:'code-worker'},{role:'research-worker'}]});
  assert.deepEqual(roles,['research-worker','code-worker','automation-worker'],'a 3-way plan must resolve to the fixed handoff order regardless of how the plan listed them');
  const calls=[];
  const mockExecute3=async(op,execOpts={})=>{calls.push(execOpts.toolFilter);return{content:'output '+calls.length,evidence:{toolCalls:[{tool:'x',ok:true}]}};};
  const result3=await runHandoffChain(roles,{title:'3-way'},{steps:[]},{execute:mockExecute3,taskAgents:null,jobId:'job-3way',onEvent:()=>{}});
  assert.equal(calls.length,3,'one call per role in a 3-way handoff');
  assert.ok(calls[2].includes('app_tool_search')&&!calls[2].includes('web_search'),'the automation phase must not inherit the research phase'+String.fromCharCode(39)+'s tools');
  assert.equal(result3.evidence.toolCalls.length,3,'all three phases'+String.fromCharCode(39)+' tool calls must be combined for QA');
}

// Settlement identity must be tied back to the SAME external marketplace job and
// deterministic ledger id so a crash between ledger/registry/idempotency writes can replay
// safely without creating detached or duplicate revenue.
{
  const registryRows={'t2000:job-77':{identity:'t2000:job-77',source:'t2000',externalId:'job-77',status:'delivered'}};
  const jobs=[{id:'local-77',source:'t2000',externalId:'job-77',status:'delivered',at:'2026-09-05T10:00:00Z'}];
  const resolved=resolveSettlementJobIdentity({source:'t2000',externalTransactionId:'chain-abc',listingId:'job-77'},{registryRows,jobs,inFlight:{}});
  assert.equal(resolved.ok,true,'a settled marketplace transaction must resolve to a registry identity');
  assert.equal(resolved.identity,'t2000:job-77');
  assert.equal(resolved.jobId,'local-77','settlement must link to the existing internal job, not create detached revenue');
  assert.equal(resolveSettlementJobIdentity({source:'t2000',externalTransactionId:'chain-no-ref'},{registryRows,jobs,inFlight:{}}).ok,false,'a settlement without a marketplace job reference must be quarantined');
  assert.equal(settlementLedgerId('t2000','chain-abc'),settlementLedgerId('t2000','chain-abc'),'settlement ledger identity must be deterministic across crash/retry');
  assert.notEqual(settlementLedgerId('t2000','chain-abc'),settlementLedgerId('t2000','chain-def'),'different chain transactions must never collide');
}

// Marketplace 'paid' is not the same as 'money reached the owner wallet'. Keep custody
// truth explicit so the commissioning proof can distinguish direct payout from a balance
// that still requires withdrawal.
{
  const owner='0x1111111111111111111111111111111111111111';
  const direct=settlementPayoutTruth({source:'clawlancer',payoutAddress:owner},{ownerWallet:owner,credentials:{clawlancer:{walletAddress:owner}}});
  assert.equal(direct.ownerWalletReached,true,'Clawlancer direct payout to the configured owner address must be recognized as owner-wallet paid');
  assert.equal(direct.withdrawalRequired,false);
  const passport=settlementPayoutTruth({source:'t2000',payoutAddress:'0xsui-passport'},{ownerWallet:owner,marketplaceWallets:{t2000:{address:'0xsui-passport'}}});
  assert.equal(passport.ownerWalletReached,false,'t2000 Passport balance must not be mislabeled as the owner EVM wallet');
  assert.equal(passport.withdrawalRequired,true,'t2000 settlement should remain withdrawal-pending until funds reach the owner destination');
  const wp=settlementPayoutTruth({source:'workprotocol',payoutAddress:''},{ownerWallet:owner});
  assert.equal(wp.fundsLocation,'workprotocol_registered_wallet');
  assert.equal(wp.verified,false,'without an authoritative registered wallet address WorkProtocol payout location must stay explicitly unverified');
  const wpDirect=settlementPayoutTruth({source:'workprotocol',payoutAddress:owner},{ownerWallet:owner});
  assert.equal(wpDirect.fundsLocation,'owner_wallet','WorkProtocol pays the agent registered Base wallet directly; matching the owner address proves owner-wallet payout');
  assert.equal(wpDirect.ownerWalletReached,true);
  assert.equal(wpDirect.withdrawalRequired,false);
  const t2000SameHex=settlementPayoutTruth({source:'t2000',payoutAddress:owner},{ownerWallet:owner,marketplaceWallets:{t2000:{address:owner}}});
  assert.equal(t2000SameHex.ownerWalletReached,false,'a Sui Passport address must never be equated with an EVM owner wallet by string equality alone');
  assert.equal(t2000SameHex.destinationCompatible,false,'t2000 Sui settlement requires a Sui-compatible owner destination or separate bridge/transfer action');
  assert.equal(t2000SameHex.humanWalletActionRequired,true);
}

// Reproduce the production symptom: an OpenAI-compatible endpoint returns HTTP 200 but
// no visible content on the first reasoning completion. The client must retry with a
// larger completion budget rather than surfacing llm_empty_response immediately.
const originalFetch=globalThis.fetch;
let calls=0;
globalThis.fetch=async(_url,init)=>{
  calls++;
  const body=JSON.parse(init.body);
  if(calls===1)return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:''}}],usage:{prompt_tokens:10,completion_tokens:100}}),{status:200,headers:{'content-type':'application/json'}});
  assert.ok(Number(body.max_completion_tokens||0)>=3200,'retry must increase completion budget');
  return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'usable result'}}],usage:{prompt_tokens:10,completion_tokens:20}}),{status:200,headers:{'content-type':'application/json'}});
};
try{
  const llm=createLlmClient({AUTONOMOS_LLM_BASE_URL:'https://example.test/v1',AUTONOMOS_LLM_API_KEY:'test',AUTONOMOS_LLM_MODEL:'gpt-5-mini'});
  const result=await llm.complete({messages:[{role:'user',content:'work'}],maxTokens:800});
  assert.equal(result.ok,true);
  assert.equal(result.text,'usable result');
  assert.equal(calls,2);
}finally{globalThis.fetch=originalFetch;}

console.log('AutonomOS workforce test PASS: bounded dynamic roles, no duplicate execution, guaranteed cleanup, empty-LLM recovery');
