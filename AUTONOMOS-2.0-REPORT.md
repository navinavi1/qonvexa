# AutonomOS 2.0 — Global Job Engine Report

Date: 2026-08-28
Base: `qonvexa-main (4).zip`
QONVEXA public product remains unchanged. AutonomOS runs inside the existing Node/Express Render service and owner admin.

## What changed

AutonomOS 2.0 moves the runtime from a seller-only x402 heartbeat into a global work engine with a common marketplace job lifecycle:

`discover → normalize → safety/capability check → unit economics → claim → execute → QA → deliver → settlement sync → ledger`

### Real adapters implemented

1. **x402/Bazaar** — existing paid machine-service seller rail + discovery.
2. **Clawlancer** — public bounty discovery, automatic agent registration when no key exists, claim, deliver, transaction sync and wallet-balance read.
3. **t2000 Passport Connect** — generic MCP-over-HTTP session support. When `T2000_MCP_URL` + `T2000_SESSION_TOKEN` are supplied, AutonomOS discovers tools dynamically, reads openings and can use discovered claim/deliver tools. Without a Passport Connect session it only records public activity and honestly reports claim-not-ready.
4. **Agentverse** — live public function discovery through the Agentverse search API.

Virtuals ACP / Olas / Nevermined / OpenServ remain explicit external-credential connectors. They are not reported as ready until their credentials exist.

## Global job normalization

Every marketplace opportunity is normalized into one structure with source, external job id, payout, currency, network, escrow flag, claim mode, deadline, category and description. This lets Profit Engine compare jobs from different networks consistently.

## Autonomous claim safety

AutonomOS auto-claims only when all checks pass:

- connector supports automatic claim;
- job is escrowed/pre-funded when policy requires it;
- payout is above the configured floor;
- capability classifier can actually execute the task;
- safety classifier allows the task;
- expected unit economics passes the minimum-margin floor;
- estimated model/API cost is under the configured payout percentage;
- the opportunity has not already been handled.

The default stays `zeroSpendMode=true`. Marketplace fees deducted from payout do **not** count as external cash spend; paid model/API/network costs do.

## Functional execution

AutonomOS now routes external marketplace jobs to execution workers:

- deterministic public HTTP / website evidence work;
- limited deterministic translation patterns;
- LLM-backed research, writing, code analysis and data work when an OpenAI-compatible model is configured.

The model is never called merely because a job exists. Profitability and capability checks happen before claim.

## Job accounting

Owner UI now distinguishes:

- heartbeat cycles;
- unique opportunities discovered;
- claimed jobs;
- delivered jobs;
- paid/settled jobs;
- revenue/cost/net profit.

This fixes the old ambiguity where a growing cycle count could look like productive work.

## Treasury 2.0

The same public Rabby EVM address is monitored across:

- Base;
- Arbitrum One;
- Polygon.

Default monitored assets include native gas assets plus USDC and USDT where configured in the built-in chain registry. Custom EVM chain/token definitions can be supplied through `AUTONOMOS_EVM_CHAINS_JSON`.

x402 now supports a configurable list of accepted assets/networks via `AUTONOMOS_X402_ACCEPTS_JSON`. The default remains Base USDC so the existing live facilitator configuration is not falsely advertised as supporting tokens it may not settle.

Important: fiat USD/EUR/UAH and non-EVM chains cannot physically settle to one Rabby `0x...` address. Those require a fiat PSP/facilitator or a chain-specific wallet. Nevermined remains the planned fiat+crypto payment adapter; t2000 uses its Sui Passport.

## Secrets

- Master Rabby seed/private key is never requested or stored.
- Auto-created marketplace API credentials are stored only on the persistent Render disk in `credentials.private.json` with restrictive file permissions.
- External connector signers/tokens remain server-side environment values.

## x402 idempotency

Payment signatures are hashed and successful results are cached persistently so a client retry can return the same result instead of re-running paid work.

## Tests

`npm run verify` passes completely in this workspace.

AutonomOS-specific checks:

- 14/14 static/unit audit PASS;
- end-to-end mocked market flow PASS:
  `discover → auto-register → claim → execute → deliver → settle → ledger`;
- QONVEXA preflight PASS;
- Render audit PASS;
- purchase audit PASS;
- production finalization PASS;
- smoke check PASS.

## Honest external gaps

No code can fabricate third-party identities or access tokens. To activate every market, external platform setup is still required where the platform mandates it:

- t2000: Passport Connect URL/session token;
- Virtuals ACP: registered provider wallet/signer/agent identifiers;
- Olas: Mech registration/credential path;
- Nevermined: API key/plan for fiat+crypto payment facilitation;
- OpenServ: API key if using authenticated platform actions.

AutonomOS 2.0 will show these as external setup rather than pretending the connector is live.
