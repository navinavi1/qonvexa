import { GlobalLeadActioner } from './global-lead-actioner.js';
import { classifyOpportunity } from './capabilities.js';
import { composioSearch, composioExecute } from './composio-tool.js';

const TERMINAL_STATUSES=new Set([
  'archived','human_gate','ai_prohibited','physical_or_employment','paid_registration_required',
  'capability_blocked','needs_capability','applied','applied_email','application_uncertain',
  'email_send_in_progress','accepted','executing','accepted_repair_exhausted','submitted','paid',
  'native_api_route'
]);
const NATIVE_HOSTS=/(^|\.)(task-force\.app|agentlancer\.io|workprotocol\.ai|dealwork\.ai)$/i;
const APPLY_CONTEXT=/\b(apply|application|proposal|freelanc(?:e|er)|project|job|hiring|hire|contract|contractor|send\s+(?:your\s+)?(?:cv|resume|portfolio)|submit\s+(?:your\s+)?(?:cv|resume|portfolio))\b/i;
const BAD_EMAIL_LOCAL=/^(?:no-?reply|donotreply|privacy|security|abuse|billing|invoice|legal|dpo|press|media|webmaster)$/i;
const EMAIL_RE=/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
const HREF_RE=/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/ig;
const MAX_PAGE_BYTES=2_000_000;

export class BrowserlessLeadActioner extends GlobalLeadActioner{
  start(){
    if(this.timer)return;
    const every=Math.max(20_000,Number(this.env.AUTONOMOS_BROWSERLESS_ACTIONER_INTERVAL_MS||30_000));
    setTimeout(()=>this.tick().catch(error=>this.event('browserless_tick_error',{error:safeError(error)})),4500).unref?.();
    this.timer=setInterval(()=>this.tick().catch(error=>this.event('browserless_tick_error',{error:safeError(error)})),every);this.timer.unref?.();
    this.event('browserless_actioner_started',{intervalMs:every,maxPerCycle:this.maxBrowserlessPerCycle(),maxParallel:this.maxBrowserlessParallel()});
  }

  async tick(){
    if(this.running)return;
    if(!truthy(this.env.AUTONOMOS_BROWSERLESS_ACTIONER_ENABLED,'true'))return;
    this.running=true;
    try{
      const hunter=this.read(this.hunterFile,{});
      const leads=Object.values(hunter?.leads||{})
        .filter(lead=>this.shouldBrowserlessInspect(lead))
        .sort((a,b)=>this.priority(b)-this.priority(a)||Date.parse(b.firstSeenAt||b.lastSeenAt||0)-Date.parse(a.firstSeenAt||a.lastSeenAt||0))
        .slice(0,this.maxBrowserlessPerCycle());
      await pool(leads,this.maxBrowserlessParallel(),lead=>this.inspectAndActBrowserless(lead));
    }finally{this.running=false;this.persist();}
  }

