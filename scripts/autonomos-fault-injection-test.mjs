import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutonomOS } from '../src/autonomos/runtime.js';

const wallet='0x1f674bf085f6fed36fa198287d51edf0fe0bb9e2';
const realFetch=globalThis.fetch;
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});

function baseEnv(){return {AUTONOMOS_ENABLED:'false',AUTONOMOS_X402_ENABLED:'false',AUTONOMOS_OWNER_WALLET:wallet};}
function autonomosDir(root){return path.join(root,'autonomos');}
function readJson(file,fallback={}){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}}
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2));}

async function testRestartAfterClaim(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'autonomos-fault-claim-'));
  let claimCalls=0,deliveryCalls=0,transactionsCalls=0,failDelivery=true;
  globalThis.fetch=async (url,opts={})=>{
    const u=String(url);
    if(u.includes('clawlancer.ai/api/agents/register')) return json({agent_id:'agent_fault_1',api_key:'secret_fault'});
    if(u.includes('clawlancer.ai/api/listings?')) return json({listings:[{id:'fault_claim_1',title:'Translate "agents hiring agents" into Spanish',description:'Translate "agents hiring agents" into Spanish',category:'translation',listing_type:'BOUNTY',status:'open',price_usdc_wei:'50000000'}]});
    if(u.includes('/api/listings/fault_claim_1/claim')){claimCalls++;return json({transaction_id:'claim_fault_tx'});}
    if(u.includes('/api/transactions/claim_fault_tx/deliver')){deliveryCalls++;if(failDelivery)return json({error:'temporary marketplace failure'},500);return json({success:true,transaction_id:'claim_fault_tx'});}
    if(u.endsWith('clawlancer.ai/api/transactions')){transactionsCalls++;return json({transactions:failDelivery?[]:[{id:'claim_fault_tx',listing_id:'fault_claim_1',status:'settled',amount_usdc_wei:'50000000'}]});}
    if(u.includes('clawlancer.ai/api/wallet/balance')) return json({usdc:'50000000',eth:'0'});
    if(u.includes('agentverse.ai/v1/search/functions')) return json({total:0,functions:[]});
    if(u==='https://t2000.ai/') return new Response('<html>market</html>',{status:200,headers:{'content-type':'text/html'}});
    if(u.includes('x402/discovery/resources')) return json({items:[]});
    if((opts.method||'GET')==='POST' && /^https:\/\/(mainnet\.base\.org|arb1\.arbitrum\.io\/rpc|polygon-rpc\.com)/.test(u)){const req=JSON.parse(opts.body||'{}');return json({jsonrpc:'2.0',id:req.id,result:'0x0'});}
    throw new Error(`unexpected_fetch:${u}`);
  };
  try{
    const first=createAutonomOS({storageDir:root,siteUrl:'https://qonvexa.co',ownerWallet:wallet,env:baseEnv(),logger:{error(){}}});
    const firstCycle=await first.runCycle();
    assert.equal(firstCycle.ok,true);
    assert.equal(claimCalls,1,'initial run must claim exactly once');
    assert.equal(deliveryCalls,1,'initial run must reach delivery before simulated failure');
    const dir=autonomosDir(root);
    const inflight=readJson(path.join(dir,'in-flight-jobs.json'));
    const entries=Object.values(inflight);
    assert.equal(entries.length,1,'failed post-claim delivery must preserve one in-flight recovery checkpoint');
    assert.equal(entries[0].op.externalId,'fault_claim_1');

    // Simulate process downtime beyond the retry backoff. This is equivalent to Render
    // restarting after the marketplace claim was already irreversible.
    const attempts=readJson(path.join(dir,'execution-attempts.json'));
    for(const row of Object.values(attempts))row.lastAttemptAt=new Date(Date.now()-60*60_000).toISOString();
    writeJson(path.join(dir,'execution-attempts.json'),attempts);
    failDelivery=false;

    const restarted=createAutonomOS({storageDir:root,siteUrl:'https://qonvexa.co',ownerWallet:wallet,env:baseEnv(),logger:{error(){}}});
    const recoveredCycle=await restarted.runCycle();
    assert.equal(recoveredCycle.ok,true);
    assert.equal(claimCalls,1,'restart recovery must NEVER claim an already-owned job again');
    assert.equal(deliveryCalls,2,'restart recovery should retry only the unfinished delivery path');
    assert.deepEqual(readJson(path.join(dir,'in-flight-jobs.json')),{},'successful recovery must clear the in-flight checkpoint');
    const registry=readJson(path.join(dir,'job-registry.json'));
    assert.equal(registry['clawlancer:fault_claim_1']?.status,'paid','recovered job must settle against the exact registry identity');
    const revenue=fs.readFileSync(path.join(dir,'ledger.ndjson'),'utf8').trim().split(/\n+/).filter(Boolean).map(JSON.parse).filter(x=>x.type==='revenue'&&x.externalId==='fault_claim_1');
    assert.equal(revenue.length,1,'recovered settlement must create one and only one revenue row');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}

