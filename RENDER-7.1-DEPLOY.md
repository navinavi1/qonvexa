# QONVEXA 7.1 — Existing Render service update

This build is for the existing `qonvexa` Web Service. Do not create another service.

## Push/update
Replace the repository contents with the complete contents of this 7.1 project root and commit to `main`.
Render should auto-deploy the new commit. If auto-deploy is disabled, use **Manual Deploy → Deploy latest commit**.

## Keep these current Render environment variables
- `LAUNCH_MODE=staging`
- `ADMIN_USERNAME` — your chosen admin login
- `ADMIN_PASSWORD` — at least 14 characters
- `ADMIN_SESSION_SECRET` — at least 32 characters
- `IP_HASH_SALT` — at least 24 characters

Do not add `ADMIN_IP_SALT`; the correct key is `IP_HASH_SALT`.

## Verify immediately after 7.1 deploy
1. Open `/health`. Expected: `ok: true` and `publicIndexAvailable: true`.
2. Open `/`. Expected: QONVEXA landing page, not `Not Found`.
3. Open `/admin`. Expected: owner login.

If `/health` says `publicIndexAvailable: false`, the GitHub repository does not contain the complete `public` folder. 7.1 now fails at startup when required public files are missing, so this should be visible directly in Render Logs.

## Why 7.1 changes the old behavior
Version 7.0 caught every homepage file/template error and returned a plain `Not found`, hiding the real filesystem error. Version 7.1 verifies the public bundle at startup and logs the exact failure instead.

## Staging vs live storage
The default `render.yaml` now uses a free staging Web Service and `./data`, so it does not force a paid persistent disk during testing. Local service filesystem on free Render is ephemeral; before accepting live paid orders, attach persistent storage or migrate operational data to a database and update `STORAGE_DIR`.
