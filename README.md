# QONVEXA — Launch-prepared build

## What this build includes
- Existing approved redesign preserved.
- Stripe Checkout session creation.
- Server-side payment verification for the success page.
- Webhook handling for immediate and delayed successful payments.
- Idempotent paid-order fulfillment for a single-instance MVP.
- Preview/checkout rate limiting and preview honeypot.
- Persistent-storage path configurable via `STORAGE_DIR`.
- Optional notification webhook for Make/Zapier/n8n.
- Production config guard: the server refuses to start if required legal/payment values are missing.
- Dynamic canonical/OG metadata and generated social preview image.
- Keyboard-accessible industry tabs and reduced-motion support.
- Legal pages converted from visible drafts into configurable templates.

## Local check
1. Copy `.env.example` to `.env`.
2. Keep `NODE_ENV=development`.
3. Add Stripe test keys if you want to test checkout.
4. Run:
   `npm install`
   `npm run check`
   `npm start`

Open `http://localhost:3000`.

## Before production
Set `NODE_ENV=production` and fill every required value in `.env`:
- `SITE_URL` — final HTTPS domain.
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `CONTACT_EMAIL`
- `LEGAL_BUSINESS_NAME`
- `LEGAL_ADDRESS`
- `LEGAL_JURISDICTION`
- `DELIVERY_TIMEFRAME`
- `REFUND_POLICY_TEXT`
- `IP_HASH_SALT`

The production server intentionally refuses to start if critical values are missing.

## Stripe webhook
Configure:
`https://YOUR-DOMAIN/stripe/webhook`

Listen for:
- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`

The code only fulfills an order when `payment_status === "paid"`.

## Storage
This MVP writes:
- `preview-requests.ndjson`
- `orders.ndjson`
- `fulfilled-sessions.json`
- `payment-failures.ndjson`

Use `STORAGE_DIR` on a persistent disk. If your host has ephemeral/serverless storage, move this data to a real database before taking live orders.

## Notifications
Set `NOTIFICATION_WEBHOOK_URL` to a webhook from Make, Zapier, n8n, or another system. QONVEXA will POST `preview_request` and `paid_order` events there.

## Manual launch items
This repository cannot know your real:
- domain,
- legal entity/address/jurisdiction,
- operational support email,
- delivery commitment,
- refund/cancellation policy,
- Stripe live credentials,
- webhook signing secret.

Those must be supplied by the operator before production.

## Admin dashboard
Open `/admin`.

Configure:
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`

The admin dashboard shows recent preview requests and paid orders from the configured storage directory.
Use a long unique password and a long random session secret in production.

## Production 6.0 Owner Dashboard
Open `/admin` after configuring the admin credentials.

Views:
- Overview
- Leads
- Orders
- Clients
- Activity
- Settings

The dashboard stores operational statuses, notes, settings and event logs under `STORAGE_DIR`.
CSV exports are available for leads, orders and clients.

Domain-email fields in Settings are preparation metadata only; actual mailbox creation happens with your domain/email provider.


## Production 7.0
Use `GITHUB-RENDER-DEPLOY.md` for the next step. The project is now designed to deploy first in `LAUNCH_MODE=staging`, then switch to `LAUNCH_MODE=live` only after qonvexa.co, legal/contact details and live payments are ready.


## QONVEXA 9.0 Purchase Experience
The customer checkout is now a four-step flow:
1. Details
2. Review
3. Payment
4. Confirmation

Payment methods are server-driven through `/api/purchase-options`.

### Card checkout
The existing hosted Stripe checkout remains available when Stripe credentials are configured.

### Bank-transfer fallback
Bank transfer is OFF by default. It becomes visible only when:
- `MANUAL_PAYMENT_ENABLED=true`
- `BANK_BENEFICIARY` is set
- `BANK_IBAN` or `BANK_ACCOUNT` is set

Optional:
- `BANK_NAME`
- `BANK_SWIFT`
- `BANK_CURRENCY`
- `BANK_PAYMENT_NOTE`

Customers receive a private `/order.html?token=...` status link. It refreshes automatically while payment is pending.

### Post-payment handoff
If `DELIVERY_PORTAL_URL` is configured, the private order page exposes that URL only after confirmed payment status. Otherwise the customer is told that the personalized audit is in preparation.


## Production Finalization (9.1.0)

Production Finalization preserves the 9.0 funnel while hardening the release for real customers.

Key additions:
- responsive mobile navigation;
- unified private order status for card and bank-transfer flows;
- per-order secure deliverable URLs;
- staging payment safety gate;
- live persistent-storage guard;
- correct paid-order/revenue metrics;
- cache revalidation for unfingerprinted JS/CSS;
- `/version` deployment marker;
- improved checkout accessibility.

Before live sales, configure the real legal values, approved live payment credentials and persistent storage. See `QONVEXA-PRODUCTION-FINALIZATION-REPORT.md`.

## AutonomOS 1.0 (QONVEXA 12.0)

This build embeds the private AutonomOS owner control plane at `/admin#autonomos` and a background 20-agent autonomous runtime under the existing QONVEXA server. It includes six x402-v2 machine products, Base/USDC receiver settlement to the configured public owner wallet, persistent market/profit/job state, bounded price optimization, child-worker replication, zero-spend policy enforcement and an emergency-stop latch.

See `AUTONOMOS-1.0-REPORT.md` and `AUTONOMOS-DEPLOY.md` for the full architecture and activation notes. Never store a seed phrase/private key in this repository or in QONVEXA environment variables intended for the receive-only seller rail.

## AutonomOS 2.0

AutonomOS 2.0 adds a global marketplace job engine on top of the existing QONVEXA owner control plane. It normalizes external jobs, checks safety/capability/unit economics before claiming, can auto-bootstrap Clawlancer, supports t2000 Passport Connect over MCP when a session is supplied, discovers Agentverse functions, retains x402 seller/discovery, tracks multi-chain EVM treasury balances, and exposes separate Opportunity / Claimed / Delivered / Paid counters so heartbeat cycles are never confused with revenue-producing work.

See `AUTONOMOS-2.0-REPORT.md` and `AUTONOMOS-2.0-DEPLOY.md`.
Trigger.dev production deployment sync.
