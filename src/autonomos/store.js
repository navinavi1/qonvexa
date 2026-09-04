import fs from 'node:fs';
import path from 'node:path';

export class AutonomOSStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    fs.mkdirSync(rootDir, { recursive: true });
  }

  readJson(name, fallback = {}) {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { return structuredCloneSafe(fallback); }
  }

  writeJson(name, value) {
    const target = this.file(name);
    return this.withLock(name, () => this.writeJsonUnlocked(target, value));
  }

  writeJsonUnlocked(target, value) {
    const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2,10)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    try { const fd=fs.openSync(tmp,'r'); fs.fsyncSync(fd); fs.closeSync(fd); } catch {}
    fs.renameSync(tmp, target);
    return value;
  }

  writeSecretJson(name, value) {
    const target = this.file(name);
    return this.withLock(name, () => this.writeSecretJsonUnlocked(target, value));
  }

  writeSecretJsonUnlocked(target, value) {
    const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2,10)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, target);
    try { fs.chmodSync(target, 0o600); } catch {}
    return value;
  }

  append(name, value) {
    return this.withLock(name, () => { fs.appendFileSync(this.file(name), `${JSON.stringify(value)}\n`, {mode:0o600}); return value; });
  }

  readNdjson(name, limit = 500) {
    const file=this.file(name);
    if(limit===0)return[];
    let text='';
    try {
      const stat=fs.statSync(file);
      if(limit>0 && stat.size>2*1024*1024){
        const bytes=Math.min(stat.size, Math.max(8192, limit*2048));
        const fd=fs.openSync(file,'r');const buf=Buffer.alloc(bytes);fs.readSync(fd,buf,0,bytes,stat.size-bytes);fs.closeSync(fd);text=buf.toString('utf8');
        const firstNewline=text.indexOf('\n'); if(firstNewline>=0)text=text.slice(firstNewline+1);
      } else text=fs.readFileSync(file,'utf8');
    } catch { return []; }
    const lines=text.split(/\r?\n/).filter(Boolean);
    const slice = limit > 0 ? lines.slice(-limit) : lines;
    const rows = [];
    for (const line of slice) {
      try { rows.push(JSON.parse(line)); } catch {}
    }
    return rows;
  }

  withLock(name, fn) {
    const lockFile=this.file(`${name}.lock`); fs.mkdirSync(this.rootDir,{recursive:true});
    const deadline=Date.now()+5000;
    while(true){
      try { const fd=fs.openSync(lockFile,'wx',0o600); try{return fn();} finally{try{fs.closeSync(fd);}catch{} try{fs.unlinkSync(lockFile);}catch{}} }
      catch(error){
        if(error?.code!=='EEXIST') throw error;
        try{const stat=fs.statSync(lockFile);if(Date.now()-stat.mtimeMs>30000)fs.unlinkSync(lockFile);}catch{}
        if(Date.now()>deadline) throw new Error(`store_lock_timeout:${name}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      }
    }
  }

  file(name) { return path.join(this.rootDir, name); }
}

function structuredCloneSafe(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}
