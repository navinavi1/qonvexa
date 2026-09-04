# AutonomOS 7.2 — Filter Recovery Report

## What was wrong
- Graveyard was too aggressive: payout-floor, economics, escrow and ambiguous `status_not_open:*` rejections could become permanent tombstones.
- Existing v7.1 policy tombstones therefore contained viable-looking $30-$100 jobs.
- Competitive jobs could remain in New when auto-submit was disabled instead of being shown as proposals.
- Funnel counters were not strict subsets (`profitable` could be lower than `claimable`).
- Funnel/yield snapshots were computed before registry dispositions, so counters and queue tabs could describe different moments.
- v5 payout defaults were still $25 (t2000 $35), hiding the requested $10-$24 work.

## What changed
- Added reversible `policy_hold` lane. Low payout, economics, escrow, source-policy and ambiguous status failures no longer become permanent Graveyard entries.
- Graveyard is now reserved for externally final conditions (explicit closed/expired/cancelled/removed/rejected/filled/completed), demo/test listings, and existing market terminal failures.
- Added one-time v7.2 repair that rescues old over-broad policy tombstones into Policy Hold for re-evaluation. Explicit final-status tombstones remain permanent.
- Competitive/bid jobs are routed to Proposal when the only blocker is auto-submit being disabled; they are not presented as accepted/working jobs.
- Added Policy Hold KPI + tab to Mission Control.
- Rebuilt funnel as strict nested stages: Raw → Paid → Above Floor → Executable → Profitable → Claimable → Ready.
- Funnel and marketplace yield now update after disposition/classification.
- Production floor defaults migrated to $10 for global/Clawlancer/Dealwork/Superteam/t2000 open jobs.
- Minimum margin relaxed from 35% to 20%; API/model-cost ceiling raised from 25% to 35% of payout.
- t2000 priority/premium tiers changed to $25/$50.

## Important behavior
- There is no hard maximum payout. A $3,000/$5,000 job is not rejected because it is expensive; it must pass capability/economics/mode rules.
- Competitive jobs are not guaranteed work. With auto-submit disabled they remain visible in Bid/Competitive but agents do not spend money executing them.
- Policy Hold jobs are invisible to execution agents but re-evaluated on later scans. Graveyard jobs stay permanent.

## Verification
`npm run verify` passed after the final changes:
- General audit: 62/62
- AutonomOS audit: 27/27
- Job Registry test: PASS
- AutonomOS 7.1 regression: PASS (updated with v7.2 policy migration/rescue assertions)
- Flow/platform/workforce/agency intelligence: PASS
- t2000 OAuth/connector: PASS
- preflight/render/purchase/finalization/smoke: PASS

## External caveat
Passing repository tests proves internal behavior, not that a marketplace will currently expose a claimable paid job. Production confirmation still requires a live scan and at least one real marketplace claim/bid/delivery cycle.
