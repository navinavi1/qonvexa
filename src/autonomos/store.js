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
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, target);
    return value;
  }

  writeSecretJson(name, value) {
    const target = this.file(name);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, target);
    try { fs.chmodSync(target, 0o600); } catch {}
    return value;
  }

  append(name, value) {
    fs.appendFileSync(this.file(name), `${JSON.stringify(value)}\n`);
    return value;
  }

  readNdjson(name, limit = 500) {
    let text = '';
    try { text = fs.readFileSync(this.file(name), 'utf8'); } catch { return []; }
    const lines = text.split(/\r?\n/).filter(Boolean);
    const slice = limit > 0 ? lines.slice(-limit) : lines;
    const rows = [];
    for (const line of slice) {
      try { rows.push(JSON.parse(line)); } catch {}
    }
    return rows;
  }

  file(name) { return path.join(this.rootDir, name); }
}

function structuredCloneSafe(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}
