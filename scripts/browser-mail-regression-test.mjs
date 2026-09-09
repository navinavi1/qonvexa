import { composioExecute } from '../src/autonomos/composio-tool.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGmailMessage,isClientReply,GmailMailbox,gmailMessageIdentity } from '../src/autonomos/gmail-mailbox.js';
import { discoverEmailRoutes } from '../src/autonomos/browserless-lead-actioner.js';
import { resourceAvailability,reserveResource } from '../src/autonomos/resource-control.js';
import { GlobalLeadActioner } from '../src/autonomos/global-lead-actioner.js';
import { GmailJobMonitor } from '../src/autonomos/gmail-job-monitor.js';
const message=(text,headers=[],labels=[])=>({id:'m2',threadId:'t1',internalDate:String(Date.now()),labelIds:labels,payload:{headers:[{name:'From',value:'Client <client@example.org>'},{name:'To',value:'agency@example.org'},{name:'Subject',value:'Re: New title'},...headers],mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{data:Buffer.from(text).toString('base64url')}}]}});
const action={recipient:'client@example.org',gmailThreadId:'t1'};
const accepted=parseGmailMessage(message('Your proposal is accepted. Please start.'));
assert.equal(isClientReply(accepted,action,'agency@example.org'),true);
assert.equal(isClientReply({...accepted,from:''},action,''),false);
assert.equal(isClientReply({...accepted,from:'stranger@example.org'},action,''),false);
assert.equal(isClientReply({...accepted,labels:['SENT']},action,''),false);
assert.equal(isClientReply({...accepted,threadId:'other'},action,''),false);
const auto=parseGmailMessage(message('Please send a portfolio.',[{name:'Auto-Submitted',value:'auto-replied'}]));assert.equal(isClientReply(auto,action,''),false);
const quoted=parseGmailMessage(message('Still reviewing.\nOn Tuesday client wrote:\nPlease start.'));assert.equal(quoted.text,'Still reviewing.');
assert.deepEqual(gmailMessageIdentity({data:{response_data:{id:'abc',threadId:'def'}}}),{gmailMessageId:'abc',gmailThreadId:'def'});
for(const bad of ['notifications@github.comwrote','jane@example.com.png','candidatehelpdesk@wtwco.com','reasonable-accommodations@dataiku.com','jobs+noreply@example.org','your@email.com']){
  assert.equal(discoverEmailRoutes(`<p>Apply for freelance project: ${bad}</p>`).length,0,bad);
}
assert.equal(discoverEmailRoutes('<p>Apply for freelance translation: jobs@company.org</p>')[0].email,'jobs@company.org');
assert.notEqual(GlobalLeadActioner.prototype.inspectPage.call({},'Freelance project: add a page. Portfolio includes completed projects.',{title:'Freelance project'} )?.status,'archived');
assert.equal(GlobalLeadActioner.prototype.inspectPage.call({},'This project is completed.',{title:'Freelance project'} )?.status,'archived');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmail-regression-'));const env={STORAGE_DIR:root,COMPOSIO_API_KEY:'test',AUTONOMOS_FREE_RESOURCE_LIMITS_JSON:JSON.stringify({gmail:{limit:1},gmail_read:{limit:20}})};
const originalFetch=globalThis.fetch;const calls=[];
try{
 await reserveResource('gmail_read',1,env);assert.equal(resourceAvailability('gmail',env).remaining,1);
 const mailbox=new GmailMailbox(env);
 globalThis.fetch=async(url,options={})=>{
   const request=options.body?JSON.parse(options.body):null;calls.push(request?.endpoint||String(url));
   if(String(url).includes('connected_accounts'))return Response.json({items:[{id:'account',status:'ACTIVE'}]});
   let data;if(request.endpoint.endsWith('/profile'))data={emailAddress:'agency@example.org'};
   else if(request.endpoint.includes('/threads/'))data={messages:[message('Please start.')]};
   else data={messages:[{id:'m2',threadId:'t1'}],resultSizeEstimate:1};
   return Response.json({status:200,data});
 };
 assert.equal((await mailbox.health()).ok,true);assert.equal(mailbox.ownEmail,'agency@example.org');
 assert.equal((await mailbox.replies('title',action)).rows[0].text,'Please start.');
 assert(calls.some(x=>x.includes('/threads/t1?format=full')));
 globalThis.fetch=async()=>Response.json({status:200,data:{unexpected:true}});assert.equal((await mailbox.health()).ok,false);
 // Full monitor path: automatic acknowledgements cannot start work, a bound client reply can.
 const state={actions:{j:{title:'Freelance project',...action,status:'applied_email',appliedAt:new Date(Date.now()-60000).toISOString()}},stats:{}};
 const actioner={state,setAction(id,patch){state.actions[id]={...state.actions[id],...patch};},persist(){},archive(){throw Error('unexpected archive');}};
 const monitor=new GmailJobMonitor({actioner,env,logger:{}});let executions=0;monitor.executeAndDeliver=async()=>{executions++;};
 monitor.searchReplies=async()=>({ok:true,rows:[auto]});await monitor.checkOne('j',state.actions.j);assert.equal(executions,0);
 monitor.searchReplies=async()=>({ok:true,rows:[accepted]});await monitor.checkOne('j',state.actions.j);assert.equal(executions,1);assert.equal(state.actions.j.status,'accepted_email');
 // Production reply path preserves Gmail thread ID and RFC reply headers.
 let sentRequest;
 globalThis.fetch=async(url,options={})=>{
   if(String(url).includes('execute/proxy')){sentRequest=JSON.parse(options.body);return Response.json({status:200,data:{id:'sent',threadId:'t1'}});}
   return Response.json({toolkit:{slug:'gmail'},version:'20260909_00'});
 };
 const sent=await composioExecute({toolSlug:'GMAIL_SEND_EMAIL',arguments:{recipient_email:'client@example.org',subject:'Re: New title',body:'Here are the requested details.',_autonomos_thread_id:'t1',_autonomos_in_reply_to:'<original@example.org>'}},{...env,AUTONOMOS_COMPOSIO_ACCOUNTS_JSON:'{"gmail":"account"}'});
 assert.equal(sent.ok,true);assert.equal(sentRequest.body.threadId,'t1');assert.match(Buffer.from(sentRequest.body.raw,'base64url').toString(),/In-Reply-To: <original@example.org>/);
 // Delivery failures archive only unanswered applications, preserving accepted obligations.
 state.actions.failed={recipient:'bad@example.org',status:'applied_email'};state.actions.obligation={recipient:'bad@example.org',status:'accepted_email',acceptedAt:'2026-09-01'};
 monitor.mailbox.health=async()=>({ok:true});monitor.mailbox.recentBounces=async()=>[{id:'bounce',at:new Date().toISOString(),text:'Your message was not delivered to bad@example.org'}];
 await monitor.probeMailbox();assert.equal(state.actions.failed.status,'application_bounced');assert.equal(state.actions.obligation.status,'accepted_email');assert(state.mailboxBouncedRecipients['bad@example.org']);
 console.log('BROWSER/MAIL REGRESSIONS: MIME decoding, thread and sender binding, auto-reply/quote rejection, separate quotas, real read probes, bad email routes and listing status PASS');
}finally{globalThis.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});}
