# Change inventory

## 2026-10-05

- AutonomOS removed: `src/autonomos/`, `trigger/`, 76 legacy scripts and tests, the dead dashboard panel and its CSS, 19 npm dependencies (LangChain, OpenAI Agents, E2B, Trigger.dev, pg, redis, AWS S3, OpenTelemetry, Langfuse, zod) and their environment variables. Archived on the `archive/autonomos` branch.

No original ZIP modification. No legacy source module deleted or rewritten. Generated runtime caches/data are excluded from the delivery.

## Modified existing files

- `.env.example`
- `.env.production.example`
- `DEPLOY.md`
- `README.md`
- `package-lock.json`
- `package.json`
- `public/admin.html`
- `public/admin.js`
- `public/app.js`
- `public/index.html`
- `public/order.js`
- `public/privacy.html`
- `public/refund.html`
- `public/success.js`
- `public/terms.html`
- `scripts/admin-integration-test.mjs`
- `scripts/general-audit.mjs`
- `scripts/payment-currency-test.mjs`
- `scripts/public-site-test.mjs`
- `scripts/smoke.js`
- `scripts/start-autonomos.mjs`
- `server.js`

## Added files

- `DEPENDENCY_REPORT.md`
- `IMPLEMENTATION_STATUS.md`
- `KNOWN_LIMITATIONS.md`
- `MIGRATION_PLAN.md`
- `OFFICIAL_SOURCES.md`
- `PAID_SERVICES_AUDIT.md`
- `QONVEXA_BUSINESS_MODEL.md`
- `SECURITY_MODEL.md`
- `SERVICE_CATALOG.md`
- `SUMMARY_UA.md`
- `TEST_REPORT.md`
- `config/qonvexa/country-policies.json`
- `config/qonvexa/dental.json`
- `config/qonvexa/hvac.json`
- `config/qonvexa/med_spa.json`
- `config/qonvexa/roofing.json`
- `migrations/001-qonvexa.sql`
- `public/admin-next.html`
- `public/admin-next.js`
- `public/opt-out.html`
- `public/opt-out.js`
- `public/portal.css`
- `public/portal.html`
- `public/portal.js`
- `scripts/legacy-disabled.mjs`
- `scripts/qonvexa-retention.mjs`
- `scripts/qonvexa-worker.mjs`
- `scripts/start-autonomos.legacy.txt`
- `scripts/syntax-next.mjs`
- `scripts/verify-existing-offline.mjs`
- `src/qonvexa/adapters/index.js`
- `src/qonvexa/audit.js`
- `src/qonvexa/catalog.js`
- `src/qonvexa/config.js`
- `src/qonvexa/connections.js`
- `src/qonvexa/costs.js`
- `src/qonvexa/knowledge.js`
- `src/qonvexa/outreach.js`
- `src/qonvexa/preflight.js`
- `src/qonvexa/retention.js`
- `src/qonvexa/routes.js`
- `src/qonvexa/runner.js`
- `src/qonvexa/scanner.js`
- `src/qonvexa/security.js`
- `src/qonvexa/store.js`
- `src/qonvexa/worker.js`
- `tests/qonvexa/core.test.mjs`
- `tests/qonvexa/journey.test.mjs`
- `tests/qonvexa/offline.cjs`
- `tests/qonvexa/scanner.test.mjs`

The legacy launcher source is preserved as non-executed text. Public global-feed JSON is generated test/runtime data and is excluded from the release, not deleted from the original archive.
