# QONVEXA — Full SaaS Redesign Changelog

## Scope
The public-facing QONVEXA experience was redesigned from the ground up while preserving the existing business flows and backend/API integration.

## What changed
- Rebuilt the public landing page into a modern, light SaaS/CRO visual system.
- Reworked the hero around the core QONVEXA story: traffic arrives, customers drop off, QONVEXA identifies conversion leaks, then recommends fixes.
- Added a CSS-driven browser/journey motion sequence with visitor flow, scanning, issue markers, and a live audit finding card.
- Reframed the value proposition around customer-journey friction instead of generic website auditing.
- Added the “Most websites don’t lose customers because they’re broken…” narrative section.
- Added a full customer-journey map from arrival to customer with leak points for clarity, trust, and form friction.
- Rebuilt “What QONVEXA sees” as a diagnostic dashboard with eight conversion lenses.
- Rebuilt the sample finding section as a premium evidence + diagnosis layout.
- Rebuilt industry examples into a more product-like interactive showcase while preserving existing tab logic.
- Rebuilt the free-preview experience around a prominent website URL scan action.
- Preserved “Find My Audit” and its existing API-driven lookup flow.
- Rebuilt pricing around one clear $149 one-time audit product.
- Reframed trust around transparency instead of invented testimonials or unverified performance claims.
- Rebuilt FAQ, final CTA, navigation, and footer to match the new visual system.
- Added responsive layouts for desktop, tablet, and mobile.
- Added reduced-motion support.

## Preserved business logic
The following existing flows and selectors were intentionally preserved:
- `POST /api/preview-request`
- `POST /api/find-mini-audit`
- `/api/purchase-options`
- `/api/create-checkout-session`
- `/api/manual-order`
- Four-step purchase dialog
- Card payment flow
- Bank-transfer flow
- Mini-audit lookup / unlock flow
- Admin, order-status, success, legal, and server routes

## Deployment / safety housekeeping
- Retained the existing deployment structure and Render configuration.
- Added explicit staging-payment defaults to the example environment files.
- Added the persistent-storage deployment invariant marker used by the project’s production audit.
- Preserved production cache and payment behavior.

## Validation performed
Passed:
- `npm run check`
- `node scripts/preflight.mjs`
- `node scripts/render-audit.mjs`
- `node scripts/purchase-audit.mjs`
- `node scripts/finalization-audit.mjs`
- HTML parser validation
- Duplicate-ID check (none found)

## Files most substantially changed
- `public/index.html`
- `public/styles.css`
- `.env.example`
- `.env.production.example`
- `server.js` (non-behavioral deployment invariant marker only)

