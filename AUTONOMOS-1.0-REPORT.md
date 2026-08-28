# AutonomOS 1.0 — Full Integration Report

Date: 2026-08-28
Base: supplied `qonvexa-main (3)(1).zip`
Owner treasury (public receiver only): `0x1f674bf085f6fed36fa198287d51edf0fe0bb9e2`

## Result

AutonomOS is integrated into the existing QONVEXA Node/Express service. It is not a second public website and does not require a second domain. QONVEXA remains the public product; `/admin#autonomos` is the private owner control plane and the AutonomOS runtime runs in the same Render process/persistent disk.

The runtime starts automatically when `AUTONOMOS_ENABLED=true` and executes a durable heartbeat loop:

`Discover → Evaluate → Build/Offer → Sell → Execute → Settle → Measure → Optimize → Replicate`

The owner can start/stop it, force a cycle, refresh treasury balances and use an emergency-stop latch from the existing protected admin account.

## 20 core agents

1. Prime Governor
2. Policy Agent
3. Treasury CFO
4. Security Sentinel
5. Internal Auditor
6. Opportunity Radar
7. Demand Analyst
8. Competition Agent
9. Economics Agent
10. Offer Architect
11. Pricing Agent
12. Distribution Agent
13. Job Router
14. Research Worker
15. Code Worker
16. Automation Worker
17. Content Worker
18. QA / Evaluator
19. Evolution Agent
20. Replication Manager

The agents are one organization, not twenty independent chat windows. Market, finance, execution, governance and evolution state is persisted under `STORAGE_DIR/autonomos`.

## Child-agent replication

`Replication Manager` creates bounded child workers when real concurrent demand for the same product reaches the configured threshold. Child workers have:

- unique ID;
- specialization;
- TTL;
- zero-dollar spending budget;
- runtime status;
- task/revenue/cost/error counters;
- no private key.

A live child becomes eligible to receive subsequent jobs for its specialization. Expired children are closed automatically.

## Machine products live in the build

AutonomOS exposes six deterministic, low-cost machine services:

- `GET /api/autonomos/v1/site-snapshot?url=...` — $0.020
- `GET /api/autonomos/v1/robots-audit?url=...` — $0.010
- `GET /api/autonomos/v1/security-headers?url=...` — $0.020
- `GET /api/autonomos/v1/conversion-signals?url=...` — $0.030
- `GET /api/autonomos/v1/technology-fingerprint?url=...` — $0.025
- `GET /api/autonomos/v1/copy-clarity-signals?url=...` — $0.025

Free machine-readable discovery surfaces:

- `GET /api/autonomos/catalog`
- `GET /.well-known/autonomos.json`

The paid endpoints are designed for x402 v2 `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` flow and include Bazaar discovery metadata.

## Payment mode

Production configuration uses:

- network: Base mainnet (`eip155:8453`)
- asset: native Circle USDC on Base
- receiver: the supplied Rabby `0x...` address
- facilitator default in this build: `https://facilitator.xpay.sh`

The server holds no wallet seed phrase and no private key. For seller-side x402, the buyer signs the USDC authorization and settlement sends funds to the public `payTo` address.

`zeroSpendMode` is enforced in the policy engine. External spending, paid procurement and private-key export are disabled. This means the first deployment can operate as a seller/discovery system without a seed balance for agent spending.

## Profit Engine

Every opportunity can be scored as:

`expected revenue × success probability - compute - API - marketplace fee - network fee - failure reserve`

The default margin floor is 35%.

Profit allocation defaults:

- 85% reserve
- 10% growth
- 5% experiments

These are accounting allocations while zero-spend mode is active; the system does not automatically spend the growth or experiment allocation.

## Autonomous pricing

Pricing Agent performs bounded market-aware tuning. It only changes a product price when there are enough tag-matched observed x402 market samples. Each change is limited to a small step and kept inside a floor/ceiling derived from the original product price. Every change is persisted and logged.

## Opportunity discovery

Opportunity Radar scans the configured x402 Bazaar discovery feed and records market signals, prices, networks and tags. Other rails are represented by explicit connectors with honest readiness states:

- Virtuals ACP
- Olas Mech
- Nevermined
- Skyfire
- OpenServ
- Agentverse / Fetch.ai
- Conway

A connector never reports `ready` when its required external credential is absent.

## Security implemented

