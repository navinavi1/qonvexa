# Implementation status

Status is scoped to the stated behavior, not the aspirational full product. **No live implementation sales/execution or complete CRM OAuth is shipped.** DONE does not mean provider production certification.

| Component | Status | Actually implemented | Verification | Remaining work / reason |
|---|---|---|---|---|
| Source/funnel compatibility | PARTIAL | Existing lead/order/client/admin/prepared delivery preserved; private-key migration for mini-audits. | Public-site/payment/admin tests; targeted review. | Not line-by-line certification of all legacy earning code. |
| AutonomOS hard isolation | DONE | Normal start and old startup alias run web only; runtime import removed; legacy routes 410. | Hostile legacy flags + no legacy state + startup tests. | Standalone old source remains available, not an active service. |
| Web / job process separation | DONE | Separate worker entrypoint, no crawling in HTTP request. | Worker configuration failure leaves health endpoint responsive. | No multi-host deployment backend. |
| Durable jobs / restart / leases | DONE | SQLite WAL, transactional claim, lease token fencing, bounded attempts. | Concurrent handles, expired leases, worker error tests. | Single local persistent disk required. |
| Public safe scanner | PARTIAL | Pinned public DNS, redirects, origin/page/byte/type/time limits. | Adversarial mocked transport and DNS tests. | No browser rendering, robots evaluator, sitemap parser, comprehensive link graph. |
| Audit engine / evidence | PARTIAL | Structured deterministic findings, evidence/provenance/freshness, confidence/severity/impact. | Rule/evidence/preview tests. | 20 module registry does not mean 20 fully automated checks. |
| Conversion / Mobile / Trust | PARTIAL | Static CTA/form/viewport observations and explicit review coverage. | Fixture findings. | Rendered journey/tap targets/screenshots/trust fact checks need browser/provider work. |
| Technical SEO / content / linking | PARTIAL | Titles, descriptions, headings, canonical/noindex, status, metadata, bounded linked pages. | Parser and crawler fixtures. | Full duplicate/redirect/link inventory and sitemap coverage absent. |
| Performance / CWV | PARTIAL | Response bytes, sampled TTFB, image dimension/script observations. | No fake CWV tests. | LCP/INP/CLS/Lighthouse/CrUX and optimization adapters absent. |
| Schema | PARTIAL | JSON-LD existence and parse errors. | Invalid JSON fixture. | Type semantics and live insertion not implemented; no fake ratings. |
| Local SEO / service-location clarity | PARTIAL | Module coverage explicitly asks for verified business facts. | Coverage output tests. | NAP reconciliation, maps/location comparisons and live changes absent. |
| AI Search/GEO | PARTIAL | Static text/structured-data readiness plus no-ranking claim. | Evidence tests. | No AI visibility measurement or guaranteed recommendation. |
| Analytics / GA4 | PARTIAL | Static markers, event plan, correlated-receipt contract. | No-success-without-receipt test. | Actual OAuth/data API event receipt absent. |
| GTM / GSC | NOT IMPLEMENTED | Explicit integration boundaries/status only. | UI does not claim connection. | Need official flow implementation and authorized test properties. |
| Lead capture / CRM follow-up / booking | PARTIAL | Static forms/contact markers and review requirements. | Form-label findings and tracking plan. | No real submits, booking reminders or lead-delivery validation. |
| Accessibility baseline | PARTIAL | ALT/label/control observations and legal disclaimer. | Parser tests. | Computed contrast, keyboard/ARIA tree and visual checks absent. |
| Security baseline | PARTIAL | HTTPS, header presence, insecure forms, mixed references. | Fixture findings; SSRF separate. | No cert-expiry inspector or authorized plugin/theme update scan. |
| E-commerce | PARTIAL | Applicability signal only; manual review status. | Registry/coverage tests. | No transactional checkout QA or product semantic audit. |
| Reputation/reviews | PARTIAL | Module and catalogue/playbook design. | No fake success output. | No review provider/workflow implementation. |
| Free mini-audit | DONE | Maximum 3 HIGH-confidence findings, additional count, server-configured price. | Unit + customer journey. | Can show fewer than 3; never fabricates findings. |
| Full audit/report web view | PARTIAL | Structured paid report, facts, coverage, recommendations, web UI. | Paid fixture journey and JSDOM. | No polished downloadable PDF; not every requested business section has deep analysis. |
| Find My Audit | DONE | Email plus private key; existing staff findings preserved with limited scope. | Updated public-site regression + enumeration/IDOR tests. | Legacy customers need a staff-issued key; no automated email recovery. |
| Service catalogue / service matrix | DONE | 12 configured products, capabilities, price rules, DoD, risk and rollback design. | 12-service and matrix tests. | All live executors deliberately unavailable. |
| Preflight | PARTIAL | Fail-closed capabilities, platform, permission, freshness, backup, cost, executor gates. | Unsupported/missing/stale/absent executor tests. | Live capabilities/plan/backup discovery incomplete. |
| Quote / scope / expiry | PARTIAL | Evidence-linked scope, hash, price, external ownership/cost disclosure, expiry, acceptance guard. | Quote scope/expiry tests. | No accepted paid implementation order or change-request workflow. |
| Implementation payment | NOT IMPLEMENTED | Checkout blocked for all unsupported execution. | Acceptance gate tested. | Need released executor + verified capabilities + payment/order integration. |
| WordPress | PARTIAL | Documented HTTPS Application Password user capability probe. | Mock permission/auth/TLS tests. | No onboarding, builder/plugin/backup discovery, write or provider revocation. |
| Pipedrive | PARTIAL | Official v2 pipeline read probe; no inferred write entitlement. | Success/failure fixtures. | OAuth lifecycle/plan/writes missing. |
| Zoho | PARTIAL | Official v8 org read probe and data-center allowlist. | Mock org/domain tests. | OAuth lifecycle/edition/workflow/functions/write support missing. |
| Access Center / secrets | PARTIAL | Encrypted store, public projection, owner checks, local disconnect, status UI. | Cipher/AAD/IDOR/disconnect tests. | UI onboarding and remote revoke absent; does not collect credentials. |
| OAuth | PARTIAL | Single-use expiring owner-bound state + exact redirect allowlist. | Replay/wrong-owner/redirect tests. | Provider exchange/refresh/revocation not shipped. |
| Implementation runner | PARTIAL | Plan generation; fixture-only allowlist, stable IDs, journaling, uncertain-state holds. | Dry-run/payment/approval/idempotency tests. | No live execution path. |
| Approvals | PARTIAL | Scope-bound plan approval and fixture risk gates. | Wrong-scope/high-risk tests and UI. | No live high-risk action can run; approval is not deployment. |
| Backup / rollback / before-after | PARTIAL | Fixture snapshot, before/after values, conflict-aware rollback. | QA failure rollback and ambiguous response tests. | No production backup/screenshot/performance comparison adapter. |
| QA / Definition of Done | PARTIAL | Machine-readable checks, VERIFIED readback requirement. | DoD, API ACCEPTED rejection, fixture success/failure. | No real provider E2E delivery QA. |
| Client portal | PARTIAL | Audit/recommendations/quotes/access/plans/approval/results/handoff sections. | Real local backend + JSDOM. | Actual completed handoff unavailable until live executor exists. |
| Handoff / disconnect | PARTIAL | Ownership disclosures, local credential deletion, explicit remote action notice. | Disconnect and close-access tests. | Remote revocation and live handoff artifacts missing. |
| Warranty/support | PARTIAL | Configurable warranty disclosed in quote. | Quote shape. | No ticketing/SLA automation; no unlimited support. |
| Outreach / discovery | PARTIAL | Drafts, high-confidence evidence, country policy, opportunity score, daily cap. | Compliance/draft/fit tests. | No discovery/search integration or sending. |
| Unsubscribe / suppression | DONE | Opaque opt-out link, replay-safe suppression check before drafts. | Suppression/redeem tests. | No real email sent; future send adapter must invoke guard again. |
| Niche playbooks | DONE | Dental, Med Spa, HVAC, Roofing config with shared workflow/modules. | JSON parsed in syntax/review; catalogue references. | No bespoke live niche automation yet. |
| AI assistant / knowledge | PARTIAL | Provenanced entries, approval/removal, exact approved-answer fallback. | No unapproved-answer test. | No deployed chatbot, semantic retrieval, bookings or lead collection. |
| Email / SMS / WhatsApp adapters | NOT IMPLEMENTED | Explicit provider boundaries and customer-owned billing. | No fake connection UI. | Need approved provider selection, consent and test account. |
| Cost ledger / unit economics | PARTIAL | Idempotent reservations/settlement, scan cap enforcement, estimate/actual distinction. | Cap/duplicate/settlement tests. | No provider invoice import, implementation cap wiring or revenue reconciliation. |
| Observability | PARTIAL | Structured identifier-only events, jobs/errors/admin views. | Worker/event/status journey. | Not every planned event exists without live integrations; no metric backend. |
| Cache / abuse limits | PARTIAL | Per-IP rate, domain cooldown, exact public result reuse with freshness, daily caps. | Cache/ownership path in journey. | No CAPTCHA, distributed rate limits or Redis; file scans remain MVP scale. |
| Retention / deletion | PARTIAL | Explicit local cleanup and close-access functions; no raw HTML stored. | Retention/cancel/session invalidation tests. | Operator scheduling and legacy accounting retention policy still needed. |
| Bank-transfer audit payment | DONE | Server price, pending order, authorized admin confirmation, private token access. | Local customer journey, spoofed amount/status and unauthorized confirmation tests. | Bank receipt must be checked manually; no automatic bank reconciliation. |
| Admin | PARTIAL | Existing leads/orders/clients/activity preserved; new audit/quote/job/access/QA-plan/cost views. | Admin regression and cross-origin/auth tests. | Full service toggles/quote-adjustment/pause UI incomplete. |
| Security review | PARTIAL | Targeted source + adversarial local tests for auth/IDOR/SSRF/payment/secrets. | New suite + legacy regressions. | Not external penetration test or security guarantee. |
| Persistence/migrations | DONE | Additive idempotent SQLite schema, existing business files preserved. | Fresh Store and multiple DB handles. | One-host local filesystem only. |
| Dependency and paid-services review | DONE | Actual import inventory, unchanged versions, jsdom production classification, npm audit. | Audit JSON and lockfile comparison. | No billing dashboard accessed; subscription cancellation not performed. |
| Documentation / packaging | DONE | Required reports, clean source archive, extracted fresh-install validation. | Final archive procedure in TEST_REPORT. | No deployment authorization. |
| Production deployment | NOT APPLICABLE | Explicitly prohibited; no external changes. | Local-only workflow. | Requires a separate future command and resolution of blockers. |

All unimplemented independent provider features require further development, not simply entering production secrets. Do not enable checkout for them. The final delivery respects the brief’s P0-first/transparent-partial clause; this is not a claim that all 163 requirements are complete.

## Isolation update — 2026-09-27

Qonvexa web/worker require neither external Redis nor PostgreSQL. Active deployment/env configuration and production verification are separated from legacy; original configuration is retained under docs/legacy. Data models are unchanged. Existing resource consumers in Render have NOT been inventoried. See ISOLATION_REPORT_UA.md for conditional shutdown criteria. No infrastructure action was performed.
