import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const files=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(['node_modules','.git','data','test-results'].includes(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.(mjs|cjs|js)$/.test(e.name))files.push(p);}}walk('.');
let failed=0;for(const p of files){const r=spawnSync(process.execPath,['--check',p],{encoding:'utf8'});if(r.status!==0){failed++;console.error(p,r.stderr);}}
console.log(JSON.stringify({command:'node --check (all JS source/scripts/tests)',files:files.length,passed:files.length-failed,failed}));process.exitCode=failed?1:0;
