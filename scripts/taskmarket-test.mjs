import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandAllowed, parseCliJson, createTaskmarketClient, normalizeTask, tasksFromListing, FORBIDDEN_COMMANDS } from '../src/autonomos/taskmarket.js';
import { TaskmarketWorker } from '../src/autonomos/taskmarket-worker.js';
import { isCryptoRevenue } from '../src/autonomos/financial-ledger.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'taskmarket-test-'));
let checks=0;
const ok=(cond,label)=>{assert.ok(cond,label);checks++;};
const eq=(a,b,label)=>{assert.deepEqual(a,b,label+' (got '+JSON.stringify(a)+')');checks++;};

// 1. Every money-moving command is refused, and refusal never shells out.
for(const forbidden of FORBIDDEN_COMMANDS){
  const gate=commandAllowed(forbidden.split(' '));
  ok(!gate.allowed,'forbidden refused: '+forbidden);
}
ok(!commandAllowed(['wallet','set-withdrawal-address','0xdeadbeef']).allowed,'withdrawal address with argument is still refused');
ok(!commandAllowed(['withdraw','1000000']).allowed,'withdraw with amount is still refused');
ok(!commandAllowed(['task','create','--reward','5']).allowed,'task create is refused');
ok(!commandAllowed(['rm','-rf','/']).allowed,'unknown command is refused');
ok(commandAllowed(['task','list','--status','open']).allowed,'task list is allowed');
ok(commandAllowed(['task','claim','abc']).allowed,'claim is allowed');
ok(commandAllowed(['task','submit','abc','--file','x.md']).allowed,'submit is allowed');
// "withdraw" must not be allowlisted by a prefix of an allowed command.
ok(!commandAllowed(['wallet','withdraw-dreams']).allowed,'withdraw-dreams is refused');
ok(commandAllowed(['wallet','balance']).allowed,'wallet balance is allowed');

// 2. A forbidden command must not reach exec even when the client is enabled.
let execCalls=0;
const spyExec=async()=>{execCalls++;return{code:0,stdout:'{"ok":true}',stderr:''};};
const enabledClient=createTaskmarketClient({env:{AUTONOMOS_TASKMARKET_ENABLED:'true'},exec:spyExec,logger:{warn(){}}});
const blocked=await enabledClient.call(['wallet','set-withdrawal-address','0xabc']);
eq(blocked.blocked,true,'blocked flag set');
eq(execCalls,0,'forbidden command never reached exec');
await enabledClient.address();
eq(execCalls,1,'allowed command did reach exec');

// 3. Disabled client refuses to run anything.
const offClient=createTaskmarketClient({env:{},exec:spyExec});
eq((await offClient.address()).error,'taskmarket_disabled','disabled client refuses');
eq(execCalls,1,'disabled client never reached exec');

// 4. Output parsing.
eq(parseCliJson('{"ok":true,"data":{"a":1}}').data.a,1,'clean JSON parses');
eq(parseCliJson('Fetching...\n{"ok":true,"n":2}\nDone').n,2,'JSON with surrounding noise parses');
eq(parseCliJson('').error,'empty_output','empty output flagged');
eq(parseCliJson('total garbage').error,'unparsable_output','garbage flagged, not thrown');

// 5. Reward conversion: Taskmarket sends integer base units, six decimals.
eq(normalizeTask({taskId:'t1',reward:'5000000'}).rewardUsd,5,'5000000 base units is $5');
eq(normalizeTask({taskId:'t2',reward:'1000'}).rewardUsd,0.001,'1000 base units is $0.001');
eq(normalizeTask({taskId:'t3'}).rewardUsd,0,'missing reward is 0, not NaN');
eq(tasksFromListing({data:{tasks:[{taskId:'a',reward:'2000000'}]}}).length,1,'nested listing shape');
eq(tasksFromListing({tasks:[{id:'b'}]})[0].taskId,'b','flat listing shape');
eq(tasksFromListing({data:[{taskId:'c'}]})[0].taskId,'c','array-data listing shape');
eq(tasksFromListing({}).length,0,'empty listing is empty, not a throw');
eq(tasksFromListing({tasks:[{reward:'1'}]}).length,0,'rows without a task id are dropped');

// 6. Worker discovery: unclaimed tasks are recorded, claimed ones are skipped.
const listing={ok:true,data:{tasks:[
  {taskId:'open-1',mode:'claim',status:'open',reward:'4000000',description:'Write a summary'},
  {taskId:'taken-1',mode:'claim',status:'open',reward:'9000000',claimedBy:'0xsomeoneelse'}
]}};
const fakeClient={enabled:true,listOpenTasks:async()=>listing,getTask:async()=>({ok:false,error:'unused'})};
const worker=new TaskmarketWorker(null,{env:{},storageDir:root,logger:{info(){},warn(){}},client:fakeClient});
await worker.discover();
const jobs=worker.store.readJson('taskmarket-jobs.json',{});
eq(Object.keys(jobs).length,1,'only the unclaimed task was recorded');
const job=Object.values(jobs)[0];
eq(job.taskId,'open-1','the open task was recorded');
eq(job.rewardUsd,4,'reward stored in USD');
await worker.discover();
eq(Object.keys(worker.store.readJson('taskmarket-jobs.json',{})).length,1,'re-discovery does not duplicate');

// 7. Deliverable is written to a real file that submit can reference.
const file=worker.writeDeliverable(job.id,'# result\nbody');
ok(fs.existsSync(file),'deliverable file exists');
eq(fs.readFileSync(file,'utf8'),'# result\nbody','deliverable content round-trips');

// 8. Payout lands in the ledger once, and counts as crypto revenue.
eq(worker.recordPayout(job,{transactionId:'0xtx1',amountUsd:4}),true,'payout recorded');
worker.recordPayout(job,{transactionId:'0xtx1',amountUsd:4});
const revenue=worker.store.readNdjson('ledger.ndjson',-1).filter(r=>r.type==='revenue');
eq(revenue.length,1,'duplicate payout did not double-count');
ok(isCryptoRevenue(revenue[0]),'taskmarket payout counts as crypto revenue');
eq(worker.recordPayout(job,{transactionId:'',amountUsd:4}),false,'payout without a transaction id is refused');
eq(worker.recordPayout(job,{transactionId:'0xtx2',amountUsd:0}),false,'zero payout is refused');

// 9. Worker refuses to start when the rail is switched off.
let started=false;
const offWorker=new TaskmarketWorker(null,{env:{},storageDir:root,logger:{info(){started=true;},warn(){}},client:{enabled:false}});
offWorker.start();
ok(started,'disabled worker logged why it did not start');
ok(!offWorker.timer,'disabled worker scheduled no timer');
offWorker.stop();

// 10. A missing taskmarket binary degrades to an error, it never crashes the fleet.
const realClient=createTaskmarketClient({env:{AUTONOMOS_TASKMARKET_ENABLED:'true',AUTONOMOS_TASKMARKET_BIN:'taskmarket-does-not-exist-'+Date.now()}});
const missing=await realClient.address();
eq(missing.ok,false,'missing binary reports failure');
ok(String(missing.error).startsWith('exit_'),'missing binary surfaces an exit error, got '+missing.error);
const missingWorker=new TaskmarketWorker(null,{env:{},storageDir:root,logger:{info(){},warn(){}},client:realClient});
await missingWorker.discover();
ok(true,'discover survived a missing binary without throwing');


fs.rmSync(root,{recursive:true,force:true});
console.log('taskmarket-test OK ('+checks+' checks)');
