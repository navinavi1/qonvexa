# Unified AutonomOS resource release

Baseline: `cd74651b0bce34d1d097b867d476b0670ae9977c`.

## Five owner-requested changes

1. Runtime, marketplace hunters, TaskForce, Agrenting and the executor read one capability registry. Composio accounts must actually be ACTIVE; E2B must execute a probe; GitHub authentication must succeed. Shell availability does not prove browser/media support. Status distinguishes configured infrastructure from verified tools. Credentials changes invalidate cached proofs.
2. OpenAI, E2B, Composio and Trigger.dev remain owner-authorized and owner-capped. Their provider billing caps are owner-attested, not independently verified by this release. Application counters never change account subscriptions or top up credits.
3. Other resources have persistent pre-call application limits. Unknown hosted providers require verified zero-cost allowance evidence and disabled paid overage before use. Exhaustion stops that resource, starts replacement recovery, and leaves other jobs running. No marketplace is removed by this release.
4. CodeRabbit outages, missing credentials or unavailable free allowance use an independent LLM review through the already authorized model. A completed review with defects cannot be bypassed. High-value coding still requires actual tests and completed review.
5. New work must pay at least USD 5, or the owner's higher configured threshold. Persisted config, commissioning, marketplace workers and dashboard inputs use the same floor. Existing funded/accepted obligations are retried rather than discarded after missing-tool errors or a changed price floor. Existing 50/50 owner/agent treasury allocation remains.

## Application limits (not provider billing limits)

| Resource | Default local limit | Unit / reset |
| --- | ---: | --- |
| Public HTTP | 2,000 | calls / UTC day |
| DuckDuckGo search | 2,000 | calls / UTC day; provider throttling pauses this provider |
| GitHub | 4,000 | guarded tool calls / UTC day; upstream API rate limits still apply |
| Gmail | 200 | actions / UTC day |
| Google Drive / Sheets | 1,000 each | actions / UTC day |
| Google Calendar / Slack / Notion | 500 each | actions / UTC day |
| Canva / Figma | 50 / 100 | ordinary API actions / UTC day; premium/AI generation is not auto-authorized |
| Local delivery artifacts | 128 MiB | cumulative reserved bytes; 25 MiB maximum file; 128 MiB disk reserve |

`AUTONOMOS_FREE_RESOURCE_LIMITS_JSON` can lower direct-free application limits. Hosted allowances require `verifiedZeroCost: true`, `paidOverageDisabled: true`, `evidenceUrl`, a finite nonnegative `remainingUnits`, and a future `resetAt`. They additionally require a shared Redis reservation counter, so different runtimes cannot each spend the same remaining allowance. Evidence must describe the real account; defaults do not claim a free R2, CodeRabbit, Langfuse, Vercel or Netlify plan. R2 allowance units in this implementation are uploaded bytes; all provider billing dimensions must still have paid overage disabled externally.

Counters and temporary resource outages persist on the existing Render disk. Failed attempts conservatively consume reservations. HTTP 401 is an authentication problem; quota/credit/402 and 429 errors have separate recovery states. No credentials or account billing settings are exposed to worker prompts.

## Automatic replacement paths and limits

- Public web search falls back to GitHub public repository search with an explicit repository-only scope. A paywall on one scraped page does not disable all web access.
- R2 unavailability falls back to real downloadable files on the existing persistent Render disk. Public download URLs are random 192-bit capability URLs, exact-name checked, and served as attachments. Existing artifacts are not deleted automatically.
- Browser, media and document gaps install known open-source packages inside each job's existing E2B sandbox and run actual checks. No new hosting subscription is created. The packages are free; E2B compute remains under the owner's existing cap.
- Other gaps trigger public discovery and save replacement candidates. An unknown repository is not automatically trusted or advertised as installed. New credentials, OAuth permissions, unknown billing or a missing compatible implementation remain explicit verification requirements. There is no guarantee of an unlimited free equivalent for every service.
- Accepted jobs wait and retry on unavailable resources. Work on other eligible jobs continues. Skill acquisition rotates gaps so one unavailable integration does not indefinitely prevent checking the next.

## Launch and verification

The explicit owner-authorized launch migration runs once for enabled AutonomOS deployments. It enables the runtime, keeps the 50/50 allocation and raises old floors to USD 5. A subsequent owner stop/kill switch remains persistent across restarts. The existing Trigger task calls the Render runtime; this release does not create another execution scheduler or independently deploy another Trigger task.

`npm run verify` includes the focused `unified-resources-test` and all existing regression, execution, marketplace, startup and production checks. Build success is separate from actual marketplace acceptance, delivery and settled revenue. Allocation accounting is not proof of an on-chain transfer to the owner's wallet.

## Provider documentation checked

- [CodeRabbit CLI and over-limit consent](https://docs.coderabbit.ai/cli/)
- [Playwright browser installation](https://playwright.dev/docs/browsers)

## Publishing this archive

The ZIP contains the complete source tree with original static assets. Extract its contents into the repository and publish one commit. Render executes the extracted code; committing only a ZIP file would not update the running program. No secrets, local state, dependencies, or Git metadata belong in the archive.
