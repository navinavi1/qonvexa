import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Read the reasons out of runtime.js itself rather than restating them here. A hardcoded
// list would pass while a newly added reason silently fell through to 'other' -- which is
// exactly how eight of them ended up unexplained.
const here=path.dirname(fileURLToPath(import.meta.url));
const source=fs.readFileSync(path.join(here,'..','src','autonomos','runtime.js'),'utf8');

const start=source.indexOf('function explainCandidacy(');
assert.ok(start>0,'explainCandidacy must exist for this test to mean anything');
const body=source.slice(start,source.indexOf('isCandidate:reasons.length===0',start));
const reasons=[...body.matchAll(/reasons\.push\(\s*[`'"]([^`'"$]+)/g)].map(m=>m[1]);
assert.ok(reasons.length>=15,'expected the full reason vocabulary, found '+reasons.length);

// Mirror of runtime's blockerBucket. Kept in step by the identity check below.
const bucketSource=source.slice(source.indexOf('function blockerBucket('),source.indexOf('function buildMarketFunnel('));
const rules=[...bucketSource.matchAll(/if\(\/(.+?)\/\.test\(r\)\)return '([a-z_]+)'/g)].map(([,re,name])=>[new RegExp(re),name]);
assert.ok(rules.length>=12,'expected the bucket rules to be parsed, found '+rules.length);
const bucket=reason=>{for(const [re,name] of rules)if(re.test(String(reason)))return name;return 'other';};

const explanationBlock=source.slice(source.indexOf('below_payout:'),source.indexOf("other:'No discovered job"));
let checks=0;
const unexplained=[];
for(const reason of reasons){
  const name=bucket(reason);
  if(name==='other')unexplained.push(reason);
  checks++;
}
assert.deepEqual(unexplained,[],'every candidacy refusal must name a bucket, these did not: '+unexplained.join(', '));

// Each bucket a reason can produce must also carry owner-facing text.
const missingText=[];
for(const reason of reasons){
  const name=bucket(reason);
  if(!explanationBlock.includes(name+':'))missingText.push(name);
  checks++;
}
assert.deepEqual([...new Set(missingText)],[],'buckets without an explanation: '+missingText.join(', '));

// The distinctions that matter: these three are different situations with different answers
// and must not collapse into one message.
const distinct=new Set(['auto_claim_disabled_in_policy','marketplace_lifecycle_not_auto_ready:retired','recent_claim_attempt_still_in_backoff'].map(bucket));
assert.equal(distinct.size,3,'auto-claim off, lifecycle not ready and retry backoff must stay distinct');
checks++;

// A retry that exhausted its attempts is not the same as one still waiting.
assert.notEqual(bucket('assigned_execution_retry_limit_reached:3'),bucket('assigned_execution_retry_backoff'),
  'an exhausted retry must not read as one still in backoff');
checks++;

console.log('blocker-coverage-test OK ('+checks+' checks, '+reasons.length+' reasons, all bucketed)');
