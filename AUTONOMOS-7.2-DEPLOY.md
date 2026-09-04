# AutonomOS 7.2 deploy

1. Upload the files from this ZIP to the same repository paths.
2. Deploy on Render.
3. Do not manually delete Job Registry files.
4. On first runtime boot, `job-registry-policy-repair-v72.json` is created and previous over-broad policy tombstones are moved from Graveyard to Policy Hold where appropriate.
5. Open Mission Control and run `Scan New Jobs` once.
6. Verify the funnel is monotonically decreasing: Raw >= Paid >= Above Floor >= Executable >= Profitable >= Claimable >= Ready.
7. Check `Policy Hold` for $10+ jobs rejected only by economics/status/escrow. Check `Graveyard` for truly final external jobs.
8. Competitive Superteam work should appear under `Bid / Competitive`, not as accepted/Working work unless auto-submit is enabled and it passes all gates.

No new ENV keys are required for this patch.
