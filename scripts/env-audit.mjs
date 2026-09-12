// Which environment variables does this deployment set that no line of code reads?
//
// Run it where the variables actually live (Render → Shell), not on a laptop: it compares
// the live process environment against every env name that appears in the source, so it
// reports the truth for THIS deployment rather than for a checkout.
//
// Three things make a variable dead, and they are not the same problem:
//   * a retired market or tool — the code deliberately refuses it (retired-resources.json),
//     so the credential is a leftover and, for a paid service, possibly a live subscription;
//   * a config field with no env reader — policy-engine reads a fixed list of names, and a
//     field outside it is owned by the dashboard alone, so setting it here does nothing;
//   * an unknown name — a typo, or a variable from a version of the code that is gone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SCAN_DIRS = ['src', 'scripts', 'public'];
const SCAN_FILES = ['server.js', 'trigger.config.js'];

// Only this application's own variables are judged. A host sets dozens of its own (Node,
// the platform, whatever shell you ran this from) and none of them are the owner's to
// delete, so the surface is anchored to what the app itself declares: .env.example and
// render.yaml name it, or it carries one of the prefixes those two files use. Anything
// else is somebody else's variable and is left alone rather than reported as junk.

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(full); }
      else if (/\.(js|mjs|cjs|json)$/.test(e.name)) out.push(full);
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(root, d));
  for (const f of SCAN_FILES) { const p = path.join(root, f); if (fs.existsSync(p)) out.push(p); }
  return out;
}

// Every env name the source mentions, however it is spelled at the call site.
const referenced = new Set();
const NAME = /(?:process\.env|env)(?:\.([A-Z][A-Z0-9_]{2,})|\[\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]\s*\])|['"`]([A-Z][A-Z0-9_]{3,})['"`]/g;
for (const file of sourceFiles()) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  for (const m of text.matchAll(NAME)) {
    const name = m[1] || m[2] || m[3];
    if (name) referenced.add(name);
  }
}

// What the code has deliberately retired — a credential for one of these is a leftover.
let retired = [];
try {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'src/autonomos/retired-resources.json'), 'utf8'));
  const rows = Array.isArray(raw) ? raw : (Object.values(raw).find(Array.isArray) || []);
  retired = rows.map(r => String(r?.id || '')).filter(Boolean);
} catch { /* no retirement list is not an error */ }
const retiredHit = (name) => retired.find(id => name.toLowerCase().replace(/_/g, '').includes(id.toLowerCase().replace(/[-_]/g, '')));

// Config fields the dashboard owns: present in the config shape, absent from the env reader.
let ownedByDashboard = new Set();
try {
  const policy = fs.readFileSync(path.join(root, 'src/autonomos/policy-engine.js'), 'utf8');
  const fields = [...policy.matchAll(/^export const DEFAULT_AUTONOMOS_CONFIG[\s\S]*?\}\)/gm)][0]?.[0] || '';
  const reads = new Set([...policy.matchAll(/'(AUTONOMOS_[A-Z0-9_]+)'/g)].map(m => m[1]));
  for (const m of fields.matchAll(/(\w+):/g)) {
    const envName = 'AUTONOMOS_' + m[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    if (!reads.has(envName)) ownedByDashboard.add(envName);
  }
} catch { /* ignore */ }

// The app's declared surface, from its own two manifests.
const declared = new Set();
const prefixes = new Set();
for (const file of ['.env.example', 'render.yaml']) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
  for (const m of text.matchAll(/^\s*(?:-\s*key:\s*)?([A-Z][A-Z0-9_]{2,})\s*[:=]?/gm)) {
    declared.add(m[1]);
    prefixes.add(m[1].split('_')[0]);
  }
}
// A retired service counts as ours even though its name is long gone from .env.example —
// being removed from the manifest is exactly what retirement did, and its leftover
// credential is the single most useful thing this audit can surface.
const isOurs = (name) => declared.has(name) || prefixes.has(name.split('_')[0]) || Boolean(retiredHit(name))
  // A credential nothing reads is worth reporting whatever it is called. Firecrawl and
  // Tavily were added straight to the deployment, so they appear in no manifest and in no
  // retirement list — and an unused API key is the one kind of dead variable that can still
  // be costing money every month.
  || CREDENTIAL.test(name);

const CREDENTIAL = /_(API_KEY|TOKEN|SECRET|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY|PASSWORD)$/;

const dead = { retired: [], dashboard: [], unknown: [], credentials: [] };
for (const name of Object.keys(process.env).sort()) {
  if (!isOurs(name) || referenced.has(name)) continue;
  const hit = retiredHit(name);
  if (hit) dead.retired.push([name, hit]);
  else if (ownedByDashboard.has(name)) dead.dashboard.push(name);
  else if (CREDENTIAL.test(name)) dead.credentials.push(name);
  else dead.unknown.push(name);
}

const total = Object.keys(process.env).filter(isOurs).length;
const deadCount = dead.retired.length + dead.dashboard.length + dead.unknown.length + dead.credentials.length;

console.log(`\nThis app's variables set here: ${total}   ·   read by no line of code: ${deadCount}\n`);

if (dead.retired.length) {
  console.log('RETIRED — the code refuses these markets/tools on purpose. Safe to delete, and');
  console.log('if any is a paid service, check whether a subscription is still being billed.');
  for (const [name, id] of dead.retired) console.log(`  ${name.padEnd(38)} (retired: ${id})`);
  console.log('');
}
if (dead.dashboard.length) {
  console.log('NO EFFECT FROM HERE — a real config field, but policy-engine does not read it');
  console.log('from the environment. Set it on the admin dashboard instead; here it does nothing.');
  for (const name of dead.dashboard) console.log(`  ${name}`);
  console.log('');
}
if (dead.credentials.length) {
  console.log('UNUSED CREDENTIALS — a key or token nothing reads. Delete it, and check');
  console.log('whether the service behind it is still charging a subscription.');
  for (const name of dead.credentials) console.log(`  ${name}`);
  console.log('');
}
if (dead.unknown.length) {
  console.log('UNKNOWN — no code mentions these. A typo, or left over from a removed feature.');
  console.log('Check each before deleting; they use this app\u2019s naming but nothing reads them.');
  for (const name of dead.unknown) console.log(`  ${name}`);
  console.log('');
}
if (!deadCount) console.log('Nothing dead. Every variable set here is read somewhere in the code.\n');
process.exitCode = 0;
