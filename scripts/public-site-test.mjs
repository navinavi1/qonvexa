// The public site, exercised rather than read. Every anchor target, every page the
// navigation offers, every button, and the whole four-step checkout are driven against a
// real server in a real DOM. Reading HTML proves nothing here: a hash link whose section was
// renamed, a button whose handler throws, a fetch to a route that no longer exists -- none
// of those are visible in the source, and all of them are invisible in a browser too,
// because the optional chaining swallows them and the page simply sits there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { JSDOM } from 'jsdom';

let checks = 0;
const ok = (condition, label) => { assert.ok(condition, label); checks++; };
const eq = (actual, expected, label) => { assert.equal(actual, expected, `${label} (got ${JSON.stringify(actual)})`); checks++; };

const PORT = 4200 + Math.floor(Math.random() * 300);
const B = `http://127.0.0.1:${PORT}`;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'public-site-'));
const repo = path.join(import.meta.dirname, '..');

// An explicit environment, never a spread of this one: the build machine sets LAUNCH_MODE=live,
// which makes server.js refuse to start unless SITE_URL is https, and a test that inherits
// that tests the machine rather than the code.
const server = spawn(process.execPath, ['server.js'], {
  cwd: repo,
  env: {
    PATH: process.env.PATH || '',
    PORT: String(PORT),
    STORAGE_DIR: storage,
    NODE_ENV: 'production',
    LAUNCH_MODE: 'staging',
    AUDIT_PRICE_CENTS: '24900',
    SITE_URL: B,
    AUTONOMOS_ENABLED: 'false',
    MANUAL_PAYMENT_ENABLED: 'true',
    PAYMENT_MODE: 'manual',
    BANK_IBAN: 'UA000000000000000000000000000',
    BANK_BENEFICIARY: 'Qonvexa Test',
    BANK_NAME: 'Test Bank',
    BANK_CURRENCY: 'USD',
    CONTACT_EMAIL: 'hello@qonvexa.co',
    ADMIN_USERNAME: 'site-probe',
    ADMIN_PASSWORD: 'site-probe-password',
    ADMIN_SESSION_SECRET: 'site-probe-secret-0123456789abcdef0123456789',
    IP_HASH_SALT: 'site-probe-salt-0123456789abcdef',
    npm_lifecycle_event: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += chunk; });
server.stderr.on('data', chunk => { serverOutput += chunk; });
const stop = () => {
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(storage, { recursive: true, force: true }); } catch {}
};
process.on('exit', stop);

let up = false;
for (let i = 0; i < 120; i++) {
  await new Promise(r => setTimeout(r, 250));
  try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch {}
}
if (!up) { stop(); throw new Error(`the server did not start, so nothing here could be verified. It said:\n${serverOutput.trim() || '(nothing)'}`); }

const html = await (await fetch(`${B}/`)).text();

// 1. Nothing the server was supposed to fill in is left as a raw token on a live page.
const leftoverTokens = [...html.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => m[1]);
eq(leftoverTokens.length, 0, `no unsubstituted template token reaches the browser: ${leftoverTokens.join(', ')}`);

// 2. Every price shown comes from AUDIT_PRICE_CENTS, including the schema.org offer search
// engines read. Seven places carried the number literally; changing the price then advertised
// one amount and charged another.
const charged = (await (await fetch(`${B}/api/purchase-options`)).json()).priceCents;
eq(charged, 24900, 'the server charges what AUDIT_PRICE_CENTS says');
for (const [label, re] of [
  ['schema.org offer', /"price":"([0-9.]+)"/],
  ['hero button', /Unlock Full Audit — \$([0-9.]+)/],
  ['price card', /data-count="([0-9.]+)"/],
  ['includes panel', /Your \$([0-9.]+) audit includes/]
]) {
  const shown = re.exec(html)?.[1];
  eq(Number(shown) * 100, charged, `${label} shows the price the server charges`);
}

