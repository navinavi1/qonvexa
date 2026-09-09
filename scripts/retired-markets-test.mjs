import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isRetiredMarket} from '../src/autonomos/retired-markets.js';
import {GlobalWorkHunter} from '../src/autonomos/global-work-hunter.js';
import {MarketExpansionEngine} from '../src/autonomos/market-expansion-engine.js';
import {FreeRevenueLeadActioner} from '../src/autonomos/free-revenue-lead-actioner.js';
import {createAutonomOS} from '../src/autonomos/runtime.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'retired-markets-'));
const originalFetch=globalThis.fetch;
const requests=[];
let runtime;
try {
  for(const source of ['AgentHansa','TaskBounty'])assert(isRetiredMarket({source}));
  assert(isRetiredMarket({url:'https://www.task-bounty.com/browse'}));
  assert(isRetiredMarket({marketHost:'api.agenthansa.com'}));
  assert(!isRetiredMarket({url:'https://example.org/task-bounty.com'}));
  assert(!isRetiredMarket({url:'https://agenthansa.com.example.org/jobs'}));
  for(const source of ['dealwork','workprotocol','clawlancer','taskforce','agrenting','github-bounties'])assert(!isRetiredMarket({source}));

  const hunter=Object.create(GlobalWorkHunter.prototype);
  const listing={title:'Paid API bug fix bounty project $100',snippet:'Open paid software project: fix the API bug for $100.'};
  assert.equal(hunter.classifyWebLead({...listing,url:'https://www.agenthansa.com/jobs/1'},'paid'),null);
  assert.equal(hunter.classifyWebLead({...listing,url:'https://www.task-bounty.com/tasks/1'},'paid'),null);
  assert(hunter.classifyWebLead({...listing,url:'https://github.com/example/project/issues/1'},'paid'));

  globalThis.fetch=async input=>{requests.push(String(input));return new Response('{}',{status:200,headers:{'content-type':'application/json'}});};
  const expansion=new MarketExpansionEngine({storageDir:root,env:{AUTONOMOS_AUTO_REGISTER_MARKETS:'true'},logger:{}});
  fs.writeFileSync(expansion.scoutFile,JSON.stringify({candidates:{a:{id:'a',homepage:'https://www.agenthansa.com',score:10},b:{id:'b',homepage:'https://www.task-bounty.com',score:10}}}));
  await expansion.tick();
  assert.equal(requests.length,0,'retired markets must not be fetched or registered again');
  assert.deepEqual(JSON.parse(fs.readFileSync(expansion.feedFile,'utf8')).rows,[]);

  const actioner=Object.create(FreeRevenueLeadActioner.prototype);
  const retiredLead={id:'old-discovered-lead',url:'https://www.task-bounty.com/tasks/old'};
  assert.equal(actioner.shouldBrowserlessInspect(retiredLead),false);
  assert.equal((await actioner.inspectAndActBrowserless(retiredLead)).reason,'marketplace_retired');
  assert.equal((await actioner.sendApplicationEmailOnce({lead:retiredLead})).reason,'marketplace_retired');
  assert.equal(requests.length,0,'cached leads must not cause new applications');

  const archive=path.join(root,'autonomos','marketplace-manager.json');
  const history=JSON.stringify({jobs:{historical:{job:{source:'taskbounty',externalId:'old'},status:'paid',receipt:{id:'historic-receipt'}}}});
  fs.writeFileSync(archive,history);
  runtime=createAutonomOS({storageDir:root,siteUrl:'https://example.org',env:{AUTONOMOS_ENABLED:'false',AUTONOMOS_X402_ENABLED:'false'},logger:{}});
  const snapshot=await runtime.snapshot();
  assert(!snapshot.newMarketplaces);
  assert(!snapshot.connectors.some(c=>['taskbounty','agenthansa'].includes(c.id)));
  for(const id of ['dealwork','workprotocol','clawlancer'])assert(snapshot.connectors.some(c=>c.id===id));
  for(const source of ['taskbounty','agenthansa']) {
    const result=await runtime.processDurableOpportunity({source,externalId:'cached-dispatch',title:'Old queued job',budgetUsd:100});
    assert.equal(result.preclaimRejected,true);
    assert(result.reasons.includes('marketplace_retired'));
  }
  assert.equal(fs.readFileSync(archive,'utf8'),history,'historical provider receipts must remain intact');
  assert(!requests.some(url=>isRetiredMarket(url)));
  console.log('PASS retired providers: no discovery, auto-registration, cached applications or durable claims; other sources and receipt history preserved');
} finally {
  runtime?.stop();
  globalThis.fetch=originalFetch;
  fs.rmSync(root,{recursive:true,force:true});
}