- No seed phrase/private key fields in the owner UI.
- No private key is required for the receive-only x402 seller rail.
- Emergency stop disables runtime and external-spend permissions.
- Same-site admin mutation protection remains in place.
- Existing admin authentication is reused.
- SSRF defense blocks localhost, private, loopback, link-local, multicast and unroutable destinations before machine products fetch a target URL.
- Redirects are validated again before following.
- Fetch size, redirect and timeout bounds are enforced.
- Stale source/deployment artifacts located under the historical `public/` folder (`server.js`, `package.json`, `render.yaml`, markdown reports, scripts) are now denied by the web server.
- Audit/event/job/revenue records are persisted.

## Owner panel

The existing QONVEXA footer now has a deliberately subtle `Owner` entry leading to `/admin#autonomos`. This is only navigation obscurity, not the security boundary; the real boundary remains the existing authenticated owner/admin session.

The panel shows:

- runtime state;
- treasury balance;
- 24h/lifetime revenue, cost and net profit;
- 20 core agents;
- active child agents;
- completed/failed jobs;
- autonomous cycles;
- product prices/payment state;
- connector readiness;
- external setup gaps;
- live audit events;
- policy settings;
- emergency stop.

## What is intentionally NOT in the code

- No mechanism for hiding income, obscuring on-chain provenance or evading tax/KYC requirements.
- No server-side Rabby seed phrase or owner private key.
- No unrestricted arbitrary self-modification of production code.
- No autonomous spending from the owner's wallet.
- No fake marketplace credentials.

Self-improvement in 1.0 is bounded to market observation, price tuning, capability routing, persistent learning state and child-worker replication. Arbitrary code mutation would require an isolated build/test/canary/signing system and is not safe to connect directly to a treasury-bearing production process.

## What still requires an external action if you want every rail

### Already enough for the first live receive-only rail

The supplied public EVM address + QONVEXA Render service are enough for the x402 Base/USDC seller endpoints in this build. No seed balance is required to receive seller payments.

### Virtuals ACP

Requires creation/upgrade of an ACP provider agent and secrets supplied by Virtuals:

- `VIRTUALS_ACP_WALLET_ID`
- `VIRTUALS_ACP_SIGNER`
- optional `VIRTUALS_ACP_AGENT_ID`

`VIRTUALS_ACP_SIGNER` is a secret. Set it directly in Render. Do not send it in chat or commit it to GitHub.

### Optional other markets

- `OLAS_MECH_API_KEY`
- `NVM_API_KEY` / optional `NVM_PLAN_ID`
- `SKYFIRE_API_KEY`
- `OPENSERV_API_KEY`
- `AGENTVERSE_API_KEY`
- `CONWAY_API_KEY`

These are optional expansion rails, not prerequisites for the AutonomOS runtime itself.

### Optional reasoning model

For fully generative research/content/code work beyond deterministic products:

- `AUTONOMOS_LLM_BASE_URL`
- `AUTONOMOS_LLM_API_KEY`
- `AUTONOMOS_LLM_MODEL`

Without them the runtime stays in deterministic/no-paid-LLM mode.

### BTC/SOL clarification

The supplied Rabby address is an EVM `0x...` address. It is suitable for Base/EVM assets such as USDC, USDT and ETH on supported EVM networks. Native Bitcoin and native Solana cannot be sent to this `0x...` address. Native BTC/SOL rails require separate chain-specific receiving addresses and connectors before enabling them.

## Verification performed

- `npm run check` — PASS
- `npm run autonomos-audit` — PASS, 9/9 checks
- all new AutonomOS JavaScript modules — `node --check` PASS
- owner public EVM address validation — PASS
- 20 unique core agents — PASS
- machine-product route uniqueness — PASS
- zero-spend enforcement — PASS
- private-key access rejection — PASS
- Profit Engine checks — PASS
- SSRF private target rejection — PASS
- x402 v2 mainnet challenge + `payTo` + Bazaar declaration — PASS
- runtime boot with no paid API/private key — PASS

A full dependency-backed `npm run verify` was not executed in this workspace because the supplied ZIP contains no `node_modules` and the execution environment does not provide npm-registry network installation. Render's build command still performs `npm install --omit=dev && npm run verify`, so the dependency-backed smoke/preflight suite runs during the actual Render build.

## Reality check

This is a working autonomous seller/orchestration foundation, not a guarantee of revenue. A payment endpoint can be technically live and still have zero buyers. The next economic constraint is distribution: x402 catalog discovery and/or activating ACP/other agent marketplaces. AutonomOS records that distinction instead of reporting fake earnings or fake connector status.
