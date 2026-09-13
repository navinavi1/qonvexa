// Records the owner's acceptance of Taskmarket's policy bundle, with HOME pointed at the
// persistent disk so the receipt is stored beside the wallet rather than in a directory the
// next deploy deletes. Interactive on purpose: the CLI shows the documents and asks, and
// this wrapper passes that through untouched. It adds no --yes flag of its own.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { taskmarketHome, taskmarketBinary } from '../src/autonomos/taskmarket.js';

const env = process.env;
const home = taskmarketHome(env);
if (!home) { console.error('STOP: no persistent home. Run npm run taskmarket-setup first.'); process.exit(1); }
fs.mkdirSync(home, { recursive: true, mode: 0o700 });

console.log('Taskmarket will now show its Terms, Privacy Policy, Risk Disclosure and');
console.log('Acceptable Use Policy. Read them. Accepting is your decision and binds you.\n');

const result = spawnSync(taskmarketBinary(env), ['legal', 'accept'],
  { env: { ...env, HOME: home }, stdio: 'inherit' });
if (result.status === 0) {
  console.log('\nAccepted. The agents will begin claiming tasks on their next cycle.');
  console.log('Check progress at qonvexa.co/admin#autonomos, or run: npm run earning-preflight');
} else {
  console.log('\nNot accepted. Nothing changed: the agents will keep discovering and will not claim.');
}
process.exitCode = result.status ?? 1;
