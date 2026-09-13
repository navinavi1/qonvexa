import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverEmailRoutes, discoverApplyLinks, buildEmailArgs } from '../src/autonomos/browserless-lead-actioner.js';
import { SearchFirstLeadActioner } from '../src/autonomos/search-first-lead-actioner.js';
import http from 'node:http';
import { readBodyCapped } from '../src/autonomos/bounded-body.js';

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


// Four call sites fetched third-party pages, checked content-length, and then did
// `(await response.text()).slice(0, MAX)`. A chunked response carries no content-length, so
// the check passes and the whole body is buffered before a byte is discarded -- on a 512MB
// instance running fifteen workers on one thread, that is an OOM kill for the entire fleet,
// decided by whatever the far end feels like sending. The cap has to bound what is read.
{
  const server=http.createServer((req,res)=>{
    res.writeHead(200,{'content-type':'text/html'});          // deliberately no content-length
    const chunk='<p>'+'x'.repeat(64*1024)+'</p>';
    let sent=0;
    const pump=()=>{ if(sent>64*1024*1024){res.end();return;} sent+=chunk.length;
      if(res.write(chunk))setImmediate(pump); else res.once('drain',pump); };
    pump();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const before=process.memoryUsage().heapUsed;
    const {text,truncated}=await readBodyCapped(await fetch('http://127.0.0.1:'+server.address().port+'/'),1_500_000);
    const grewMb=(process.memoryUsage().heapUsed-before)/1048576;
    assert.equal(text.length,1_500_000,'exactly the budget is kept');
    assert.equal(truncated,true,'and the caller is told the page was longer');
    assert.ok(grewMb<40,'memory is bounded by the cap, not the far end (grew '+grewMb.toFixed(1)+'MB against a 64MB stream)');
  } finally { server.close(); }
}

console.log('BROWSERLESS ACTIONER: direct application routing PASS');
