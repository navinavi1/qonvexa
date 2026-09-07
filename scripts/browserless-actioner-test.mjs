import assert from 'node:assert/strict';
import { discoverEmailRoutes, discoverApplyLinks, buildEmailArgs } from '../src/autonomos/browserless-lead-actioner.js';

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

console.log('BROWSERLESS ACTIONER: direct application routing PASS');
