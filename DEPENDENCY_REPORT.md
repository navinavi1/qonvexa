# Dependency report

Actual import inventory, 2026-09-25. Package versions were not upgraded. `jsdom` moved from devDependencies to dependencies because production deterministic scanning needs its non-executing DOM parser. Node SQLite is built in; no new npm package/database service. Lockfile package version changes detected: 0.

| Dependency | Category | Evidence / decision |
|---|---|---|
| `@aws-sdk/client-s3` | AUTONOMOS ONLY | src/autonomos/artifact-store.js; kept to preserve legacy source/tests. |
| `@aws-sdk/s3-request-presigner` | AUTONOMOS ONLY | src/autonomos/artifact-store.js; kept to preserve legacy source/tests. |
| `@e2b/code-interpreter` | AUTONOMOS ONLY | src/autonomos/sandbox-session.js, src/autonomos/tools.js, src/autonomos/coding-job.js; kept to preserve legacy source/tests. |
| `@langchain/core` | REMOVE CANDIDATE | No direct runtime import found; may be peer/transitive requirement. Retained pending dependency graph review. |
| `@langchain/langgraph` | AUTONOMOS ONLY | src/autonomos/orchestration.js; kept to preserve legacy source/tests. |
| `@langchain/langgraph-checkpoint` | REMOVE CANDIDATE | No direct runtime import found; may be peer/transitive requirement. Retained pending dependency graph review. |
| `@langchain/langgraph-checkpoint-postgres` | AUTONOMOS ONLY | src/autonomos/orchestration.js; kept to preserve legacy source/tests. |
| `@langfuse/otel` | AUTONOMOS ONLY | src/autonomos/langfuse-observability.js; kept to preserve legacy source/tests. |
| `@langfuse/tracing` | AUTONOMOS ONLY | src/autonomos/langfuse-observability.js; kept to preserve legacy source/tests. |
| `@openai/agents` | AUTONOMOS ONLY | src/autonomos/planner.js; kept to preserve legacy source/tests. |
| `@opentelemetry/api` | REMOVE CANDIDATE | No direct runtime import found; may be peer/transitive requirement. Retained pending dependency graph review. |
| `@opentelemetry/core` | REMOVE CANDIDATE | No direct runtime import found; may be peer/transitive requirement. Retained pending dependency graph review. |
| `@opentelemetry/exporter-trace-otlp-http` | REMOVE CANDIDATE | No direct runtime import found; may be peer/transitive requirement. Retained pending dependency graph review. |
| `@opentelemetry/sdk-node` | AUTONOMOS ONLY | src/autonomos/langfuse-observability.js; kept to preserve legacy source/tests. |
| `@opentelemetry/sdk-trace-base` | REMOVE CANDIDATE | No direct runtime import found; may be peer/transitive requirement. Retained pending dependency graph review. |
| `@trigger.dev/sdk` | AUTONOMOS ONLY | src/autonomos/trigger-client.js, trigger.config.js; kept to preserve legacy source/tests. |
| `dotenv` | REQUIRED FOR QONVEXA | server.js |
| `express` | REQUIRED FOR QONVEXA | server.js |
| `helmet` | REQUIRED FOR QONVEXA | server.js |
| `pg` | AUTONOMOS ONLY | src/autonomos/memory.js, src/autonomos/orchestration.js; kept to preserve legacy source/tests. |
| `redis` | AUTONOMOS ONLY | src/autonomos/event-bus.js, src/autonomos/resource-control.js, src/autonomos/cache.js; kept to preserve legacy source/tests. |
| `zod` | REMOVE CANDIDATE | No direct runtime import found; may be peer/transitive requirement. Retained pending dependency graph review. |
| `jsdom` | REQUIRED FOR QONVEXA | src/qonvexa/audit.js, src/qonvexa/scanner.js |

`npm audit --json`: zero known vulnerabilities reported for the installed dependency tree at the time of testing. This does not establish that code is vulnerability-free. No dependency removed. Full peer/runtime pruning remains a separate deliberate change.
