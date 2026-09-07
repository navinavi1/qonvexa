import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AutonomOSStore} from '../src/autonomos/store.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'autonomos-t2000-migrate-'));
try{
  fs.writeFileSync(path.join(root,'credentials.private.json'),JSON.stringify({t2000:{accessToken:'legacy-passport-token'}}),{mode:0o600});
  const store=new AutonomOSStore(root);
  const migrated=store.readJson('t2000-oauth.private.json',{});
  assert.equal(migrated?.token?.accessToken,'legacy-passport-token','missing new OAuth file must preserve previously authorized Passport token');
  fs.writeFileSync(path.join(root,'t2000-oauth.private.json'),JSON.stringify({token:null,lastError:'explicitly_disconnected'}),{mode:0o600});
  const explicit=store.readJson('t2000-oauth.private.json',{});
  assert.equal(explicit?.token,null,'existing OAuth state must win over legacy fallback');
  assert.equal(explicit?.lastError,'explicitly_disconnected');
  console.log('T2000 LEGACY TOKEN: 1/1 passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
