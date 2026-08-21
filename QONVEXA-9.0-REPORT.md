# QONVEXA 9.0 — Launch Preparation & Customer Purchase Experience

## Implemented as one stage
1. **Purchase logic** — replaced the single-submit checkout with a structured four-step purchase flow: Details → Review → Payment → Confirm.
2. **Customer guidance** — added contextual tips and clear explanations at each purchase step.
3. **Progress & review** — added a visible progress indicator, order review summary, one-time-price clarity and saved in-session purchase draft.
4. **Provider-neutral payments** — kept the stable hosted-card checkout path while adding `/api/purchase-options`, so the customer UX no longer needs to be rewritten when the final provider changes.
5. **Fallback payment with business details** — added configurable bank-transfer fallback. No bank data is fabricated; it is shown only when `MANUAL_PAYMENT_ENABLED=true` and real beneficiary/account details exist.
6. **Automatic post-payment handoff** — added a private order-status link for fallback orders, automatic status polling every 15 seconds and optional `DELIVERY_PORTAL_URL` handoff after confirmed payment. A personalized audit is never falsely marked as delivered before it exists.
7. **Mobile & tablet adaptation** — the purchase dialog becomes a full-height mobile flow with stacked fields/actions; order status and payment instructions adapt down to small phone widths.
8. **Final audit** — added a dedicated purchase audit plus the existing Render/preflight/smoke checks.

## New customer endpoints
- `GET /api/purchase-options`
- `POST /api/manual-order`
- `GET /api/order-status?token=...`
- `/order.html?token=...`

## Stable functionality preserved
- Free preview request
- Existing Stripe hosted checkout (when configured)
- Stripe webhook verification and paid-order fulfillment
- Owner dashboard
- Render deployment architecture
- Legal/SEO/staging controls from 8.0

## Important configuration
The fallback payment method is intentionally OFF by default.
To enable it with real business payment details:
- `MANUAL_PAYMENT_ENABLED=true`
- `BANK_BENEFICIARY`
- one of `BANK_IBAN` or `BANK_ACCOUNT`
- optionally `BANK_NAME`, `BANK_SWIFT`, `BANK_CURRENCY`, `BANK_PAYMENT_NOTE`

The customer never sees blank/fake bank details.

## Automatic delivery semantics
9.0 automatically provides:
- order creation confirmation,
- private order status,
- automatic transition display after payment confirmation,
- optional delivery-area link when `DELIVERY_PORTAL_URL` is configured.

It does **not** pretend a personalized audit has been completed instantly. If no delivery URL exists, paid customers see that their audit is confirmed and in preparation.

## Remaining external/manual items before live sales
- Final payment-provider approval and credentials (Payoneer review is external to this codebase).
- Real bank-transfer details if fallback payment will be enabled.
- Final legal business name/address, delivery timeframe and refund policy.
- Persistent production storage/database.
- Notification workflow destination.
- One real end-to-end payment test after the final provider is connected.
