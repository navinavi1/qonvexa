# QONVEXA Production 5.0 — Deploy Guide

## Recommended hosting shape
Use a host that supports:
- Node.js 20+
- persistent disk or attached database
- HTTPS custom domain
- environment variables
- public inbound webhook endpoint

## Build / start
No build step is required.

Start command:
`npm start`

Health check:
`/health`

## Required production environment
Copy `.env.production.example` to your host's secret/environment settings and fill all values.

Production intentionally fails fast if required fields are missing.

## Stripe
Create webhook:
`https://YOUR-DOMAIN.com/stripe/webhook`

Subscribe to:
- checkout.session.completed
- checkout.session.async_payment_succeeded
- checkout.session.async_payment_failed

Run test mode first. Only after a successful end-to-end test should you switch to live keys.

## Persistent data
Current MVP stores:
- preview-requests.ndjson
- orders.ndjson
- fulfilled-sessions.json
- payment-failures.ndjson

Point `STORAGE_DIR` to persistent storage. Do not use ephemeral filesystem for live orders.

## Notifications
Optional but strongly recommended:
connect `NOTIFICATION_WEBHOOK_URL` to Make, Zapier, n8n or another workflow so you receive:
- preview_request
- paid_order

## Launch sequence
1. Deploy with test Stripe keys.
2. Connect domain + HTTPS.
3. Configure Stripe test webhook.
4. Submit preview request.
5. Verify lead storage/notification.
6. Complete Stripe test checkout.
7. Verify webhook records paid order once.
8. Verify success page reports paid only after Stripe verification.
9. Review legal/contact/delivery text live.
10. Switch to Stripe live keys + live webhook.
11. Repeat one small live end-to-end transaction if appropriate for your setup.