// 3. Every page the navigation links to actually answers.
const pageLinks = [...new Set([...html.matchAll(/href="((?:\/|[a-z0-9-]+\.html)[^"#]*)"/gi)].map(m => m[1]))];
ok(pageLinks.length >= 3, `the page links somewhere (${pageLinks.length} targets)`);
for (const href of pageLinks) {
  const response = await fetch(new URL(href, B), { redirect: 'follow' });
  ok(response.ok, `${href} answers (HTTP ${response.status})`);
}

// 4. Every in-page anchor points at a section that exists. A renamed id leaves a nav item
// that silently does nothing.
const dom = new JSDOM(html, { url: B, runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
for (const anchor of [...new Set([...html.matchAll(/href="#([a-z0-9-]+)"/gi)].map(m => m[1]))])
  ok(doc.getElementById(anchor), `the "#${anchor}" link lands on a section that exists`);

// 5. The script runs, and every button it is supposed to wire up is present. Running it is the
// only way to catch a handler that throws on load and takes every later listener with it.
const errors = [];
window.addEventListener('error', event => errors.push(String(event.error?.stack || event.message)));
window.fetch = async (input, init) => fetch(new URL(String(input?.url || input), B), init);
window.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0);
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
window.HTMLElement.prototype.scrollIntoView = function () {};
// jsdom implements neither of these; the page uses them for reveal animations and counters.
// Stubbing them is about the test environment, not about the page: in a browser they exist.
window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
window.matchMedia = window.matchMedia || (query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
// The browser loads common.js before the page script; so must this, or the test runs
// against a window the browser never produces.
window.eval(fs.readFileSync(path.join(repo, 'public', 'common.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(repo, 'public', 'app.js'), 'utf8'));
eq(errors.length, 0, `the page script runs clean: ${errors.join(' | ')}`);

for (const id of ['open-checkout', 'close-checkout', 'finish-purchase', 'unlock-found-audit'])
  ok(doc.getElementById(id), `the "${id}" button is on the page`);

// 6. The industry tabs: each one must have data behind it. A tab whose target is missing
// throws inside the click handler and the panel stops updating for every tab after it.
const tabs = [...doc.querySelectorAll('.tab')];
ok(tabs.length >= 2, `the industry tabs are present (${tabs.length})`);
for (const tab of tabs) {
  tab.dispatchEvent(new window.Event('click', { bubbles: true }));
  ok(doc.querySelector('#industry-title')?.textContent?.trim(), `the "${tab.dataset.target}" tab fills the panel`);
  ok(doc.querySelector('#industry-pills')?.children.length, `the "${tab.dataset.target}" tab fills its pills`);
}
eq(errors.length, 0, `no tab click threw: ${errors.join(' | ')}`);

// 7. The checkout, driven the way a customer drives it: open, fill, step through, and read the
// total on the review step. That total was a hardcoded string one click before payment.
doc.getElementById('open-checkout').dispatchEvent(new window.Event('click', { bubbles: true }));
await new Promise(r => setTimeout(r, 400));
const dialog = doc.querySelector('#checkout-dialog');
ok(dialog?.open, 'the checkout dialog opens');

const form = doc.querySelector('#checkout-form');
form.elements.websiteUrl.value = 'https://example.com';
form.elements.email.value = 'buyer@example.com';
for (const element of [...form.elements]) element.reportValidity = () => true;

const step = n => doc.querySelector(`.purchase-step[data-step="${n}"]`);
doc.querySelector('[data-next="2"]').dispatchEvent(new window.Event('click', { bubbles: true }));
await new Promise(r => setTimeout(r, 200));
ok(!step(2).hidden, 'step 2 opens');
const total = doc.querySelector('#purchase-review .review-total b')?.textContent || '';
ok(/249/.test(total), `the review total is the price actually charged, not a literal: "${total}"`);
ok(doc.querySelector('#purchase-review').textContent.includes('example.com'), 'the review shows what was entered');

doc.querySelector('[data-next="3"]').dispatchEvent(new window.Event('click', { bubbles: true }));
await new Promise(r => setTimeout(r, 600));
ok(!step(3).hidden, 'step 3 opens');
const payment = doc.querySelector('#payment-options')?.textContent || '';
ok(/249|payment|Contact/i.test(payment), `the payment step renders something real: "${payment.slice(0, 80)}"`);

doc.querySelector('[data-prev="2"]')?.dispatchEvent(new window.Event('click', { bubbles: true }));
await new Promise(r => setTimeout(r, 200));
ok(!step(2).hidden, 'the Back button returns to the previous step');

doc.getElementById('close-checkout').dispatchEvent(new window.Event('click', { bubbles: true }));
ok(!dialog.open, 'the checkout dialog closes');
eq(errors.length, 0, `nothing threw while driving the checkout: ${errors.join(' | ')}`);

// 8. "Find my audit", end to end. The findings the admin writes one per line were split on
// /\\r?\\n/ -- a literal backslash followed by r or n, which no real newline ever matches --
// so all five arrived as a single crushed bullet. clean() keeps real newlines, so nothing
// upstream made that regex correct; it was simply wrong, and only running the route shows it.
{
  const post = (url, body, extra = {}) => fetch(B + url, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: B, ...extra },
    body: JSON.stringify(body)
  });

  const created = await (await post('/api/preview-request', {
    websiteUrl: 'https://findme.example.com', email: 'findme@example.com', businessType: 'dental'
  })).json();
  ok(created.requestId, 'a preview request creates a lead');

  const login = await post('/api/admin/login', { username: 'site-probe', password: 'site-probe-password' });
  const adminCookie = (login.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  eq(login.status, 200, 'the admin can log in');

  const patched = await fetch(`${B}/api/admin/leads/${encodeURIComponent(created.requestId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: adminCookie, origin: B },
    body: JSON.stringify({
      status: 'preview_sent',
      miniAuditTitle: 'Your mini-audit',
      miniAuditSummary: 'Three things cost you bookings.',
      miniAuditFindings: 'Weak call to action\nNo mobile booking\nSlow contact form'
    })
  });
  eq(patched.status, 200, 'the admin can attach a mini-audit');

  const found = await (await post('/api/find-mini-audit', { email: 'findme@example.com' })).json();
  ok(found.found, 'the customer finds their mini-audit by email');
  eq(found.miniAudit.findings.length, 3, 'each line the admin wrote is its own finding');
  eq(found.miniAudit.findings[0], 'Weak call to action', 'and the first one is intact');
  eq(found.miniAudit.findings[2], 'Slow contact form', 'and so is the last');
  eq(found.priceCents, charged, 'the price quoted here is the price charged');
}

// These helpers lived in three files as four implementations and had already drifted: pretty()
// was made to escape in admin.js after it was found being interpolated into innerHTML, while
// the identical copy in order.js -- feeding the order status card a customer sees -- was left
// as it was. One implementation each, or the next fix reaches one page out of three.
{
  const shared = ['esc', 'escHtml', 'escAttr', 'pretty', 'money', 'formatMoney', 'formatDate', 'link'];
  const scripts = ['app.js', 'admin.js', 'order.js', 'success.js', 'marketplaces.js']
    .filter(name => fs.existsSync(path.join(repo, 'public', name)));
  for (const name of shared) {
    const owners = scripts.filter(file =>
      new RegExp(`^(?:function ${name}\\(|const ${name}\\s*=)`, 'm')
        .test(fs.readFileSync(path.join(repo, 'public', name === '' ? '' : file), 'utf8')));
    eq(owners.length, 0, `${name}() is defined only in common.js, not in ${owners.join(', ')}`);
  }
  const common = fs.readFileSync(path.join(repo, 'public', 'common.js'), 'utf8');
  for (const name of shared)
    ok(new RegExp(`function ${name}\\(`).test(common), `${name}() lives in common.js`);
  ok(!/^const \w+ = esc;/m.test(common),
    'and is declared as a function, since a classic script const is not visible to an eval the way it is to a browser');

  // Every page that runs a script must load the shared one first.
  for (const page of ['index.html', 'admin.html', 'order.html', 'success.html']) {
    const markup = fs.readFileSync(path.join(repo, 'public', page), 'utf8');
    ok(markup.includes('common.js'), `${page} loads common.js`);
    ok(markup.indexOf('common.js') < markup.search(/src="(?:app|admin|order|success)\.js"/),
      `${page} loads it before its own script`);
  }
}

stop();
console.log(`public-site-test OK (${checks} checks, live server, real DOM, every link and button driven)`);
