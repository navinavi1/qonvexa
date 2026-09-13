import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverEmailRoutes, discoverApplyLinks, buildEmailArgs } from '../src/autonomos/browserless-lead-actioner.js';
import { SearchFirstLeadActioner } from '../src/autonomos/search-first-lead-actioner.js';

const html=`
<html><body>
  <p>Freelance translation project. To apply, send your proposal to <a href="mailto:jobs@example.com">jobs@example.com</a>.</p>
  <p>Privacy questions: privacy@example.com</p>
  <a href="/careers/apply">Apply now</a>
</body></html>`;
const routes=discoverEmailRoutes(html,'https://example.com/jobs/1');
assert.equal(routes[0]?.email,'jobs@example.com');
assert.equal(routes.some(x=>x.email==='privacy@example.com'),false);
const links=discoverApplyLinks(html,'https://example.com/jobs/1');
assert.equal(links.includes('https://example.com/careers/apply'),true);

const args=buildEmailArgs({properties:{recipient_email:{type:'string'},subject:{type:'string'},body:{type:'string'}}},'jobs@example.com','Application','Proposal');
assert.deepEqual(args,{recipient_email:'jobs@example.com',subject:'Application',body:'Proposal'});
assert.equal(buildEmailArgs({properties:{foo:{type:'string'}}},'jobs@example.com','Application','Proposal'),null);


// A marketplace that only accepts applications from a logged-in native account cannot be
// talked into an email route by fetching its pages. That verdict used to be reached after
// the job page fetch and a fallback web search -- and freelancer.com does not answer a
// datacenter IP, so both timed out, the throw landed in the short-backoff catch instead of
// the 24h disposition, and the live logs filled with the same hosts being dialled every
// cycle while the daily HTTP allowance drained. The answer is in the URL: it must cost
// nothing.
const storage=fs.mkdtempSync(path.join(os.tmpdir(),'actioner-'));
const realFetch=globalThis.fetch;
let calls=0;
globalThis.fetch=(...args)=>{calls++;return realFetch(...args);};
try{
  const actioner=new SearchFirstLeadActioner({env:{STORAGE_DIR:storage,AUTONOMOS_MIN_JOB_PAYOUT_USD:'5'},
    storageDir:storage,logger:{info(){},warn(){},error(){}}});
  await actioner.inspectAndActBrowserless({id:'lead-native',url:'https://www.freelancer.com/projects/writing/article-1',
    title:'Write 5 articles',category:'copywriting',snippet:'Paid freelance writing project, $250.'});
  assert.equal(calls,0,'a native-account marketplace costs no network calls, got '+calls);
  const action=actioner.state.actions['lead-native'];
  assert.equal(action?.status,'native_marketplace_auth_required','and says exactly why');
  assert.ok(Date.parse(action.nextRetryAt)-Date.now()>20*60*60_000,'and waits a day, not a short backoff');
}finally{globalThis.fetch=realFetch;fs.rmSync(storage,{recursive:true,force:true});}

console.log('BROWSERLESS ACTIONER: direct application routing PASS');
