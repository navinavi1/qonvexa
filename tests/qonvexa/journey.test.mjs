import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import net from 'node:net';import {JSDOM,VirtualConsole} from 'jsdom';
import {Store} from '../../src/qonvexa/store.js';import {tick} from '../../src/qonvexa/worker.js';import {config} from '../../src/qonvexa/config.js';
const root=path.resolve('.');
async function start(t,extra={}){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qvx-journey-'));const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const base=`http://127.0.0.1:${port}`;
 let logs='';const child=spawn(process.execPath,['server.js'],{cwd:root,env:{PATH:process.env.PATH,NODE_ENV:'test',PORT:String(port),SITE_URL:base,STORAGE_DIR:temp,ADMIN_PASSWORD:'fixture-password-only',ADMIN_SESSION_SECRET:'fixture-session-secret-not-production',QONVEXA_PUBLIC_FETCH_ENABLED:'true',AUTONOMOS_ENABLED:'true',AUTONOMOS_INTERNET_HUNTER_ENABLED:'true',...extra},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 t.after(async()=>{child.kill('SIGTERM');await new Promise(r=>{child.once('exit',r);setTimeout(r,2000).unref();});fs.rmSync(temp,{recursive:true,force:true});});
 let up=false;for(let i=0;i<80;i++){try{if((await fetch(base+'/health')).ok){up=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert(up,logs);
 const request=async(p,body,headers={})=>{const r=await fetch(base+p,{method:body?'POST':'GET',headers:{...(body?{'content-type':'application/json',origin:base}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});let data;try{data=await r.json();}catch{data=null;}return {status:r.status,data,headers:r.headers};};
 return {temp,base,request,child,logs:()=>logs};
}
const fixture=async()=>({pages:[{url:'https://example.com/',status:200,headers:{'content-type':'text/html'},body:'<html><head></head><body><h1>Example</h1><img src="photo.jpg"><form><input name="email"></form></body></html>',bytes:130,ttfbMs:20,redirects:[],observedAt:new Date().toISOString()}],ancillary:[],observedAt:new Date().toISOString(),limits:{maxPages:2}});
test('End-to-end customer/admin flow with fixture scan and manual test payment',async t=>{
 const {temp,base,request}=await start(t,{QONVEXA_PAYMENTS_ENABLED:'true',MANUAL_PAYMENT_ENABLED:'true',BANK_BENEFICIARY:'Fixture Company',BANK_NAME:'Fixture Bank',BANK_IBAN:'UA123456789012345678901234567',BANK_CURRENCY:'USD'});
 const home=await fetch(base+'/');assert.equal(home.status,200);assert.match(await home.text(),/Growth Audit/);
 assert.equal((await request('/api/admin/next')).status,401);
 const created=await request('/api/preview-request',{websiteUrl:'https://example.com',email:'client@example.com'});assert.equal(created.status,200);assert(created.data.personal?.portalUrl);
 const key=created.data.personal.accessKey,headers={authorization:`Bearer ${key}`};
 let workspace=await request('/api/next/portal',null,headers);assert.equal(workspace.status,200);assert.equal(workspace.data.audits.length,1);
 assert.equal((await request('/api/next/portal',null,{authorization:`Bearer ${'a'.repeat(64)}`})).status,401);
 assert.equal((await request('/api/find-mini-audit',{email:'client@example.com'})).data.found,false);
 assert.equal((await request('/api/find-mini-audit',{email:'client@example.com',accessKey:key})).data.found,true);
 const s=new Store(temp);t.after(()=>s.close());await tick(s,{...config({}),scannerEnabled:true},{scan:fixture});
 workspace=await request('/api/next/portal',null,headers);assert.equal(workspace.data.audits[0].status,'AUDIT_READY');assert(workspace.data.audits[0].report.findings.length<=3);assert(!workspace.data.audits[0].report.recommendations);
 const foreign=await request('/api/preview-request',{websiteUrl:'https://other.example.com',email:'other@example.com'});
 assert.equal((await request('/api/next/quotes',{auditId:created.data.personal.auditId,serviceId:'seo',findingIds:[]},{authorization:`Bearer ${foreign.data.personal.accessKey}`})).status,404);
 const options=await request('/api/purchase-options');assert.equal(options.data.priceCents,14900);
 const order=await request('/api/manual-order',{websiteUrl:'https://example.com',email:'client@example.com',sourceLeadId:created.data.requestId});assert.equal(order.status,201,JSON.stringify(order.data));
 assert.equal((await request('/api/next/from-order',{orderToken:order.data.accessToken})).status,403);
 assert.equal((await request('/api/order-status?token='+order.data.accessToken+'&paid=true')).data.paymentStatus,'pending');
 const login=await request('/api/admin/login',{username:'admin',password:'fixture-password-only'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const patch=await fetch(base+'/api/admin/orders/'+order.data.orderId,{method:'PATCH',headers:{cookie,origin:base,'content-type':'application/json'},body:JSON.stringify({status:'paid',adminNote:'Local fixture bank payment, no money moved.'})});assert.equal(patch.status,200);
 assert.equal((await request('/api/order-status?token='+order.data.accessToken)).data.paymentStatus,'paid');
 const paid=await request('/api/next/from-order',{orderToken:order.data.accessToken});assert.equal(paid.status,200);const paidKey=paid.data.portalUrl.split('#')[1],paidHeaders={authorization:`Bearer ${paidKey}`};
 for(let i=0;i<3;i++)await tick(s,{...config({}),scannerEnabled:true},{scan:fixture});
 const full=(await request('/api/next/portal',null,paidHeaders)).data;const a=full.audits[0];assert(a.paid);assert(a.report.findings.length>3);assert(a.report.recommendations.length);
 const rec=a.report.recommendations.find(r=>r.serviceId==='seo');
 const q=await request('/api/next/quotes',{auditId:a.id,serviceId:'seo',findingIds:rec.findingIds},paidHeaders);assert.equal(q.status,201);assert.equal(q.data.checkoutAllowed,false);assert.equal(q.data.preflight.passed,false);
 assert.equal((await request(`/api/next/quotes/${q.data.id}/accept`,{},paidHeaders)).status,400);
 const plan=await request(`/api/next/quotes/${q.data.id}/plan`,{},paidHeaders);assert.equal(plan.data.status,'DRY_RUN');assert.equal(plan.data.externalActionsPerformed,0);
 assert.equal((await request(`/api/next/implementations/${plan.data.id}/approve`,{scopeHash:'wrong'},paidHeaders)).status,400);
 assert.equal((await request(`/api/next/implementations/${plan.data.id}/approve`,{scopeHash:plan.data.scopeHash},paidHeaders)).status,200);
 assert.equal((await request('/api/next/connections',{},paidHeaders)).status,501);
 const ops=await request('/api/admin/next',null,{cookie});assert.equal(ops.status,200);assert(ops.data.costs.length>0);assert(ops.data.quotes.length>0);
 assert.equal((await request('/api/admin/next/legacy-link',{leadId:created.data.requestId},{cookie,origin:'https://attacker.test'})).status,403);
 for(const url of ['/portal.html','/portal.js','/admin-next.html','/admin-next.js','/order.html','/admin','/privacy.html'])assert.equal((await fetch(base+url)).status,200,url);
 // Exercise actual portal JS DOM rendering and action handlers with live local backend.
 const virtualConsole=new VirtualConsole();const errors=[];virtualConsole.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(await(await fetch(base+'/portal.html')).text(),{url:base+'/portal.html#'+paidKey,runScripts:'outside-only',virtualConsole});t.after(()=>dom.window.close());
 dom.window.fetch=(url,init)=>fetch(new URL(url,base),init);dom.window.AbortSignal=AbortSignal;
 dom.window.eval(fs.readFileSync('public/portal.js','utf8'));for(let i=0;i<50&&!dom.window.document.querySelector('[data-plan]');i++)await new Promise(r=>setTimeout(r,20));
 assert.match(dom.window.document.getElementById('audits').textContent,/AUDIT_READY/);assert(dom.window.document.querySelector('[data-plan]'));assert.match(dom.window.document.getElementById('plans').textContent,/DRY_RUN/);assert.equal(dom.window.location.hash,'');assert.deepEqual(errors,[]);
 // No paid implementation or completed handoff is fabricated.
 assert.match(dom.window.document.getElementById('handoff').textContent,/No verified/);
});
test('Normal startup ignores legacy enable flags; unsafe actions remain disabled',async t=>{
 const {temp,base,request,logs}=await start(t);
 for(const p of ['/api/autonomos/catalog','/api/admin/autonomos/start','/api/internal/autonomos/trigger/execute'])assert.equal((await request(p,{})).status,410);
 assert(!fs.readdirSync(temp).some(f=>/autonomos|treasury|marketplace/.test(f)));
 assert(!/hunter|earning loop|swarm/i.test(logs()));
 const worker=spawn(process.execPath,['scripts/qonvexa-worker.mjs','--once'],{cwd:root,env:{PATH:process.env.PATH,STORAGE_DIR:temp,QONVEXA_FREE_COST_CAP:'-1'},stdio:'ignore'});const exit=await new Promise(r=>worker.once('exit',r));assert.notEqual(exit,0);assert.equal((await fetch(base+'/health')).status,200,'worker failure does not terminate web');
 assert.equal((await request('/api/manual-order',{websiteUrl:'https://example.com',email:'test@example.com'})).status,503);
 const t0=performance.now();for(let i=0;i<10;i++)assert.equal((await fetch(base+'/health')).status,200);assert(performance.now()-t0<3000);
 const admin=await(await fetch(base+'/admin')).text();assert(!admin.includes('src="marketplaces.js'));assert(admin.includes('/admin-next.html'));
 const source=fs.readFileSync('server.js','utf8');assert(!source.includes('createAutonomOS'));assert.equal(JSON.parse(fs.readFileSync('package.json')).scripts.start,'node scripts/start-qonvexa.mjs');
});
test('Bank transfer amount and paid status are server controlled',async t=>{
 const {base,request}=await start(t,{QONVEXA_PAYMENTS_ENABLED:'true',MANUAL_PAYMENT_ENABLED:'true',BANK_BENEFICIARY:'Fixture',BANK_NAME:'Fixture Bank',BANK_IBAN:'UA123456789012345678901234567',BANK_CURRENCY:'USD'});
 const options=await request('/api/purchase-options');assert.deepEqual(Object.keys(options.data.methods),['bankTransfer']);
 const o=await request('/api/manual-order',{websiteUrl:'https://example.com',email:'buyer@example.com',amountTotal:1,paymentStatus:'paid',status:'paid'});assert.equal(o.status,201);assert.equal(o.data.amountTotal,14900);
 const status=await request('/api/order-status?token='+o.data.accessToken+'&paid=true&session_id=paid');assert.equal(status.data.paymentStatus,'pending');
 const denied=await fetch(base+'/api/admin/orders/'+o.data.orderId,{method:'PATCH',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({status:'paid'})});assert.equal(denied.status,401);
 assert.equal((await request('/api/next/from-order',{orderToken:o.data.accessToken})).status,403);
 assert.equal((await request('/api/order-status?token='+'a'.repeat(48))).status,404);
});
