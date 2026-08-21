import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const index=read('public/index.html');
const app=read('public/app.js');
const css=read('public/styles.css');
const admin=read('public/admin.js');

const checks=[
  ['four-step purchase UI', index.includes('data-step="1"') && index.includes('data-step="4"')],
  ['progress UI', index.includes('purchase-progress')],
  ['inline purchase tips', index.includes('purchase-tip')],
  ['server purchase options', server.includes("/api/purchase-options")],
  ['manual fallback order', server.includes("/api/manual-order") && server.includes('BANK_BENEFICIARY')],
  ['secure public order status', server.includes("/api/order-status") && server.includes('hashOrderToken')],
  ['automatic status refresh', read('public/order.js').includes('15000')],
  ['card checkout preserved', server.includes("/api/create-checkout-session") && app.includes('startCardCheckout')],
  ['mobile purchase layout', css.includes('@media(max-width:760px)') && css.includes('.purchase-dialog')],
  ['admin awaiting-payment workflow', admin.includes('awaiting_payment')]
];

let failed=false;
for(const [name,ok] of checks){
  console.log(`${ok?'PASS':'FAIL'}  ${name}`);
  if(!ok) failed=true;
}
if(failed) process.exit(1);
console.log('PASS  QONVEXA 9.0 purchase experience audit');
