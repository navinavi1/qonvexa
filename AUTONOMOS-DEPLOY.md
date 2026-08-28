# AutonomOS 1.0 — Deploy / Activate

AutonomOS is embedded in the existing QONVEXA Render web service. No second domain and no second public website are required.

## 1. Push this build to the existing QONVEXA GitHub repository

Deploy from the repository root, not from `/public`.

Render should use the existing root `render.yaml` / `server.js`.

## 2. Existing QONVEXA secrets stay unchanged

Keep the already working owner/admin values in Render:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`
- `IP_HASH_SALT`
- existing QONVEXA payment/legal settings

Do not put those secret values in GitHub.

## 3. AutonomOS values included by render.yaml

- `AUTONOMOS_OWNER_WALLET=0x1f674bf085f6fed36fa198287d51edf0fe0bb9e2`
- `AUTONOMOS_ENABLED=true`
- `AUTONOMOS_BASE_RPC_URL=https://mainnet.base.org`
- `AUTONOMOS_X402_ENABLED=true`
- `AUTONOMOS_X402_NETWORK=eip155:8453`
- `AUTONOMOS_X402_FACILITATOR_URL=https://facilitator.xpay.sh`

The selected x402 seller path is receive-only from the QONVEXA side and does not require the Rabby seed/private key.

## 4. After Render deploy

Open:

`https://qonvexa.co/admin#autonomos`

Log in with the existing QONVEXA owner credentials.

Check:

1. Runtime = `running`
2. Agents = `20`
3. Treasury shows the supplied `0x...` address
4. x402 connector = `ready`
5. Product endpoints show `mainnet`
6. Event log begins recording autonomous cycles

The machine catalog is:

`https://qonvexa.co/.well-known/autonomos.json`

## 5. First x402 challenge check

An unpaid request to a machine product should return HTTP 402 and a `PAYMENT-REQUIRED` header:

`GET https://qonvexa.co/api/autonomos/v1/security-headers?url=https://example.com`

Do not expect a 200 without a valid x402 payment signature; 402 is the correct response.

## 6. First real revenue

A compatible buyer agent requests an endpoint, receives the 402 payment requirements, signs an EIP-3009 USDC authorization and retries. The facilitator verifies it, AutonomOS executes + QA checks the job, then settlement transfers USDC to the configured public owner address.

## 7. Virtuals ACP expansion

When you choose to activate Virtuals, create/upgrade the provider agent there and put its values directly into Render secrets:

- `VIRTUALS_ACP_WALLET_ID`
- `VIRTUALS_ACP_SIGNER`
- `VIRTUALS_ACP_AGENT_ID` (if supplied)

Never paste the signer/private key into the website, GitHub, or chat.

## 8. Emergency stop

Use the `EMERGENCY STOP` button inside AutonomOS. It latches the runtime off and forces zero-spend/external-spending disabled. Double-click the runtime badge to clear the latch; the runtime remains stopped until `Start 24/7` is pressed.
