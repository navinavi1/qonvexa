# Historical baseline: 2026-09-25

This report records the previous release. See ISOLATION_TEST_REPORT.md for the 2026-09-27 isolation changes.

# Test report

## Environment and scope

- Linux local workspace; Node v24.19.0, npm 11.9.0.
- Original archive preserved. No Git mutation, production database/storage, migration, deployment, DNS, email, CRM/WordPress write or real payment action.
- Fresh install: `npm ci --ignore-scripts --no-audit --no-fund` (PASS). Install scripts deliberately disabled; no dependency version upgrades.
- Syntax: `node scripts/syntax-next.mjs` — 236 JS/MJS/CJS files PASS, 0 FAIL at final source validation.
- New suite: `npm run test:next` — **87 tests PASS, 0 FAIL, 0 SKIPPED**.
- Existing chain: `node scripts/verify-existing-offline.mjs` expands every command in the original `npm run verify`: **100 command checks PASS, 1 FAIL, 1 SKIPPED**. Command checks include syntax checks and scripts with multiple assertions; do not add this count to 87 and call it one test total.
- Dependency audit: `npm audit --json` — PASS, 0 known advisories reported (not a security guarantee).
- Build: no frontend build/transpiler is required. Source HTML/CSS/JS and Node ESM run directly.
- Local startup: `node server.js`, verified by real HTTP tests and existing production-config boot test. Worker failure did not terminate web. No AutonomOS state created even with legacy enable flags.

## New test coverage

SSRF IPv4/IPv6/private/metadata/unsupported URL forms; DNS rebinding/redirect checks; pinned socket DNS; streaming byte/content type/encoding limits; DNS timeout; bounded crawl; evidence/provenance; confidence and preview restrictions; no invented CWV/tracking; catalog/matrix; capabilities and checkout fail-closed; scope/expiry; ledger/cap/idempotency; durable/fenced jobs; expired attempts; stale-worker result protection; encrypted owner-bound secrets; OAuth state/replay/redirect; WordPress/Pipedrive/Zoho read fixtures; no inferred write entitlement; tracking receipt contract; QA/DoD; dry-run zero effects; payment/approval gate; fixture idempotency/rollback/uncertain state; compliance/suppression/opt-out; approved knowledge; retention/close-access.

Customer/admin journey executes local homepage → preview → private mini audit → Find My Audit → manual test order → authenticated manual payment confirmation → full fixture audit → recommendations → blocked unsupported preflight → scoped quote → plan → approval → explicit no-live-results status. It also checks another user's ID rejection, cross-origin admin mutation rejection and connection-unavailable behavior. Unsupported work ends with an explicit review path, not a fake completion.


UI smoke uses the existing public/admin tests and new portal JSDOM against the actual localhost server. It checks DOM output/actions, not pixel layout or accessibility certification. A real provider sandbox/browser-visual test was not performed.

## Known failure and deliberate skip

- **FAIL — `node scripts/dashboard-truth-test.mjs`:** unchanged legacy AutonomOS crypto-only refusal visibility assertion. Reproduced on the original extracted source using the same dependencies and offline guard. Not caused by the new Qonvexa runtime, which does not load it. Left unchanged because AutonomOS is outside this task.
- **SKIPPED — `node scripts/coding-job-test.mjs`:** fixture explicitly invokes `git commit`. The user's no-commit instruction prevents execution. The first attempt under the process guard blocked the command before a commit; the final runner marks it SKIPPED with this reason.
- Live CRM/CMS OAuth/write tests, actual GA4 receipt, rendered CWV, real email/SMS, real charge and real deployment: NOT RUN / not claimed PASS. These correspond to incomplete features in IMPLEMENTATION_STATUS.

No test was deleted. Existing tests were deliberately updated for changed contracts: disabled legacy callback/startup expectations; admin now validates Qonvexa controls and rejects legacy runtime; Find My Audit now asserts that email alone reveals nothing and private-key access preserves staff findings; payment currency fixtures explicitly enable test payment mode. Original assertions about currency/price/admin security were retained. Taskmarket tests use their inspected local fake CLI only; external network/process execution remains denied.

## Existing command results

