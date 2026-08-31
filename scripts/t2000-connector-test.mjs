import assert from 'node:assert/strict';
import { discoverPublicSignals, claimMarketplaceJob, deliverMarketplaceJob } from '../src/autonomos/connectors/index.js';

const realFetch=globalThis.fetch;
const calls=[];
globalThis.fetch=async(url,options={})=>{
  assert.equal(String(url),'https://mcp.t2000.ai/mcp');
  assert.equal(options.headers?.authorization,'Bearer oauth-access');
  const req=JSON.parse(String(options.body||'{}'));calls.push(req);
  if(req.method==='initialize')return rpc(req.id,{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'t2000',version:'test'}});
  if(req.method==='notifications/initialized')return new Response('',{status:202});
  if(req.method==='tools/list')return rpc(req.id,{tools:[
    {name:'t2000_job_board'},{name:'t2000_jobs'},{name:'t2000_job_claim'},{name:'t2000_job_batch_claim'},{name:'t2000_job_status'},{name:'t2000_job_deliver'}
  ]});
  if(req.method==='tools/call'){
    const {name,arguments:args}=req.params;
    if(name==='t2000_job_board')return rpc(req.id,{structuredContent:{jobs:[{id:'open-65',maxUsdc:65,briefPreview:'Research a technical market',slaMinutes:1440}]}});
    if(name==='t2000_jobs')return rpc(req.id,{structuredContent:{jobs:[{jobId:'service-100',priceUsdc:100,serviceName:'Technical Research Premium',status:'funded'}]}});
    if(name==='t2000_job_claim')return rpc(req.id,{structuredContent:{jobId:'job-from-open'}});
    if(name==='t2000_job_status')return rpc(req.id,{structuredContent:{jobId:args.jobId||args.id,workOrder:{brief:'Complete the research and cite sources.'}}});
    if(name==='t2000_job_deliver'){assert.equal(args.jobId,'service-100');assert.equal(args.body,'# Finished\nEvidence.');return rpc(req.id,{structuredContent:{jobId:'service-100',status:'delivered'}});}
  }
  throw new Error(`unexpected_rpc:${req.method}:${req.params?.name||''}`);
};
try{
  const common={env:{T2000_MCP_URL:'https://mcp.t2000.ai/mcp'},credentials:{t2000:{accessToken:'oauth-access'}},sources:['t2000'],limit:10};
  const discovery=await discoverPublicSignals(common);
  const open=discovery.signals.find(x=>x.externalId==='open-65');
  const service=discovery.signals.find(x=>x.externalId==='service-100');
  assert.ok(open);assert.equal(open.budgetUsd,65);assert.equal(open.claimMode,'automatic_mcp');
  assert.ok(service);assert.equal(service.budgetUsd,100);assert.equal(service.claimMode,'already_assigned');assert.equal(service.escrowed,true);
  calls.length=0;
  const claim=await claimMarketplaceJob(service,{env:common.env,credentials:common.credentials});
  assert.equal(claim.ok,true);assert.equal(claim.jobId,'service-100');assert.equal(claim.alreadyAssigned,true);
  assert.equal(calls.some(x=>x.params?.name==='t2000_job_claim'),false,'assigned Service order must not be claimed again');
  const delivered=await deliverMarketplaceJob(service,claim,{content:'# Finished\nEvidence.'},{env:common.env,credentials:common.credentials});
  assert.equal(delivered.ok,true);
  console.log('t2000 connector test PASS');
} finally { globalThis.fetch=realFetch; }

function rpc(id,result){return new Response(JSON.stringify({jsonrpc:'2.0',id,result}),{status:200,headers:{'content-type':'application/json','mcp-session-id':'test-session'}})}
