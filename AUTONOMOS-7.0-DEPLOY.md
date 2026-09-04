# AutonomOS 7.0 — Upload & Setup

## Upload
The delivery ZIP contains only files that are new or changed relative to the uploaded source ZIP. Upload them to the same repository paths, preserving folders.

After GitHub receives the files, deploy the same Render service as usual and wait for a clean build/start.

## Existing integrations
Keep the existing environment variables and credentials already used by the project. Do not remove working marketplace or infrastructure keys.

## New optional marketplace settings
Add only the values you actually obtain from official marketplace accounts/docs:

```env
CLAWJOBS_API_KEY=
LABORX_AGENT_FEED_URL=
LABORX_API_KEY=
DEWORK_BOUNTY_FEED_URL=
DEWORK_API_KEY=
BOUNTYCASTER_FEED_URL=
BOUNTYCASTER_API_KEY=
QUESTBOOK_FEED_URL=
QUESTBOOK_API_KEY=
```

### ClawJobs
Public job discovery works without a key. Create/register an account/agent only if you want to submit proposals. The platform documents a worker stake requirement. AutonomOS does not store a private key or automatically sign that stake transaction, so do not paste seed phrases/private keys into Render.

### LaborX / Dework / Bountycaster / Questbook
These are deliberately shipped as disabled discovery/watch adapters. Enable one only after you have a verified official JSON feed/API endpoint and, if needed, an API key. This prevents false integrations based on guessed URLs.

## First production check after deploy
1. Open Admin -> AutonomOS.
2. Confirm header says **AutonomOS 7.0 / Mission Control**.
3. Press **Scan new jobs** once.
4. Verify Ready/New/Bid-Competitive/Retry/Graveyard lanes populate independently.
5. Do **not** expect old terminal jobs to reappear after another scan or service restart.
6. Confirm active jobs show Agent, ETA, deadline, payout/currency and execution mode.
7. Confirm marketplace health shows sources separately.
8. Keep the global minimum payout at `$25` initially unless you intentionally want cheaper jobs.
9. Keep t2000 Open Jobs floor at `$35` initially; Seller Orders are handled separately.

## What changed about the old Reset button
There is no normal dashboard control that clears permanent job history. **Retry transient** only releases temporary failures. The compatibility API route remains for old clients but also preserves the permanent registry.

## Rollback
If deployment itself fails, revert the commit containing this packet. Do not manually delete the persistent AutonomOS state directory just to make jobs reappear, because that also discards the durable registry/history the v7 rebuild is designed to preserve.
