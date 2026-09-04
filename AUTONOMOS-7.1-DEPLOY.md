# AutonomOS 7.1 — deploy checklist

## 1. Upload the package files

Upload the contents of this ZIP into the repository root, preserving the included paths. This package intentionally contains only changed/new files, not the full repository.

No files need to be deleted.

## 2. Deploy on Render

Deploy the updated repository normally. Do not delete the persistent disk/state directory before deployment: the v7.1 migration needs the old state to build permanent tombstones correctly.

## 3. First opening after a green deploy

Open `Admin -> AutonomOS` and confirm:

- header shows `AUTONOMOS 7.1 · PRODUCTION CLOSURE`;
- Mission Control has `System Blocked` and `Graveyard`;
- the funnel shows Raw / Paid / Above Floor / Executable / Profitable / Claimable / Ready;
- when runtime is already running, Start is disabled and displays `Running`;
- policy Global min payout is $25 after migration unless you intentionally set a different newer override.

## 4. Clean the old visible history once

Go to the Maintenance section and use:

`Archive Legacy History / Start Clean V7 History`

Use it only after the v7.1 deployment has booted and migration has run.

This archives old UI history but preserves:

- permanent tombstones / Graveyard memory;
- ledger and settled payment history;
- credentials;
- configuration.

The old $5,000/$600 outcomes should then stop dominating the live Recent Outcomes panel without making those jobs eligible again.

## 5. Run Live Self-Test

Click `Run Live Self-Test`.

This is safe: it scans health/discovery and does NOT claim jobs. Inspect any source reported Unavailable or Needs credentials before expecting that source to generate Ready work.

## 6. Keep competitive auto-submit OFF initially

`Auto-submit competitive bounties` defaults to OFF. Leave it OFF until the normal instant/bid pipeline is producing stable deliveries. Superteam prize listings are competitive opportunities, not guaranteed $5,000 jobs.

## 7. Check the funnel, not Raw Signals

The key number is `Ready`, not Raw Signals. If Ready is zero, use `Inspect Blockers`. Mission Control now exposes the blocker distribution so you can see whether the cause is payout floor, economics, missing capability, escrow, source mode, auth, registry or System Blocked state.

## 8. New external marketplace keys

No new credential is mandatory just to deploy this fix. New/watch marketplace credentials can be added later. Do not invent feed URLs or API keys.

Existing working ENV variables and integrations are preserved.

## 9. Verification command

Locally or in a compatible shell you can run:

`npm run verify`

The package passed this suite before delivery.

## 10. Revenue proof

After the first genuinely qualified job appears, verify one real lifecycle:

`discover -> normalize -> deduplicate -> preflight -> economics -> claim/bid -> execute phases -> aggregate evidence -> QA -> deliver -> settle -> paid`

Only after a real third-party marketplace completes that path should the installation be considered externally proven for that marketplace.
