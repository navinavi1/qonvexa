# AutonomOS 7.6 — deploy handoff

Source baseline: `qonvexa-main (29)`.

## Apply
1. Back up the current repository/Render service.
2. Copy every file in this package over the repository root, preserving paths.
3. Delete every path listed in `AUTONOMOS-7.6-DELETE-FILES.txt`.
4. Run `npm install` only if your lockfile/dependencies require it; package changes here are script wiring, not an intentional dependency upgrade.
5. Run `npm run verify` and require a full PASS.
6. Commit and push to the branch Render deploys.
7. Deploy on Render.

## Required production checks after deploy
- Mission Control reports runtime 7.6.0.
- Funnel says **Priced**, not Paid, before settlement.
- Marketplace lifecycle status is one of `FULL AUTO`, `AUTO WORK · CASHOUT ACTION`, or `DISCOVERY ONLY`.
- Old x402 Bazaar operational pollution is removed by the one-time registry repair.
- Old Dealwork buyer-funding/config tombstones are converted to timed Policy Hold rather than permanent Graveyard.
- Commissioning mode permits at most one safe crypto-native canary before the first real crypto settlement.
- A claimed job survives restart without a second marketplace claim.
- A marketplace-accepted delivery survives restart without duplicate delivery.
- Settlement is reconciled to exact marketplace job identity and creates one deterministic ledger revenue row.
- `Paid` overrides stale local tombstones for the same job identity.
- Dashboard distinguishes marketplace settlement from owner-wallet arrival/cash-out action.

## Production truth
A green local verification proves code paths and recovery invariants. It does **not** guarantee that a marketplace currently has an eligible job, that a third-party API will accept a claim, or that a marketplace will release funds. Mission Control should surface the live blocker instead of representing those conditions as success.
