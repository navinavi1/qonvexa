# QONVEXA 7.0 — GitHub → Render

You are currently at the Render step where it says no repository was found. That is expected until QONVEXA is uploaded to GitHub.

## 1. Create the GitHub repository
1. Open GitHub.
2. Click **New repository**.
3. Repository name: `qonvexa`.
4. Choose **Private**.
5. Do not add a README, .gitignore, or license there — this project already includes its own files.
6. Create repository.

## 2. Upload this project
Upload the CONTENTS of the `qonvexa-landing-1.0` folder so that `package.json`, `server.js`, and `render.yaml` are at the repository root. Do not upload the outer ZIP as the application.

## 3. Return to Render
1. Refresh the repository selector.
2. Select the new `qonvexa` repository.
3. Render can read `render.yaml`, or you can create a Web Service from the repository.

## 4. First deploy = STAGING
Keep `LAUNCH_MODE=staging`. This allows the site to deploy with Stripe test credentials and before every legal/live value is finalized.

Render Blueprint 7.0 already declares:
- Node runtime
- Starter instance
- Virginia region
- health check `/health`
- persistent 1 GB disk
- custom domain `qonvexa.co`
- persistent storage path `/var/lib/qonvexa/data`

## 5. Environment values during initial setup
For the first deploy, the Blueprint asks only for `ADMIN_PASSWORD` (14+ characters). The admin username defaults to `owner`. Render generates `ADMIN_SESSION_SECRET` and `IP_HASH_SALT` automatically.

Stripe and legal/contact variables are intentionally **not** required for the first deployment. Add Stripe TEST keys later when we reach the payment-test step. Do not put secrets into GitHub.

## 6. Test on the Render URL
Before changing DNS, verify:
- home page opens
- `/health` returns `ok: true`
- preview form submits
- `/admin` login works
- data remains after a redeploy (persistent disk)
- Stripe test checkout and webhook work

## 7. Connect qonvexa.co
Render will show the DNS records required for the custom domain. Enter those records in Namecheap DNS. Wait until Render shows the domain as verified and HTTPS is active.

Then set:
`SITE_URL=https://qonvexa.co`

## 8. Go live
Only after the domain and test payment work:
1. Add the real domain email and legal values.
2. Replace Stripe test credentials with the live credentials for the payment provider you actually use.
3. Set `LAUNCH_MODE=live`.
4. Deploy.
5. Run one final end-to-end payment test appropriate for the live setup.
