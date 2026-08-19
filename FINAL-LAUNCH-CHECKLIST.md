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
