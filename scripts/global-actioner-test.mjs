import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GlobalLeadActioner } from '../src/autonomos/global-lead-actioner.js';
import { GlobalWorkHunter } from '../src/autonomos/global-work-hunter.js';
import { GlobalFeedPublisher } from '../src/autonomos/global-feed-publisher.js';
import { classifyOpportunity } from '../src/autonomos/capabilities.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'global-actioner-'));
const env={STORAGE_DIR:root,AUTONOMOS_REGISTRATION_EMAIL:'agent@example.com',AUTONOMOS_AGENT_NAME:'AutonomOS',SITE_URL:'https://example.com'};
const actioner=new GlobalLeadActioner({env,storageDir:root,logger:{info(){},warn(){}}});

const lead={id:'lead1',title:'Remote freelance translation project',url:'https://example.org/jobs/1',category:'translation',amountUsd:50,payoutCurrency:'USD',snippet:'Paid freelance translation contract. Budget $50.'};
assert.equal(actioner.inspectPage('Freelance translation project. Apply for this contract. Budget $50.',lead),null);
assert.equal(actioner.inspectPage('Freelance task. Complete CAPTCHA and phone verification to continue.',lead)?.status,'human_gate');
assert.equal(actioner.inspectPage('Freelance project. Buy connects and pay an application fee to apply.',lead)?.status,'paid_registration_required');
assert.equal(actioner.inspectPage('Full-time employee role with salary per year and employee benefits.',lead)?.status,'physical_or_employment');
assert.equal(actioner.inspectPage('Freelance writing project. No AI-generated content is allowed.',lead)?.status,'ai_prohibited');

const payout=actioner.resolvePayout(lead,'Fixed-price freelance contract. Budget $50 USD.');
assert.equal(payout.paid,true);assert.equal(payout.amountUsd,50);
const op=actioner.toOpportunity(lead,'Translate the supplied document accurately.');
assert.equal(op.source,'global-web');assert.equal(op.externalId,'lead1');assert.equal(op.budgetUsd,50);

// Marketplace boilerplate like “buy services” is not a task requirement and must not
// force a normal translation job into external_procurement. An explicit requirement to
// buy a paid license for the task still must be blocked.
const context={llmEnabled:true,hasBrowserTool:false,hasShellTool:true,hasArtifactTool:true,hasAppTool:true,hasWebSearchTool:true};
const normal=classifyOpportunity({...op,description:'Translate the supplied document accurately. Marketplace: buy services, hire freelancers, purchase work securely.'},context);
assert.equal(normal.skill,'translation');assert.equal(normal.executable,true);assert.equal(normal.missingTools.includes('external_procurement'),false);
const procurement=classifyOpportunity({...op,description:'Translate the supplied document. You are required to purchase a paid software license to complete this task.'},context);
assert.equal(procurement.missingTools.includes('external_procurement'),true);

assert.equal(actioner.capabilityContext().hasBrowserTool,false);
assert.equal(actioner.capabilityContext().hasWebSearchTool,true);

// persist() rewrote the feed and archive views on every scan even when the scan found
// nothing -- and the live logs report newLeads:0 on nearly every one. At production scale
// that was 280ms of blocked event loop and 26MB written every twenty to thirty seconds, on
// the thread that also serves HTTP and runs fifteen workers. Skipping identical writes is
// only correct if a real change still publishes immediately, so assert both halves.
{
  const storage=fs.mkdtempSync(path.join(os.tmpdir(),'hunter-persist-'));
  const hunter=new GlobalWorkHunter({env:{STORAGE_DIR:storage},storageDir:storage,
    logger:{info(){},warn(){},error(){}}});
  for(let i=0;i<50;i++){
    const lead=hunter.classifyWebLead({url:'https://example'+i+'.com/job',
      title:'Remote freelance contract: build a landing page '+i,
      snippet:'Paid freelance digital project, remote, fixed price.'},'freelance job');
    if(lead)hunter.state.leads[lead.id]={...lead,firstSeenAt:new Date().toISOString()};
  }
  hunter.persist();
  const stamp=()=>fs.statSync(hunter.feedFile).mtimeMs+':'+fs.statSync(hunter.feedFile).size;
  const first=stamp();
  hunter.persist(); hunter.persist();
  assert.equal(stamp(),first,'a scan that changed nothing does not rewrite the feed');

  hunter.state.leads.webwork_new={id:'webwork_new',source:'x.com',title:'A brand new job',
    url:'https://x.com/j',firstSeenAt:new Date().toISOString()};
  hunter.persist();
  const feed=JSON.parse(fs.readFileSync(hunter.feedFile,'utf8'));
  assert.equal(feed.count,51,'a real change publishes at once');
  assert.ok(feed.items.some(x=>x.id==='webwork_new'),'and the new lead is in the published view');
  assert.ok(feed.generatedAt,'the view still says when it was rebuilt');

  fs.rmSync(hunter.feedFile);
  hunter.persist();
  assert.ok(fs.existsSync(hunter.feedFile),'a deleted view is rebuilt rather than assumed present');
  fs.rmSync(storage,{recursive:true,force:true});
}


