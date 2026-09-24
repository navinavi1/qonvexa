// No test ever started the server in the configuration it is actually deployed in.
//
// dashboard-render-test boots it with NODE_ENV=production but LAUNCH_MODE=staging, and the
// whole live branch of validateProductionConfig sits behind `if (isLiveLaunch)`. So the one
// combination that matters -- production plus live, which is exactly what render.yaml sets --
// was never exercised. A const declared below the function that reads it therefore shipped:
// validateProductionConfig runs at the top of server.js and reaches manualPaymentConfig(),
// which compares BANK_CURRENCY against PRICE_CURRENCY, and PRICE_CURRENCY was still in its
// temporal dead zone. `Cannot access 'PRICE_CURRENCY' before initialization`, at module load,
// every time -- while `npm run verify` stayed green from end to end, because the crash needs
// NODE_ENV=production and no test used it together with live mode.
//
// That is the shape of the worst class of bug this repository can have: the build passes, the
// service cannot boot, and the deploy goes red for a reason no test output mentions. So this
// test boots the real server.js under render.yaml's own values and asks it two questions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let checks = 0;
const ok = (condition, label) => { assert.ok(condition, label); checks++; };
const eq = (actual, expected, label) => { assert.equal(actual, expected, `${label} (got ${JSON.stringify(actual)})`); checks++; };

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'production-boot-'));
const PORT = 5300 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'a-very-long-admin-password-123456';

// Declared, never inherited: the build machine's own LAUNCH_MODE once leaked into a test this
// way and took a deploy down. These are render.yaml's values, with a stand-in per `sync: false`
// secret. SITE_URL must be https because live mode refuses anything else, which is why the
// health check is polled over plain http against the loopback port instead.
const env = {
  PATH: process.env.PATH || '', PORT: String(PORT),
  NODE_ENV: 'production', LAUNCH_MODE: 'live', SITE_URL: 'https://qonvexa.co',
  STORAGE_DIR: storage, AUDIT_PRICE_CENTS: '14900',
  PAYMENT_MODE: 'manual', MANUAL_PAYMENT_ENABLED: 'true', ALLOW_STAGING_PAYMENTS: 'false',
  CONTACT_EMAIL: 'hello@qonvexa.co',
  LEGAL_BUSINESS_NAME: 'Qonvexa', LEGAL_ADDRESS: 'Kyiv, Ukraine', LEGAL_JURISDICTION: 'Ukraine',
  DELIVERY_TIMEFRAME: '1–24 hours after payment confirmation',
  REFUND_POLICY_TEXT: 'Refunds are considered case by case once delivery has started.',
  BANK_BENEFICIARY: 'Qonvexa', BANK_NAME: 'Bank', BANK_IBAN: 'UA000000000000000000000000000',
  BANK_SWIFT: 'AAAAUAUX', BANK_CURRENCY: 'USD', BANK_PAYMENT_NOTE: 'note',
  ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: PASSWORD,
  ADMIN_SESSION_SECRET: 'generated-secret-0123456789abcdef0123456789abcdef',
  IP_HASH_SALT: 'generated-salt-0123456789abcdef0123',
  AUTONOMOS_ENABLED: 'false', npm_lifecycle_event: ''
};

const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });
const stop = () => { try { server.kill('SIGKILL'); } catch {} };

let health = null;
for (let attempt = 0; attempt < 120 && !health; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 250));
  if (server.exitCode !== null) break;
  try {
    const response = await fetch(`${BASE}/health`);
    if (response.ok) health = await response.json();
  } catch {}
}
if (!health) {
  stop();
  fs.rmSync(storage, { recursive: true, force: true });
  // The message is the point: a module-load throw names itself here instead of only in a
  // Render deploy log an hour later.
  assert.fail(`server.js did not start under render.yaml's own configuration.\n` +
    `This is a red deploy: the build passes and the service never answers /health.\n\nIt said:\n${output.trim().slice(-2500) || '(nothing)'}`);
}

// 1. It is really in the mode it will be deployed in, not a laxer one that happens to boot.
eq(health.ok, true, 'the service reports itself healthy');
eq(health.environment, 'production', 'and is in production, so validateProductionConfig actually ran');
eq(health.launchMode, 'live', 'and in live mode, so its live branch actually ran');
eq(health.manualPaymentConfigured, true, 'manualPaymentConfig() evaluated without throwing');
eq(health.salesEnabled, true, 'and the site is able to sell');

// 2. The other thing NODE_ENV gates is the owner's session cookie. Without `Secure` that
// cookie is allowed onto plain HTTP, which is worth an assertion rather than a comment.
const login = await fetch(`${BASE}/api/admin/login`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
  body: JSON.stringify({ username: 'owner', password: PASSWORD })
});
eq(login.status, 200, 'the owner can log in');
const setCookie = (login.headers.getSetCookie?.() || []).join(' | ');
ok(/qonvexa_admin=/.test(setCookie), 'a session cookie is issued');
ok(/;\s*Secure/i.test(setCookie), `the session cookie carries Secure in production: ${setCookie}`);
ok(/HttpOnly/i.test(setCookie), 'and HttpOnly');
ok(/SameSite=Strict/i.test(setCookie), 'and SameSite=Strict');

stop();
fs.rmSync(storage, { recursive: true, force: true });
console.log(`PRODUCTION BOOT: PASS (${checks} checks, real server.js under render.yaml's NODE_ENV=production + LAUNCH_MODE=live)`);
