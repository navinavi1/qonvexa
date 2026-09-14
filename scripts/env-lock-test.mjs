import assert from 'node:assert/strict';
import { DEFAULT_AUTONOMOS_CONFIG } from '../src/autonomos/policy-engine.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envForcedConfig, ENV_OVERRIDABLE_CONFIG, normalizeConfig } from '../src/autonomos/policy-engine.js';

let checks=0;
const ok=(c,l)=>{assert.ok(c,l);checks++;};
const eq=(a,b,l)=>{assert.deepEqual(a,b,l+' (got '+JSON.stringify(a)+')');checks++;};

// normalizeConfig skips environment overrides when npm_lifecycle_event looks like a test
// (check|verify|*test|*audit), so this file has to clear it to exercise the production path
// at all. `npm start` sets it to "start", which is not test-like, so production does apply
// them -- that asymmetry is exactly why the form's checkbox appeared to work in a test run
// and did nothing on the server.
const OWNED=['npm_lifecycle_event','AUTONOMOS_ZERO_SPEND_MODE','AUTONOMOS_CRYPTO_ONLY_EARNINGS'];
const SAVED=Object.fromEntries(OWNED.map(k=>[k,process.env[k]]));
for(const k of OWNED)delete process.env[k];
process.on('exit',()=>{for(const k of OWNED){if(SAVED[k]===undefined)delete process.env[k];else process.env[k]=SAVED[k];}});

ok(!/^(?:check|verify|.*test|.*audit)$/i.test('start'),'npm start is not test-like, so production does apply the environment');

// 1. The defect: the form saved a value the runtime then overwrote from the environment.
const saved={enabled:true,zeroSpendMode:false,earnedFundsOnly:true,updatedAt:new Date().toISOString()};
process.env.AUTONOMOS_ZERO_SPEND_MODE='true';
eq(normalizeConfig(saved).zeroSpendMode,true,'unticking the box does not survive the environment');
delete process.env.AUTONOMOS_ZERO_SPEND_MODE;
eq(normalizeConfig(saved).zeroSpendMode,false,'and it does survive once the variable is gone');

// 2. So the dashboard has to be told which fields are held, and by what.
const forced=envForcedConfig({AUTONOMOS_ZERO_SPEND_MODE:'true',AUTONOMOS_CRYPTO_ONLY_EARNINGS:'true'});
eq(forced.zeroSpendMode.variable,'AUTONOMOS_ZERO_SPEND_MODE','the held field names its variable');
eq(forced.zeroSpendMode.value,'true','and the value it is held at');
eq(forced.cryptoOnlyEarnings.variable,'AUTONOMOS_CRYPTO_ONLY_EARNINGS','every held field is reported');
eq(Object.keys(envForcedConfig({})).length,0,'nothing is reported as held when nothing is set');
eq(Object.keys(envForcedConfig({AUTONOMOS_ZERO_SPEND_MODE:''})).length,0,'an empty variable does not count as held');
ok(Object.keys(ENV_OVERRIDABLE_CONFIG).length>=15,'the overridable map covers the real surface, got '+Object.keys(ENV_OVERRIDABLE_CONFIG).length);
for(const [field,key] of Object.entries(ENV_OVERRIDABLE_CONFIG)){
  ok(/^AUTONOMOS_[A-Z0-9_]+$/.test(key),field+' maps to a real variable name: '+key);
}

const here=path.dirname(fileURLToPath(import.meta.url));
const read=p=>fs.readFileSync(path.join(here,'..',p),'utf8');

// 3. The snapshot reports it from the same source normalizeConfig reads, not a passed-in env.
const runtime=read('src/autonomos/runtime.js');
ok(/envForced:envForcedConfig\(process\.env\)/.test(runtime),
  'the snapshot reads process.env, the source that actually decides');

// 4. The form disables a held field and names the variable instead of pretending it is live.
const admin=read('public/admin.js');
ok(/const forced=a\.config\?\.envForced\|\|\{\}/.test(admin),'the form reads the held set');
ok(/field\.disabled=Boolean\(hold\)/.test(admin),'a held field is disabled, not silently ignored');
ok(/env-lock-note/.test(admin)&&/hold\.variable/.test(admin),'and the note names the variable');
ok(/\.env-lock-note/.test(read('public/admin.css')),'the note is styled rather than invisible');


// A fallback written beside a config read is a second copy of that setting's default, and
// they had drifted: the api-cost gate fell back to 25% where the real default is 60%, so a
// config missing that key would have refused work at under half the intended ceiling, with
// nothing in either place saying which number was real. Falling back to 0 is different and
// allowed -- that is "no budget, no cap", which fails safe. Any OTHER disagreement is two
// answers to one question.
{
  const root=new URL('../src/', import.meta.url);
  const sources=[];
  (function walk(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const child=new URL(entry.name+(entry.isDirectory()?'/':''),dir);
      if(entry.isDirectory())walk(child); else if(/\.m?js$/.test(entry.name))sources.push(child);
    }
  })(root);
  sources.push(new URL('../server.js', import.meta.url));

  const contradictions=[];
  for(const file of sources){
    const body=fs.readFileSync(file,'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
    for(const [key,real] of Object.entries(DEFAULT_AUTONOMOS_CONFIG)){
      if(typeof real!=='number')continue;
      for(const m of body.matchAll(new RegExp(`\\.${key}\\s*(?:\\?\\?|\\|\\|)\\s*(-?[0-9.]+)`,'g'))){
        const written=Number(m[1]);
        if(written!==0&&written!==Number(real))
          contradictions.push(`${file.pathname.split('/').pop()}: ${key} falls back to ${written}, the default is ${real}`);
      }
    }
  }
  assert.deepEqual(contradictions,[],'no inline fallback contradicts the config default it stands in for');
  checks++;
}

console.log('env-lock-test OK ('+checks+' checks)');
