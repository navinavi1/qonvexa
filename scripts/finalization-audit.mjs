import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const index=read('public/index.html');
const app=read('public/app.js');
const css=read('public/styles.css');
const adminHtml=read('public/admin.html');
const admin=read('public/admin.js');
const order=read('public/order.js');
const env=read('.env.production.example');
const render=read('render.yaml');
const pkg=JSON.parse(read('package.json'));

const checks=[
  ['finalization version', ['9.1.0','11.0.0','12.0.0','13.0.0'].includes(pkg.version)],
  ['mobile menu markup', index.includes('nav-toggle') && index.includes('primary-nav')],
  ['mobile menu behavior', app.includes('setMobileNav')],
  ['mobile menu responsive CSS', css.includes('.primary-nav.open') && css.includes('@media(max-width:900px)')],
  ['checkout aria current step', index.includes('aria-current="step"') && app.includes("setAttribute('aria-current', 'step')")],
  ['staging payment safety gate', server.includes('ALLOW_STAGING_PAYMENTS') && render.includes('ALLOW_STAGING_PAYMENTS') && env.includes('ALLOW_STAGING_PAYMENTS=false')],
  ['unified card order status', server.includes('/order.html?token=') && order.includes('session_id')],
  ['secure card token verification', server.includes('publicTokenHash') && server.includes('safeCredentialEqual(expectedHash, hashOrderToken(token))')],
  ['per-order delivery URL', adminHtml.includes('deliveryUrl') && admin.includes('deliveryUrl') && server.includes("state.deliveryUrl")],
  ['no global delivery URL', !server.includes('DELIVERY_PORTAL_URL') && !env.includes('DELIVERY_PORTAL_URL')],
  ['paid revenue excludes pending orders', server.includes('(isOrderPaid(order) ? Number(order.amountTotal || 0) : 0)')],
  ['paid count excludes pending orders', server.includes('paidOrders: orders.filter(isOrderPaid).length')],
  ['persistent storage enforced in live mode', server.includes('Live mode requires persistent STORAGE_DIR under /var/lib/qonvexa')],
  ['admin reports storage truthfully', admin.includes("data.system.persistentStorage?'Persistent'")],
  ['cache revalidation', server.includes("max-age=0, must-revalidate")],
  ['version endpoint', server.includes("app.get('/version'") && server.includes('X-QONVEXA-Version')],
  ['legal placeholders are explicitly pre-launch', server.includes('QONVEXA — pre-launch') && server.includes('before paid checkout is enabled')]
];

let failed=false;
for(const [name,ok] of checks){
  console.log(`${ok?'PASS':'FAIL'}  ${name}`);
  if(!ok) failed=true;
}
if(failed) process.exit(1);
console.log('PASS  QONVEXA Production Finalization audit');
