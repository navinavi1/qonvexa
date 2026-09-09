import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { githubRequest } from '../src/autonomos/github-transport.js';
import { githubApplication } from '../src/autonomos/github-application.js';
import { ActionJournal } from '../src/autonomos/action-journal.js';
import { NativeMarketAdapter,operationBody } from '../src/autonomos/native-market-adapter.js';
import { DynamicMarketRegistry } from '../src/autonomos/dynamic-market-registry.js';
import { businessSnapshot } from '../src/autonomos/business-snapshot.js';
import { canonicalOpportunity,eligibility } from '../src/autonomos/canonical-opportunity.js';
import { createJobBudget } from '../src/autonomos/job-budget.js';
import { AutonomOSStore } from '../src/autonomos/store.js';
import { DEFAULT_AUTONOMOS_CONFIG } from '../src/autonomos/policy-engine.js';
import { coordinateExecution } from '../src/autonomos/execution-coordinator.js';
import { FreelancerAdapter } from '../src/autonomos/freelancer-adapter.js';
import { verifyInboundReceipt,reconcileClientPayments } from '../src/autonomos/inbound-receipt.js';
import { updateVerifiedPullRequest } from '../src/autonomos/verified-github-pr.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'remaining-lifecycle-')),env={STORAGE_DIR:root,COMPOSIO_API_KEY:'fixture-key'};
const original=globalThis.fetch;const response=(value,status=200)=>new Response(JSON.stringify(value),{status});let count=0;
const test=async(name,run)=>{await run();count++;console.log('PASS '+name);};
try{
 await test('GitHub uses existing connected account without exporting its token',async()=>{
  const calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,body:options.body});if(String(url).includes('connected_accounts'))return response({items:[{id:'account-1',status:'ACTIVE'}]});const b=JSON.parse(options.body);assert.equal(b.connected_account_id,'account-1');assert.equal(b.endpoint,'/user');assert(!JSON.stringify(b).includes('fixture-key'));return response({status:200,data:{login:'agency'}});};
  const r=await githubRequest('/user',{env});assert(r.ok);assert.equal(r.value.login,'agency');assert.equal(calls.length,2);
 });
 await test('upstream auth rejection is not a successful proxy HTTP 200',async()=>{globalThis.fetch=async()=>response({status:403,data:{message:'denied'}});const r=await githubRequest('/user',{env});assert(!r.ok);assert.equal(r.status,403);});
 await test('proxy rejects foreign hosts and destructive force updates',async()=>{await assert.rejects(githubRequest('https://attacker.invalid',{env}),/endpoint/);await assert.rejects(githubRequest('/repos/a/b/git/refs/heads/main',{env,method:'PATCH',body:{force:true}}),/operation/);});
 await test('lost GitHub comment is recovered by author and stable marker without repost',async()=>{
  const local={STORAGE_DIR:path.join(root,'comments'),GITHUB_TOKEN:'fixture'},issue={owner:'buyer',repo:'repo',number:7},lead={url:'https://github.com/buyer/repo/issues/7'};
  let posted=null,writes=0;
  globalThis.fetch=async(url,options)=>{const p=new URL(url).pathname;if(p==='/user')return response({login:'agency'});if(p.endsWith('/comments')&&options.method==='GET')return response(posted?[posted]:[]);if(p.endsWith('/issues/7'))return response({state:'open',title:'Paid task $20',author_association:'OWNER',body:'Reward $20 for fixing the bug',assignees:[]});if(options.method==='POST'){writes++;posted={id:17,html_url:lead.url+'#issuecomment-17',body:JSON.parse(options.body).body,user:{login:'agency'}};throw Error('lost response');}throw Error('unexpected '+url);};
  const first=await githubApplication(issue,{lead,proposal:'Task proposal',env:local});assert(first.uncertain);const second=await githubApplication(issue,{lead,env:local,reconcileOnly:true});assert(second.ok);assert.equal(second.commentId,17);assert.equal(writes,1);
 });
 await test('native schema validates required fields before external intent',()=>{assert.throws(()=>operationBody({requestSchema:{properties:{identity:{type:'string'}},required:['identity']}},{}),/required_field/);});
 await test('native write without external receipt stays uncertain and cannot replay',async()=>{
  const analysis={host:'market.example',automationPermitted:true,claim:{path:'/jobs/{id}/apply',method:'POST',security:[],requestSchema:{properties:{proposal:{type:'string'}},required:['proposal']}}};
  const a=new NativeMarketAdapter({id:'market',analysis,root:path.join(root,'native'),env}),job={id:'job',externalId:'42'};let writes=0;globalThis.fetch=async()=>{writes++;return response({success:true});};
  const first=await a.write('claim',job,{proposal:'Transparent proposal'});assert(first.uncertain);await a.write('claim',job,{proposal:'Transparent proposal'});assert.equal(writes,1);
 });
 await test('native endpoint substitution does not leak auth across origins',async()=>{const a=new NativeMarketAdapter({id:'m',analysis:{host:'market.example'},root:path.join(root,'safety'),env});await assert.rejects(a.request({path:'https://attacker.example/steal',method:'GET'}),/origin/);});
 await test('registry observations retain earlier independent evidence',()=>{const registry=new DynamicMarketRegistry(path.join(root,'registry'));registry.observe('m',{evidence:{authentication:{verified:true,externalId:'account',verifiedAt:new Date().toISOString()}}});registry.observe('m',{evidence:{jobs:{verified:true,url:'https://market.example/jobs',verifiedAt:new Date().toISOString()}}});assert(registry.read().m.evidence.authentication);assert.equal(registry.read().m.status,'DISCOVER_READY');});
 await test('stale jobs cannot become currently eligible',()=>{const op=canonicalOpportunity({source:'m',id:'1',currency:'USD',payout:10,applicationRoute:'API',workType:'REAL_MARKET_JOB',observedAt:'2020-01-01'});assert(eligibility(op).reasons.includes('FRESHNESS_UNVERIFIED'));});
 await test('free application does not invent win probability or authorize execution',()=>{const op=canonicalOpportunity({source:'m',id:'1',currency:'USD',payout:10,applicationRoute:'API',workType:'REAL_MARKET_JOB',fresh:true,competitive:true,applicationCostUsd:0});assert.equal(op.expectedNetProfit,null);assert(eligibility(op,env,{phase:'application'}).eligible);assert(!eligibility(op,env).eligible);});
 await test('funnel counts a paid job once while retaining multiple real receipts',()=>{const dir=path.join(root,'money'),store=new AutonomOSStore(path.join(dir,'autonomos'));store.append('ledger.ndjson',{id:'one',externalTransactionId:'one',jobId:'job',type:'revenue',status:'settled',amountUsd:10});store.append('ledger.ndjson',{id:'two',externalTransactionId:'two',jobId:'job',type:'revenue',status:'settled',amountUsd:5});store.append('ledger.ndjson',{id:'cost',type:'cost',amountUsd:2});const b=businessSnapshot(dir);assert.equal(b.counts.paid,1);assert.equal(b.money.netProfitUsd,13);});
 await test('parallel job budgets reserve against the same durable treasury',()=>{const dir=path.join(root,'budgets'),store=new AutonomOSStore(path.join(dir,'autonomos'));store.writeJson('config.json',{...DEFAULT_AUTONOMOS_CONFIG,enabled:true,seedSpendBudgetUsd:1,allowExternalSpending:false});const options={env:{STORAGE_DIR:dir},onCost:n=>store.append('ledger.ndjson',{id:String(Math.random()),type:'cost',amountUsd:n})};const a=createJobBudget(1,options),b=createJobBudget(1,options);a.charge(.7);assert.throws(()=>b.charge(.7),/shared_treasury/);assert.equal(b.spent,0);});
 await test('queued duplicates cannot spawn and concurrency remains bounded',async()=>{const e={STORAGE_DIR:path.join(root,'queue'),AUTONOMOS_EXECUTION_CONCURRENCY:'1'};let release,active=0,max=0;const first=coordinateExecution({jobId:'first'},e,async()=>{active++;max=Math.max(max,active);await new Promise(r=>release=r);active--;});await new Promise(r=>setTimeout(r,0));const second=coordinateExecution({jobId:'second'},e,async()=>{active++;max=Math.max(max,active);active--;});await assert.rejects(coordinateExecution({jobId:'second'},e,async()=>{}),/already_executing/);release();await Promise.all([first,second]);assert.equal(max,1);});
 await test('Freelancer recovers a lost delivery only by project, sender and revision marker',async()=>{
  const a=new FreelancerAdapter({id:'freelancer.com',analysis:{},credential:{id:'7'},root:path.join(root,'freelancer'),env}),job={id:'work',externalId:'42',revision:2};
  const intent=a.journal.begin(a.id,job.id,'delivery:2');let wrong=true;
  a.api=async p=>p.includes('threads/?')?{ok:true,data:{threads:[{id:9,context:{id:42}}]}}:{ok:true,data:{messages:[{id:11,from_user:wrong?8:7,message:'AutonomOS delivery: '+intent.id}]}};
  assert.equal(await a.reconcile('delivery',job),null);wrong=false;assert.equal((await a.reconcile('delivery',job)).id,11);assert.equal(a.journal.read()[intent.id].status,'confirmed');
 });
 await test('OpenAPI alternatives select a supported scheme, while compound security requires all',async()=>{
  const a=new NativeMarketAdapter({id:'m',analysis:{host:'market.example',securitySchemes:{unsupported:{type:'oauth2'},key:{type:'apiKey',in:'header',name:'X-API-Key'}}},credential:{apiKey:'fixture'},root:path.join(root,'security'),env});
  globalThis.fetch=async(_,opts)=>{assert.equal(opts.headers['X-API-Key'],'fixture');return response([]);};
  assert((await a.request({path:'/jobs',method:'GET',security:[{unsupported:[]},{key:[]}]})).ok);
  await assert.rejects(a.request({path:'/jobs',method:'GET',security:[{unsupported:[],key:[]}]}),/authenticated_account_required/);
 });
 await test('Inbound payment requires configured token, successful receipt, wallet, age and confirmations',async()=>{
  const address='0x'+'1'.repeat(40),txHash='0x'+'a'.repeat(64),token='0x'+'2'.repeat(40),blockHash='0x'+'b'.repeat(64),at=Date.now(),chain={id:'eip155:8453',chainId:8453,rpc:'https://rpc.example',tokens:[{symbol:'USDC',address:token,decimals:6}]};
  const e={AUTONOMOS_EVM_CHAINS_JSON:JSON.stringify([chain])};let destination=address;
  const fetchImpl=async(_,opts)=>{const {method}=JSON.parse(opts.body);const values={eth_chainId:'0x2105',eth_blockNumber:'0x100',eth_getBlockByHash:{hash:blockHash,timestamp:'0x'+Math.floor(at/1000).toString(16)},eth_getTransactionReceipt:{status:'0x1',transactionHash:txHash,blockHash,blockNumber:'0xf0',logs:[{address:token,data:'0x989680',topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef','0x'+'0'.repeat(64),'0x'+destination.slice(2).padStart(64,'0')]}]}};return response({result:values[method]});};
  const args={txHash,address,acceptedAt:new Date(at-60000).toISOString(),env:e,fetchImpl};assert.equal((await verifyInboundReceipt(args)).amountUsd,10);destination='0x'+'3'.repeat(40);assert(!(await verifyInboundReceipt(args)).ok);
  destination=address;assert(!(await verifyInboundReceipt({...args,acceptedAt:new Date(at+60000).toISOString()})).ok);
 });
 await test('Client receipt reconciliation survives retry and cannot allocate one receipt to two jobs',async()=>{
  const store=new AutonomOSStore(path.join(root,'client-payments')),txHash='0x'+'a'.repeat(64),action={paymentClaims:[txHash],payout:{amountUsd:10}},verify=async()=>({ok:true,txHash,network:'eip155:8453',amountUsd:10});
  assert((await reconcileClientPayments({store,jobId:'one',action,env:{},verify})).paid);assert((await reconcileClientPayments({store,jobId:'one',action,env:{},verify})).paid);assert(!(await reconcileClientPayments({store,jobId:'two',action,env:{},verify})).paid);assert.equal(store.readNdjson('ledger.ndjson',-1).length,1);
 });
 await test('Timed-out GitHub revision is recovered by exact tree and parent without another push',async()=>{
  const pr={number:1,html_url:'https://github.com/b/r/pull/1',user:{login:'agency'},head:{sha:'fixed',ref:'autonomos/job',repo:{full_name:'agency/r',html_url:'https://github.com/agency/r'}}};
  const proof={ok:true,testsPassOnFix:true,regressionFailsOnBase:true,files:[{path:'fix.js',content:'fixed'}],baseSha:'original',repoUrl:pr.head.repo.html_url};let pushes=0;
  globalThis.fetch=async(url,opts)=>{const p=new URL(url).pathname;if(p==='/user')return response({login:'agency'});if(p.includes('/git/ref/'))return response({object:{sha:'fixed'}});if(p.endsWith('/git/commits/original'))return response({tree:{sha:'oldtree'}});if(p.endsWith('/git/trees'))return response({sha:'verified-tree'});if(p.endsWith('/git/commits/fixed'))return response({tree:{sha:'verified-tree'},parents:[{sha:'original'}]});pushes++;throw Error('unexpected mutation');};
  const r=await updateVerifiedPullRequest(proof,pr,{env:{STORAGE_DIR:path.join(root,'revision'),GITHUB_TOKEN:'fixture'}});assert(r.ok&&r.recovered);assert.equal(pushes,0);
 });
}finally{globalThis.fetch=original;fs.rmSync(root,{recursive:true,force:true});}
console.log(`REMAINING LIFECYCLE: ${count}/${count} passed`);
