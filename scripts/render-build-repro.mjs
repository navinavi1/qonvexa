// Two red deploys in this repo had the same root cause, and it was not either bug: it was
// that nobody ever ran what Render runs. A test read /home/user/qonvexa/public/admin.html,
// which exists on exactly one machine. Another spawned the server with {...process.env},
// so on the build host it inherited LAUNCH_MODE=live while forcing an http SITE_URL and the
// server refused to start. Both passed locally every time, because locally the absolute path
// resolved and the environment was the developer's, not the builder's.
//
// This runs Render's own pipeline, from render.yaml, against the committed tree:
//
//   npm ci --include=dev && npm run verify && npm prune --omit=dev     (buildCommand)
//   npm start, then GET /health                                       (startCommand + healthCheckPath)
//
// Two things make it faithful, and they are the two things that were missing:
//
//   * the tree comes from `git archive HEAD`, so an uncommitted or ignored file cannot prop
//     the build up -- Render clones, it does not copy your working directory;
//   * the environment is built from nothing, not inherited, and holds render.yaml's values.
//
// It is slow (npm ci, then the whole verify chain) and needs the npm registry, so it is not
// in `npm run verify`. Run it before a deploy you care about: `npm run render-build-repro`.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.join(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'render-repro-'));
const tree = path.join(work, 'app');
fs.mkdirSync(tree, { recursive: true });

// render.yaml's disk mountPath, used literally. A stand-in under /tmp is not equivalent:
// preflight refuses live mode unless STORAGE_DIR sits under /var/lib/qonvexa, precisely so a
// deploy cannot come up writing the owner's ledger to a container layer that is discarded on
// the next push. Substituting a temp directory here would have skipped that check -- which is
// the same shortcut, in spirit, that produced the two red deploys this script exists to stop.
const disk = '/var/lib/qonvexa/data';
let diskReady = false;
try { fs.mkdirSync(path.join(disk, 'taskmarket-home'), { recursive: true }); diskReady = true; }
catch { diskReady = false; }

const step = (label) => console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
const fail = (message) => { console.error(`\nRENDER BUILD REPRO: FAIL\n\n${message}\n`); process.exit(1); };

// The host's network and TLS settings, and nothing else. `npm ci` has to reach the registry,
// and on a machine behind a proxy with its own CA that needs these -- but they describe the
// machine, not the service, so they are listed rather than inherited wholesale. Render's
// builder has no proxy and simply has none of them set.
const HOST_NETWORK_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy',
  'no_proxy', 'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_noproxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
const hostNetwork = {};
for (const key of HOST_NETWORK_KEYS) if (process.env[key]) hostNetwork[key] = process.env[key];

// render.yaml's envVars, read from render.yaml itself. This used to be a hand-written copy,
// and a copy drifts: it still carried a page of AutonomOS variables after the blueprint had
// dropped them. Built from nothing rather than spread over process.env, because the point is
// to catch a variable the service needs and render.yaml does not set -- this machine has
// GITHUB_TOKEN and AWS keys in its environment, and inheriting them would hide exactly that.
//
// `value:` is used as written; `generateValue: true` gets a fresh random value the way Render
// generates one; `sync: false` is a secret the owner types into the dashboard, so it gets a
// stand-in that satisfies the same startup checks the real one must.
const STANDINS = {
  ADMIN_PASSWORD: 'a-very-long-admin-password-123456',
  LEGAL_BUSINESS_NAME: 'Qonvexa', LEGAL_ADDRESS: 'Kyiv, Ukraine',
  BANK_BENEFICIARY: 'Qonvexa', BANK_NAME: 'Bank', BANK_IBAN: 'UA000000000000000000000000000',
  BANK_SWIFT: 'AAAAUAUX', BANK_CURRENCY: 'USD', BANK_PAYMENT_NOTE: 'note'
};
const blueprintEnv = {};
const yamlText = fs.readFileSync(path.join(repo, 'render.yaml'), 'utf8');
for (const match of yamlText.matchAll(/- key: (\w+)\n\s+(value|sync|generateValue): ?(.*)/g)) {
  const [, key, kind, raw] = match;
  if (kind === 'value') blueprintEnv[key] = raw.trim().replace(/^"(.*)"$/, '$1');
  else if (kind === 'generateValue') blueprintEnv[key] = crypto.randomBytes(24).toString('hex');
  else blueprintEnv[key] = STANDINS[key] ?? 'repro-standin';
}
if (!blueprintEnv.NODE_ENV || !blueprintEnv.LAUNCH_MODE) fail('could not read the env vars from render.yaml');
const renderEnv = {
  ...hostNetwork,
  ...blueprintEnv,
  PATH: process.env.PATH || '', HOME: work,
  STORAGE_DIR: disk
};

