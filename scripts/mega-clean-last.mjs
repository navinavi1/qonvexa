import fs from 'node:fs';
const file='scripts/workprotocol-bootstrap-test.mjs';
let s=fs.readFileSync(file,'utf8');
s=s.replace("from '../src/autonomos/secret-provider.js'","from '../src/autonomos/workprotocol-bootstrap.js'");
fs.writeFileSync(file,s);
console.log('[mega-clean-last] deleted-module test imports aligned with clean tree');
