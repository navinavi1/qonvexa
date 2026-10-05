import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import net from 'node:net';import {spawn} from 'node:child_process';
const root=process.cwd();
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
async function launch(t,entry,{poison=true,once=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qvx-isolation-'));let attempts=0;
 const trap=net.createServer(s=>{attempts++;s.destroy();});await listen(trap);
 const probe=net.createServer();await listen(probe);const port=probe.address().port;await new Promise(r=>probe.close(r));
 const env={PATH:process.env.PATH,NODE_ENV:'test',PORT:String(port),SITE_URL:`http://127.0.0.1:${port}`,STORAGE_DIR:dir,AUTONOMOS_ENABLED:'true',AUTONOMOS_TASKMARKET_ENABLED:'true',QONVEXA_PUBLIC_FETCH_ENABLED:'false',QONVEXA_PAYMENTS_ENABLED:'false',QONVEXA_OUTBOUND_ENABLED:'false'};
 if(poison){env.REDIS_URL=`redis://127.0.0.1:${trap.address().port}`;env.DATABASE_URL=`postgres://fixture:fixture@127.0.0.1:${trap.address().port}/autonomos`;} 
 let logs='';const child=spawn(process.execPath,['--experimental-loader',path.resolve('tests/qonvexa/fixtures/no-legacy-loader.mjs'),entry,...(once?['--once']:[])],{env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);const exited=new Promise(r=>child.once('exit',(code)=>r(code)));
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await exited;}await new Promise(r=>trap.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 if(once){assert.equal(await exited,0,logs);}else{
  let ready=false;for(let i=0;i<100;i++){try{const res=await fetch(env.SITE_URL+'/health');if(res.ok){const h=await res.json();assert.equal(h.runtimeProfile,'qonvexa-isolated-v1');assert.equal(h.externalRedisRequired,false);assert.equal(h.externalPostgresRequired,false);ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,30));}
  assert(ready,logs);assert.equal((await fetch(env.SITE_URL+'/')).status,200);assert.equal((await fetch(env.SITE_URL+'/api/purchase-options')).status,200);
  assert.equal((await fetch(env.SITE_URL+'/api/autonomos/catalog')).status,410);
 }
 assert.equal(attempts,0,'No Redis or PostgreSQL connection attempts');assert(!fs.readdirSync(dir).some(n=>/autonomos|treasury|marketplace/.test(n)));assert(!/Forbidden legacy/.test(logs),logs);
}
for(const poison of [false,true]){
 test(`Qonvexa web ignores ${poison?'inherited legacy URLs':'absent legacy URLs'}`,t=>launch(t,'server.js',{poison}));
 test(`Qonvexa worker ignores ${poison?'inherited legacy URLs':'absent legacy URLs'}`,t=>launch(t,'scripts/qonvexa-worker.mjs',{poison,once:true}));
}
test('Old startup alias only starts isolated web',t=>launch(t,'scripts/start-autonomos.mjs'));
test('Application import graph and deployment config have no legacy service dependencies',()=>{
 const visited=new Set();function visit(file){file=path.resolve(file);if(visited.has(file))return;visited.add(file);const source=fs.readFileSync(file,'utf8');assert(!/process\.env\.(REDIS_URL|DATABASE_URL)/.test(source),file);
  for(const m of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)){
   const spec=m[1];assert(!/(?:^|\/)autonomos\//.test(spec),file);assert(!/^(redis|pg|@langchain)(\/|$)/.test(spec),file);
   if(spec.startsWith('.'))visit(path.resolve(path.dirname(file),spec));
  }
 }
 for(const entry of ['server.js','scripts/qonvexa-worker.mjs','scripts/start-autonomos.mjs','scripts/start-qonvexa.mjs'])visit(entry);
 const yaml=fs.readFileSync('render.yaml','utf8');assert(!/key: (REDIS_URL|DATABASE_URL)|autonomos-cache|autonomos-db|fromDatabase|fromService/.test(yaml));assert(!/AUTONOMOS_ENABLED\s*\n\s*value: "true"/.test(yaml));
 for(const f of ['.env.example','.env.production.example'])assert(!/^(REDIS_URL|DATABASE_URL)=/m.test(fs.readFileSync(f,'utf8')));
 const pkg=JSON.parse(fs.readFileSync('package.json'));assert.equal(pkg.scripts.verify,'node scripts/verify-qonvexa.mjs');assert(!pkg.scripts['verify:legacy'],'AutonomOS lives on the archive/autonomos branch, not here');assert(!fs.existsSync('src/autonomos'),'the AutonomOS engine must not return to the Qonvexa tree');for(const dep of Object.keys(pkg.dependencies||{}))assert(!/^(pg|redis|@langchain|@openai\/agents|@e2b|@trigger\.dev|@aws-sdk)/.test(dep),'AutonomOS-only dependency: '+dep);assert(!fs.readFileSync('.github/workflows/verify.yml','utf8').includes('src/autonomos'));
});

test('Production launcher runs isolated web and worker on one disk',t=>launch(t,'scripts/start-qonvexa.mjs'));
