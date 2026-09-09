import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {runAcceptedJob} from '../src/autonomos/accepted-job-engine.js';
import {AutonomOSStore} from '../src/autonomos/store.js';
import {createJobBudget} from '../src/autonomos/job-budget.js';
import {githubApplication} from '../src/autonomos/github-application.js';
import {githubRequest} from '../src/autonomos/github-transport.js';
import {validateMarketContract} from '../src/autonomos/market-expansion-engine.js';
import {classifyFailure} from '../src/autonomos/action-journal.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mega73-')),original=globalThis.fetch;let count=0;
const test=async(name,run)=>{await run();count++;console.log('PASS '+name);};
try{
 await test('Accepted work executes, passes common QA, retires squad and replays durable result',async()=>{
 const env={STORAGE_DIR:path.join(root,'engine')},store=new AutonomOSStore(path.join(env.STORAGE_DIR,'autonomos'));
 const opportunity={jobId:'accepted-realistic-fixture',source:'taskforce',externalId:'42',claimMode:'already_assigned',title:'Translate "hello world" to Spanish',description:'Return the translation.',budgetUsd:5};
 const options={opportunity,capability:{mode:'deterministic',skill:'translation'},llm:{enabled:false},budget:createJobBudget(1,{env}),env,store};
 const first=await runAcceptedJob(options);assert.equal(first.deliverable.content,'hola mundo');assert(first.qa.ok);
 const second=await runAcceptedJob({...options,capability:{mode:'unsupported'}});assert.deepEqual(second.deliverable,first.deliverable);
 assert.equal(store.readNdjson('accepted-work-learning.ndjson',-1).length,1);
 assert(store.readJson('accepted-task-squads.json',{}).agents.every(x=>!['working','running','active'].includes(x.status)));
 });
 await test('A restart cannot reset cumulative per-job spending',()=>{
 const env={STORAGE_DIR:path.join(root,'budget')},store=new AutonomOSStore(path.join(env.STORAGE_DIR,'autonomos'));
 const options={env,jobId:'one',onCost:n=>store.append('ledger.ndjson',{type:'cost',jobId:'one',amountUsd:n})};
 createJobBudget(1,options).charge(.7);const restarted=createJobBudget(1,options);assert(Math.abs(restarted.remaining-.3)<1e-9);assert.throws(()=>restarted.charge(.4),/job_spend_limit/);
 });
 await test('An open but already rewarded Algora issue cannot receive another application',async()=>{
 const env={STORAGE_DIR:path.join(root,'rewarded'),GITHUB_TOKEN:'fixture'};let writes=0;
 globalThis.fetch=async(url,opts)=>{if(opts.method!=='GET')writes++;const p=new URL(url).pathname;const data=p==='/user'?{login:'agency'}:p.endsWith('/comments')?[{user:{type:'Bot',login:'algora-pbc[bot]'},body:"@other has been awarded **$75**!"}]:{state:'open',author_association:'OWNER',title:'Bounty $75',body:'Paid task',assignees:[]};return new Response(JSON.stringify(data));};
 const r=await githubApplication({owner:'buyer',repo:'repo',number:1},{env,lead:{}});assert.equal(r.error,'bounty_already_rewarded');assert.equal(writes,0);
 });
 await test('Secondary GitHub limit persists and stops further requests',async()=>{
 const env={STORAGE_DIR:path.join(root,'rate'),GITHUB_TOKEN:'fixture'};let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({message:'You have exceeded a secondary rate limit'}),{status:403,headers:{'retry-after':'90'}});};
 assert.equal((await githubRequest('/user',{env})).status,429);assert.equal((await githubRequest('/user',{env})).status,429);assert.equal(calls,1);
 });
 await test('Connector repair rejects foreign endpoints and incomplete schemas',()=>{
 assert(!validateMarketContract({host:'market.example',claim:{path:'https://elsewhere.example/apply',method:'POST',requestSchema:{}}}).ok);
 assert(!validateMarketContract({host:'market.example',claim:{path:'/apply',method:'POST',requestSchema:{required:['identity'],properties:{}}}}).ok);
 assert(validateMarketContract({host:'market.example',jobs:{path:'/jobs',method:'GET'}}).ok);
 });
 await test('Permanent and human failures are not ordinary retries',()=>{
 for(const status of [401,402,404,422])assert.equal(classifyFailure(status).retryable,false);
 assert.equal(classifyFailure(429).retryable,true);
 });
}finally{globalThis.fetch=original;fs.rmSync(root,{recursive:true,force:true});}
console.log(`MEGA PASS: ${count}/${count} passed`);
