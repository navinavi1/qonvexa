# Deployment authorization update — 2026-09-27

The owner has now authorized publishing the full current release through GitHub main and Render auto-deploy. Prior no-deploy language below records the ZIP preparation phase. Rollback baseline commit: `6ae2c708ae8e3b6414acd745fffaa443452aa670`. Existing persistent storage remains in place; the additive SQLite schema does not rewrite old financial records. No old Redis/Postgres resource is to be stopped or deleted. Production launcher runs web and worker as separate processes on the existing one-host disk.

# Future deployment checklist — DO NOT DEPLOY THIS PACKAGE NOW

No deployment was performed or authorized. Production readiness is blocked by the limitations/status report. The locally updated `render.yaml` has not been applied. Its build uses Qonvexa-only `verify`; the original mixed suite remains available as `verify:legacy` and its historical failure is preserved in TEST_REPORT.md. Active configuration has no Redis/Postgres binding. See ISOLATION_REPORT_UA.md before considering any legacy resource shutdown.

Future steps, only after separate owner authorization:

1. Back up source, original JSON/NDJSON and the new SQLite state using a consistent backup; record the rollback release.
2. Review `.env.example`, customer ownership, operational costs and all existing Render resources; do not delete resources based solely on the code inventory.
3. Resolve live-flow blockers and approve legal/privacy/refund disclosures.
4. Decide same-host web/worker supervision versus an explicitly implemented shared durable backend. Two Render services do not share an attached web disk. The current SQLite queue supports one machine, not distributed replicas.
5. Apply the additive schema only to staging first. Run fresh install, syntax, new suite and relevant legacy regressions.
7. Verify persistent disk path, permissions, encryption key management, backup restore, rate limits behind the actual reverse proxy, bounded jobs and retention.
8. Review and explicitly enable only the required live read/payment features. Implementation sending/writes remain unavailable until implemented and separately reviewed.
9. Run health, preview, private-link, payment webhook, jobs and disconnect smoke tests. Deploy only after acceptance and explicit authorization; then monitor errors and job lag.
10. Rollback: stop workers, disable new external actions, restore reviewed release and data snapshot, preserve financial records, reconcile ambiguous effects manually.

There is no production migration command or live deploy script added by this work.
