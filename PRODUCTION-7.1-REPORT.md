# QONVEXA Production 7.1 — Render Post-Deploy Fix

## Render evidence
The supplied Render logs show earlier environment-variable failures, followed by a successful start and `Your service is live`. The remaining browser symptom was the homepage returning `Not Found`.

## Fixes in 7.1
- Public asset package is verified at process startup; deployment now fails clearly if `public/index.html` or other required assets are missing.
- Homepage rendering no longer silently converts filesystem/template failures into a misleading `404 Not found`; it logs the real error and returns a deployment-specific 500.
- Added a deployment-safe root `index.html` fallback while preserving `public/index.html` as the canonical source.
- Explicit homepage and dynamic SEO/admin routes are registered before `express.static`.
- Fixed route-order risk where static `admin.html`, `robots.txt`, or `sitemap.xml` could bypass dedicated handlers.
- Admin assets are forced to `Cache-Control: no-store`.
- Server binds explicitly to `0.0.0.0` and Render's `PORT`.
- `/health` now confirms whether the public homepage file exists.
- Added staging-only homepage request logging to make the next Render diagnosis immediate.
- Added Render-specific route/deployment audit script.
- Bounded Node to `>=22 <25`; Render documentation warns that unbounded ranges such as `>=20` can jump major versions unexpectedly.
- Pinned direct dependency versions instead of floating caret ranges.

## Deployment procedure
Push the complete contents of this 7.1 project root to the existing GitHub repository root. On Render use the existing Web Service and deploy the latest commit. Keep `LAUNCH_MODE=staging` until domain/payment/legal configuration is complete.

## Expected checks after deploy
- `/health` returns JSON with `ok: true` and `publicIndexAvailable: true`.
- `/` renders the QONVEXA landing page.
- `/admin` renders the owner login page.
- `/robots.txt` and `/sitemap.xml` contain the runtime site URL rather than `{{SITE_URL}}`.

## Staging cost/config clarification
The default `render.yaml` in 7.1 is intentionally a free staging configuration and no longer forces a paid persistent disk. This matches the current Render service used for troubleshooting. Before live paid traffic, persistent storage or a database is still required for durable lead/order/admin data.

## Node runtime
Added `.node-version` pinned to Render's documented current default `24.14.1`, while `package.json` keeps an upper-bounded compatible range. This prevents the old unbounded `>=20` range from unexpectedly selecting Node 26+.