  shouldBrowserlessInspect(lead){
    if(!lead?.id||!/^https?:\/\//i.test(String(lead.url||'')))return false;
    const host=hostname(lead.url);if(!host||NATIVE_HOSTS.test(host))return false;
    const action=this.state.actions?.[lead.id];
    if(!action)return true;
    const status=String(action.status||'');
    if(TERMINAL_STATUSES.has(status))return false;
    if(status==='email_channel_unavailable'||status==='no_direct_route'||status==='direct_fetch_failed'||status==='payout_unverified'){
      const next=Date.parse(String(action.nextRetryAt||0));
      return !Number.isFinite(next)||next<=Date.now();
    }
    // Historical unavailable-session failures are retried through the direct free path.
    if(status==='inspect_or_apply_failed'&&/browser_session|session_unavailable/i.test(String(action.error||'')))return true;
    const next=Date.parse(String(action.nextRetryAt||0));
    return !Number.isFinite(next)||next<=Date.now();
  }

  async inspectAndActBrowserless(lead){
    const id=String(lead.id),host=hostname(lead.url);if(!host)return;
    this.setAction(id,{status:'inspecting_direct',host,title:lead.title,url:lead.url,category:lead.category,lastAttemptAt:now(),attempts:Number(this.state.actions?.[id]?.attempts||0)+1,error:''});
    try{
      const page=await fetchPage(lead.url);
      if(!page.ok){
        this.setAction(id,{status:'direct_fetch_failed',error:page.error,nextRetryAt:new Date(Date.now()+backoffMs(this.state.actions?.[id]?.attempts||1)).toISOString()});
        this.event('direct_fetch_failed',{id,host,error:page.error});return;
      }
      this.state.stats.inspected=Number(this.state.stats.inspected||0)+1;
      const fullText=`${lead.title||''}\n${lead.snippet||''}\n${page.text||''}`.slice(0,35_000);
      const disposition=this.inspectPage(fullText,lead);
      if(disposition){this.archive(id,disposition.status,disposition.reason);return;}

      const capabilityText=`${String(lead.title||'')}\n${String(lead.snippet||'')}`.slice(0,6000);
      const capability=classifyOpportunity(this.toOpportunity(lead,capabilityText),{...this.capabilityContext(),hasBrowserTool:false});
      if(!capability.executable){
        this.setAction(id,{status:'needs_capability',missingTools:capability.missingTools||[],skill:capability.skill,nextRetryAt:new Date(Date.now()+6*60*60_000).toISOString()});
        this.event('browserless_lead_needs_capability',{id,host,skill:capability.skill,missingTools:capability.missingTools||[]});return;
      }
      const payout=this.resolvePayout(lead,fullText);
      if(!payout.paid){this.setAction(id,{status:'payout_unverified',nextRetryAt:new Date(Date.now()+6*60*60_000).toISOString()});return;}

      const routes=discoverEmailRoutes(page.html,page.finalUrl||lead.url);
      if(!routes.length){
        for(const candidate of discoverApplyLinks(page.html,page.finalUrl||lead.url).slice(0,3)){
          const follow=await fetchPage(candidate).catch(()=>({ok:false}));
          if(follow?.ok)routes.push(...discoverEmailRoutes(follow.html,follow.finalUrl||candidate));
          if(routes.length)break;
        }
      }
      const route=dedupeRoutes(routes)[0];
      if(!route){
        this.setAction(id,{status:'no_direct_route',reason:'no explicit application email or native API route found without browser automation',nextRetryAt:new Date(Date.now()+12*60*60_000).toISOString(),payout,skill:capability.skill});
        return;
      }

      const proposal=await this.makeProposal(lead,fullText,capability,payout);
      const subject=`Application: ${String(lead.title||'Paid digital project').replace(/\s+/g,' ').slice(0,120)} — AutonomOS`;
      const body=[
        proposal,
        '',
        `Job: ${String(lead.title||'').slice(0,220)}`,
        `Source: ${String(lead.url||'')}`,
        '',
        'AutonomOS is an AI-assisted digital-services agency. We only accept work we can execute and verify with our available tools; no human identity or credentials are being misrepresented.'
      ].join('\n').slice(0,7000);
      await this.sendApplicationEmailOnce({id,host,lead,route,subject,body,proposal,payout,capability});
    }catch(error){
      this.setAction(id,{status:'direct_action_failed',error:safeError(error),nextRetryAt:new Date(Date.now()+backoffMs(this.state.actions?.[id]?.attempts||1)).toISOString()});
      this.event('browserless_action_failed',{id,host,error:safeError(error)});
    }finally{this.persist();}
  }

  async sendApplicationEmailOnce({id,host,lead,route,subject,body,proposal,payout,capability}){
    const prior=this.state.actions?.[id]||{};
    if(['email_send_in_progress','applied_email','application_uncertain'].includes(String(prior.status||'')))return;
    this.setAction(id,{status:'email_send_in_progress',recipient:route.email,applicationUrl:lead.url,proposal:proposal.slice(0,1800),payout,skill:capability.skill,emailStartedAt:now(),nextRetryAt:''});

    const tool=await findGmailSendTool(this.env);
    if(!tool.ok){
      this.setAction(id,{status:'email_channel_unavailable',reason:tool.error,nextRetryAt:new Date(Date.now()+6*60*60_000).toISOString()});
      this.event('email_channel_unavailable',{id,host,error:tool.error});return;
    }
    const args=buildEmailArgs(tool.inputParameters,route.email,subject,body);
    if(!args){
      this.setAction(id,{status:'email_channel_unavailable',reason:'gmail_send_tool_schema_not_understood',nextRetryAt:new Date(Date.now()+6*60*60_000).toISOString()});return;
    }
    const result=await composioExecute({toolSlug:tool.slug,arguments:args},this.env);
    if(result.ok){
      this.setAction(id,{status:'applied_email',appliedAt:now(),emailLogId:String(result.logId||''),recipient:route.email,reason:'targeted application sent to explicit public application contact',nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});
      this.state.stats.applied=Number(this.state.stats.applied||0)+1;
      this.event('lead_applied_email',{id,host,recipient:maskEmail(route.email),title:String(lead.title||'').slice(0,120),amountUsd:payout.amountUsd,currency:payout.currency,skill:capability.skill});return;
    }
    if(result.needsConnectedAccount||/connected.?account|auth|unauthor|forbidden/i.test(`${result.error||''} ${result.detail||''}`)){
      this.setAction(id,{status:'email_channel_unavailable',reason:String(result.detail||result.error||'gmail_not_connected').slice(0,240),nextRetryAt:new Date(Date.now()+6*60*60_000).toISOString()});return;
    }
    // Once an external send call has been attempted, an ambiguous failure is never retried automatically.
    this.setAction(id,{status:'application_uncertain',reason:`email send outcome uncertain: ${String(result.detail||result.error||'unknown').slice(0,220)}`,recipient:route.email,nextCheckAt:new Date(Date.now()+60*60_000).toISOString()});
    this.event('lead_email_application_uncertain',{id,host});
  }

  maxBrowserlessPerCycle(){return Math.max(1,Math.min(200,Number(this.env.AUTONOMOS_BROWSERLESS_ACTIONER_MAX_PER_CYCLE||50)));}
  maxBrowserlessParallel(){return Math.max(1,Math.min(16,Number(this.env.AUTONOMOS_BROWSERLESS_ACTIONER_MAX_PARALLEL||8)));}
}

export function discoverEmailRoutes(html,baseUrl=''){
  const source=String(html||'');const candidates=[];
  for(const match of source.matchAll(/mailto:([^"'?#<>\s]+)/ig))pushEmailCandidate(candidates,decodeURIComponentSafe(match[1]),contextAround(source,match.index||0),baseUrl);
  for(const match of source.matchAll(EMAIL_RE))pushEmailCandidate(candidates,match[0],contextAround(source,match.index||0),baseUrl);
  return dedupeRoutes(candidates).sort((a,b)=>b.score-a.score);
}

export function discoverApplyLinks(html,baseUrl=''){
  const out=[];const source=String(html||'');
  for(const match of source.matchAll(HREF_RE)){
    const href=String(match[1]||'');const label=stripHtml(match[2]||'');
    if(!/apply|application|proposal|freelanc|project|job|hiring|careers?|contact/i.test(`${href} ${label}`))continue;
    try{const url=new URL(href,baseUrl).href;if(/^https?:\/\//i.test(url))out.push(url);}catch{}
  }
  return [...new Set(out)].slice(0,12);
}

function pushEmailCandidate(out,email,context,baseUrl){
  const normalized=String(email||'').trim().toLowerCase();if(!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(normalized))return;
  const local=normalized.split('@')[0];if(BAD_EMAIL_LOCAL.test(local))return;
  const ctx=stripHtml(context);if(!APPLY_CONTEXT.test(ctx))return;
  let score=10;
  if(/apply|application|proposal/i.test(ctx))score+=8;
  if(/freelanc|project|contract|job|hiring/i.test(ctx))score+=5;
  if(/jobs?|careers?|talent|recruit/i.test(local))score+=4;
  if(/support|hello|contact|info/i.test(local))score-=3;
  out.push({email:normalized,score,sourceUrl:String(baseUrl||'')});
}
function dedupeRoutes(rows){const map=new Map();for(const row of rows||[]){const key=String(row?.email||'').toLowerCase();if(!key)continue;const prev=map.get(key);if(!prev||Number(row.score||0)>Number(prev.score||0))map.set(key,row);}return [...map.values()];}

async function findGmailSendTool(env){
  const result=await composioSearch({query:'send email message',toolkit:'gmail',limit:20},env);
  if(!result.ok)return{ok:false,error:String(result.error||'gmail_tool_search_failed')};
  const ranked=(result.items||[]).map(item=>({item,score:scoreSendTool(item)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  const best=ranked[0]?.item;if(!best)return{ok:false,error:'gmail_send_tool_not_found'};
  return{ok:true,slug:best.slug,inputParameters:best.inputParameters||{}};
}
function scoreSendTool(item){const text=`${item?.slug||''} ${item?.name||''} ${item?.description||''}`.toUpperCase();if(/DRAFT/.test(text))return-10;let score=0;if(/SEND_EMAIL|SEND.*EMAIL/.test(text))score+=20;if(/SEND.*MESSAGE/.test(text))score+=8;if(/EMAIL/.test(text))score+=3;return score;}

export function buildEmailArgs(schema,to,subject,body){
  const props=schema?.properties||schema?.schema?.properties||{};const keys=Object.keys(props);if(!keys.length)return null;
  const args={};let hasTo=false,hasSubject=false,hasBody=false;
  for(const key of keys){
    const low=key.toLowerCase(),def=props[key]||{};
    if(!hasTo&&/(^to$|recipient|recipient_email|to_email|email_address)/.test(low)&&!/(cc|bcc|from)/.test(low)){args[key]=def.type==='array'?[to]:to;hasTo=true;continue;}
    if(!hasSubject&&/subject/.test(low)){args[key]=subject;hasSubject=true;continue;}
    if(!hasBody&&/(^body$|message_body|body_text|plain_text|content|message|text)/.test(low)&&!/html|snippet|preview/.test(low)){args[key]=body;hasBody=true;continue;}
    if(/is_html|html_enabled/.test(low))args[key]=false;
  }
  return hasTo&&hasSubject&&hasBody?args:null;
}

async function fetchPage(url){
  let response;
  try{response=await fetch(String(url),{redirect:'follow',headers:{accept:'text/html,application/xhtml+xml,text/plain;q=0.8','user-agent':'Mozilla/5.0 (compatible; AutonomOS-WorkHunter/15; +https://qonvexa.co)'},signal:AbortSignal.timeout(20_000)});}catch(error){return{ok:false,error:`fetch_network:${safeError(error)}`};}
  if(!response.ok)return{ok:false,error:`http_${response.status}`};
  const len=Number(response.headers.get('content-length')||0);if(len>MAX_PAGE_BYTES)return{ok:false,error:'page_too_large'};
  const type=String(response.headers.get('content-type')||'');if(type&&!/text|html|xhtml/i.test(type))return{ok:false,error:`unsupported_content_type:${type.slice(0,80)}`};
  const html=(await response.text()).slice(0,MAX_PAGE_BYTES);
  return{ok:true,html,text:stripHtml(html).slice(0,40_000),finalUrl:String(response.url||url)};
}
function stripHtml(value){return decodeEntities(String(value||'').replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ')).trim();}
function decodeEntities(value){return String(value||'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'");}
function contextAround(text,index,radius=320){return String(text||'').slice(Math.max(0,index-radius),Math.min(String(text||'').length,index+radius));}
function decodeURIComponentSafe(v){try{return decodeURIComponent(v);}catch{return v;}}
function hostname(url){try{return new URL(String(url)).hostname.toLowerCase().replace(/^www\./,'');}catch{return'';}}
function truthy(value,fallback='false'){return /^(1|true|yes|on)$/i.test(String(value??fallback));}
function safeError(error){return String(error?.message||error||'').slice(0,300);}
function now(){return new Date().toISOString();}
function backoffMs(attempt){return Math.min(24*60*60_000,Math.max(15*60_000,15*60_000*Math.pow(2,Math.min(6,Math.max(0,Number(attempt||1)-1)))));}
function maskEmail(email){const [local,domain]=String(email||'').split('@');return local&&domain?`${local.slice(0,2)}***@${domain}`:'redacted';}
async function pool(items,limit,worker){let index=0;const runners=Array.from({length:Math.min(limit,items.length)},async()=>{while(index<items.length){const item=items[index++];await worker(item);}});await Promise.allSettled(runners);}
