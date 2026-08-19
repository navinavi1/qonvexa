# QONVEXA Production 7.0 — Final Audit

## Fixed in 7.0
- Updated Render Blueprint to current `runtime: node` syntax.
- Added the purchased custom domain `qonvexa.co` to the Render Blueprint.
- Added a paid Starter web service with a 1 GB persistent disk for lead/order/admin data.
- Set the Render region to Virginia for the primary US audience.
- Added generated Render secrets for admin session signing and IP hashing.
- Added staging/live launch modes so the first Render deployment can use Stripe test credentials without weakening the final live guard.
- `SITE_URL` now falls back to Render's `RENDER_EXTERNAL_URL` before the custom domain is connected.
- Live mode still refuses to start without final domain, payment, contact, legal, delivery and refund configuration.
- Added stricter admin password/session/salt requirements.
- Added same-site/origin checks to state-changing admin requests.
- Added no-store caching for admin pages/APIs.
- Added admin-session expiry cleanup.
- Status updates now verify that the lead/order actually exists.
- Admin default statuses are validated.
- Private admin notes are no longer duplicated into the activity log.
- Stripe fulfillment now retrieves a fresh Checkout Session and reconfirms `payment_status === paid` before writing an order.
- Added preflight validation, GitHub Actions checks and a GitHub→Render deployment guide.

## Intentionally not fabricated
These still require the owner's real/external information:
- official QONVEXA domain mailbox
- final legal business details
- delivery commitment
- refund/cancellation policy
- live payment credentials and webhook secret
- Namecheap DNS records supplied by Render during domain connection

## Test scope
The project can be syntax-checked and statically preflighted in this workspace. A full HTTP runtime test could not be executed here because npm dependency installation timed out. The final deployed service must therefore still receive one staging end-to-end test on Render before live launch.
