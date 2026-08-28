import fs from 'node:fs';
import path from 'node:path';

const required = [
  'server.js',
  'public/index.html',
  'public/app.js',
  'public/styles.css',
  'public/privacy.html',
  'public/terms.html',
  'public/refund.html',
  'public/success.html',
  'public/success.js',
  'public/admin.html',
  'public/admin.js',
  'public/admin.css',
  '.env.example'
];

let failed = false;
for (const file of required) {
  if (!fs.existsSync(path.resolve(file))) {
    console.error(`MISSING: ${file}`);
    failed = true;
  }
}

const index = fs.readFileSync('public/index.html','utf8');
for (const marker of [
  'id="preview-form"',
  'id="checkout-form"',
  'id="open-checkout"',
  'id="industry-panel"',
  'QONVEXA'
]) {
  if (!index.includes(marker)) {
    console.error(`INDEX MARKER MISSING: ${marker}`);
    failed = true;
  }
}

const server = fs.readFileSync('server.js','utf8');
for (const endpoint of [
  '/api/preview-request',
  '/api/create-checkout-session',
  '/api/checkout-session-status',
  '/stripe/webhook',
  '/api/admin/login',
  '/api/admin/dashboard',
  '/api/admin/export/',
  '/api/admin/settings',
  '/api/admin/events',
  '/api/admin/clients',
  '/api/admin/orders/',
  '/api/admin/leads/',
  '/api/admin/autonomos',
  '/api/autonomos/catalog'
]) {
  if (!server.includes(endpoint)) {
    console.error(`SERVER ENDPOINT MISSING: ${endpoint}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('QONVEXA smoke check passed.');
