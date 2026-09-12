// One-time setup for the Taskmarket earning lane, run on the host that owns the
// persistent disk.
//
// The CLI writes the agent's private key to os.homedir() + '/.taskmarket/keystore.json'
// and takes no override for that path. Running `taskmarket init` by hand, without HOME
// pointed at the persistent disk first, silently creates the wallet in the container's
// ephemeral layer -- where the next deploy deletes it, together with access to anything
// already settled to that address. This wrapper exists so that cannot happen by accident.
//
// It deliberately stops short of accepting the marketplace's policy bundle. That is an
// agreement binding the owner, and nothing here may sign it for them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { taskmarketHome, createTaskmarketClient } from '../src/autonomos/taskmarket.js';

const env = process.env;
const binary = String(env.AUTONOMOS_TASKMARKET_BIN || 'taskmarket');
const home = taskmarketHome(env);
const line = '-'.repeat(72);

console.log('TASKMARKET SETUP\n' + line);

if (!home) {
  console.log('STOP: no persistent location for the wallet.');
  console.log('  STORAGE_DIR is not set, and AUTONOMOS_TASKMARKET_HOME is not set either.');
  console.log('  Refusing to create a wallet that the next deploy would delete.');
  process.exit(1);
}

fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const keystore = path.join(home, '.taskmarket', 'keystore.json');
console.log(`Wallet location : ${keystore}`);
console.log(`Persistent      : ${home.startsWith('/var/lib') || Boolean(env.AUTONOMOS_TASKMARKET_HOME) ? 'yes' : 'verify this path is on your mounted disk'}`);

const run = (args, { quiet = false } = {}) => {
  try {
    const out = execFileSync(binary, args, { env: { ...env, HOME: home }, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (error) {
    if (!quiet) console.log(`  (${args.join(' ')} failed: ${String(error.stderr || error.message).trim().slice(0, 200)})`);
    return { ok: false, out: String(error.stdout || '') };
  }
};

if (!run(['--version'], { quiet: true }).ok) {
  console.log('\nSTOP: the taskmarket CLI is not installed on this host.');
  console.log('  Run: npm run taskmarket-install');
  process.exit(1);
}

const existed = fs.existsSync(keystore);
console.log(`\n1. Wallet ${existed ? '(already present, init is safe to re-run)' : '(creating)'}`);
run(['init']);
const address = run(['address'], { quiet: true });
if (address.ok) console.log(`   Address: ${address.out.trim()}`);
console.log(`   Key stored at: ${keystore}`);
if (!existed && fs.existsSync(keystore)) console.log('   This file IS the wallet. It is not backed up anywhere else.');

console.log('\n2. Policy bundle');
const legal = run(['legal', 'status'], { quiet: true });
console.log(legal.out.trim() ? legal.out.trim().split('\n').map(l => '   ' + l).join('\n') : '   (no status returned)');

const client = createTaskmarketClient({ env });
console.log('\n3. What this agent can and cannot do');
const status = client.status();
console.log(`   Allowed commands : ${status.allowedCommands.join(', ')}`);
console.log(`   Can spend USDC   : ${status.canSpend}`);
console.log(`   Can withdraw     : ${status.canWithdraw}`);

console.log('\n' + line);
console.log('NEXT, AND ONLY YOU CAN DO IT:');
console.log('  Read the Terms, Privacy Policy, Risk Disclosure and Acceptable Use Policy');
console.log('  linked in the status above. If you agree, run:');
console.log('');
console.log('      npm run taskmarket-accept');
console.log('');
console.log('  Until then the agents will keep discovering tasks and will not claim any.');
console.log('  Withdrawal setup is separate, later, and irreversible -- do not rush it.');
