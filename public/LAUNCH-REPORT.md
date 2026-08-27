# QONVEXA Launch Preparation Report

## Completed in this build
- Preserved the approved visual redesign and sales funnel.
- Added production configuration validation.
- Added server-side Stripe Checkout Session verification for the success page.
- Added paid-status checks before fulfillment.
- Added delayed payment success/failure webhook handling.
- Added idempotent fulfillment tracking for a single-instance MVP.
- Added in-memory rate limiting for preview, checkout, and status endpoints.
- Added a preview-form honeypot.
- Added configurable persistent storage directory.
- Added optional Make/Zapier/n8n notification webhook.
- Added IP hashing instead of storing raw IP addresses in preview logs.
- Added dynamic production values for canonical URL, legal identity, contact email, delivery timeframe, and refund policy.
- Replaced visible LEGAL DRAFT pages with configurable production templates.
- Added OG/Twitter metadata, favicon, and a generated OG preview image.
- Improved industry-tab keyboard and ARIA behavior.
- Added `success.js` and protected success messaging from unverified direct visits.
- Added `.gitignore`.
- Added Node engine requirement and check/smoke scripts.
- Added a static smoke test; all included checks passed.

## Manual items still required before domain launch
1. Buy/connect the final domain and set `SITE_URL=https://...`.
2. Create the real domain email and set `CONTACT_EMAIL`.
3. Fill legal business name, address, and jurisdiction.
4. Choose a delivery commitment you can consistently meet.
5. Choose/refine the refund/cancellation policy for your actual jurisdiction and business model.
6. Add Stripe live secret key and webhook signing secret.
7. Configure Stripe webhook events:
   - checkout.session.completed
   - checkout.session.async_payment_succeeded
   - checkout.session.async_payment_failed
8. Put `STORAGE_DIR` on persistent storage OR replace file storage with a database.
9. Optional but recommended: connect `NOTIFICATION_WEBHOOK_URL` to Make/Zapier/n8n so new preview requests and paid orders reach you immediately.
10. Run a real Stripe test-mode end-to-end payment after deployment, then switch to live credentials only after it passes.
11. Have the legal templates reviewed for the jurisdiction in which you operate.

## Test status
- `server.js`: syntax check passed.
- `public/app.js`: syntax check passed.
- `public/success.js`: syntax check passed.
- Static launch smoke test: passed.
- Full live HTTP/Stripe E2E test: not executed in this environment because installing runtime dependencies timed out and no real Stripe/domain credentials were supplied.
