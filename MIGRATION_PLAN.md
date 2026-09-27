# Migration plan — not executed in production

1. Freeze writes for the future migration window and back up the entire existing `STORAGE_DIR`, environment configuration and source release. Do not export secrets into this ZIP.
2. Validate on a staging copy with synthetic/sanitized data. Existing `preview-requests.ndjson`, `orders.ndjson`, `lead-state.json`, `order-state.json`, admin sessions, prepared audit URLs, clients (derived from leads/orders), fulfilled sessions and legacy AutonomOS directory are not migrated or deleted by new schema initialization.
3. `migrations/001-qonvexa.sql` is additive/idempotent. The web/worker Store applies it locally on startup to a new SQLite file. Tables: records, jobs, schema_version. No ALTER against legacy records; no production database was connected.
4. Check ownership/permissions and use one local persistent filesystem for web and worker. SQLite WAL must not be copied alone while active: stop both processes and copy database plus WAL/SHM, or use a proper SQLite backup. New encrypted connection keys must be backed up separately from this archive.
6. Start web with `node server.js`, worker with `node scripts/qonvexa-worker.mjs`, on the SAME host/disk. Do not use the legacy launcher text. Existing start-autonomos.mjs now launches only web.
7. Keep scanner/payments/notifications disabled until separately reviewed in staging. All new live implementation capabilities are absent, not merely waiting for a flag. Customer action is required for OAuth app registration and future adapters.
8. Legacy audit email lookup is deliberately hardened: email alone returns no report. Staff issues a new private key to a verified customer; existing order-token links and prepared-delivery URLs still work. No automated email recovery was introduced.
9. Configure identity/privacy notices and retention operation. Review applicable legal terms with counsel; this code is not legal certification.

## Rollback

Stop both processes. Restore the former source and backed-up environment/legacy data only after reviewing the fact that the old launcher activates AutonomOS. The safest rollback keeps the isolated web launcher. New SQLite data can be retained for review; removing it loses only new audit/planning/access state, but must be an explicit operator decision after backup. Never delete original orders/accounting records. Disable access sessions and revoke provider credentials before discarding encrypted connection storage. There is no automatic cross-release rollback of live CRM changes because none are implemented.

## Deployment constraint

Render web and a separate Render worker cannot assume that one attached disk is shared. This release has no distributed queue/database adapter. Use a reviewed same-host process arrangement for staging, or implement a shared durable database backend before separate-host deployment. Do not deploy `render.yaml` unchanged merely because it is present; it is inherited infrastructure configuration, not a validated new deployment plan.

The new additive state lives in `qonvexa-next.sqlite*`. Existing financial records are retained; bank-transfer orders use the existing admin confirmation workflow. No payment-provider credentials are required.

## Isolation update — 2026-09-27

Qonvexa web/worker require neither external Redis nor PostgreSQL. Active deployment/env configuration and production verification are separated from legacy; original configuration is retained under docs/legacy. Data models are unchanged. Existing resource consumers in Render have NOT been inventoried. See ISOLATION_REPORT_UA.md for conditional shutdown criteria. No infrastructure action was performed.
