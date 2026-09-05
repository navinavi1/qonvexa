import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutonomOS } from '../src/autonomos/runtime.js';

const wallet='0x1f674bf085f6fed36fa198287d51edf0fe0bb9e2';
const realFetch=globalThis.fetch;
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});

globalThis.fetch=async (url,opts={})=>{
  const u=String(url);
  if(u.includes('clawlancer.ai/api/agents/register')) return json({agent_id:'agent_1',api_key:'secret_test'});
  if(u.includes('clawlancer.ai/api/listings?')) return json({listings:[{id:'bounty_1',title:'Translate "agents hiring agents" into Spanish',description:'Translate "agents hiring agents" into Spanish',category:'translation',listing_type:'BOUNTY',status:'open',price_usdc_wei:'50000000'}]});
  if(u.includes('/api/listings/bounty_1/claim')) return json({transaction_id:'tx_1'});
  if(u.includes('/api/transactions/tx_1/deliver')) return json({success:true,transaction_id:'tx_1'});
  if(u.endsWith('clawlancer.ai/api/transactions')) return json({transactions:[{id:'tx_1',listing_id:'bounty_1',status:'settled',amount_usdc_wei:'50000000'}]});
  if(u.includes('clawlancer.ai/api/wallet/balance')) return json({usdc:'50000000',eth:'0'});
  if(u.includes('agentverse.ai/v1/search/functions')) return json({total:0,functions:[]});
  if(u==='https://t2000.ai/') return new Response('<html>market</html>',{status:200,headers:{'content-type':'text/html'}});
  if(u.includes('x402/discovery/resources')) return json({items:[]});
  if((opts.method||'GET')==='POST' && /^https:\/\/(mainnet\.base\.org|arb1\.arbitrum\.io\/rpc|polygon-rpc\.com)/.test(u)){
    const req=JSON.parse(opts.body||'{}'); return json({jsonrpc:'2.0',id:req.id,result:'0x0'});
  }
  throw new Error(`unexpected_fetch:${u}`);
};

const root=fs.mkdtempSync(path.join(os.tmpdir(),'autonomos2-flow-'));
try{
  const runtime=createAutonomOS({storageDir:root,siteUrl:'https://qonvexa.co',ownerWallet:wallet,env:{AUTONOMOS_ENABLED:'false',AUTONOMOS_X402_ENABLED:'false',AUTONOMOS_OWNER_WALLET:wallet},logger:{error(){}}});
  const cycle=await runtime.runCycle();
  assert.equal(cycle.ok,true);
  assert.equal(cycle.claimed,1);
  assert.equal(cycle.delivered,1);
  const snap=await runtime.snapshot();
  assert.equal(snap.version,'7.6.0');
  assert.equal(snap.metrics.claimedJobs,1);
  assert.equal(snap.metrics.deliveredJobs,1);
  assert.equal(snap.metrics.paidJobs,1);
  assert.equal(snap.metrics.totalRevenueUsd,50);
  assert.equal(snap.connectors.find(x=>x.id==='clawlancer').configured,true);

  const autonomosDir=path.join(root,'autonomos');
  const ledgerRows=fs.readFileSync(path.join(autonomosDir,'ledger.ndjson'),'utf8').trim().split(/\n+/).filter(Boolean).map(JSON.parse);
  const revenueRows=ledgerRows.filter(x=>x.type==='revenue'&&x.source==='clawlancer');
  assert.equal(revenueRows.length,1,'settlement must create exactly one revenue row');
  assert.equal(revenueRows[0].externalId,'bounty_1','revenue must carry the external marketplace job identity');
  assert.ok(revenueRows[0].jobId,'revenue must be linked to the internal execution job id');
  assert.equal(revenueRows[0].registryIdentity,'clawlancer:bounty_1','revenue must be linked to the JobRegistry identity');
  const registry=JSON.parse(fs.readFileSync(path.join(autonomosDir,'job-registry.json'),'utf8'));
  assert.equal(registry['clawlancer:bounty_1']?.status,'paid','the same registry job must become Paid after settlement');
  assert.equal(fs.existsSync(path.join(autonomosDir,'unresolved-settlements.json'))?Object.keys(JSON.parse(fs.readFileSync(path.join(autonomosDir,'unresolved-settlements.json'),'utf8')||'{}')).length:0,0,'a correctly mapped settlement must not remain quarantined');

  // Restart against the same persistent disk and see the same marketplace settlement again.
  // Revenue must be idempotent and the paid job must not be reclaimed/re-executed.
  const restarted=createAutonomOS({storageDir:root,siteUrl:'https://qonvexa.co',ownerWallet:wallet,env:{AUTONOMOS_ENABLED:'false',AUTONOMOS_X402_ENABLED:'false',AUTONOMOS_OWNER_WALLET:wallet},logger:{error(){}}});
  const second=await restarted.runCycle();
  assert.equal(second.ok,true);
  assert.equal(second.claimed,0,'a paid external job must never be reclaimed after restart');
  const ledgerAfterRestart=fs.readFileSync(path.join(autonomosDir,'ledger.ndjson'),'utf8').trim().split(/\n+/).filter(Boolean).map(JSON.parse).filter(x=>x.type==='revenue'&&x.source==='clawlancer');
  assert.equal(ledgerAfterRestart.length,1,'replaying settlement after restart must not duplicate revenue');
  const snap2=await restarted.snapshot();
  assert.equal(snap2.metrics.totalRevenueUsd,50,'restart must preserve the exact settled revenue total');
  assert.equal(snap2.jobRegistry.summary.paid,1,'restart must preserve the Paid registry identity');
  console.log('AutonomOS 2.0 flow PASS: discover → register → claim → execute → deliver → settle → ledger → restart/idempotent recovery');
} finally {
  globalThis.fetch=realFetch;
  fs.rmSync(root,{recursive:true,force:true});
}
