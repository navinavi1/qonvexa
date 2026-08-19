import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const index = fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const app = fs.readFileSync(path.join(root,'public','app.js'),'utf8');
const server = fs.readFileSync(path.join(root,'server.js'),'utf8');
const success = fs.readFileSync(path.join(root,'public','success.html'),'utf8');

const checks = [
  ['preview form exists', index.includes('id="preview-form"')],
  ['checkout form exists', index.includes('id="checkout-form"')],
  ['checkout button exists', index.includes('id="open-checkout"')],
  ['industry panel exists', index.includes('id="industry-panel"')],
  ['app posts preview', app.includes("fetch('/api/preview-request'" )],
  ['app starts checkout', app.includes("fetch('/api/create-checkout-session'" )],
  ['server verifies checkout session', server.includes("/api/checkout-session-status")],
  ['server handles async success', server.includes('checkout.session.async_payment_succeeded')],
  ['server enforces paid status', server.includes("session.payment_status === 'paid'")],
  ['server rate limits', server.includes('function rateLimit')],
  ['success page starts unverified', success.includes('Verifying payment')],
  ['success page is noindex', success.includes('noindex,nofollow')]
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
