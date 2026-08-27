# QONVEXA Production 5.0 — Final Launch Checklist

## Already completed in code
- Approved design and funnel preserved.
- Preview form backend.
- Stripe Checkout.
- Server-side success verification.
- Stripe paid-status checks.
- Async payment webhook handling.
- Idempotent order fulfillment for single-instance MVP.
- Rate limiting.
- Honeypot anti-spam.
- Helmet security headers.
- SEO canonical/OG/Twitter structure.
- Favicon + OG image.
- Keyboard-accessible industry tabs.
- Legal templates no longer expose "LEGAL DRAFT" text.
- Persistent `STORAGE_DIR` support.
- Optional notification webhook.
- Production config validation.
- Syntax and static smoke tests.

## Admin added
- [x] Basic protected owner dashboard at `/admin`.
- [x] Preview requests table.
- [x] Paid orders table.
- [x] Search/filter + refresh + logout.

## Manual / external-only
- [ ] Buy or connect final domain.
- [ ] Create real domain email.
- [ ] Set legal entity name/address/jurisdiction.
- [ ] Set delivery timeframe.
- [ ] Finalize refund/cancellation policy.
- [ ] Add Stripe live secret key.
- [ ] Add Stripe live webhook signing secret.
- [ ] Configure Stripe webhook URL/events.
- [ ] Choose and configure persistent storage OR database.
- [ ] Optional: connect Make/Zapier/n8n notification webhook.
- [ ] Deploy to Node 20+ hosting.
- [ ] Run one full test-mode checkout on deployed domain.
- [ ] Review live legal pages.
- [ ] Switch Stripe from test to live only after all above passes.

## Do not change before launch unless necessary
- visual design
- core sales funnel
- audit price, unless intentionally repriced

- [ ] Set ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_SESSION_SECRET before production.

## Production 6.0 Owner Dashboard
- [x] Full owner overview.
- [x] Lead statuses and private notes.
- [x] Order fulfillment statuses and private notes.
- [x] Client aggregation.
- [x] Search and filtering.
- [x] CSV export.
- [x] Activity log.
- [x] Owner settings.
- [x] Domain-email preparation.


## QONVEXA 9.0 — Customer Purchase Experience
- [x] Four-step purchase flow.
- [x] Customer tips and progress.
- [x] Review-before-pay.
- [x] Provider-neutral payment-options API.
- [x] Configurable fallback bank transfer.
- [x] Private order-status page.
- [x] Automatic payment-status refresh / post-payment handoff.
- [x] Mobile and tablet checkout adaptation.
- [x] Dedicated purchase-flow audit.
- [ ] Final approved payment provider connected.
- [ ] Real fallback bank details enabled, if desired.
- [ ] Persistent production storage/database.
- [ ] Final live payment test.


## Production Finalization 9.1.0

- [x] Mobile navigation works below 900px.
- [x] Purchase progress exposes accessible current step.
- [x] Card and fallback purchases use the private order-status architecture.
- [x] Card order token is verified server-side.
- [x] Deliverable URL is per order, not global.
- [x] Pending fallback orders do not count as paid revenue.
- [x] Public staging paid checkout is disabled by default.
- [x] Live mode requires persistent `/var/lib/qonvexa` storage.
- [x] JS/CSS and dynamic HTML revalidate after deploys.
- [x] `/version` and `X-QONVEXA-Version` identify the deployed release.
- [x] Production Finalization automated audit passes.
- [ ] Configure real legal business name/address.
- [ ] Publish final delivery and refund terms.
- [ ] Configure approved live payment provider.
- [ ] Configure persistent Render disk or equivalent data store.
- [ ] Run one real end-to-end production payment.
