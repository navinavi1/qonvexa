// Installs the Taskmarket CLI onto the mounted disk, not into the container image.
//
// A global install during the build does not survive a failed native compile (the command is
// wrapped so it cannot redden the deploy) and has to be repeated on every deploy besides.
// The disk outlives deploys, so the CLI is installed there once and found there afterwards.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { taskmarketCliRoot, taskmarketBinary, taskmarketHome } from '../src/autonomos/taskmarket.js';

const env = process.env;
const root = taskmarketCliRoot(env);
if (!root) {
  console.error('STOP: no persistent location. STORAGE_DIR and AUTONOMOS_TASKMARKET_HOME are both unset.');
  console.error('Installing into the container would be undone by the next deploy.');
  process.exit(1);
}
fs.mkdirSync(root, { recursive: true });
console.log(`Installing @lucid-agents/taskmarket into ${root}`);
console.log('(on the mounted disk, so it survives deploys)\n');

const result = spawnSync('npm', ['install', '--prefix', root, '--no-audit', '--no-fund', '@lucid-agents/taskmarket@latest'],
  { stdio: 'inherit', env, timeout: 900000 });

const binary = taskmarketBinary({ ...env, AUTONOMOS_TASKMARKET_BIN: '' });
const installed = binary !== 'taskmarket' && fs.existsSync(binary);
console.log('');
if (installed) {
  console.log(`Installed: ${binary}`);
  console.log('Next: npm run taskmarket-setup');
} else {
  console.log('The CLI did not install. @lucid-agents/taskmarket pulls @xmtp/node-sdk, which');
  console.log('builds native bindings and can fail on a small instance.');
  console.log(`npm exited ${result.status}. The Taskmarket lane stays inert until this succeeds;`);
  console.log('nothing else in the system is affected.');
}
process.exitCode = installed ? 0 : 1;
