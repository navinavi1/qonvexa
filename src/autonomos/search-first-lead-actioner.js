import { BrowserlessLeadActioner, discoverEmailRoutes, discoverApplyLinks } from './browserless-lead-actioner.js';
import { classifyOpportunity } from './capabilities.js';
import { tavilySearch } from './tavily-tool.js';

const AGGREGATOR_HOST=/(^|\.)(indeed\.com|ziprecruiter\.com|dailyremote\.com|remoterocketship\.com|remoteleads\.io|euremotejobs\.com|weworkremotely\.com|nodesk\.co)$/i;
const MAX_FETCH_BYTES=1_500_000;
const TEXTUAL_SKILLS=new Set(['translation','copywriting','web-research','data-transform','document-generation','code-analysis','app-automation','general-digital']);
const MEDIA_TERM=/\b(?:logo design|podcast cover|cover art|illustration|brand identity|graphic design|figma design|canva design|video edit(?:ing)?|motion graphics|3d render(?:ing)?)\b/ig;
const BAD_ROUTE_TLD=/\.(?:png|jpe?g|gif|svg|webp|ico|css|js|map)$/i;
const BAD_ROUTE_DOMAIN=/^(?:example\.(?:com|org|net)|2x\.png|localhost)$/i;

export class SearchFirstLeadActioner extends BrowserlessLeadActioner{
  shouldBrowserlessInspect(lead){
    const action=this.state?.actions?.[lead?.id];
    if(String(action?.status||'')==='needs_capability'){
      const next=Date.parse(String(action?.nextRetryAt||0));
      return !Number.isFinite(next)||next<=Date.now();
    }
    return super.shouldBrowserlessInspect(lead);
  }

  async inspectAndActBrowserless(lead){
    const id=String(lead?.id||''),host=hostname(lead?.url);if(!id||!host)return;
    this.setAction(id,{status:'inspecting_direct',host,title:lead.title,url:lead.url,category:lead.category,lastAttemptAt:now(),attempts:Number(this.state.actions?.[id]?.attempts||0)+1,error:''});
    try{
      let page={ok:false,html:'',text:'',finalUrl:String(lead.url||''),error:''};
      if(!AGGREGATOR_HOST.test(host))page=await fetchPage(lead.url);
      const searchFallback=!page.ok||AGGREGATOR_HOST.test(host)
        ? await searchForOriginalApplication(lead,host,this.env)
        : {ok:true,text:'',html:'',urls:[]};

      const evidenceText=`${lead.title||''}\n${lead.snippet||''}\n${page.text||''}\n${searchFallback.text||''}`.slice(0,40_000);
      this.state.stats.inspected=Number(this.state.stats.inspected||0)+1;
      const disposition=this.inspectPage(evidenceText,lead);
      if(disposition){this.archive(id,disposition.status,disposition.reason);return;}

      const capability=classifyLeadCapability(lead,this.capabilityContext());
      if(!capability.executable){
        this.setAction(id,{status:'needs_capability',missingTools:capability.missingTools||[],skill:capability.skill,nextRetryAt:new Date(Date.now()+60*60_000).toISOString()});
        this.event('searchfirst_needs_capability',{id,host,skill:capability.skill,missingTools:capability.missingTools||[]});return;
      }
      const payout=this.resolvePayout(lead,evidenceText);
      if(!payout.paid){this.setAction(id,{status:'payout_unverified',nextRetryAt:new Date(Date.now()+6*60*60_000).toISOString()});return;}

      // Only trust emails parsed from fetched pages. Search snippets are discovery hints and
      // can contain example addresses or image asset names such as avatar@2x.png.
      let routes=[...discoverEmailRoutes(page.html,page.finalUrl||lead.url)];
      const candidateUrls=[...discoverApplyLinks(page.html,page.finalUrl||lead.url),...(searchFallback.urls||[])];
      for(const url of unique(candidateUrls).filter(url=>hostname(url)!==host||!AGGREGATOR_HOST.test(host)).slice(0,6)){
        const follow=await fetchPage(url);
        if(follow.ok)routes.push(...discoverEmailRoutes(follow.html,follow.finalUrl||url));
        if(routes.filter(validRoute).length>=3)break;
      }
      if(!routes.filter(validRoute).length){
        const contactSearch=await searchForExplicitApplicationContact(lead,host,this.env);
        if(contactSearch.ok){
          for(const url of (contactSearch.urls||[]).slice(0,6)){
            const follow=await fetchPage(url);
            if(follow.ok)routes.push(...discoverEmailRoutes(follow.html,follow.finalUrl||url));
            if(routes.filter(validRoute).length>=3)break;
          }
        }
      }
      routes=rankRoutes(routes.filter(validRoute));
      const route=routes[0];
      if(!route){
        const reason=page.ok?'no verified direct application email found':'aggregator/direct page blocked; search fallback found no verified application email';
        this.setAction(id,{status:'no_direct_route',reason,nextRetryAt:new Date(Date.now()+6*60*60_000).toISOString(),payout,skill:capability.skill,contactSearchAttempted:true,searchFallbackUsed:Boolean(searchFallback.ok),directFetchError:page.error||''});
        this.event('lead_no_direct_route',{id,host,searchFallbackUsed:Boolean(searchFallback.ok),directFetchError:page.error||''});return;
      }

      this.event('explicit_application_route_found',{id,host,recipientDomain:String(route.email||'').split('@')[1]||'',score:Number(route.score||0)});
      const proposal=await this.makeProposal(lead,evidenceText,capability,payout);
      const subject=`Application: ${String(lead.title||'Paid digital project').replace(/\s+/g,' ').slice(0,120)} — AutonomOS`;
      const body=[proposal,'',`Job: ${String(lead.title||'').slice(0,220)}`,`Source: ${String(lead.url||'')}`,'','AutonomOS is an AI-assisted digital-services agency. We only accept work we can execute and verify with our available tools; no human identity or credentials are being misrepresented.'].join('\n').slice(0,7000);
      await this.sendApplicationEmailOnce({id,host,lead,route,subject,body,proposal,payout,capability});
    }catch(error){
      this.setAction(id,{status:'direct_action_failed',error:safeError(error),nextRetryAt:new Date(Date.now()+backoffMs(this.state.actions?.[id]?.attempts||1)).toISOString()});
      this.event('searchfirst_action_failed',{id,host,error:safeError(error)});
    }finally{this.persist();}
  }
}

