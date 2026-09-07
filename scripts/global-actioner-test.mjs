import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GlobalLeadActioner } from '../src/autonomos/global-lead-actioner.js';
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
const instruction=actioner.applicationInstruction({lead,proposal:'We can complete this.',email:'agent@example.com',account:{password:'generated-secret'},payout});
assert.match(instruction,/Do NOT bypass/i);assert.match(instruction,/Do NOT pay fees/i);assert.match(instruction,/Do NOT claim the applicant is a human/i);
const op=actioner.toOpportunity(lead,'Translate the supplied document accurately.');
assert.equal(op.source,'global-web');assert.equal(op.externalId,'lead1');assert.equal(op.budgetUsd,50);

// Marketplace boilerplate like “buy services” is not a task requirement and must not
// force a normal translation job into external_procurement. An explicit requirement to
// buy a paid license for the task still must be blocked.
const context={llmEnabled:true,hasBrowserTool:true,hasShellTool:true,hasArtifactTool:true,hasAppTool:true,hasWebSearchTool:true};
const normal=classifyOpportunity({...op,description:'Translate the supplied document accurately. Marketplace: buy services, hire freelancers, purchase work securely.'},context);
assert.equal(normal.skill,'translation');assert.equal(normal.executable,true);assert.equal(normal.missingTools.includes('external_procurement'),false);
const procurement=classifyOpportunity({...op,description:'Translate the supplied document. You are required to purchase a paid software license to complete this task.'},context);
assert.equal(procurement.missingTools.includes('external_procurement'),true);

console.log('GLOBAL ACTIONER: safety + paid-work + procurement gates PASS');
fs.rmSync(root,{recursive:true,force:true});
