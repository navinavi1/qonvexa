# AutonomOS 2.0 — Deploy

## 1. Upload

Upload the **CHANGED-ONLY** archive contents into the root of the existing `navinavi1/qonvexa` GitHub repository, preserving all paths. Do not upload the ZIP itself.

## 2. Render

Existing QONVEXA admin/payment secrets stay unchanged. Render auto-deploys from `main`.

No new secret is mandatory for the first AutonomOS 2.0 cycle.

### What happens automatically

- x402 seller rail continues using the existing Base/USDC settings.
- AutonomOS attempts a one-time Clawlancer agent registration if no Clawlancer API key exists; returned credentials are stored on the private persistent Render disk.
- Agentverse discovery runs without a private key.
- t2000 public activity is observed; claims remain disabled until Passport Connect is configured.

## 3. Optional environment values

### t2000 real Open-board claiming

- `T2000_MCP_URL`
- `T2000_SESSION_TOKEN`
- optional `T2000_PASSPORT_ADDRESS`

### Virtuals ACP

- `VIRTUALS_ACP_WALLET_ID`
- `VIRTUALS_ACP_SIGNER`
- optional `VIRTUALS_ACP_AGENT_ID`

### LLM execution for broader jobs

- `AUTONOMOS_LLM_BASE_URL`
- `AUTONOMOS_LLM_API_KEY`
- `AUTONOMOS_LLM_MODEL`
- optional cost rates: `AUTONOMOS_LLM_INPUT_USD_PER_MILLION`, `AUTONOMOS_LLM_OUTPUT_USD_PER_MILLION`

With zero-spend mode enabled, jobs needing a non-zero paid-model cost are not auto-claimed.

### Multi-token x402

`AUTONOMOS_X402_ACCEPTS_JSON` accepts an array such as:

```json
[
  {"network":"eip155:8453","networkName":"Base","symbol":"USDC","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","decimals":6,"live":true,"scheme":"exact"}
]
```

Only add a token/network if the configured facilitator actually supports it. Do not advertise unsupported assets.

## 4. Post-deploy check

Open `/admin#autonomos` and verify:

- Version behavior corresponds to AutonomOS 2.0;
- runtime = running;
- Global Work Radar shows connector health;
- Opportunities grows independently of Cycles;
- Clawlancer becomes `ready` after successful auto-registration or shows the exact external failure;
- Jobs remain zero until a job is really claimed;
- Paid remains zero until an external settlement is actually observed.

## 5. No master wallet secret

Never place the Rabby seed phrase or private key in GitHub, Render, the admin UI or chat.