function classifyLeadCapability(lead,context){
  const rich=`${String(lead?.title||'')}\n${String(lead?.snippet||'')}`.slice(0,6000);
  const first=classifyOpportunity(toCapabilityOpportunity(lead,rich),{...context,hasBrowserTool:false});
  const missing=Array.isArray(first?.missingTools)?first.missingTools.map(String):[];
  if(first.executable||missing.length!==1||missing[0]!=='design_media_tool'||!TEXTUAL_SKILLS.has(String(first.skill||''))||looksLikeRealMediaLead(lead))return first;
  // Strip cross-category marketplace navigation such as "Writing | Graphic Design |
  // Translation" before the second classification. Actual media projects are caught above.
  const cleanedTitle=String(lead?.title||'').replace(MEDIA_TERM,' ').replace(/\s+/g,' ').trim();
  const narrow=`${String(lead?.category||'')}\n${cleanedTitle}`.slice(0,1800);
  return classifyOpportunity(toCapabilityOpportunity({...lead,title:cleanedTitle},narrow),{...context,hasBrowserTool:false});
}
function toCapabilityOpportunity(lead,description){return{source:'global-web',externalId:String(lead?.id||''),title:String(lead?.title||'Paid digital work'),description,category:String(lead?.category||'general-digital'),budgetUsd:Number(lead?.amountUsd||0),currency:String(lead?.payoutCurrency||'USD'),network:lead?.cryptoPayout?'crypto':'fiat',escrowed:Boolean(lead?.payoutVerified),claimMode:'competitive_submission',status:'open',url:String(lead?.url||''),skills:[]};}
function looksLikeRealMediaLead(lead){
  const category=String(lead?.category||'').toLowerCase();if(/^(?:graphic-design|ui-ux|video|audio|design)$/.test(category))return true;
  const title=String(lead?.title||'').toLowerCase();
  return /\b(?:design|create|make|edit|produce|render)\b.{0,35}\b(?:logo|illustration|brand identity|figma|canva|video|motion graphics|3d|cover art)\b|\b(?:logo|graphic|figma|video|motion|3d)\s+(?:designer|editor|artist|project|needed|wanted)\b/i.test(title);
}
function validRoute(row){
  const email=String(row?.email||'').trim().toLowerCase();const parts=email.split('@');if(parts.length!==2)return false;
  const [local,domain]=parts;if(!local||!domain||BAD_ROUTE_DOMAIN.test(domain)||BAD_ROUTE_TLD.test(domain))return false;
  if(/^(?:test|example|sample|demo|user|name|email)$/i.test(local))return false;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email);
}

