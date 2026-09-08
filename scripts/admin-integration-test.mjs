import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {JSDOM,VirtualConsole} from 'jsdom';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'admin-integration-'));
const port=36400+Math.floor(Math.random()*1000);const base=`http://127.0.0.1:${port}`;
const proc=spawn(process.execPath,['server.js'],{env:{PATH:process.env.PATH,PORT:String(port),NODE_ENV:'development',STORAGE_DIR:dir,SITE_URL:base,ADMIN_PASSWORD:'local-test-only-password',ADMIN_SESSION_SECRET:'local-test-only-session-secret-32-characters',AUTONOMOS_ENABLED:'false',TASKBOUNTY_WEBHOOK_SECRET:'local-test-webhook-secret-32-characters'},stdio:['ignore','pipe','pipe']});
let output='';proc.stdout.on('data',b=>output+=b);proc.stderr.on('data',b=>output+=b);let dom;
try{
  let ready=false;for(let i=0;i<80;i++){try{ready=(await fetch(base+'/version')).ok}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert(ready,output);
  const request=(suffix,body,cookie='',origin=base)=>fetch(base+suffix,{method:'POST',headers:{'content-type':'application/json',cookie,origin},body:JSON.stringify(body)});
  assert.equal((await request('/api/admin/autonomos/marketplaces/taskbounty/config',{enabled:false})).status,401);
  const login=await request('/api/admin/login',{username:'admin',password:'local-test-only-password'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/admin/autonomos/marketplaces/taskbounty/config',{enabled:false},cookie,'https://evil.example')).status,403);
  assert.equal((await request('/api/admin/autonomos/marketplaces/taskbounty/config',{enabled:false},cookie)).status,200);
  assert.equal((await request('/api/admin/autonomos/marketplaces/taskbounty/config',{mode:'live'},cookie)).status,400);
  assert.equal((await request('/api/admin/autonomos/marketplaces/taskbounty/canary',{},cookie)).status,400);
  const eventBody=JSON.stringify({task_id:'fixture-task'});const signature='sha256='+crypto.createHmac('sha256','local-test-webhook-secret-32-characters').update(eventBody).digest('hex');
  const webhook=sig=>fetch(base+'/api/webhooks/taskbounty',{method:'POST',headers:{'content-type':'application/json','X-TaskBounty-Signature':sig},body:eventBody});
  assert.equal((await webhook('invalid')).status,401);assert((await(await webhook(signature)).json()).queued);assert((await(await webhook(signature)).json()).duplicate);
  const errors=[];const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',e=>errors.push(e.message));virtualConsole.on('error',e=>errors.push(String(e)));
  dom=new JSDOM(await(await fetch(base+'/admin')).text(),{url:base+'/admin#autonomos',runScripts:'outside-only',virtualConsole});
  dom.window.fetch=(url,opts={})=>fetch(new URL(url,base),{...opts,headers:{...opts.headers,cookie,origin:base}});dom.window.alert=()=>{};dom.window.confirm=()=>false;
  dom.window.eval(await fs.readFile('public/marketplaces.js','utf8'));dom.window.eval(await fs.readFile('public/admin.js','utf8'));
  for(let i=0;i<50;i++){if(dom.window.document.getElementById('autonomos-global-work-feed'))break;await new Promise(r=>setTimeout(r,50));}
  assert(dom.window.document.getElementById('autonomos-global-work-feed'),'clean global work feed must render');
  assert.equal(dom.window.document.querySelectorAll('[data-market]').length,0,'legacy marketplace control cards must stay deleted');
  assert.equal(dom.window.document.querySelector('.autonomos-t2000-card'),null,'legacy T2000 card must not survive dashboard cleanup');
  for(const tab of dom.window.document.querySelectorAll('[data-view]')){tab.click();assert.equal(dom.window.document.querySelector('.admin-view.active').dataset.panel,tab.dataset.view);}
  dom.window.location.hash='leads';await new Promise(r=>setTimeout(r,30));assert.equal(dom.window.document.querySelector('.admin-view.active').dataset.panel,'leads');
  dom.window.document.querySelector('[data-view="autonomos"]').click();
  const snapshot=await(await fetch(base+'/api/admin/autonomos',{headers:{cookie}})).json();assert(snapshot.newMarketplaces?.markets?.length>=2,'active AgentHansa/TaskBounty backend remains available');
  assert.deepEqual(errors,[]);
  globalThis.console.log('PASS real HTTP server: auth, cross-origin rejection, webhook, cleaned admin rendering and active marketplace backend');
}finally{dom?.window.close();proc.kill('SIGTERM');await Promise.race([once(proc,'exit'),new Promise(r=>setTimeout(r,3000))]);await fs.rm(dir,{recursive:true,force:true});}
