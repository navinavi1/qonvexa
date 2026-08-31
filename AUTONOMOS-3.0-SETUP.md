# AutonomOS 3 — activation checklist

This build keeps the existing QONVEXA/AutonomOS runtime and adds a production-oriented platform layer. All components degrade gracefully when their credentials are absent; the dashboard exposes missing infrastructure.

## Core runtime now wired

- LangGraph — orchestration graph for plan → execute → QA.
- Postgres + pgvector — durable operational memory and semantic recall.
- OpenAI Agents SDK — planner path when `OPENAI_API_KEY` is configured.
- Temporal — durable paid-job workflows plus a separate worker process.
- LiteLLM — optional OpenAI-compatible model gateway/router.
- Firecrawl — live web search and scraping.
- E2B — Python plus bounded shell/filesystem execution and artifact collection.
- Stagehand v4 + Browserbase — bounded browser operations with target-domain policy.
- Composio v3.1 — authenticated non-financial/non-destructive connected-app actions.
- CodeRabbit CLI — second review gate for high-value coding jobs.
- Redis — cache/short-lived coordination state.
- NATS — event bus.
- S3-compatible storage — durable generated artifacts and signed/public URLs.
- Langfuse + OpenTelemetry — agent traces.
- OpenSearch — operational event logs.
- Auth0 — optional bearer authentication for admin API alongside the existing owner session.
- AWS Secrets Manager — optional startup secret bundle, allowlisted and lower precedence than explicit Render env vars.

## Required registrations / keys to activate components

Set only the services you actually want active.

| Component | Required configuration |
|---|---|
| OpenAI Agents SDK | `OPENAI_API_KEY` |
| LiteLLM | `LITELLM_BASE_URL`, optionally `LITELLM_API_KEY` |
| Postgres/pgvector | `DATABASE_URL`; DB user must be able to use/create the `vector` extension |
| Temporal | `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `AUTONOMOS_TEMPORAL_WORKER_TOKEN`, `AUTONOMOS_INTERNAL_BASE_URL` |
| Redis | `REDIS_URL` |
| NATS | `NATS_URL` |
| Firecrawl | `FIRECRAWL_API_KEY` |
| E2B | `E2B_API_KEY` |
| Browserbase/Stagehand | `BROWSERBASE_API_KEY`; `BROWSERBASE_PROJECT_ID` remains optional metadata |
| Composio | `COMPOSIO_API_KEY`; connected accounts/OAuth must be created for the apps agents should use |
| CodeRabbit | `CODERABBIT_API_KEY` plus E2B |
| S3-compatible storage | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, optional `S3_REGION` |
| Langfuse | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` |
| OpenSearch | `OPENSEARCH_URL`; optional username/password |
| Auth0 | `AUTH0_DOMAIN`, `AUTH0_AUDIENCE` |
| AWS Secrets Manager | `AUTONOMOS_AWS_SECRET_ID`, `AWS_REGION`; set `AUTONOMOS_SECRETS_REQUIRED=true` only if startup must fail when it is unavailable |

## Payment / payout routing

AutonomOS does **not** store wallet private keys and does not sign arbitrary transfers. It routes where legitimate earnings should be paid and reconciles settlement evidence.

- Crypto destination: `AUTONOMOS_OWNER_WALLET`, allowed currencies via `AUTONOMOS_PAYOUT_CRYPTO_JSON`, allowed networks via `AUTONOMOS_PAYOUT_NETWORKS_JSON`.
- FOP SWIFT/IBAN: existing legacy `BANK_*` account remains supported.
- Multi-currency FOP accounts: use `AUTONOMOS_FOP_ACCOUNTS_JSON` with one object per currency (`USD`, `EUR`, etc.). The router only selects a bank account whose currency matches the job payout currency.
- Verified intermediaries: `AUTONOMOS_VERIFIED_PAYOUT_INTERMEDIARIES_JSON`. A provider is ignored unless `verifiedForUkraineFop:true`, `verifiedAt` is recent, and `officialSourceUrl` is HTTPS.
- Marketplace capabilities: `AUTONOMOS_MARKET_PAYOUT_METHODS_JSON` should contain only payout methods verified from that marketplace's current documentation.
- Stripe remains available for the existing QONVEXA customer checkout. It is not treated as a universal AutonomOS agent-payout rail.

## Market policy changes

- Zero-payout Agentverse discovery was removed from the earning-opportunity feed.
- Global production floor defaults to $5.
- Clawlancer floor defaults to $5.
- Dealwork floor defaults to $10.
- Superteam floor defaults to $25.
- t2000 Open Job floor defaults to $35, priority $65, premium $100.
- Every candidate is capability-, safety-, payout-, and profitability-gated before claim.
- Failed claimed jobs remain durable/in-flight for retry/manual attention instead of being silently discarded.
- t2000 keeps the existing Passport OAuth connection and now has manual Refresh Jobs plus broader paginated discovery attempts.

## Temporal deployment

The web service can dispatch paid candidates to Temporal when configured. Run a second process/service with:

```text
npm run autonomos-temporal-worker
```

The worker calls the internal authenticated endpoint in the web service. If Temporal is unavailable, dispatch falls back to the protected local pipeline rather than dropping the job.

## Elastic agents

`autoReplication` creates bounded role-specific elastic workers under load and scales idle workers back down. They share the same hard safety and spend policies as the core runtime. `maxChildren`, `maxConcurrentJobs`, thresholds and TTL remain owner-controlled ceilings; there is no unlimited runaway replication.

## External limitations that code cannot remove

Some work will still require account authorization, marketplace approval, KYC, CAPTCHA/2FA, human payout claims, or a client's own credentials. AutonomOS refuses to bypass those controls. Connectors that are only declared but do not yet have a verified current claim/delivery contract remain non-operational rather than being faked as ready.
