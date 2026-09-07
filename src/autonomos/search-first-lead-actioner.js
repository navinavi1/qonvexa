import { BrowserlessLeadActioner, discoverEmailRoutes, discoverApplyLinks } from './browserless-lead-actioner.js';
import { classifyOpportunity } from './capabilities.js';
import { tavilySearch } from './tavily-tool.js';

const AGGREGATOR_HOST=/(^|\.)(indeed\.com|ziprecruiter\.com|dailyremote\.com|remoterocketship\.com|remoteleads\.io|euremotejobs\.com|weworkremotely\.com|nodesk\.co)$/i;
const MAX_FETCH_BYTES=1_500_000;

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

      const capabilityText=`${String(lead.title||'')}\n${String(lead.snippet||'')}`.slice(0,6000);
      const capability=classifyOpportunity(this.toOpportunity(lead,capabilityText),{...this.capabilityContext(),hasBrowserTool:false});
      if(!capability.executable){
        this.setAction(id,{status:'needs_capability',missingTools:capability.missingTools||[],skill:capability.skill,nextRetryAt:new Date(Date.now()+6*60*60_000).toISOString()});
        this.event('searchfirst_needs_capability',{id,host,skill:capability.skill,missingTools:capability.missingTools||[]});return;
      }
      const payout=this.resolvePayout(lead,evidenceText);
      if(!payout.paid){this.setAction(id,{status:'payout_unverified',nextRetryAt:new Date(Date.now()+6*60*60_000).toISOString()});return;}

      let routes=[
        ...discoverEmailRoutes(page.html,page.finalUrl||lead.url),
        ...discoverEmailRoutes(searchFallback.html||'',lead.url)
      ];
      const candidateUrls=[...discoverApplyLinks(page.html,page.finalUrl||lead.url),...(searchFallback.urls||[])];
      for(const url of unique(candidateUrls).filter(url=>hostname(url)!==host||!AGGREGATOR_HOST.test(host)).slice(0,5)){
        const follow=await fetchPage(url);
        if(follow.ok)routes.push(...discoverEmailRoutes(follow.html,follow.finalUrl||url));
        if(routes.length>=3)break;
      }
      routes=rankRoutes(routes);
      const route=routes[0];
      if(!route){
        const reason=page.ok?'no explicit direct application email found':'aggregator/direct page blocked; search fallback found no explicit application email';
        this.setAction(id,{status:'no_direct_route',reason,nextRetryAt:new Date(Date.now()+12*60*60_000).toISOString(),payout,skill:capability.skill,searchFallbackUsed:Boolean(searchFallback.ok),directFetchError:page.error||''});
        this.event('lead_no_direct_route',{id,host,searchFallbackUsed:Boolean(searchFallback.ok),directFetchError:page.error||''});return;
      }

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

async function searchForOriginalApplication(lead,host,env){
  const title=String(lead?.title||'').replace(/["']/g,' ').replace(/\s+/g,' ').trim().slice(0,180);
  const category=String(lead?.category||'digital freelance').replace(/[^a-z0-9 -]/gi,' ').slice(0,80);
  const query=`"${title}" ${category} freelance contract apply proposal email -site:${host}`;
  const result=await tavilySearch(query,env);
  if(!result.ok)return{ok:false,text:'',html:'',urls:[],error:String(result.error||'search_failed')};
  const rows=(result.results||[]).slice(0,8);
  const text=rows.map(row=>`${row.title||''} ${row.snippet||''}`).join('\n').slice(0,25_000);
  // discoverEmailRoutes can safely parse plain emails in this synthetic HTML/text bundle.
  const html=rows.map(row=>`<section><a href="${escapeAttr(row.url||'')}">${escapeHtml(row.title||'')}</a><p>${escapeHtml(row.snippet||'')}</p></section>`).join('\n');
  const urls=rows.map(row=>String(row.url||'')).filter(url=>/^https?:\/\//i.test(url));
  return{ok:true,text,html,urls};
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
function unique(rows){return[...new Set((rows||[]).filter(Boolean))];}
function hostname(url){try{return new URL(String(url)).hostname.toLowerCase().replace(/^www\./,'');}catch{return'';}}
function safeError(error){return String(error?.message||error||'').slice(0,300);}
function now(){return new Date().toISOString();}
function backoffMs(attempt){return Math.min(12*60*60_000,Math.max(10*60_000,10*60_000*Math.pow(2,Math.min(6,Math.max(0,Number(attempt||1)-1)))));}
function stripHtml(value){return decodeEntities(String(value||'').replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ')).trim();}
function decodeEntities(value){return String(value||'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'");}
function escapeHtml(value){return String(value||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function escapeAttr(value){return escapeHtml(value).replace(/'/g,'&#39;');}
