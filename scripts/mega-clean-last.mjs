import fs from 'node:fs';

{
  const file='scripts/workprotocol-bootstrap-test.mjs';
  let s=fs.readFileSync(file,'utf8');
  s=s.replace("from '../src/autonomos/secret-provider.js'","from '../src/autonomos/workprotocol-bootstrap.js'");
  fs.writeFileSync(file,s);
}

{
  const file='scripts/autonomos-production-readiness-test.mjs';
  let s=fs.readFileSync(file,'utf8');
  s=s.replace(/rules:'15'/g,"rules:'16'");
  fs.writeFileSync(file,s);
}

console.log('[mega-clean-last] deleted-module imports and current rules-generation assertions aligned with clean tree');
