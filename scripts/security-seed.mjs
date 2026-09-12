import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutonomOSStore } from '../src/autonomos/store.js';
import { PROGRAM_FILE, programsFromRegistry } from '../src/autonomos/security-research.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const seed=JSON.parse(fs.readFileSync(path.join(here,'..','data','security-programs.seed.json'),'utf8'));
const root=process.env.STORAGE_DIR;
if(!root){console.error('STORAGE_DIR is not set; nothing to seed.');process.exit(1);}
const store=new AutonomOSStore(root);
const existing=store.readJson(PROGRAM_FILE,null);
if(existing&&programsFromRegistry(existing).length&&!process.argv.includes('--force')){
  console.log('security-programs.json already has '+programsFromRegistry(existing).length+' programs; pass --force to overwrite.');
  process.exit(0);
}
store.writeJson(PROGRAM_FILE,seed);
const programs=programsFromRegistry(seed);
console.log('Seeded '+programs.length+' programs.');
console.log('Advertised ceiling total: $'+programs.reduce((a,b)=>a+b.maxBountyUsd,0).toLocaleString());
console.log('Actually escrowed total:  $'+programs.reduce((a,b)=>a+b.vaultUsd,0).toLocaleString());
