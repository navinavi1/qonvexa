import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomOSStore } from '../src/autonomos/store.js';
import { ledgerEntry, appendUniqueLedgerEntry } from '../src/autonomos/financial-ledger.js';
import { computeEarnedSpendBudgetUsd, allocateRevenue } from '../src/autonomos/profit-engine.js';
import { normalizeConfig } from '../src/autonomos/policy-engine.js';

let checks=0;
const ok=(c,l)=>{assert.ok(c,l);checks++;};
const close=(a,b,l)=>{assert.ok(Math.abs(a-b)<0.011,l+' (expected ~'+b+', got '+a+')');checks++;};

const cfg=normalizeConfig({enabled:true,earnedFundsOnly:true,ownerRevenuePercent:50,agentTreasuryPercent:50,seedSpendBudgetUsd:0});
const fresh=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'net-split-'));return{root,store:new AutonomOSStore(path.join(root,'autonomos'))};};

// 1. A marketplace fee is the platform's money and must never be split.
{
  const {root,store}=fresh();
  appendUniqueLedgerEntry(store,ledgerEntry({id:'r1',type:'revenue',source:'taskmarket.dev',amountUsd:40,feeUsd:3,currency:'USDC',status:'settled'}));
  const row=store.readNdjson('ledger.ndjson',-1)[0];
  close(row.grossUsd,40,'gross is the invoiced amount');
  close(row.feeUsd,3,'the fee is recorded');
  close(row.netUsd,37,'net is what arrived');
  close(computeEarnedSpendBudgetUsd(store.readNdjson('ledger.ndjson',-1),cfg),18.5,'agents get half of what arrived, not half of the invoice');
  fs.rmSync(root,{recursive:true,force:true});
}

// 2. Owner and agents together can never be promised more than the receipt.
{
  const {root,store}=fresh();
  appendUniqueLedgerEntry(store,ledgerEntry({id:'r1',type:'revenue',source:'m',amountUsd:100,feeUsd:20,status:'settled'}));
  const rows=store.readNdjson('ledger.ndjson',-1);
  const agents=computeEarnedSpendBudgetUsd(rows,cfg);
  const owner=allocateRevenue(rows[0].netUsd,cfg).ownerUsd;
  close(agents+owner,80,'the two halves sum to the $80 that arrived, not the $100 billed');
  ok(agents+owner<=rows[0].netUsd+0.01,'the split never exceeds the receipt');
  fs.rmSync(root,{recursive:true,force:true});
}

// 3. A stored allocation is respected, but only while it fits inside its own receipt.
{
  const {root,store}=fresh();
  store.append('ledger.ndjson',{...ledgerEntry({id:'r1',type:'revenue',source:'m',amountUsd:40,feeUsd:3,status:'settled'}),
    allocation:{ownerUsd:20,treasuryUsd:20}});
  close(computeEarnedSpendBudgetUsd(store.readNdjson('ledger.ndjson',-1),cfg),18.5,
    'an allocation that distributes more than arrived is recomputed from the receipt');
  fs.rmSync(root,{recursive:true,force:true});
}
{
  const {root,store}=fresh();
  store.append('ledger.ndjson',{...ledgerEntry({id:'r1',type:'revenue',source:'m',amountUsd:40,feeUsd:3,status:'settled'}),
    allocation:{ownerUsd:27,treasuryUsd:10}});
  close(computeEarnedSpendBudgetUsd(store.readNdjson('ledger.ndjson',-1),cfg),10,
    'a deliberate uneven split that fits the receipt is left alone');
  fs.rmSync(root,{recursive:true,force:true});
}

// 4. Costs still come off the agents' side, and the pool never goes negative.
{
  const {root,store}=fresh();
  appendUniqueLedgerEntry(store,ledgerEntry({id:'r1',type:'revenue',source:'m',amountUsd:10,feeUsd:1,status:'settled'}));
  appendUniqueLedgerEntry(store,ledgerEntry({id:'c1',type:'cost',source:'openai',amountUsd:100,status:'settled'}));
  close(computeEarnedSpendBudgetUsd(store.readNdjson('ledger.ndjson',-1),cfg),0,'an overspent pool floors at zero, never negative');
  fs.rmSync(root,{recursive:true,force:true});
}

// 5. A fee-free receipt is unchanged: this fix must not move money that was already right.
{
  const {root,store}=fresh();
  appendUniqueLedgerEntry(store,ledgerEntry({id:'r1',type:'revenue',source:'m',amountUsd:50,status:'settled'}));
  close(computeEarnedSpendBudgetUsd(store.readNdjson('ledger.ndjson',-1),cfg),25,'no fee means the split is unchanged');
  fs.rmSync(root,{recursive:true,force:true});
}


// The lock has to cover the decision, not only the write. It used to cover only the write,
// so two writers could both read "not present" and both then append the same payment. The
// check is what must be inside; assert on where it runs, because a dedup test alone passes
// either way in a single process.
{
  const store=new AutonomOSStore(fs.mkdtempSync(path.join(os.tmpdir(),'ledger-lock-')));
  let readsInsideLock=0, depth=0;
  const realLock=store.withLock.bind(store), realRead=store.readNdjson.bind(store);
  store.withLock=(name,fn)=>realLock(name,()=>{depth++;try{return fn();}finally{depth--;}});
  store.readNdjson=(name,limit)=>{if(name==='ledger.ndjson'&&depth>0)readsInsideLock++;return realRead(name,limit);};

  const row=id=>ledgerEntry({id,type:'revenue',source:'taskmarket.dev',amountUsd:10,
    externalTransactionId:'0x'+'a'.repeat(64),network:'eip155:8453',status:'settled'});
  assert.equal(appendUniqueLedgerEntry(store,row('first')),true,'a new receipt is booked');
  assert.ok(readsInsideLock>0,'the duplicate check runs while the lock is held');
  assert.equal(appendUniqueLedgerEntry(store,row('second')),false,'the same receipt is refused under a different id');
  assert.equal(store.readNdjson('ledger.ndjson',-1).length,1,'and the journal holds exactly one row');
}

console.log('net-split-test OK ('+checks+' checks)');
