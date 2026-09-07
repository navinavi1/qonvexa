import fs from 'node:fs';
import path from 'node:path';

const DURABLE_DISPATCH_MAX_AGE_MS=15*60_000;

export function pruneTerminalInFlightJobs(value){
  if(!value||Array.isArray(value)||typeof value!=='object')return value;
  for(const [jobId,record] of Object.entries(value)){
    if(String(record?.status||'')!=='manual_attention')continue;
    const lastError=String(record?.lastError||'').toLowerCase();
    if(lastError.includes('claimed_job_capability_no_longer_executable'))delete value[jobId];
  }
  return value;
}

// Trigger/Temporal dispatch is only a transport reservation, not a marketplace claim.
// A lost callback used to hold work for six hours. On restart, release a reservation older
// than 15 minutes. The callback carries a unique leaseId; after redispatch an old callback
// becomes stale and releaseDispatchPending() ignores it before any marketplace side effect.
export function releaseStaleDispatchReservations(value,{now=Date.now(),maxAgeMs=DURABLE_DISPATCH_MAX_AGE_MS}={}){
  if(!value||Array.isArray(value)||typeof value!=='object')return value;
  for(const [identity,row] of Object.entries(value)){
    if(String(row?.status||'')!=='dispatch_pending')continue;
    if(row?.everOwned)continue;
    const since=Date.parse(String(row?.lastStateAt||row?.lastSeenAt||''));
    if(!Number.isFinite(since)||now-since<maxAgeMs)continue;
    value[identity]={...row,status:'new',failureOwner:'',reasonCode:'durable_dispatch_lease_expired',reason:'Lost durable-dispatch callback lease expired; safe for fresh dispatch.',retryAfter:'',dispatchLeaseId:'',dispatchRunId:'',lastStateAt:new Date(now).toISOString()};
  }
  return value;
}

export function legacyT2000OAuthFallback(rootDir){
  try{
    const credentials=JSON.parse(fs.readFileSync(path.join(rootDir,'credentials.private.json'),'utf8'));
    const accessToken=String(credentials?.t2000?.accessToken||'').trim();
    if(!accessToken)return null;
    return {token:{accessToken},oauth:{legacyCredentialFallback:true},lastError:'legacy_t2000_token_fallback'};
  }catch{return null;}
}

export class AutonomOSStore {
  constructor(rootDir){this.rootDir=rootDir;fs.mkdirSync(rootDir,{recursive:true});}
  readJson(name,fallback={}){
    try{
      let value=JSON.parse(fs.readFileSync(this.file(name),'utf8'));
      if(name==='in-flight-jobs.json')value=pruneTerminalInFlightJobs(value);
      if(name==='job-registry.json')value=releaseStaleDispatchReservations(value);
      return value;
    }catch(error){if(error?.code==='ENOENT'&&name==='t2000-oauth.private.json'){const migrated=legacyT2000OAuthFallback(this.rootDir);if(migrated)return migrated;}return structuredCloneSafe(fallback);}
  }
  readJsonStrict(name,fallback={}){
    try{
      let value=JSON.parse(fs.readFileSync(this.file(name),'utf8'));
      if(name==='in-flight-jobs.json')value=pruneTerminalInFlightJobs(value);
      if(name==='job-registry.json')value=releaseStaleDispatchReservations(value);
      return value;
    }catch(error){if(error?.code==='ENOENT'&&name==='t2000-oauth.private.json'){const migrated=legacyT2000OAuthFallback(this.rootDir);if(migrated)return migrated;}if(error?.code==='ENOENT')return structuredCloneSafe(fallback);throw error;}
  }
  writeJson(name,value){if(name==='in-flight-jobs.json')pruneTerminalInFlightJobs(value);const target=this.file(name);return this.withLock(name,()=>this.writeJsonUnlocked(target,value));}
  writeJsonUnlocked(target,value){const tmp=`${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2,10)}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});try{const fd=fs.openSync(tmp,'r');fs.fsyncSync(fd);fs.closeSync(fd);}catch{}fs.renameSync(tmp,target);return value;}
  writeSecretJson(name,value){const target=this.file(name);return this.withLock(name,()=>this.writeSecretJsonUnlocked(target,value));}
  writeSecretJsonUnlocked(target,value){const tmp=`${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2,10)}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});try{fs.chmodSync(tmp,0o600);}catch{}fs.renameSync(tmp,target);try{fs.chmodSync(target,0o600);}catch{}return value;}
  append(name,value){return this.withLock(name,()=>{fs.appendFileSync(this.file(name),`${JSON.stringify(value)}\n`,{mode:0o600});return value;});}
  readNdjson(name,limit=500){const file=this.file(name);if(limit===0)return[];let text='';try{const stat=fs.statSync(file);if(limit>0&&stat.size>2*1024*1024){const bytes=Math.min(stat.size,Math.max(8192,limit*2048));const fd=fs.openSync(file,'r');const buf=Buffer.alloc(bytes);fs.readSync(fd,buf,0,bytes,stat.size-bytes);fs.closeSync(fd);text=buf.toString('utf8');const firstNewline=text.indexOf('\n');if(firstNewline>=0)text=text.slice(firstNewline+1);}else text=fs.readFileSync(file,'utf8');}catch{return[];}const lines=text.split(/\r?\n/).filter(Boolean),slice=limit>0?lines.slice(-limit):lines,rows=[];for(const line of slice){try{rows.push(JSON.parse(line));}catch{}}return rows;}
  withLock(name,fn){const lockFile=this.file(`${name}.lock`);fs.mkdirSync(this.rootDir,{recursive:true});const deadline=Date.now()+5000;while(true){try{const fd=fs.openSync(lockFile,'wx',0o600);try{return fn();}finally{try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(lockFile);}catch{}}}catch(error){if(error?.code!=='EEXIST')throw error;try{const stat=fs.statSync(lockFile);if(Date.now()-stat.mtimeMs>30000)fs.unlinkSync(lockFile);}catch{}if(Date.now()>deadline)throw new Error(`store_lock_timeout:${name}`);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}}
  file(name){return path.join(this.rootDir,name);}
}
function structuredCloneSafe(value){try{return structuredClone(value);}catch{return JSON.parse(JSON.stringify(value));}}
