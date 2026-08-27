# QONVEXA Production 6.0 — Owner Dashboard & Launch Report

## Completed
- Public website design and business funnel preserved.
- Expanded `/admin` into a full owner dashboard.
- Overview metrics: previews, open leads, paid orders, active orders, clients.
- Lead pipeline statuses: new, reviewing, preview_sent, follow_up, won, lost, closed.
- Order fulfillment statuses: paid, queued, in_progress, ready, delivered, refunded, cancelled.
- Private admin notes for leads and orders.
- Aggregated client cards by email with preview count, order count and paid total.
- Search and status filtering.
- CSV export for leads, orders and clients.
- Activity/audit log.
- Owner settings for display name, future domain email, notification email and default statuses.
- Launch readiness indicators inside the dashboard.
- Domain-email preparation fields added to environment templates.
- Secrets remain server-side; Stripe keys and admin password are not exposed in the browser.
- Syntax/static smoke checks executed.

## Storage used by the owner dashboard
- `lead-state.json`
- `order-state.json`
- `admin-settings.json`
- `admin-events.ndjson`

These live under `STORAGE_DIR`, alongside the existing lead/order files.

## Manual items remaining before live domain launch
1. Final domain + DNS + HTTPS.
2. Domain mailbox/provider, then set your official QONVEXA email.
3. Real legal identity/address/jurisdiction appropriate to your operating setup.
4. Delivery timeframe and final refund/cancellation wording.
5. Stripe/live payment provider credentials and webhook.
6. Persistent production storage or database.
7. Strong ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_SESSION_SECRET.
8. Optional workflow/notification automation.
9. Deployed-domain end-to-end test.

## MVP architecture note
Admin sessions are still in server memory. This is fine for one Node server instance. For horizontal scaling or multiple instances, move sessions to Redis/database storage.

## Final verification
PASS:
- `server.js` syntax
- public `app.js` syntax
- `success.js` syntax
- Owner Dashboard `admin.js` syntax
- static project smoke test

Verified unchanged from Production 5.1:
- `public/index.html`
- `public/styles.css`
- `public/app.js`

Not claimed as completed:
- live HTTP integration test with installed npm dependencies (dependency installation timed out in this workspace)
- real payment-provider E2E transaction
- real domain/email/DNS test
