# Security model and verification limits

## Access

New customer sessions use 32 random bytes, SHA-256 identifiers at rest and owner-scoped record lookups. Links put the key in a fragment, remove it from the visible page and use Authorization bearer headers. No localStorage or browser credential storage. Anyone with the private link has bearer access; automated email identity verification/recovery is not shipped. Treat links as sensitive. Old order links retain their existing 24-byte token contract. Find My Audit now needs email AND key; old mini-audit contents are not exposed through email enumeration.

Existing admin authentication, persistent signed/session-token protections and same-site mutation checks remain. New admin endpoints use these guards. Bearer-only customer mutations have no cookie-based ambient authentication and no permissive CORS. Reverse proxy trust/rate limiting must be reviewed in the actual hosting topology; in-memory rate buckets are one-process only.

## Scanner

HTTP/HTTPS only, no embedded credentials, sensitive query credentials rejected, ports restricted, localhost/private/link-local/metadata/reserved IPv4 and private/special IPv6 denied. IPv6 policy is conservative (some valid public 2001 ranges excluded). All resolved IPs must be public. Validated DNS is pinned to the socket; destinations revalidated on each redirect. Authenticated reads cannot redirect at all. Same-origin pages, max redirects 3, free pages 2/paid 10 plus robots/sitemap probes, per-resource bytes/time/content-type bounds, sequential crawl. Compressed responses are rejected rather than parsed incorrectly. No authenticated form submits, exploitation, credential attacks or production writes. Static HTML parsing runs no scripts or resources. Single sampled TTFB is not CWV.

Tests simulate DNS rebinding/private redirects and transport byte/type limits; no private/internal endpoint was actually contacted. No real public-site crawling was performed during this task.

## Secrets and integrations

AES-256-GCM with owner/connection authenticated data; 32-byte hex key supplied by operator, absent from ZIP. Public connection projection excludes ciphertext/credentials. Disconnect deletes local credentials and explicitly asks customer to revoke remotely. Remote revocation/refresh/token health scheduling are NOT implemented. No frontend credential form. WordPress uses the documented Application Password mechanism for a limited read probe; it inherits user capabilities and is not a scoped OAuth token. Use a dedicated least-privilege user later.

OAuth primitives validate exact redirect allowlist, owner/provider, expiry and one-time state, tested locally. No complete provider OAuth exchange/refresh/revocation flow is claimed. Provider probes are limited official read endpoints, no guessed workflow entitlements. GA4/GTM/GSC integration boundaries and tracking plans do not verify event delivery.

## Payment


Existing JSON fulfillment now reconciles a prior order if a restart occurred between order append and fulfilled-marker write; the signed-webhook test exercises this replay. Financial persistence is still single-instance, not a multi-host exactly-once guarantee. See limitations; do not scale web replicas against these files.

## Execution

No live implementation checkout/executor. Offline runner accepts fixture environment only, stable operation IDs, snapshots, explicit scope-bound approval for medium/high risk, readback + Definition of Done, rollback conflict detection. REQUESTED/ACCEPTED is not VERIFIED. Ambiguous effects become manual review. Plan approval never secretly enables live execution. DNS/payment/domain/delete/bulk messaging are not supported actions.

## Data, output, logs

Structured findings with provenance; HTML is never interpolated unescaped in new UI. SQLite bound parameters; no arbitrary file paths from requests. New events contain bounded identifier fields, not provider bodies or secrets. Raw pages are discarded. Retention/close-access remove reports, knowledge and stored credentials while preserving order identifiers/accounting records. Legacy records still follow the old retention policy; new cleanup does not rewrite them. Original legal templates have new disclosures but require professional review before use.

## Scope of review

Static repository inventory/syntax, targeted auth/payment/scanner/queue/portal review and local adversarial tests. This is not a penetration test, legal certification, load certification or guarantee of security. No external provider account was tested.

Payment uses bank transfer only. Server configuration controls price and currency. Orders start pending; only authenticated, same-origin admin confirmation can grant paid access. Browser redirects, request bodies and query parameters cannot confirm receipt. Orders and existing accounting records are preserved.
