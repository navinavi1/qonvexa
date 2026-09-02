# AutonomOS 3.0 — Production Rebuild Report

## Why this rebuild was necessary

The production screenshots exposed two concrete failures that the previous audits did not catch:

1. **Worker leak / fake activity.** The dashboard showed 32 task agents in `Executing` while `Active tasks` was empty. The old orchestration could spawn a task team in LangGraph, catch an execution error, then enter a fallback path that planned/spawned again. If the fallback failed too, the task agents were not guaranteed to retire. The global task-worker cap was also independent from the owner-facing `maxChildren` setting, so the dashboard could show 32 workers while policy showed 12.
2. **`llm_empty_response` loop.** Recent marketplace activity repeatedly failed with `llm_empty_response`. GPT-5 class reasoning models can consume a small completion budget on reasoning and return HTTP 200 with no visible text. The old client treated that as a terminal job failure immediately. That created repeated paid-job failures even though the provider connection itself was alive.

## Architecture used as reference

This rebuild borrows production patterns — not proprietary source code or pixel-for-pixel UI — from ten mature agent/runtime approaches:

1. OpenAI Agents SDK — manager/handoff/tool/guardrail model, tracing, small primitive set.
2. Anthropic effective-agent patterns — simple composable workflows before complex swarms.
3. LangGraph — explicit graph state, persistence/checkpoints, durable workflow shape.
4. Microsoft Agent Framework — sequential/concurrent/handoff orchestration with checkpoints and HITL boundaries.
5. Google ADK — stateful agent workflows, sandboxed execution, durable recovery patterns.
6. Trigger.dev — long-running TypeScript jobs, queues, retries, idempotency and observability.
7. Temporal — durable execution and recoverable long-running workflows.
8. E2B — isolated task workspaces/sandboxes for code and tool execution.
9. dealwork.ai/OpenWork — agent-native job matching, escrow/contract lifecycle, agent-to-agent work marketplace.
10. t2000 — machine marketplace pattern: discover/claim/work-order/deliver/settle with a persistent agent identity.

## New operating model

### Permanent control plane

AutonomOS no longer treats research/code/content/automation workers as permanent employees. Only nine control-plane roles remain resident:

- Orchestrator
- Policy & Guardrails
- Opportunity Radar
- Economics Gate
- Job Router
- QA Gate
- Treasury & Ledger
- Security Sentinel
- Learning Loop

### Dynamic workforce

For every accepted job:

1. Plan the job once.
2. Group planned work by specialist role.
3. Spawn only the required specialists.
4. Bound specialists by global and per-job capacity.
5. Execute the job once.
6. Run QA.
7. Deliver.
8. Retire every specialist in a `finally` path whether the job succeeds, fails, is cancelled, or QA rejects it.

Ten Code Worker steps no longer create ten Code Workers. They collapse into one Code Worker lease for the job unless multiple genuinely different specialist roles are required.

## Critical fixes

### 1. Removed the legacy persistent child-agent pool

The old `children.json` pool is migrated to empty on boot. External marketplace execution no longer calls the legacy autoscaler. `maxChildren` is retained only as a backward-compatible configuration field and now acts as the maximum dynamic workforce capacity.

### 2. Idempotent task-team creation

`TaskAgentRuntime.spawnForPlan()` is idempotent by `jobId`. A graph retry/checkpoint cannot duplicate the same team.

### 3. Guaranteed worker cleanup

`orchestrateJob()` has one lifecycle boundary. Worker retirement occurs in `finally`, covering:

- success
- LLM failure
- tool failure
- QA failure
- cancellation
- LangGraph runtime error

The dashboard also retires any orphaned lease that has no matching active job.

### 4. No duplicate paid execution on LangGraph failure

The previous catch block could replay a paid execution through a sequential fallback after an execution error. AutonomOS 3.0 plans once and only falls back to sequential execution when the graph infrastructure itself cannot be built. An execution failure is propagated and never replayed automatically inside orchestration.

### 5. GPT-5 empty-response recovery

The LLM client now:

- accepts `OPENAI_API_KEY` directly without requiring a duplicate `AUTONOMOS_LLM_API_KEY`;
- defaults to the OpenAI-compatible base URL when `OPENAI_API_KEY` exists;
- parses string and structured message content;
- retries a successful-but-empty response with a larger completion budget;
- switches to `max_completion_tokens` and low reasoning effort on the retry;
- uses a short circuit breaker after repeated provider failures so one bad model/provider state cannot burn through the queue.

### 6. dealwork matching feed

AutonomOS now merges dealwork's authenticated `/jobs/matching` feed with the newest public jobs feed and deduplicates by job ID. This makes candidate discovery depend not only on chronology but also on marketplace-side matching.

### 7. Operator dashboard cleanup

The dashboard now shows:

- real active jobs;
- only task workers attached to those real active jobs;
- compact permanent control-plane roles instead of 19 pseudo-workers;
- LLM health including circuit-open state;
- dynamic worker limit instead of the misleading legacy "max child agents" label;
- no legacy replication-tree panel.

## Production acceptance criteria

Passing unit/audit tests is necessary but is not considered proof of revenue. AutonomOS 3.0 is accepted only when a production job completes this chain with real marketplace credentials:

`discover → qualify → claim/bid → plan → spawn specialists → execute tools → QA → deliver → marketplace accepts → settlement recorded → ledger updated`

## New verification added

`npm run autonomos-workforce-test` proves:

- many plan steps collapse to bounded specialist roles;
- spawning the same job twice does not duplicate workers;
- a finished job has zero active workers;
- a failed execution is called exactly once (no replay through fallback);
- a failed job retires every task worker;
- an HTTP-200 empty GPT-5 completion is retried and recovered.

The new test is included in `npm run verify`.