| Command | Status | Note |
|---|---|---|
| `node --check server.js` | PASS | Executed locally under offline guard. |
| `node --check scripts/start-autonomos.mjs` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/internet-hunter.js` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/lean-internet-hunter.js` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/global-work-hunter.js` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/revenue-global-work-hunter.js` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/browserless-lead-actioner.js` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/search-first-lead-actioner.js` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/revenue-lead-actioner.js` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/gmail-job-monitor.js` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/email-channel-probe.js` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/qa-engine.js` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/global-actioner-migrations.js` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/taskforce-verifier.js` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/taskforce-worker.js` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/global-feed-publisher.js` | PASS | Executed locally under offline guard. |
| `node --check src/autonomos/legacy-state-cleaner.js` | PASS | Executed locally under offline guard. |
| `node --check public/app.js` | PASS | Executed locally under offline guard. |
| `node --check public/order.js` | PASS | Executed locally under offline guard. |
| `node --check public/admin.js` | PASS | Executed locally under offline guard. |
| `node --check public/marketplaces.js` | PASS | Executed locally under offline guard. |
| `node --check public/success.js` | PASS | Executed locally under offline guard. |
| `node --check scripts/preflight.mjs` | PASS | Executed locally under offline guard. |
| `node --check scripts/purchase-audit.mjs` | PASS | Executed locally under offline guard. |
| `node --check scripts/finalization-audit.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/startup-module-graph-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/browser-mail-regression-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/unified-resources-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/retired-markets-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/general-audit.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/autonomos-audit.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/survival-swarm-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/job-registry-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/autonomos-regression-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/autonomos-final-regression-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/final-mega-regression-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/marketplace-hardening-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/earning-lifecycle-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/execution-queue-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/sandbox-session-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/coding-job-test.mjs` | SKIPPED | Contains prohibited git commit fixture. |
| `node scripts/verified-github-pr-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/marketplace-ui-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/admin-integration-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/autonomos-production-readiness-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/autonomos-fault-injection-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/autonomos-platform-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/autonomos-workforce-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/agency-intelligence-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/agency-reliability-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/job-state-tracking-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/crypto-revenue-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/money-report-scope-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/fiat-crypto-routes-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/spend-budget-visibility-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/paid-counter-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/llm-key-name-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/earning-preflight-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/env-audit-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/earning-reserve-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/diagnostics-noise-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/probe-churn-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/opportunity-pricing-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/dashboard-truth-test.mjs` | FAIL | Pre-existing legacy assertion; reproduced in original ZIP source. |
| `node scripts/blocker-coverage-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/taskmarket-e2e-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/taskmarket-keystore-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/marketplace-fee-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/net-split-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/bounty-source-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/spend-gate-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/env-lock-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/earning-path-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/shared-treasury-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/corrupt-state-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/dashboard-latency-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/browser-tools-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/fulfilment-race-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/payment-currency-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/public-site-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/production-boot-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/dashboard-render-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/taskmarket-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/security-research-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/agent-treasury-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/admin-form-contract-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/global-actioner-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/browserless-actioner-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/qa-resilience-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/resilient-search-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/preflight.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/render-audit.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/purchase-audit.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/finalization-audit.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/smoke.js` | PASS | Executed locally under offline guard. |
| `node scripts/smoke.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/marketplace-transport-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/worker-smoke-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/production-lifecycle-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/remaining-lifecycle-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/mega-pass-73-test.mjs` | PASS | Executed locally under offline guard. |
| `node scripts/long-final-regression-test.mjs` | PASS | Executed locally under offline guard. |

## Clean directory and ZIP acceptance

The release source is copied into a clean directory excluding dependencies, runtime data, caches, logs, .git and generated legacy feed data. A fresh dependency install and new/critical regressions are required there. Then the actual output ZIP is extracted into another empty directory and installed/tested again. Final archive validation status is recorded in `ZIP_VERIFICATION.md`; no deployment follows it.

Bank-transfer tests use local fixture bank details and move no money. They verify server-controlled price, pending-by-default status, private-token access and authenticated admin confirmation.

Final archive round-trip: fresh install PASS; 87 new tests PASS; payment-currency, admin and startup smoke PASS. See ZIP_VERIFICATION.md.