// The public feed was rebuilt from scratch on a ten-second timer: eight JSON files read, a
// row built for every lead, a full business snapshot computed over the ledger. At 5,000
// leads that measured about 830ms with the event loop frozen -- roughly eight percent of all
// wall-clock time, in chunks close to a second, on the thread serving HTTP and running
// fifteen workers -- and every rebuild after the first produced identical bytes. Skipping is
// only safe if a real change still reaches the feed on the very next tick.
{
  const storage=fs.mkdtempSync(path.join(os.tmpdir(),'feed-pub-'));
  fs.mkdirSync(path.join(storage,'public'),{recursive:true});
  const env={STORAGE_DIR:storage,PUBLIC_DIR:path.join(storage,'public')};
  const hunter=new GlobalWorkHunter({env,storageDir:storage,logger:{info(){},warn(){},error(){}}});
  for(let i=0;i<40;i++){
    const lead=hunter.classifyWebLead({url:'https://example'+i+'.com/job',
      title:'Remote freelance contract: build a landing page '+i,
      snippet:'Paid freelance digital project, remote, fixed price.'},'freelance job');
    if(lead)hunter.state.leads[lead.id]={...lead,firstSeenAt:new Date().toISOString()};
  }
  hunter.persist();

  // publicDir() falls back to the repository's own public/ when AUTONOMOS_PUBLIC_DIR is unset,
  // so this published the feed straight over the tracked public/autonomos-global-feed.json --
  // overriding .root moves where it reads from, not where it writes to. Every `npm run verify`
  // left that file changed, on Render's build tree as much as here.
  const publicOut=path.join(storage,'public');
  fs.mkdirSync(publicOut,{recursive:true});
  const publisher=new GlobalFeedPublisher({env:{...env,AUTONOMOS_PUBLIC_DIR:publicOut},
    storageDir:storage,logger:{info(){},warn(){},error(){}}});
  publisher.root=path.join(storage,'autonomos');
  assert.notEqual(publisher.publish(),false,'the first tick builds the feed');
  assert.equal(publisher.publish(),false,'a tick with no source change rebuilds nothing');
  assert.equal(publisher.publish(),false,'and keeps not rebuilding while nothing moves');

  hunter.state.leads.webwork_fresh={id:'webwork_fresh',source:'x.com',title:'A brand new job',
    url:'https://x.com/j',category:'website',firstSeenAt:new Date().toISOString()};
  hunter.persist();
  assert.notEqual(publisher.publish(),false,'a real change is published on the next tick');
  const feed=JSON.parse(fs.readFileSync(publisher.publicFile,'utf8'));
  assert.ok(feed.rows.some(r=>r.id==='webwork_fresh'),'and the new lead is in it');

  fs.rmSync(publisher.publicFile);
  assert.notEqual(publisher.publish(),false,'a deleted feed is rebuilt, not assumed present');
  fs.rmSync(storage,{recursive:true,force:true});
}

console.log('GLOBAL ACTIONER: provider-neutral safety + paid-work + procurement gates PASS');
fs.rmSync(root,{recursive:true,force:true});
