# AutonomOS 7.0 — Rebuild Report

## Scope
This release is a structural rebuild of the AutonomOS operations layer, not a cosmetic patch. The QONVEXA application package remains on its existing product version; the autonomous operations runtime now identifies itself as **AutonomOS 7.0.0**.

## 1. Permanent Job Registry — the repeated-job loop is removed
A new durable `JobRegistry` stores every marketplace job by `source + externalId` and a content fingerprint.

For the same job version:
- `graveyard` is terminal and survives refreshes, restarts and deploys;
- agents never receive the job again;
- the normal UI no longer has a button that forgets permanent decisions;
- if a marketplace later changes the material job content/budget/deadline, the registry creates a new version instead of blindly treating it as the old failed copy.

The legacy `/reset-claim-history` endpoint is retained only for compatibility but now clears transient claim retry bookkeeping only. It does **not** erase the permanent registry.

## 2. Failure ownership
Failures are classified before deciding whether a job is permanently buried:
- **market / external permanent**: already claimed, job taken, expired, closed, removed, 404/409/410 -> permanent Graveyard;
- **policy**: below floor, demo/test, non-positive economics, required escrow missing -> Graveyard for that job version;
- **transient**: network timeout, 429, 5xx -> Retry with backoff;
- **our_system**: LLM/QA/evidence/tool/auth/payload problems -> never mislabeled as marketplace failure and never permanently buried automatically.

Claimed jobs that fail during execution remain owned by the recovery pipeline. They cannot become eligible for a second claim after retry backoff expires.

## 3. Honest job lanes
The registry separates operational modes:
- `Ready` = qualified instant/owned work;
- `Bid / Competitive` = Dealwork bids, Superteam competitive submissions and similar proposal lanes;
- `Working` = claimed/executing/QA;
- `Retry` = temporary/internal recovery;
- `Delivered`;
- `Paid`;
- `Graveyard` = terminal jobs hidden from agents.

This prevents a competitive $5,000 bounty from visually looking like a guaranteed escrowed $5,000 job.

## 4. Mission Control dashboard
The AutonomOS admin view was rebuilt into a compact operations dashboard:
- useful controls only: Start 24/7, Pause, Scan new jobs, Retry transient, Emergency stop;
- no production-facing “reset/forget everything” control;
- compact KPI row: Ready Now, New, Active, 24h Revenue, 24h Cost, Net Profit, Delivered, Paid, Retry, Graveyard;
- job command center with queue tabs and a 50-row scrollable table;
- live active-job cards with job title, market, payout/currency, claim mode, escrow flag, assigned worker, start time, ETA, deadline and estimated progress;
- Agent Fleet showing task-scoped specialists and phases;
- Marketplace Health/Yield panel;
- recent claim/execution/delivery outcomes;
- compact treasury/payment display;
- Action Center for Superteam/manual payout claims and setup gaps;
- policies, connectors, infrastructure, permanent agents and seller products moved into collapsible control panels so the main screen stays operational rather than configuration-heavy;
- live event stream remains available for deep diagnosis.

## 5. Marketplace layer
Existing integrations are retained. AutonomOS 7.0 does not delete a market merely because its current public feed is weak; it separates earning jobs, seller rails, competitive lanes and infrastructure.

### Existing primary earning lanes
- **Dealwork** — claim + bid modes; Tier-1 operational lane.
- **Clawlancer** — escrowed USDC jobs with profitability floor.
- **t2000** — Open Jobs filtered by the dedicated payout floor; already-purchased Seller Service orders remain active.
- **Superteam Earn** — competitive submission lane; not presented as escrow-guaranteed work.

### New market expansion
1. **ClawJobs** — implemented public discovery using the documented `/api/v1/jobs?status=open` API. Jobs are Base/USDC escrowed, but proposals require an account/API key and worker stake, so AutonomOS deliberately does not fabricate an automatic claim/signing flow. It appears as a discovery/proposal-gated market.
2. **LaborX** — code-ready discovery watch adapter, disabled until a verified JSON feed/API URL is configured.
3. **Dework** — code-ready DAO bounty watch adapter, disabled until a verified feed/API URL is configured.
4. **Bountycaster** — code-ready competitive crypto bounty watch adapter, disabled until a verified feed/API URL is configured.
5. **Questbook / grants** — separate grants/proposal watch lane, disabled until a verified feed/API URL is configured.

For the four watch adapters AutonomOS intentionally has **no invented endpoint**. They activate only when an official/verified feed URL is supplied.

## 6. Why the architecture looks this way
The rebuild follows established production-agent patterns rather than a custom one-off dashboard:
- run/thread/job state and inspectable execution history;
- explicit workflow states and durable recovery;
- manager/specialist delegation;
- guardrails before expensive or external actions;
- trace/event-oriented observability;
- separate operational queues for active work, retries and terminal outcomes;
- compact mission-control presentation with deeper configuration behind disclosures.

These patterns map to current production practices documented by LangGraph/LangSmith, OpenAI Agents SDK, Microsoft Agent Framework, CrewAI AMP and Google ADK observability tooling.

## 7. Tests added / updated
A new `job-registry-test.mjs` verifies:
- Graveyard survives process restart;
- a permanently blocked job cannot return;
- a material job-version change is treated as a new version;
- transient claim retry can be released;
- claimed execution retry remains owned and cannot fall back into re-claim;
- market, transient and our-system failures are classified differently.

The full project verification suite passes after the rebuild:
- General audit: **62/62**
- AutonomOS audit: **27/27**
- Job Registry test: **PASS**
- AutonomOS flow/platform/workforce: **PASS**
- Agency intelligence: **PASS**
- t2000 OAuth + connector: **PASS**
- Render/preflight/purchase/finalization/smoke: **PASS**

## 8. Important operational truth
A passing code/test suite cannot guarantee that an external marketplace has profitable jobs at a particular moment, accepts a proposal, or pays a competitive bounty. AutonomOS 7.0 now represents those states honestly and avoids spending agent effort on known-dead repeats. External credentials, marketplace account approval, escrow/stake rules, and marketplace availability still control what can be claimed in production.
