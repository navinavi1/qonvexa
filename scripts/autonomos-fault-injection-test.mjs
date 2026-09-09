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

async function testRestartAfterDeliveryAck({withBlocked=false}={}){
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
    if(u==='https://workprotocol.ai/') return new Response('<html>market</html>',{status:200,headers:{'content-type':'text/html'}});
    if(u.includes('x402/discovery/resources')) return json({items:[]});
    if((opts.method||'GET')==='POST' && /^https:\/\/(mainnet\.base\.org|arb1\.arbitrum\.io\/rpc|polygon-rpc\.com)/.test(u)){const req=JSON.parse(opts.body||'{}');return json({jsonrpc:'2.0',id:req.id,result:'0x0'});}
    throw new Error(`unexpected_fetch:${u}`);
  };
  try{
    const dir=autonomosDir(root);fs.mkdirSync(dir,{recursive:true});
    const op={source:'fixture-market',externalId:'fault_ack_1',title:'Translate "agents hiring agents" into Spanish',description:'Translate "agents hiring agents" into Spanish',category:'translation',status:'open',budgetUsd:0.5,currency:'USDC',escrowed:true,claimMode:'claim',capability:{skill:'translation',executable:true,estimatedModelCostUsd:0}};
    const jobId='job_fault_ack_1';
    writeJson(path.join(dir,'in-flight-jobs.json'),{[jobId]:{jobId,op,claim:{ok:true,transactionId:'ack_tx_1'},workerId:'dynamic-workforce',status:'delivery_accepted',deliveryTransactionId:'ack_tx_1',deliverableHash:'hash_ack',deliveryAcceptedAt:new Date(Date.now()-1000).toISOString()}});
    writeJson(path.join(dir,'job-registry.json'),{'clawlancer:fault_ack_1':{identity:'clawlancer:fault_ack_1',source:'fixture-market',externalId:'fault_ack_1',title:op.title,budgetUsd:0.5,currency:'USDC',status:'executing',terminal:false,firstSeenAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),lastStateAt:new Date().toISOString(),seenCount:1}});
    fs.writeFileSync(path.join(dir,'jobs.ndjson'),`${JSON.stringify({id:jobId,source:'fixture-market',externalId:'fault_ack_1',status:'claimed',at:new Date().toISOString()})}\n`);

    if(withBlocked){
      const blocked={},attempts={};
      for(let i=0;i<3;i++){
        const id='blocked_'+i;const heldOp={...op,externalId:id};
        blocked[id]={jobId:id,op:heldOp,claim:{ok:true,transactionId:id},status:'manual_attention'};
        attempts[`clawlancer:${id}`]={count:3,lastAttemptAt:new Date().toISOString()};
      }
      writeJson(path.join(dir,'in-flight-jobs.json'),{...blocked,...readJson(path.join(dir,'in-flight-jobs.json'))});
      writeJson(path.join(dir,'execution-attempts.json'),attempts);
    }

    const restarted=createAutonomOS({storageDir:root,siteUrl:'https://qonvexa.co',ownerWallet:wallet,env:baseEnv(),logger:{error(){}}});
    restarted.start();
    const cycle=await restarted.runCycle();
    restarted.stop();
    assert.equal(cycle.ok,true);
    assert.equal(claimCalls,0,'delivery-ack recovery must not claim again');
    assert.equal(deliveryCalls,0,'delivery-ack recovery must never resubmit an acknowledged deliverable');
    const remaining=readJson(path.join(dir,'in-flight-jobs.json'));
    assert.equal(remaining[jobId],undefined,'blocked records must not starve delivery checkpoint recovery');
    assert.equal(Object.keys(remaining).length,withBlocked?3:0,'existing holds must remain intact');
    const registry=readJson(path.join(dir,'job-registry.json'));
    assert.equal(registry['fixture-market:fault_ack_1']?.status,'delivered','delivery ACK checkpoint must recover local state to Delivered');
    const jobs=fs.readFileSync(path.join(dir,'jobs.ndjson'),'utf8').trim().split(/\n+/).filter(Boolean).map(JSON.parse);
    assert.equal(jobs.filter(x=>x.externalId==='fault_ack_1'&&x.status==='delivered').length,1,'recovery must append exactly one local Delivered transition');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}

try{
  await testRestartAfterDeliveryAck();
  await testRestartAfterDeliveryAck({withBlocked:true});
  console.log('AutonomOS fault injection PASS: post-delivery-ACK at-most-once recovery');
} finally {
  globalThis.fetch=realFetch;
}
