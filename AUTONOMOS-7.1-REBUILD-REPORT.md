# AutonomOS 7.1 — Production Closure report

## Scope

This release was built from the latest supplied repository snapshot `qonvexa-main (27)(1).zip` and addresses the production-gap audit rather than performing another cosmetic redesign.

## Critical defects fixed

### 1. Mission Control was reading the Job Registry from the wrong snapshot path

The server exposed `jobRegistry` at the top level while the UI primarily read `runtime.jobRegistry`. This could render Ready/New/Retry/Graveyard as zero even when persistent registry data existed. The runtime now exposes the registry consistently and the UI supports both paths during migration.

### 2. Graveyard is now identity-permanent

Permanent rejection is keyed by `marketplace + externalJobId`. A mutable title, payout, deadline, description or fingerprint cannot resurrect the same external job. Permanent tombstones are stored separately in `job-tombstones.json` and are not pruned with the bounded operational registry.

### 3. Legacy state migration

A one-time v7.1 migration classifies legacy handled jobs. External/permanent/completed jobs become tombstones. Failures owned by our executor/LLM/tools become System Blocked instead of being falsely blamed on the marketplace.

### 4. System Blocked / Capability Hold

Our failures are separated from marketplace failures. Jobs held because of LLM, QA, missing evidence/tooling or executor problems do not repeatedly reach agents after a normal refresh. A held job may be released automatically only when the capability version changes, or through deliberate recovery logic.

### 5. Safe history reset replacement

The old concept of forgetting claim history is not restored. A new maintenance action archives `jobs.ndjson`, `events.ndjson` and `opportunities.ndjson`, then starts a clean live-history view while preserving permanent tombstones, ledger/payment history, credentials and configuration.

### 6. Multi-agent phase contracts

Specialists no longer all receive the full final acceptance contract. The workflow now uses:

`Job Contract -> Phase Contracts -> Specialist execution -> Final evidence aggregation -> Final QA`

Research, code, automation and content specialists are checked against the requirements that belong to their phase. This prevents an early research specialist from failing because a later code specialist has not yet produced the implementation.

### 7. Canonical evidence pack

Tool calls, phase outputs, usage and costs are aggregated across handoffs and a canonical evidence pack is produced after the chain. Final QA/delivery can therefore reason about the whole job journey rather than only the last specialist response.

### 8. Competitive marketplace behavior

Competitive submissions are no longer enabled by default. `autoCompetitiveSubmissions` defaults to false. Superteam therefore does not behave as a guaranteed instant-claim job merely because the displayed prize is large.

### 9. Policy migration

The policy schema generation is bumped. A legacy persisted global floor of $5 or $10 migrates to the current $25 production default. This fixes the UI/config contradiction observed in production.

### 10. Retry behavior

Claim and execution retries now use exponential backoff with caps instead of treating every attempt as the same fixed delay. Permanent market failures remain tombstoned and our-system failures can enter System Blocked after retry exhaustion.

## Mission Control changes

- Added System Blocked KPI and queue tab.
- Fixed Job Registry data source mismatch.
- Added 24h net, 7d net and lifetime net separation.
- Added truthful funnel: Raw -> Paid -> Above Floor -> Executable -> Profitable -> Claimable -> Ready.
- Added blocker categories to explain why profitable work still did not become Ready.
- Added per-market yield fields in the runtime for signals, readiness, historical claims/delivery/paid counts and basic net figures.
- Improved marketplace status wording: Ready / Watch only / Needs credentials / Unavailable instead of treating a non-crashing watch feed as a healthy earning source.
- Added job search and a Job/Run detail dialog.
- Added Incident/Needs Attention rendering.
- Added `Inspect Blockers`, `Run Live Self-Test`, `Reconcile Payments` and safe legacy-history maintenance actions.
- Running state now disables the redundant Start button.

## Production diagnostics added

### Live Self-Test

The new safe self-test performs discovery/health checks against configured earning sources and explicitly performs no claims. It stores its latest report in `live-self-test.json`.

### Incident signals

Current incident generation covers important operational conditions including LLM circuit-open state, unavailable connectors, System Blocked jobs and prolonged zero-Ready conditions.

## Tests

A new `scripts/autonomos71-regression-test.mjs` verifies:

- permanent identity tombstones survive mutable marketplace metadata;
- System Blocked is distinct from Graveyard;
- System Blocked does not release under the same capability version;
- a capability-version change can release the hold;
- research phase contracts do not require final implementation;
- code phase contracts do require implementation;
- handoff evidence/tool calls/cost/usage are aggregated;
- canonical evidence pack is produced;
- legacy $10 policy migrates to $25;
- competitive auto-submit defaults off.

`npm run verify` passed after the final changes, including the existing general audit (62/62), AutonomOS audit (27/27), registry test, new 7.1 regression suite, flow/platform/workforce/agency tests, t2000 OAuth/connector tests, preflight, Render audit, purchase/finalization audits and smoke test.

## What is NOT honestly guaranteed by code alone

This package should not be called proven end-to-end revenue production until it is deployed with the real production credentials and at least one real marketplace job successfully completes claim/bid -> execution -> delivery -> settlement. The safe live self-test validates current discovery/auth/schema reachability but deliberately does not spend money or claim work.

LaborX, Dework, Bountycaster and Questbook remain watch/discovery integrations unless a verified API/feed is configured. They are not promoted to fake autonomous Ready sources. ClawJobs still depends on its real external API/key/stake requirements.

External marketplace availability, employer selection on competitive jobs, payout decisions and third-party API uptime cannot be guaranteed by this repository.

## Remaining non-blocking improvements

The 7.1 job-detail drawer is operational but is not a full LangSmith-style trace explorer. Persistent incident history, graphical charts, advanced multi-column filters and a UI button for arbitrary checkpoint replay can be expanded later without changing the core claim/execution correctness fixed here. Existing durable in-flight recovery/checkpointing remains in place.
