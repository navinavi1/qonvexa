# Qonvexa Next — local implementation package

**This is a tested local foundation, not a production-ready implementation agency.** Public audit and quote planning work; live implementation checkout, CRM OAuth lifecycle, production writes and provider-level QA are not shipped. Read `IMPLEMENTATION_STATUS.md` and `KNOWN_LIMITATIONS.md` before enabling anything.

## Product

Free website preview → personal audit workspace → configurable paid Growth Audit → evidence-linked recommendations → capability preflight → scoped estimate → dry-run implementation plan → plan approval. The customer owns CRM, CMS, email/SMS, AI/API and other SaaS accounts. Their recurring bills are separate from Qonvexa's one-time fee.

## Runtime

- `server.js`: existing Express website, leads/orders/admin/payment verification plus new routes.
- `src/qonvexa/`: evidence/rules, scanner, service catalogue, preflight, quotes, cost ledger, queue, security, adapters and offline runner.
- `scripts/qonvexa-worker.mjs`: separate Node process; no work is executed inside the public HTTP request.
- Legacy `src/autonomos/`: retained. No runtime import, worker startup, marketplace polling or treasury revenue split in normal web startup. `scripts/start-autonomos.mjs` is a compatibility alias for web only; original launcher text is preserved in `scripts/start-autonomos.legacy.txt` and is not executed.
- Existing JSON/NDJSON data remain in place. New SQLite state is additive at `$STORAGE_DIR/qonvexa-next.sqlite`, using Node's built-in `node:sqlite` (no new database server or npm dependency). WAL/transactions provide cross-process claims on one local persistent disk.

## Local setup

Tested with Node 24.19.0, npm 11.9.0. Package engines are preserved: >=22.18.0 <25.0.0. Use Node 24 for parity with the validation.

```sh
npm ci --ignore-scripts --no-audit --no-fund
cp .env.example .env
npm start
```

Set a local `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, and `IP_HASH_SALT` yourself. No real credentials are supplied. Public pages are at http://localhost:3000; admin at `/admin`; growth operations at `/admin-next.html`.

Default external behavior: public fetching OFF; payments OFF; notification webhooks OFF; outreach sending impossible; implementation writes impossible. `QONVEXA_IMPLEMENTATIONS` enables planning only. Setting `IMPLEMENTATION_DRY_RUN=false` does not unlock a live executor. CRM onboarding returns an explicit unavailable response and the UI does not solicit credentials.

To run public **read-only** scanning later, deliberately set `QONVEXA_PUBLIC_FETCH_ENABLED=true` and run `npm run worker` in another terminal using the same `STORAGE_DIR`. This documentation does not authorize production actions. No real websites were scanned during validation; tests supply local observations.

The free request returns a personal link with a random fragment key. Save that original link. The workspace removes the fragment from the address bar and sends the key only as a bearer header; no localStorage. Find My Audit now requires the key as well as email. Staff can issue a key for a legacy lead after verifying the recipient. Legacy staff-written mini-audits are retained and returned only with that key; they are not relabeled as fresh scanner evidence.

## Tests

```sh
npm run test:next
node scripts/verify-existing-offline.mjs
node scripts/syntax-next.mjs
```

The original `verify` command remains available for transparency. It includes legacy earning tests; see the report for the unchanged pre-existing failure and the commit-based fixture that must not run under this task's constraints. The offline runner expands the entire original command chain so one failure does not hide later tests, denies external network and disallowed processes, and records each outcome.


## Data and lifecycle

Queue operations are transactional, leases are fenced, attempts bounded, stale jobs recover. Unknown/ambiguous effects cannot be marked completed. Scans store structured facts, not raw pages. Temporary retention is available through `node scripts/qonvexa-retention.mjs --apply` against a deliberately selected local storage folder after backup. Without `--apply` it does nothing. Scheduling cleanup is an operator responsibility.

No Git push/commit/PR, Render action, live account modification, email or payment was performed. `DEPLOY.md` describes future review only, not a deployment instruction to execute now.

Bank-transfer tests use local fixture bank details and move no money. They verify server-controlled price, pending-by-default status, private-token access and authenticated admin confirmation.

## Isolation update — 2026-09-27

Qonvexa web/worker require neither external Redis nor PostgreSQL. Active deployment/env configuration and production verification are separated from legacy; original configuration is retained under docs/legacy. Data models are unchanged. Existing resource consumers in Render have NOT been inventoried. See ISOLATION_REPORT_UA.md for conditional shutdown criteria. No infrastructure action was performed.

## Production launcher (2026-09-27)

`npm start` supervises web and audit worker as separate OS processes on the same persistent disk. `npm run start:web` runs web only; `npm run worker` runs only jobs. Worker restart attempts are bounded (3); HTTP stays available if the worker fails. Do not create a second Render worker pointing at an unshared local disk.