async function testRestartAfterDeliveryAck(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'autonomos-fault-ack-'));
  let claimCalls=0,deliveryCalls=0;
  globalThis.fetch=async (url,opts={})=>{
    const u=String(url);
    if(u.includes('clawlancer.ai/api/agents/register')) return json({agent_id:'agent_fault_2',api_key:'secret_fault'});
    if(u.includes('clawlancer.ai/api/listings?')) return json({listings:[]});
    if(u.includes('/claim')){claimCalls++;return json({transaction_id:'should_not_claim'});}
    if(u.includes('/deliver')){deliveryCalls++;return json({success:true,transaction_id:'should_not_deliver'});}
    if(u.endsWith('clawlancer.ai/api/transactions')) return json({transactions:[]});
    if(u.includes('clawlancer.ai/api/wallet/balance')) return json({usdc:'0',eth:'0'});
    if(u.includes('agentverse.ai/v1/search/functions')) return json({total:0,functions:[]});
    if(u==='https://t2000.ai/') return new Response('<html>market</html>',{status:200,headers:{'content-type':'text/html'}});
    if(u.includes('x402/discovery/resources')) return json({items:[]});
    if((opts.method||'GET')==='POST' && /^https:\/\/(mainnet\.base\.org|arb1\.arbitrum\.io\/rpc|polygon-rpc\.com)/.test(u)){const req=JSON.parse(opts.body||'{}');return json({jsonrpc:'2.0',id:req.id,result:'0x0'});}
    throw new Error(`unexpected_fetch:${u}`);
  };
  try{
    const dir=autonomosDir(root);fs.mkdirSync(dir,{recursive:true});
    const op={source:'clawlancer',externalId:'fault_ack_1',title:'Translate "agents hiring agents" into Spanish',description:'Translate "agents hiring agents" into Spanish',category:'translation',status:'open',budgetUsd:0.5,currency:'USDC',escrowed:true,claimMode:'claim',capability:{skill:'translation',executable:true,estimatedModelCostUsd:0}};
    const jobId='job_fault_ack_1';
    writeJson(path.join(dir,'in-flight-jobs.json'),{[jobId]:{jobId,op,claim:{ok:true,transactionId:'ack_tx_1'},workerId:'dynamic-workforce',status:'delivery_accepted',deliveryTransactionId:'ack_tx_1',deliverableHash:'hash_ack',deliveryAcceptedAt:new Date(Date.now()-1000).toISOString()}});
    writeJson(path.join(dir,'job-registry.json'),{'clawlancer:fault_ack_1':{identity:'clawlancer:fault_ack_1',source:'clawlancer',externalId:'fault_ack_1',title:op.title,budgetUsd:0.5,currency:'USDC',status:'executing',terminal:false,firstSeenAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),lastStateAt:new Date().toISOString(),seenCount:1}});
    fs.writeFileSync(path.join(dir,'jobs.ndjson'),`${JSON.stringify({id:jobId,source:'clawlancer',externalId:'fault_ack_1',status:'claimed',at:new Date().toISOString()})}\n`);

    const restarted=createAutonomOS({storageDir:root,siteUrl:'https://qonvexa.co',ownerWallet:wallet,env:baseEnv(),logger:{error(){}}});
    const cycle=await restarted.runCycle();
    assert.equal(cycle.ok,true);
    assert.equal(claimCalls,0,'delivery-ack recovery must not claim again');
    assert.equal(deliveryCalls,0,'delivery-ack recovery must never resubmit an acknowledged deliverable');
    assert.deepEqual(readJson(path.join(dir,'in-flight-jobs.json')),{},'delivery checkpoint must be finalized and cleared');
    const registry=readJson(path.join(dir,'job-registry.json'));
    assert.equal(registry['clawlancer:fault_ack_1']?.status,'delivered','delivery ACK checkpoint must recover local state to Delivered');
    const jobs=fs.readFileSync(path.join(dir,'jobs.ndjson'),'utf8').trim().split(/\n+/).filter(Boolean).map(JSON.parse);
    assert.equal(jobs.filter(x=>x.externalId==='fault_ack_1'&&x.status==='delivered').length,1,'recovery must append exactly one local Delivered transition');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}

try{
  await testRestartAfterClaim();
  await testRestartAfterDeliveryAck();
  console.log('AutonomOS fault injection PASS: post-claim restart recovery + post-delivery-ACK at-most-once recovery');
} finally {
  globalThis.fetch=realFetch;
}
