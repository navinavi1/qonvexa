# Isolation validation — 2026-09-27

Environment: Linux, Node 24.19.0; local fixture data only.

- `npm ci --ignore-scripts --no-audit --no-fund`: PASS, fresh install, lockfile unchanged.
- `npm run verify`: PASS. New production gate is independent of legacy runtime/tests.
- Node test suite: **93 PASS, 0 FAIL, 0 SKIPPED** (previous 87 plus 6 isolation tests).
- Nine additional scripts: PASS — payment-currency, admin-integration, public-site, production-boot, render-audit, purchase-audit, finalization-audit, smoke.js and smoke.mjs.
- Six isolation tests cover web and worker with absent/inherited Redis/Postgres URLs, old launcher compatibility, transitive source import graph and active deployment/env/CI configuration.
- A test-only module loader rejects legacy imports and Redis/Postgres client imports. Local TCP tripwires count attempted database connections; count was zero. No external database was contacted.
- Production gate runs with a loopback-only test network boundary. Fixture scans may enqueue local work, but external network requests remain blocked. An initial run exposed a test-harness conflict that disabled fixture enqueueing; corrected only the test harness, then reran the complete gate successfully.
- Old mixed suite retained as `verify:legacy`; not rerun for this scoped change. Its previously reported legacy failure and skipped commit fixture are not relabeled as PASS. See historical TEST_REPORT.md.
- No live Render inventory, deployed-version check, or service shutdown was performed. Independence is confirmed for this archive's Qonvexa runtime, not for all consumers of the current Render services.

Archive delivery procedure: source-only ZIP, excluding .git, node_modules, runtime data and logs; integrity check; extraction to a new directory; fresh dependency install and the entire `npm run verify` gate again before delivery. No deployment follows.
