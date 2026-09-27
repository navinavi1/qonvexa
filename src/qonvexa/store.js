import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export class Store {
  constructor(directory) {
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const file=path.join(directory,'qonvexa-next.sqlite');
    this.db=new DatabaseSync(file);
    fs.chmodSync(file,0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    this.db.exec(fs.readFileSync(new URL('../../migrations/001-qonvexa.sql',import.meta.url),'utf8'));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=fn(); this.db.exec('COMMIT'); return result; }
    catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  get(kind,id) {const row=this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id);return row?JSON.parse(row.data):null;}
  put(kind,id,data,owner='') {this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET owner=excluded.owner,data=excluded.data').run(kind,id,owner,JSON.stringify(data));return data;}
  list(kind,owner) {return (owner===undefined?this.db.prepare('SELECT data FROM records WHERE kind=?').all(kind):this.db.prepare('SELECT data FROM records WHERE kind=? AND owner=?').all(kind,owner)).map(r=>JSON.parse(r.data));}
  remove(kind,id) {this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id);}
  event(type,ids={}) { // Identifiers only; never arbitrary provider bodies/errors/secrets.
    const row={id:crypto.randomUUID(),type,at:new Date().toISOString()};
    for(const k of ['auditId','jobId','orderId','quoteId','connectionId','actor','reason']) if(ids[k]) row[k]=String(ids[k]).slice(0,160);
    this.put('events',row.id,row);return row;
  }
  enqueue(type,owner,payload,id=crypto.randomUUID()) {
    this.db.prepare('INSERT OR IGNORE INTO jobs(id,type,owner,payload,createdAt) VALUES(?,?,?,?,?)').run(id,type,owner,JSON.stringify(payload),Date.now());return this.job(id);
  }
  job(id) {const r=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);return r?{...r,payload:JSON.parse(r.payload),result:r.result?JSON.parse(r.result):null}:null;}
  jobs(owner) {const rows=owner===undefined?this.db.prepare('SELECT id FROM jobs ORDER BY createdAt DESC LIMIT 200').all():this.db.prepare('SELECT id FROM jobs WHERE owner=? ORDER BY createdAt DESC LIMIT 200').all(owner);return rows.map(r=>this.job(r.id));}
  claim(cfg,now=Date.now()) {
    return this.transaction(()=>{
      for (const stale of this.db.prepare("SELECT payload,owner FROM jobs WHERE status='RUNNING' AND leaseUntil<? AND attempt>=?").all(now,cfg.maxAttempts)) {
        const auditId=JSON.parse(stale.payload).auditId, a=auditId&&this.get('audits',auditId);
        if(a)this.put('audits',a.id,{...a,status:'REQUIRES_REVIEW',failureCode:'RETRY_EXHAUSTED'},a.owner);
      }
      this.db.prepare("UPDATE jobs SET status=CASE WHEN attempt>=? THEN 'FAILED' ELSE 'QUEUED' END,lastError='LEASE_EXPIRED',leaseToken=NULL WHERE status='RUNNING' AND leaseUntil<?").run(cfg.maxAttempts,now);
      const row=this.db.prepare("SELECT id FROM jobs WHERE status='QUEUED' AND nextRetryAt<=? AND attempt<? ORDER BY createdAt LIMIT 1").get(now,cfg.maxAttempts);
      if(!row)return null;
      this.db.prepare("UPDATE jobs SET status='RUNNING',attempt=attempt+1,startedAt=?,leaseUntil=?,leaseToken=? WHERE id=?").run(now,now+cfg.leaseMs,crypto.randomUUID(),row.id);
      return this.job(row.id);
    });
  }
  finish(job,result) {return this.db.prepare("UPDATE jobs SET status='COMPLETED',progress=100,finishedAt=?,result=?,leaseToken=NULL WHERE id=? AND status='RUNNING' AND leaseToken=?").run(Date.now(),JSON.stringify(result),job.id,job.leaseToken).changes===1;}
  fail(job,code,cfg,retryable=false) {return this.db.prepare("UPDATE jobs SET status=?,lastError=?,nextRetryAt=?,finishedAt=?,leaseToken=NULL WHERE id=? AND leaseToken=?").run(retryable&&job.attempt<cfg.maxAttempts?'QUEUED':'FAILED',code,Date.now()+1000*2**job.attempt,Date.now(),job.id,job.leaseToken).changes===1;}
  close(){this.db.close();}
}
