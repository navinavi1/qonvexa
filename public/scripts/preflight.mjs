import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const mode=String(process.env.LAUNCH_MODE||'staging').toLowerCase();
const errors=[]; const warnings=[];
const requiredFiles=['server.js','render.yaml','public/index.html','public/styles.css','public/app.js','public/admin.html','public/admin.js','public/success.html','public/success.js','public/order.html','public/order.js'];
for(const f of requiredFiles) if(!fs.existsSync(path.join(root,f))) errors.push(`Missing ${f}`);
const server=read('server.js'); const index=read('public/index.html'); const render=read('render.yaml');
for(const marker of ['/stripe/webhook','/api/preview-request','/api/create-checkout-session','/api/purchase-options','/api/manual-order','/api/order-status','/api/admin/dashboard','/version']) if(!server.includes(marker)) errors.push(`Missing endpoint ${marker}`);
if(!render.includes('runtime: node')) errors.push('render.yaml must use runtime: node');
if(mode==='live' && !String(process.env.STORAGE_DIR||'').startsWith('/var/lib/qonvexa')) errors.push('Live mode requires persistent STORAGE_DIR under /var/lib/qonvexa');
if(!render.includes('qonvexa.co')) warnings.push('Custom domain qonvexa.co is not declared');
if(!index.includes('{{SITE_URL}}')) warnings.push('Dynamic SITE_URL token not found in index metadata');
if(!index.includes('hello@qonvexa.co') && !index.includes('{{CONTACT_EMAIL}}')) warnings.push('Production contact email is not wired into the site');
if(index.includes('Replace placeholder contact')) errors.push('Public footer still contains launch placeholder text');
if(index.includes('data-count="149">0<')) errors.push('Price fallback still renders as $0 without JavaScript');
if(!index.includes('purchase-dialog')) errors.push('Purchase flow markup missing');
if(!index.includes('nav-toggle') || !index.includes('primary-nav')) errors.push('Production mobile navigation toggle missing');
if(!index.includes('aria-current="step"')) errors.push('Checkout step accessibility state missing');
const css=read('public/styles.css');
if(!css.includes('QONVEXA 9.0 — Customer Purchase Experience')) errors.push('9.0 responsive purchase CSS missing');
if(!css.includes('@media(max-width:760px)')) warnings.push('Expected mobile breakpoint missing');
if(!server.includes("max-age=0, must-revalidate")) errors.push('Production cache policy must revalidate JS/CSS and dynamic HTML');
if(server.includes('DELIVERY_PORTAL_URL')) errors.push('Global delivery URL is unsafe for personalized per-order delivery');
if(!server.includes("deliveryUrl: type === 'order'")) errors.push('Per-order delivery state is not surfaced to admin');
if(mode==='live'){
  const keys=['SITE_URL','CONTACT_EMAIL','LEGAL_BUSINESS_NAME','LEGAL_ADDRESS','LEGAL_JURISDICTION','DELIVERY_TIMEFRAME','REFUND_POLICY_TEXT','ADMIN_USERNAME','ADMIN_PASSWORD','ADMIN_SESSION_SECRET','IP_HASH_SALT'];
  for(const k of keys) if(!String(process.env[k]||'').trim()) errors.push(`Missing live env ${k}`);
  const hasStripe=Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET && !process.env.STRIPE_SECRET_KEY.startsWith('sk_test_'));
  const manualEnabled=/^(1|true|yes|on)$/i.test(String(process.env.MANUAL_PAYMENT_ENABLED||'false'));
  const hasManual=manualEnabled && Boolean(process.env.BANK_BENEFICIARY) && Boolean(process.env.BANK_IBAN||process.env.BANK_ACCOUNT);
  if(!hasStripe && !hasManual) errors.push('Live mode needs at least one configured payment method');
}
for(const w of warnings) console.log(`WARN  ${w}`);
for(const e of errors) console.error(`FAIL  ${e}`);
if(errors.length) process.exit(1);
console.log(`PASS  QONVEXA preflight (${mode})`);
