# AutonomOS 7.7 production repair

Changed-files overlay for `qonvexa-main (30)`.

## Fixed from live production evidence
- $0.50 is now the minimum payout, not the target; higher-value executable work is preferred.
- Commissioning remains one safe unproven crypto job at a time, but ranking no longer picks the cheapest job.
- Claimed-job recovery revalidates capabilities before retrying and stops burning budget on impossible jobs.
- Passport Connect buy/swap/send tasks are blocked preclaim when they require unsupported procurement/wallet side effects.
- X posting requires a real connected X app, not only a Composio key.
- New-agent referral/invite tasks are blocked instead of blindly claimed.
- QA no longer fails solely because an optional tool attempt failed; required evidence is still checked.
- Default LLM timeout raised 60s → 120s.
- Render Postgres memory TLS fixed for the observed self-signed certificate error.
- Trigger.dev callback wait raised 20m → 28m inside the 30m task cap.
- Active runtime/UI version labels updated to 7.7.

## Owner actions
1. Overlay this package into the current repo; commit/push.
2. Let Render deploy.
3. Run `npm run trigger-deploy` from the repo so Trigger.dev receives the updated task bundle too. Render deploy alone does not update Trigger.dev.
4. Do not add fake `AUTONOMOS_CONNECTED_APPS`; list only apps that are actually connected.
5. After both deploys: run **Live Self-Test**, then **Scan New Jobs** once.

Full `npm run verify` passes.
