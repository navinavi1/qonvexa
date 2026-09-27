// Production verification belongs to Qonvexa only. Legacy tests remain opt-in.
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const commands=[
 ['--test','tests/qonvexa/core.test.mjs','tests/qonvexa/scanner.test.mjs','tests/qonvexa/journey.test.mjs','tests/qonvexa/isolation.test.mjs'],
 ...['payment-currency-test.mjs','admin-integration-test.mjs','public-site-test.mjs','production-boot-test.mjs','render-audit.mjs','purchase-audit.mjs','finalization-audit.mjs','smoke.js','smoke.mjs'].map(x=>['scripts/'+x])
];
for(const args of commands){
 const result=spawnSync(process.execPath,args,{env:{PATH:process.env.PATH,QONVEXA_TEST_ALLOW_FIXTURE_SCANS:args[0]==='--test'?'true':'false',NODE_ENV:'test',QONVEXA_PAYMENTS_ENABLED:'true',QONVEXA_OUTBOUND_ENABLED:'false',NODE_OPTIONS:`--require=${path.resolve('tests/qonvexa/offline.cjs')}`},stdio:'inherit',timeout:90000});
 if(result.status!==0){console.error('Qonvexa verification failed:',args.join(' '),result.error?.message||'');process.exit(1);}
}
console.log('Qonvexa production verification PASS; no legacy test/runtime prerequisite.');
