// AUDIT_PRICE_CENTS is a dollar amount -- the schema.org offer, /api/purchase-options and the
// Stripe session all say USD. BANK_CURRENCY is whatever the receiving account happens to be
// denominated in. The bank-transfer order recorded amountTotal = priceCents alongside
// currency = BANK_CURRENCY, which is the same number labelled with a different unit: with the
// account in UAH a $149 audit was invoiced as 149 UAH, about $3.60, and the customer paid it.
// Nothing in this process knows an exchange rate, so the only honest options are "the price
// currency and the account currency agree" or "this method is off, and here is why".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

let checks = 0;
const ok = (condition, label) => { assert.ok(condition, label); checks++; };
const eq = (actual, expected, label) => { assert.equal(actual, expected, `${label} (got ${JSON.stringify(actual)})`); checks++; };

async function withServer(bankCurrency, run) {
  const port = 4900 + Math.floor(Math.random() * 300);
  const base = `http://127.0.0.1:${port}`;
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-currency-'));
  // Explicit environment: the build machine sets LAUNCH_MODE=live, and a spread of it would
  // stop the server booting at all.
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: {
      PATH: process.env.PATH || '',
      PORT: String(port),
      STORAGE_DIR: storage,
      NODE_ENV: 'production',
      LAUNCH_MODE: 'staging',
      ALLOW_STAGING_PAYMENTS: 'true',
      AUDIT_PRICE_CENTS: '14900',
      SITE_URL: base,
      AUTONOMOS_ENABLED: 'false',
      MANUAL_PAYMENT_ENABLED: 'true',
      PAYMENT_MODE: 'manual',
      BANK_BENEFICIARY: 'Qonvexa Test',
      BANK_NAME: 'Test Bank',
      BANK_IBAN: 'UA000000000000000000000000000',
      BANK_CURRENCY: bankCurrency,
      ADMIN_USERNAME: 'pay-probe',
      ADMIN_PASSWORD: 'pay-probe-password',
      ADMIN_SESSION_SECRET: 'pay-probe-secret-0123456789abcdef0123456789',
      IP_HASH_SALT: 'pay-probe-salt-0123456789abcdef',
      npm_lifecycle_event: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  try {
    let up = false;
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 250));
      try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch {}
    }
    if (!up) throw new Error(`the server did not start. It said:\n${output.trim() || '(nothing)'}`);
    return await run(base);
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    try { fs.rmSync(storage, { recursive: true, force: true }); } catch {}
  }
}

const order = (base) => fetch(`${base}/api/manual-order`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ websiteUrl: 'https://example.com', email: 'buyer@example.com' })
});

// The account currency matches the price currency: business as usual.
await withServer('USD', async (base) => {
  const options = await (await fetch(`${base}/api/purchase-options`)).json();
  eq(options.priceCents, 14900, 'the price is what AUDIT_PRICE_CENTS says');
  ok(options.methods.bankTransfer.available, 'bank transfer is offered when the account is in the price currency');

  const response = await order(base);
  eq(response.status, 201, 'the order is created');
  const body = await response.json();
  eq(body.amountTotal, 14900, 'and it is for the price that was quoted');
  eq(String(body.currency).toUpperCase(), 'USD', 'in the currency the price is denominated in');
});

// The account is in another currency, and there is no rate to convert with.
await withServer('UAH', async (base) => {
  const options = await (await fetch(`${base}/api/purchase-options`)).json();
  const bank = options.methods.bankTransfer;
  eq(bank.available, false, 'bank transfer is refused rather than quoted in the wrong unit');
  ok(/UAH/.test(bank.unavailableReason), 'and the reason names the account currency');
  ok(/USD/.test(bank.unavailableReason), 'and the price currency');
  ok(/convert/i.test(bank.unavailableReason), 'and says plainly that nothing here can convert between them');

  const response = await order(base);
  eq(response.status, 503, 'and no order can be created down that path');
});

// EUR would have overcharged rather than undercharged; same defect, opposite direction.
await withServer('EUR', async (base) => {
  const options = await (await fetch(`${base}/api/purchase-options`)).json();
  eq(options.methods.bankTransfer.available, false, 'an account in EUR is refused too, not billed 149 EUR');
});

console.log(`payment-currency-test OK (${checks} checks, live servers, three account currencies)`);