const run = (label, file, args, options = {}) => {
  step(label);
  try {
    execFileSync(file, args, { cwd: tree, env: renderEnv, stdio: 'inherit', timeout: 40 * 60_000, ...options });
  } catch (error) {
    fail(`${label} failed the way Render's build would.\n` +
      `Nothing above this line is local noise: it is the build log you would get.\n` +
      `${error.message}`);
  }
};

// Render clones the commit. `git archive HEAD` is that clone: committed content only.
step('export the committed tree (git archive HEAD)');
const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
execFileSync('bash', ['-c', `git -C ${JSON.stringify(repo)} archive HEAD | tar -x -C ${JSON.stringify(tree)}`],
  { stdio: 'inherit' });
console.log(`HEAD ${head} exported to ${tree}`);
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
if (dirty) console.log(`\nNote: your working tree has uncommitted changes, which Render will NOT get:\n${dirty}`);

run('npm ci --include=dev', 'npm', ['ci', '--include=dev']);

// Snapshot the committed files before verify runs, so anything verify changes is verify's
// doing and not npm's. a test once overwrote two tracked JSON files in public/ and then deleted them, because
// server.js resolves its public directory from __dirname and the test had nowhere else to put
// them. So every `npm run verify` removed two tracked files from the tree it ran in, Render's
// build tree included, and briefly left a fabricated revenue figure in the repository's own
// feed file. A test may use the checkout; it may not leave a mark on it.
const snapshot = new Map();
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) snapshot.set(path.relative(tree, full), crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
  }
};
step('fingerprint the committed files');
walk(tree);
console.log(`${snapshot.size} files recorded`);

run('npm run verify', 'npm', ['run', 'verify']);

step('check verify left the checkout alone');
const scribbled = [];
for (const [relative, digest] of snapshot) {
  const full = path.join(tree, relative);
  if (!fs.existsSync(full)) { scribbled.push(`deleted:  ${relative}`); continue; }
  const now = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  if (now !== digest) scribbled.push(`modified: ${relative}`);
}
if (scribbled.length) {
  fail(`the test suite changed ${scribbled.length} committed file(s) in the tree it ran in.\n` +
    `On Render that is the tree being deployed, so whatever it touched ships changed or missing:\n\n` +
    scribbled.map(line => '  ' + line).join('\n'));
}
console.log(`all ${snapshot.size} committed files unchanged`);
run('npm prune --omit=dev', 'npm', ['prune', '--omit=dev']);

// The build can pass and the service still fail to boot: production code importing a
// devDependency survives verify and dies the moment prune removes it.
step('npm start, then GET /health (Render\'s healthCheckPath)');
if (!diskReady) {
  console.log(`Skipped: ${disk} is not writable here, and Render mounts its disk there at`);
  console.log('runtime. The build steps above are the faithful part; re-run with permission');
  console.log('to create that path to cover start-up and the health check as well.');
  console.log(`\nRENDER BUILD REPRO: BUILD PASS, START NOT COVERED (${head})`);
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(0);
}
const port = 5900 + Math.floor(Math.random() * 90);
const server = spawn('npm', ['start'], { cwd: tree, env: { ...renderEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', chunk => { log += chunk; });
server.stderr.on('data', chunk => { log += chunk; });
const stop = () => { try { server.kill('SIGKILL'); } catch {} };

let health = null;
for (let attempt = 0; attempt < 120 && !health; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 500));
  if (server.exitCode !== null) break;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (response.ok) health = await response.json();
  } catch {}
}
stop();
if (!health) {
  fail(`the build passed but the service never answered /health, which is a red deploy too.\n` +
    `Render would retry, fail the health check and roll back.\n\nIt said (the tail, where a dying process writes its error):\n${log.trim().slice(-3000) || '(nothing)'}`);
}
if (health.ok !== true) fail(`/health answered but not ok: ${JSON.stringify(health)}`);
fs.rmSync(work, { recursive: true, force: true });

console.log(`\nRENDER BUILD REPRO: PASS (${head}: npm ci, verify, prune, start and /health all clean` +
  ` on the committed tree with render.yaml's environment)`);
