import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd();
const runtime=fs.readFileSync(path.join(root,'src/autonomos/runtime.js'),'utf8');
const connectors=fs.readFileSync(path.join(root,'src/autonomos/connectors/index.js'),'utf8');
const admin=fs.readFileSync(path.join(root,'public/admin.js'),'utf8');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));

assert.match(runtime,/version:'7\.6\.0'/,'runtime snapshot must identify AutonomOS 7.6.0');
assert.match(runtime,/rules:'7\.6'/,'capability fingerprint must use the current rules generation');
assert.ok(pkg.scripts['autonomos-regression-test'],'current regression script name must be version-neutral');
assert.ok(!pkg.scripts['autonomos71-regression-test'],'stale 7.1 regression script alias must be removed');
assert.match(pkg.scripts.verify,/autonomos-production-readiness-test/,'production readiness audit must run inside npm run verify');

assert.match(runtime,/workAutonomousReady:claimReadySources\.length>0/,'live self-test must expose autonomous work readiness');
assert.match(runtime,/autonomousReady:fullAutoSources\.length>0/,'live self-test autonomousReady must mean end-to-end owner-wallet readiness');
assert.match(runtime,/\['needs_credentials','needs_configuration','connect_required'\]/,'missing setup must include explicit connect-required sources such as t2000');
assert.match(runtime,/status:'cashout_action'/,'missing setup must surface autonomous-work sources whose final cash-out is not verified');

assert.match(admin,/FULL AUTO/,'dashboard must expose FULL AUTO truth');
assert.match(admin,/AUTO WORK · CASHOUT ACTION/,'dashboard must distinguish work automation from final cash-out automation');
assert.match(admin,/DISCOVERY ONLY/,'dashboard must expose discovery-only connectors truthfully');
assert.doesNotMatch(connectors,/AutonomOS\/(?:1\.0|2\.0|3\.0|7\.0|7\.4)/,'connector HTTP user-agent strings must not advertise stale AutonomOS generations');

console.log('AutonomOS production readiness audit PASS');
