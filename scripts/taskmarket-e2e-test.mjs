import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskmarketWorker } from '../src/autonomos/taskmarket-worker.js';
import { createTaskmarketClient } from '../src/autonomos/taskmarket.js';

// A stand-in for the first-party CLI, answering the same shapes the real one does. The
// worker is exercised through its real command surface -- spawning a process, parsing the
// JSON that comes back -- rather than against an injected client, so a wrong flag or a
// mis-shaped response fails here instead of in production.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'tm-e2e-'));
const bin=path.join(root,'taskmarket');
const state=path.join(root,'cli-state');
fs.mkdirSync(state,{recursive:true});
fs.writeFileSync(bin,`#!/bin/bash
STATE="${state}"
sub="$(echo "$1 $2" | sed 's/ *$//')"
case "$sub" in
  "task list")
    if [ -f "$STATE/claimed" ]; then echo '{"ok":true,"data":{"tasks":[]}}'
    else echo '{"ok":true,"data":{"tasks":[{"taskId":"tm-1","mode":"claim","status":"open","reward":"40000000","description":"Summarize a dataset into a short markdown report."}]}}'; fi ;;
  "task get")
    if [ -f "$STATE/claimed" ]; then echo '{"ok":true,"data":{"taskId":"tm-1","mode":"claim","status":"claimed","reward":"40000000","claimedBy":"0xus","description":"Summarize a dataset into a short markdown report."}}'
    else echo '{"ok":true,"data":{"taskId":"tm-1","mode":"claim","status":"open","reward":"40000000","description":"Summarize a dataset into a short markdown report."}}'; fi ;;
  "task claim") touch "$STATE/claimed"; echo '{"ok":true,"data":{"taskId":"tm-1","claimed":true}}' ;;
  "task submit")
     for a in "$@"; do [ -f "$a" ] && cp "$a" "$STATE/submitted.md"; done
     echo "$@" > "$STATE/submit-argv"
     echo '{"ok":true,"data":{"submissionId":"sub-1"}}' ;;
  "address") echo '{"ok":true,"data":{"address":"0xagent"}}' ;;
  *) echo '{"ok":true,"data":{}}' ;;
esac
`,{mode:0o755});

const env={AUTONOMOS_TASKMARKET_ENABLED:'true',AUTONOMOS_TASKMARKET_BIN:bin};
let checks=0;
const ok=(c,l)=>{assert.ok(c,l);checks++;};
const eq=(a,b,l)=>{assert.deepEqual(a,b,l+' (got '+JSON.stringify(a)+')');checks++;};

// 1. The real command surface answers through a real process.
const client=createTaskmarketClient({env});
eq((await client.address()).data.address,'0xagent','address round-trips through the CLI');
const listing=await client.listOpenTasks({mode:'claim',limit:5});
eq(listing.data.tasks.length,1,'an open claim-mode task is listed');

const worker=new TaskmarketWorker(null,{env,storageDir:root,logger:{info(){},warn(){}},client});

// 2. Discovery records the task with its reward converted from base units.
await worker.discover();
const discovered=Object.values(worker.store.readJson('taskmarket-jobs.json',{}));
eq(discovered.length,1,'one task discovered');
eq(discovered[0].rewardUsd,40,'40000000 base units read as $40');
eq(discovered[0].status,'discovered','starts as discovered');

// 3. Claim goes through the CLI and is observable in the CLI's own state.
const claim=await client.claimTask('tm-1');
eq(claim.ok,true,'claim succeeded');
ok(fs.existsSync(path.join(state,'claimed')),'the CLI recorded the claim');

// 4. A produced deliverable is submitted as a real file the CLI can read.
const file=worker.writeDeliverable(discovered[0].id,'# Report\n\nThe dataset has 3 columns.');
const submission=await client.submitWork('tm-1',[file]);
eq(submission.ok,true,'submission succeeded');
const argv=fs.readFileSync(path.join(state,'submit-argv'),'utf8');
ok(argv.includes('--file'),'submit passed --file, got: '+argv.trim());
eq(fs.readFileSync(path.join(state,'submitted.md'),'utf8'),'# Report\n\nThe dataset has 3 columns.',
  'the exact deliverable reached the CLI');

// 5. Payout is recorded once, as crypto revenue, and the job closes.
const job=discovered[0];
eq(worker.recordPayout(job,{transactionId:'0xpaid1',amountUsd:40}),true,'payout recorded');
eq(worker.recordPayout(job,{transactionId:'0xpaid1',amountUsd:40}),false,'a repeat payout is refused');
const revenue=worker.store.readNdjson('ledger.ndjson',-1).filter(r=>r.type==='revenue');
eq(revenue.length,1,'exactly one revenue row');
eq(revenue[0].amountUsd,40,'the ledger holds the full $40');
eq(worker.store.readJson('taskmarket-jobs.json',{})[job.id].status,'paid','the job is closed as paid');

// 6. Money-out stays impossible even with a working CLI in front of it.
const withdraw=await client.call(['withdraw','40']);
eq(withdraw.blocked,true,'withdraw is refused before the process is ever spawned');
const setAddr=await client.call(['wallet','set-withdrawal-address','0xattacker']);
eq(setAddr.blocked,true,'set-withdrawal-address is refused too');

// 7. The task leaves the feed once claimed, and re-discovery adds nothing.
await worker.discover();
eq(Object.keys(worker.store.readJson('taskmarket-jobs.json',{})).length,1,'no duplicate job after a second scan');

fs.rmSync(root,{recursive:true,force:true});
console.log('taskmarket-e2e-test OK ('+checks+' checks, discover -> claim -> submit -> paid)');
