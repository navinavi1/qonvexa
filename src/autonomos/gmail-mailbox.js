import { reserveResource, observeResourceResult } from './resource-control.js';

// Read-only Gmail REST through the already connected Composio account. Message list
// snippets are not acceptance evidence: fetch the complete MIME message/thread first.
export class GmailMailbox {
  constructor(env=process.env){this.env=env;this.account='';this.accountAt=0;this.ownEmail='';}
  async accountId(){
    if(this.account&&Date.now()-this.accountAt<300000)return this.account;
    const key=String(this.env.COMPOSIO_API_KEY||'');if(!key)throw Error('composio_api_key_missing');
    const cap=await reserveResource('composio',1,this.env);if(!cap.ok)throw Error(cap.error);
    const qs=new URLSearchParams({toolkit_slugs:'gmail',statuses:'ACTIVE',limit:'100'});
    const r=await fetch(`https://backend.composio.dev/api/v3.1/connected_accounts?${qs}`,{headers:{'x-api-key':key},signal:AbortSignal.timeout(15000)});
    const data=await r.json();if(!r.ok)throw Error(`gmail_accounts_http_${r.status}`);
    const accounts=(data.items||[]).filter(x=>x.status==='ACTIVE'&&!x.is_disabled);
    let mapping={};try{mapping=JSON.parse(this.env.AUTONOMOS_COMPOSIO_ACCOUNTS_JSON||'{}');}catch{}
    const mapped=mapping.gmail||mapping.GMAIL;
    const account=mapped?accounts.find(x=>x.id===mapped):accounts.length===1?accounts[0]:null;
    if(!account)throw Error('gmail_account_missing_or_ambiguous');
    this.account=account.id;this.accountAt=Date.now();return this.account;
  }
  async get(endpoint){
    if(!/^\/gmail\/v1\/users\/me\/(profile|messages|threads)(?:[/?]|$)/.test(endpoint))throw Error('gmail_read_endpoint_invalid');
    const account=await this.accountId();
    for(const resource of ['composio','gmail_read']){const cap=await reserveResource(resource,1,this.env);if(!cap.ok)throw Error(cap.error);}
    const r=await fetch('https://backend.composio.dev/api/v3.1/tools/execute/proxy',{method:'POST',headers:{'x-api-key':this.env.COMPOSIO_API_KEY,'content-type':'application/json'},body:JSON.stringify({connected_account_id:account,endpoint,method:'GET'}),signal:AbortSignal.timeout(20000)});
    const body=await r.json();const status=Number(body.status||body.status_code||r.status);
    if(!r.ok||status>=400||body.successful===false){const error=`gmail_read_http_${status}`;observeResourceResult('gmail_read',{ok:false,error},this.env);throw Error(error);}
    const result=unwrap(body);if(result?.error)throw Error('gmail_upstream_error');return result;
  }
  async list(query,max=20){
    const body=await this.get('/gmail/v1/users/me/messages?'+new URLSearchParams({q:query,maxResults:String(max)}));
    if(!Array.isArray(body.messages)&&!('resultSizeEstimate' in body))throw Error('gmail_list_malformed_response');
    return body;
  }
  async thread(id){const body=await this.get(`/gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=full`);if(!Array.isArray(body.messages))throw Error('gmail_thread_malformed_response');return body.messages.map(parseGmailMessage);}
  async health(){
    try{
      const profile=await this.get('/gmail/v1/users/me/profile');if(!profile.emailAddress)throw Error('gmail_profile_malformed_response');this.ownEmail=String(profile.emailAddress).toLowerCase();
      const inbox=await this.list('in:inbox newer_than:7d',1);const sent=await this.list('in:sent newer_than:7d',1);
      return{ok:true,inboxReadable:true,sentReadable:true,recentInboxPresent:Boolean(inbox.messages?.length),recentSentPresent:Boolean(sent.messages?.length)};
    }catch(error){return{ok:false,error:String(error.message).slice(0,200)};}
  }
  async recentBounces(){
    const listing=await this.list('from:mailer-daemon@googlemail.com subject:"Delivery Status Notification" newer_than:7d',20);const rows=[];
    for(const item of listing.messages||[]){const thread=await this.thread(item.threadId);for(const row of thread)if(emailAddress(row.from)==='mailer-daemon@googlemail.com'&&/failure/i.test(row.subject))rows.push(row);}
    return rows;
  }
  async replies(title,action){
    try{
      if(action.gmailThreadId)return{ok:true,rows:await this.thread(action.gmailThreadId)};
      const subject=String(action.emailSubject||`Application: ${String(title).replace(/\s+/g,' ').slice(0,120)} — AutonomOS`).replace(/["\r\n]/g,' ');
      const recipient=emailAddress(action.recipient);if(!recipient)return{ok:false,error:'application_recipient_missing',rows:[]};
      // Old applications have no saved thread ID. Locate the sent original and bind
      // only its actual Gmail thread; never accept an unrelated keyword match.
      const listing=await this.list(`in:sent to:${recipient} subject:"${subject}" newer_than:90d`,10);
      const rows=[];const seen=new Set();
      for(const item of listing.messages||[]){if(!item.threadId||seen.has(item.threadId))continue;seen.add(item.threadId);const thread=await this.thread(item.threadId);
        const original=thread.find(x=>x.labels.includes('SENT')&&x.to.toLowerCase().includes(recipient)&&normalizeSubject(x.subject)===normalizeSubject(subject));
        if(original){action.gmailThreadId=item.threadId;action.gmailMessageId=original.id;rows.push(...thread);break;}
      }
      return{ok:true,rows};
    }catch(error){return{ok:false,error:String(error.message).slice(0,200),rows:[]};}
  }
}
function unwrap(body){
  if(typeof body==='string'){try{return unwrap(JSON.parse(body));}catch{return{};}}
  if(!body||typeof body!=='object')return{};
  if('messages' in body||'emailAddress' in body||'resultSizeEstimate' in body||('id' in body&&('payload' in body||'threadId' in body)))return body;
  for(const key of ['data','response_data','responseData','response','body'])if(body[key]!=null){const result=unwrap(body[key]);if(Object.keys(result).length)return result;}
  return body;
}
export function gmailMessageIdentity(body){const x=unwrap(body);return{gmailMessageId:String(x.id||''),gmailThreadId:String(x.threadId||'')};}
export function emailAddress(value){return String(value||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase()||'';}
function normalizeSubject(value){return String(value||'').replace(/^(?:(?:re|fw|fwd):\s*)+/ig,'').replace(/\s+/g,' ').trim().toLowerCase();}
export function parseGmailMessage(message){
  const headers=Object.fromEntries((message.payload?.headers||[]).map(x=>[String(x.name).toLowerCase(),decodeHeader(String(x.value||''))]));
  const parts=[];function walk(p){if(!p)return;if(p.body?.data&&(!p.mimeType||/^text\/(plain|html)/.test(p.mimeType)))parts.push({type:p.mimeType,text:Buffer.from(p.body.data,'base64url').toString('utf8')});for(const child of p.parts||[])walk(child);}walk(message.payload);
  const plain=parts.filter(x=>x.type==='text/plain');let text=(plain.length?plain:parts).map(x=>x.text).join('\n');
  text=text.replace(/<blockquote\b[\s\S]*?<\/blockquote>/gi,'').replace(/<br\s*\/?\s*>|<\/p>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&');
  text=text.split(/\nOn [\s\S]{0,250}?wrote:\s*\n|\n-{2,}\s*(?:Original Message|Forwarded message)[\s\S]*|\nFrom:\s/)[0].split('\n').filter(x=>!/^\s*>/.test(x)).join('\n').trim();
  const subject=headers.subject||'';const from=headers.from||'';
  const autoReply=Boolean(headers['auto-submitted']&&headers['auto-submitted'].toLowerCase()!=='no')||/auto.?reply|out of office|automatic (?:reply|response)/i.test(subject)||/^(?:no-?reply|donotreply)(?:[+@.-])/i.test(emailAddress(from))||/\b(?:we (?:have )?received your (?:message|email|request|application)|your (?:request|ticket) (?:has been|was) received|this is an automated|automatically generated|thank you for (?:contacting|applying)|thanks for reaching out)[\s\S]{0,200}(?:respond|reply|review|received|business days|team|support|application)/i.test(text);
  const timestamp=Number(message.internalDate);return{id:String(message.id||''),threadId:String(message.threadId||''),from,to:headers.to||'',subject,text:text.slice(0,12000),at:Number.isFinite(timestamp)&&timestamp>0?new Date(timestamp).toISOString():headers.date||'',labels:message.labelIds||[],autoReply,rfcMessageId:headers['message-id']||''};
}
export function isClientReply(row,action,own){
  const from=emailAddress(row.from);const expected=emailAddress(action.replyFrom||action.recipient);
  return Boolean(from&&expected&&from===expected&&from!==emailAddress(own)&&!row.labels?.includes('SENT')&&!row.labels?.includes('DRAFT')&&(!action.gmailThreadId||row.threadId===action.gmailThreadId)&&row.text&&!row.autoReply);
}

function decodeHeader(value){return value.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/ig,(_,charset,mode,text)=>{try{const bytes=mode.toUpperCase()==='B'?Buffer.from(text,'base64'):Buffer.from(text.replace(/_/g,' ').replace(/=([0-9a-f]{2})/ig,(_m,h)=>String.fromCharCode(parseInt(h,16))),'binary');return new TextDecoder(charset).decode(bytes);}catch{return text;}});}
