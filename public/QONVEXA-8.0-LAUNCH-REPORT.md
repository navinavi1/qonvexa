# QONVEXA 8.0 — Launch Preparation Report

## Completed in 8.0
- Preserved the approved public design and owner dashboard.
- Wired the real business contact email `hello@qonvexa.co`.
- Removed the public footer launch-placeholder sentence.
- Fixed the non-JavaScript / crawler price fallback so the launch price is `$149`, not `$0`.
- Made checkout wording payment-provider-neutral while Payoneer review is pending.
- Added staging-safe legal fallbacks so public pages do not expose `*_NOT_CONFIGURED` strings.
- Legal pages are `noindex,nofollow` in staging and become indexable only in `LAUNCH_MODE=live`.
- Added `/launch-readiness` JSON endpoint to show what still blocks live sales.
- Pinned the known production site URL and contact email in environment templates.
- Kept live-mode validation strict: real legal business name/address, delivery terms, refund policy and final payment provider are still required before live sales.
- Strengthened preflight checks against public placeholder text and the old `$0` fallback.

## Still intentionally NOT fabricated
The following need real operator/business decisions or external approval:
- LEGAL_BUSINESS_NAME
- LEGAL_ADDRESS
- final DELIVERY_TIMEFRAME
- final REFUND_POLICY_TEXT
- final payment-provider integration / credentials
- persistent production storage or database
- notification workflow destination

## Payment status
Payoneer onboarding is currently external and pending review. QONVEXA 8.0 therefore does not pretend Payoneer is integrated.
The existing Stripe backend remains in the codebase until the final payment method is approved, but public copy no longer claims Stripe specifically.

## Recommended next step
After Payoneer approval:
1. Confirm which Payoneer checkout/request-payment capability is available to this business account.
2. Decide final payment flow.
3. Implement payment adapter.
4. Configure persistent lead/order storage.
5. Fill legal/delivery/refund values.
6. Switch `LAUNCH_MODE=live`.
7. Run one full end-to-end live-domain test.
