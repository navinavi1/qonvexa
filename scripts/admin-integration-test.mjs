import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {JSDOM,VirtualConsole} from 'jsdom';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'admin-integration-'));
const port=36400+Math.floor(Math.random()*1000);const base=`http://127.0.0.1:${port}`;
const proc=spawn(process.execPath,['server.js'],{env:{PATH:process.env.PATH,PORT:String(port),NODE_ENV:'development',STORAGE_DIR:dir,SITE_URL:base,ADMIN_PASSWORD:'local-test-only-password',ADMIN_SESSION_SECRET:'local-test-only-session-secret-32-characters',AUTONOMOS_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
let output='';proc.stdout.on('data',b=>output+=b);proc.stderr.on('data',b=>output+=b);let dom;
try{
  let ready=false;for(let i=0;i<80;i++){try{ready=(await fetch(base+'/version')).ok}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert(ready,output);
  const request=(suffix,body,cookie='',origin=base)=>fetch(base+suffix,{method:suffix==='/api/admin/autonomos/config'?'PATCH':'POST',headers:{'content-type':'application/json',cookie,origin},body:JSON.stringify(body)});
  assert.equal((await request('/api/admin/autonomos/config',{enabled:false})).status,401);
  const login=await request('/api/admin/login',{username:'admin',password:'local-test-only-password'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/admin/autonomos/config',{enabled:false},cookie,'https://evil.example')).status,403);
  assert.equal((await request('/api/admin/autonomos/config',{enabled:false},cookie)).status,200);
  for(const source of ['taskbounty','agenthansa'])assert.equal((await request(`/api/admin/autonomos/marketplaces/${source}/canary`,{},cookie)).status,404);
  assert.equal((await request('/api/webhooks/taskbounty',{})).status,404);
  const errors=[];const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',e=>errors.push(e.message));virtualConsole.on('error',e=>errors.push(String(e)));
  dom=new JSDOM(await(await fetch(base+'/admin')).text(),{url:base+'/admin#autonomos',runScripts:'outside-only',virtualConsole});
  dom.window.fetch=(url,opts={})=>fetch(new URL(url,base),{...opts,headers:{...opts.headers,cookie,origin:base}});dom.window.alert=()=>{};dom.window.confirm=()=>false;
  dom.window.eval(await fs.readFile('public/marketplaces.js','utf8'));dom.window.eval(await fs.readFile('public/admin.js','utf8'));
  for(let i=0;i<50;i++){if(dom.window.document.getElementById('autonomos-global-work-feed'))break;await new Promise(r=>setTimeout(r,50));}
  assert(dom.window.document.getElementById('autonomos-global-work-feed'),'clean global work feed must render');
  assert.equal(dom.window.document.querySelectorAll('[data-market]').length,0,'legacy marketplace control cards must stay deleted');
  assert.equal(dom.window.document.querySelector('.autonomos-workprotocol-card'),null,'legacy WorkProtocol card must not survive dashboard cleanup');
  for(const tab of dom.window.document.querySelectorAll('[data-view]')){tab.click();assert.equal(dom.window.document.querySelector('.admin-view.active').dataset.panel,tab.dataset.view);}
  dom.window.location.hash='leads';await new Promise(r=>setTimeout(r,30));assert.equal(dom.window.document.querySelector('.admin-view.active').dataset.panel,'leads');
  dom.window.document.querySelector('[data-view="autonomos"]').click();
  const snapshot=await(await fetch(base+'/api/admin/autonomos',{headers:{cookie}})).json();assert(!snapshot.newMarketplaces,'retired marketplace manager must not run');assert(!snapshot.connectors.some(x=>['agenthansa','taskbounty'].includes(x.id)));assert(!snapshot.connectors.some(x=>x.id==='workprotocol'));assert(!snapshot.connectors.some(x=>x.id==='dealwork'));
  assert.deepEqual(errors,[]);
  globalThis.console.log('PASS real HTTP server: auth, cross-origin rejection, removed provider routes, cleaned admin rendering and remaining connectors');
}finally{dom?.window.close();proc.kill('SIGTERM');await Promise.race([once(proc,'exit'),new Promise(r=>setTimeout(r,3000))]);await fs.rm(dir,{recursive:true,force:true});}

