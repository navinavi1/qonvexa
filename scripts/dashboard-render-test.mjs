// Render the real page against the real server payload in a real DOM. A missing element or a
// thrown renderer is invisible in a browser -- el('#x') returns null, the optional chain
// swallows it, the panel simply stays blank -- so nothing short of running it proves the
// dashboard still draws after the cut.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { spawn } from 'node:child_process';

// Boots the real server and renders the real page against its real snapshot. Reading the
// files proves nothing here: a removed element leaves el('#x') returning null, the optional
// chain swallows it, and the panel just stays blank in the browser with no error anywhere.
const PORT=3991+Math.floor(Math.random()*40);
const B='http://127.0.0.1:'+PORT;
const storage=fs.mkdtempSync(path.join(os.tmpdir(),'dash-render-'));
const server=spawn(process.execPath,['server.js'],{
  cwd:path.join(import.meta.dirname,'..'),
  env:{...process.env,PORT:String(PORT),STORAGE_DIR:storage,NODE_ENV:'production',
    ADMIN_USERNAME:'render-probe',ADMIN_PASSWORD:'render-probe-password',
    ADMIN_SESSION_SECRET:'render-probe-secret-0123456789abcdef0123456789',
    IP_HASH_SALT:'render-probe-salt-0123456789abcdef',
    SITE_URL:B,AUTONOMOS_ENABLED:'false',npm_lifecycle_event:''},
  stdio:['ignore','pipe','pipe']});
const stop=()=>{try{server.kill('SIGKILL');}catch{}try{fs.rmSync(storage,{recursive:true,force:true});}catch{}};
process.on('exit',stop);

const jsonOf=async(url,init)=>{const r=await fetch(url,init);return{status:r.status,headers:r.headers,body:await r.json()};};
let up=false;
for(let i=0;i<120;i++){
  await new Promise(r=>setTimeout(r,250));
  try{const r=await fetch(B+'/health');if(r.ok){up=true;break;}}catch{}
}
if(!up){stop();throw new Error('the server did not start, so nothing here could be verified');}

const login=await fetch(B+'/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:'render-probe',password:'render-probe-password'})});
const cookie=(login.headers.getSetCookie?.()||[]).map(c=>c.split(';')[0]).join('; ');
const snapshot=(await jsonOf(B+'/api/admin/autonomos',{headers:{cookie}})).body;

// Absolute paths to the author's own checkout. They resolved here and nowhere else, so
// verify passed locally and died with ENOENT inside the deploy build, where the repo sits
// at /opt/render/project/src -- a red deploy caused entirely by the test, not the code.
// Resolve against this file instead, so the test travels with the repository.
const publicDir=path.join(import.meta.dirname,'..','public');
const html=fs.readFileSync(path.join(publicDir,'admin.html'),'utf8');
const dom=new JSDOM(html,{url:B,runScripts:'outside-only',pretendToBeVisual:true});
const {window}=dom;
// The script runs inside the jsdom window, not this process, so give that window its own
// fetch stub rather than reassigning read-only globals here.
window.fetch=async()=>({ok:true,status:200,json:async()=>({}),text:async()=>''});

const script=fs.readFileSync(path.join(publicDir,'admin.js'),'utf8');
const errors=[];
window.addEventListener('error',e=>errors.push(String(e.message)));
try{ window.eval(script); }catch(e){ errors.push('load: '+e.message); }

// Drive the renderer the page itself uses.
let rendered=0;
const fn=window.renderAutonomOS||window.eval('typeof renderAutonomOS!=="undefined"?renderAutonomOS:null');
if(typeof fn==='function'){ try{ fn(snapshot); rendered=1; }catch(e){ errors.push('renderAutonomOS: '+e.message); } }

const doc=window.document;
const assert=(await import('node:assert/strict')).default;
let checks=0;
const ok=(c,l)=>{assert.ok(c,l);checks++;};
const eq=(a,b,l)=>{assert.equal(a,b,l+' (got '+JSON.stringify(a)+')');checks++;};

eq(errors.length,0,'the page renders live data without a JavaScript error: '+errors.join(' | '));
eq(rendered,1,'renderAutonomOS ran against the real snapshot');

// Every id the script reaches for must exist, because a missing one fails silently.
const defined=new Set([...doc.querySelectorAll('[id]')].map(n=>n.id));
const asked=new Set([...script.matchAll(/el\('#([a-zA-Z0-9-]+)'\)|setText\('#([a-zA-Z0-9-]+)'/g)].map(m=>m[1]||m[2]));
const orphans=[...asked].filter(id=>!defined.has(id));
eq(orphans.length,0,'no element is asked for and absent: '+orphans.join(', '));
const unused=[...defined].filter(id=>!script.includes(id));
eq(unused.length,0,'no element is rendered and never touched: '+unused.join(', '));

// The panel is six tiles, one per stage of the work, not twenty restating the same money.
const tiles=[...doc.querySelectorAll('.autonomos-stat')].map(a=>a.querySelector('small')?.textContent);
assert.deepEqual(tiles,['FOUND','READY NOW','ACTIVE','DELIVERED','PAID','NET'],'the tiles are the six stages');checks++;

// Controls that cannot do what they appear to do are the defect this pass exists to remove.
for(const name of ['reservePercent','growthPercent']){
  const input=doc.querySelector(`[name="${name}"]`);
  ok(input,name+' is still shown');
  ok(input.hasAttribute('readonly'),name+' is a reading, not an editable control: it is derived server-side');
  ok(input.closest('label')?.querySelector('.derived-note'),name+' says where its value comes from');
}
ok(!script.includes("'reservePercent','growthPercent'"),'the form no longer submits the derived fields');

// Panels that carried no information are gone, and the one useful line they held was kept.
for(const gone of ['autonomos-events','autonomos-connectors','autonomos-infrastructure','autonomos-products','autonomos-active-jobs','autonomos-task-agents','autonomos-market-jobs','autonomos-incidents'])
  ok(!defined.has(gone),gone+' was removed');
ok(defined.has('autonomos-missing'),'what is not configured is still shown, beside what is blocking');
ok(defined.has('autonomos-market-radar'),'the panel explaining why it is not earning is kept');
ok(defined.has('autonomos-job-queue'),'the work pipeline is kept');
ok(defined.has('autonomos-wallet'),'the wallet panel is kept');


// A test that reads a path which exists on one developer's machine passes there and takes
// the whole deploy build down with ENOENT everywhere else -- and the build is the only
// thing standing between a bad commit and production, so it is the worst possible place
// to hide a machine-specific path. This file did exactly that. Nothing under scripts/ may
// read an absolute path again: repo files resolve from import.meta.dirname, scratch space
// comes from os.tmpdir(). (src/ is exempt: /home/user there is the E2B sandbox's own
// filesystem, a real remote path, not this checkout.)
const scriptsDir=path.join(import.meta.dirname);
const machinePaths=[];
for(const file of fs.readdirSync(scriptsDir).filter(f=>/\.(mjs|js)$/.test(f))){
  const body=fs.readFileSync(path.join(scriptsDir,file),'utf8');
  for(const match of body.matchAll(/readFileSync\(\s*(['"`])(\/[^'"`]*)\1/g)){
    const target=match[2];
    if(target.startsWith('/tmp/')||target.startsWith('/dev/'))continue;
    machinePaths.push(file+' -> '+target);
  }
}
eq(machinePaths.length,0,'no script reads an absolute path that only exists on one machine: '+machinePaths.join(', '));

stop();
console.log('dashboard-render-test OK ('+checks+' checks, '+tiles.length+' tiles, live server, no JS errors)');
