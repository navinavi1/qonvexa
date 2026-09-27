import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const pkg=JSON.parse(fs.readFileSync('package.json'));
const expand=command=>command.split(' && ').flatMap(c=>c.startsWith('npm run ')?expand(pkg.scripts[c.slice(8).trim()]):[c]);
const commands=expand(pkg.scripts['verify:legacy'] || pkg.scripts.verify);const results=[];
fs.mkdirSync('test-results',{recursive:true});
for(const [index,command] of commands.entries()){
 if(command==='node scripts/coding-job-test.mjs'){results.push({command,status:'SKIPPED',reason:'Fixture executes git commit; user explicitly prohibited commits. Initial guarded attempt was blocked before commit.'});continue;}
 const parts=command.split(/\s+/);if(parts[0]!=='node'){results.push({command,status:'SKIPPED',reason:'Non-node command needs review'});continue;}
 const start=Date.now();const run=spawnSync(process.execPath,parts.slice(1),{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_OPTIONS:`--require=${path.resolve('tests/qonvexa/offline.cjs')}`,NODE_ENV:'test',QONVEXA_PAYMENTS_ENABLED:'true',QONVEXA_OUTBOUND_ENABLED:'false'},encoding:'utf8',timeout:45000,maxBuffer:2e6});
 const status=run.status===0?'PASS':'FAIL';const output=(run.stdout||'')+(run.stderr||'');
 fs.writeFileSync(`test-results/existing-${index}.log`,output);
 results.push({command,status,exitCode:run.status,signal:run.signal,durationMs:Date.now()-start,reason:run.error?.message||(status==='FAIL'?output.slice(-2500):'Executed with loopback-only network guard')});
 fs.writeFileSync('test-results/existing.json',JSON.stringify(results,null,2));console.log(`${index+1}/${commands.length} ${status} ${command}`);
}
console.log(JSON.stringify({passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,skipped:results.filter(x=>x.status==='SKIPPED').length}));
