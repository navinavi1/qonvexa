import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hydrateWorkProtocolRegistration} from '../src/autonomos/secret-provider.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'workprotocol-bootstrap-'));
const wallet='0x1111111111111111111111111111111111111111';
let registrations=0;
const fetchFn=async(url,options={})=>{
  registrations++;
  assert.equal(url,'https://workprotocol.ai/api/agents/register');
  assert.equal(options.method,'POST');
  const body=JSON.parse(options.body);
  assert.equal(body.walletAddress,wallet);
  assert.ok(body.capabilities.categories.includes('code'));
  return new Response(JSON.stringify({agent:{id:'agent-test-1',apiKey:'wp_agent_test_secret'}}),{status:200,headers:{'content-type':'application/json'}});
};
try{
  const env={STORAGE_DIR:root,AUTONOMOS_OWNER_WALLET:wallet,AUTONOMOS_MIN_JOB_PAYOUT_USD:'0.5'};
  const first=await hydrateWorkProtocolRegistration(env,{fetchFn,logger:{warn(){}}});
  assert.equal(first.ok,true);assert.equal(first.registered,true);
  assert.equal(env.WORKPROTOCOL_API_KEY,'wp_agent_test_secret');
  assert.equal(env.WORKPROTOCOL_AGENT_ID,'agent-test-1');
  assert.equal(registrations,1);
  const file=path.join(root,'autonomos','workprotocol-bootstrap.private.json');
  assert.ok(fs.existsSync(file));
  if(process.platform!=='win32')assert.equal(fs.statSync(file).mode & 0o777,0o600);

  const restarted={STORAGE_DIR:root,AUTONOMOS_OWNER_WALLET:wallet};
  const second=await hydrateWorkProtocolRegistration(restarted,{fetchFn,logger:{warn(){}}});
  assert.equal(second.ok,true);assert.equal(second.source,'persistent_disk');
  assert.equal(restarted.WORKPROTOCOL_API_KEY,'wp_agent_test_secret');
  assert.equal(restarted.WORKPROTOCOL_AGENT_ID,'agent-test-1');
  assert.equal(registrations,1,'restart must not register a duplicate agent');

  const different={STORAGE_DIR:root,AUTONOMOS_OWNER_WALLET:'0x2222222222222222222222222222222222222222'};
  const mismatch=await hydrateWorkProtocolRegistration(different,{fetchFn,logger:{warn(){}}});
  assert.equal(mismatch.ok,false);assert.equal(mismatch.reason,'workprotocol_saved_wallet_mismatch');
  assert.equal(different.WORKPROTOCOL_API_KEY,undefined);
  assert.equal(registrations,1,'wallet mismatch must not create or activate a payout credential');
  console.log('workprotocol-bootstrap-test: PASS');
} finally {fs.rmSync(root,{recursive:true,force:true});}