async function searchForOriginalApplication(lead,host,env){
  const title=cleanTitle(lead?.title);
  const category=String(lead?.category||'digital freelance').replace(/[^a-z0-9 -]/gi,' ').slice(0,80);
  const query=`"${title}" ${category} freelance contract apply proposal email -site:${host}`;
  return searchBundle(query,env);
}

async function searchForExplicitApplicationContact(lead,host,env){
  const title=cleanTitle(lead?.title);
  const sourceHint=companyHint(lead,host);
  const category=String(lead?.category||'freelance').replace(/[^a-z0-9 -]/gi,' ').slice(0,60);
  const queries=[
    `"${title}" ${sourceHint} ${category} "apply by email" OR "send proposal" OR "application email" -site:${host}`,
    `"${title}" ${sourceHint} (jobs@ OR careers@ OR hiring@ OR talent@ OR freelance@ OR projects@) -site:${host}`,
    `${sourceHint} ${category} freelancer contractor "send your proposal" email -site:${host}`
  ];
  let text='',urls=[];let ok=false;
  for(const query of queries){
    const result=await searchBundle(query,env);
    if(!result.ok)continue;ok=true;text+=`\n${result.text}`;urls.push(...result.urls);
  }
  return{ok,text:text.slice(0,35_000),urls:unique(urls).slice(0,16)};
}

async function searchBundle(query,env){
  const result=await tavilySearch(query,env);
  if(!result.ok)return{ok:false,text:'',urls:[],error:String(result.error||'search_failed')};
  const rows=(result.results||[]).slice(0,8);
  const text=rows.map(row=>`${row.title||''} ${row.snippet||''}`).join('\n').slice(0,25_000);
  const urls=rows.map(row=>String(row.url||'')).filter(url=>/^https?:\/\//i.test(url));
  return{ok:true,text,urls};
}

async function fetchPage(url){
  let response;
  try{response=await fetch(String(url),{redirect:'follow',headers:{accept:'text/html,application/xhtml+xml,text/plain;q=0.8','user-agent':'Mozilla/5.0 (compatible; AutonomOS-WorkHunter/15; +https://qonvexa.co)'},signal:AbortSignal.timeout(12_000)});}catch(error){return{ok:false,error:`fetch_network:${safeError(error)}`,html:'',text:'',finalUrl:String(url||'')};}
  if(!response.ok)return{ok:false,error:`http_${response.status}`,html:'',text:'',finalUrl:String(response.url||url)};
  const len=Number(response.headers.get('content-length')||0);if(len>MAX_FETCH_BYTES)return{ok:false,error:'page_too_large',html:'',text:'',finalUrl:String(response.url||url)};
  const type=String(response.headers.get('content-type')||'');if(type&&!/text|html|xhtml/i.test(type))return{ok:false,error:`unsupported_content_type:${type.slice(0,70)}`,html:'',text:'',finalUrl:String(response.url||url)};
  const html=(await response.text()).slice(0,MAX_FETCH_BYTES);
  return{ok:true,html,text:stripHtml(html).slice(0,35_000),finalUrl:String(response.url||url),error:''};
}
function rankRoutes(rows){const map=new Map();for(const row of rows||[]){const email=String(row?.email||'').toLowerCase();if(!email)continue;const prev=map.get(email);if(!prev||Number(row?.score||0)>Number(prev?.score||0))map.set(email,row);}return[...map.values()].sort((a,b)=>Number(b.score||0)-Number(a.score||0));}
function cleanTitle(value){return String(value||'').replace(/["']/g,' ').replace(/\s+/g,' ').trim().slice(0,180);}
function companyHint(lead,host){
  const title=cleanTitle(lead?.title);const parts=title.split(/\s[-–—|]\s/).map(x=>x.trim()).filter(Boolean);
  if(parts.length>1)return `"${parts[parts.length-1].slice(0,100)}"`;
  const base=String(host||'').split('.')[0].replace(/[-_]+/g,' ');return base?`"${base.slice(0,80)}"`:'';
}
function unique(rows){return[...new Set((rows||[]).filter(Boolean))];}
function hostname(url){try{return new URL(String(url)).hostname.toLowerCase().replace(/^www\./,'');}catch{return'';}}
function safeError(error){return String(error?.message||error||'').slice(0,300);}
function now(){return new Date().toISOString();}
function backoffMs(attempt){return Math.min(12*60*60_000,Math.max(10*60_000,10*60_000*Math.pow(2,Math.min(6,Math.max(0,Number(attempt||1)-1)))));}
function stripHtml(value){return decodeEntities(String(value||'').replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ')).trim();}
function decodeEntities(value){return String(value||'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'");}
