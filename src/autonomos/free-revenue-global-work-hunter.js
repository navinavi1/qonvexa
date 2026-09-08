import { RevenueGlobalWorkHunter } from './revenue-global-work-hunter.js';

const SOURCE_CONFIG = [
  {name:'freelancer-public-api',minIntervalMs:10*60_000,load:loadFreelancer},
  {name:'issuehunt-funded',minIntervalMs:60*60_000,load:loadIssueHunt},
  {name:'boss-open-bounties',minIntervalMs:60*60_000,load:loadBoss},
  {name:'jobicy',minIntervalMs:60*60_000,load:loadJobicy},
  {name:'remoteok',minIntervalMs:60*60_000,load:loadRemoteOk},
  {name:'weworkremotely',minIntervalMs:60*60_000,load:loadWwr},
  {name:'remotive',minIntervalMs:6*60*60_000,load:loadRemotive},
  {name:'github-bounties',minIntervalMs:6*60*60_000,load:loadGithubBounties}
];

// Zero-paid-dependency discovery. These sources are public/free-to-query and do not use
// Tavily, Firecrawl or Browserbase. The parent class is retained for TaskForce lifecycle
// logic only; its paid-search searchWorldwide() implementation is deliberately not called.
export class FreeRevenueGlobalWorkHunter extends RevenueGlobalWorkHunter {
  async searchWorldwide(){
    this.state.freeSources=this.state.freeSources||{};
    let newLeads=0,polled=0,skipped=0,failed=0,rowsSeen=0;
    const now=Date.now();
    for(const source of SOURCE_CONFIG){
      const state=this.state.freeSources[source.name]||{};const last=Date.parse(String(state.lastPollAt||0));
      if(Number.isFinite(last)&&now-last<source.minIntervalMs){skipped++;continue;}polled++;
      try{
        const rows=await source.load(this.env);rowsSeen+=rows.length;let sourceNew=0;
        for(const row of rows){
          const lead=this.classifyWebLead(row,`free:${source.name}`);if(!lead||this.state.ignored?.[lead.id])continue;
          if(lead.terminal){this.archiveLead(lead.id,'listing_terminal',lead);continue;}
          if(lead.humanGate){this.archiveLead(lead.id,'protected_registration_or_identity_step_required',lead);continue;}
          const prev=this.state.leads?.[lead.id];if(!prev){newLeads++;sourceNew++;}
          const directRouteHint=/\b(apply|application|send (?:your )?(?:proposal|cv|resume)|email|contact|contract|freelance|claim|bounty|bid)\b/i.test(`${row.title||''} ${row.snippet||''}`);
          this.state.leads[lead.id]={...prev,...lead,directRouteHint,freeSource:source.name,firstSeenAt:prev?.firstSeenAt||new Date().toISOString(),lastSeenAt:new Date().toISOString()};
        }
        this.state.freeSources[source.name]={lastPollAt:new Date().toISOString(),lastSuccessAt:new Date().toISOString(),lastCount:rows.length,lastNew:sourceNew,error:''};
        this.event('free_job_source_polled',{source:source.name,rows:rows.length,newLeads:sourceNew});
      }catch(error){failed++;this.state.freeSources[source.name]={...state,lastPollAt:new Date().toISOString(),error:String(error?.message||error).slice(0,220)};this.event('free_job_source_failed',{source:source.name,error:String(error?.message||error).slice(0,220)});}
    }
    this.persist();return{newLeads,freeSources:{polled,skipped,failed,rowsSeen},directNewLeads:0,directQueryPool:0};
  }
}

async function loadFreelancer(){
  const data=await getJson('https://www.freelancer.com/api/projects/0.1/projects/active/?limit=100&compact=true&full_description=true');
  const projects=Array.isArray(data?.result?.projects)?data.result.projects:[];
  return projects.map(p=>{
    const budget=p?.budget||{};const currency=String(p?.currency?.code||p?.currency?.sign||'USD');const min=Number(budget?.minimum||0),max=Number(budget?.maximum||0);
    const raw=String(p?.seo_url||'').replace(/^\/+|\/+$/g,'');const url=raw?`https://www.freelancer.com/projects/${raw}`:`https://www.freelancer.com/projects/${p?.id||''}`;
    return{title:String(p?.title||''),url,score:2,snippet:cleanHtml(`Freelancer paid project. Budget ${min}${max?`-${max}`:''} ${currency}. ${p?.preview_description||p?.description||''} Apply/bid on the explicit project listing.`).slice(0,6000)};
  }).filter(row=>validRow(row)&&/\d/.test(row.snippet));
}

async function loadIssueHunt(){
  const html=await getHtml('https://oss.issuehunt.io/issues?page=1&sortBy=-totalAmount');const out=[],seen=new Set();
  const links=[...html.matchAll(/href=["']([^"']*\/r\/[^"']+\/issues\/\d+)["']/gi)];
  for(const m of links){const url=new URL(m[1],'https://oss.issuehunt.io').toString();if(seen.has(url))continue;seen.add(url);const start=Math.max(0,(m.index||0)-1200),end=Math.min(html.length,(m.index||0)+1800);const chunk=cleanHtml(html.slice(start,end));const money=chunk.match(/\$\s?([0-9][0-9,.]*)/);if(!money)continue;const title=extractTitle(chunk)||`IssueHunt funded issue $${money[1]}`;out.push({title,url,score:2,snippet:`IssueHunt funded open-source task. ${chunk}`.slice(0,6000)});if(out.length>=100)break;}
  return out.filter(validRow);
}

async function loadBoss(){
  const html=await getHtml('https://www.boss.dev/issues/open');const out=[],seen=new Set();
  for(const m of html.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/g)){
    const url=m[0];if(seen.has(url))continue;seen.add(url);const start=Math.max(0,(m.index||0)-1000),end=Math.min(html.length,(m.index||0)+1600);const chunk=cleanHtml(html.slice(start,end));const money=chunk.match(/(?:\$|€|£)\s?([0-9][0-9,.]*)/);if(!money)continue;out.push({title:extractTitle(chunk)||`BOSS GitHub bounty ${m[1]}/${m[2]}#${m[3]}`,url,score:2,snippet:`BOSS funded GitHub bounty. ${chunk}`.slice(0,6000)});if(out.length>=100)break;}
  return out.filter(validRow);
}

async function loadJobicy(){
  const data=await getJson('https://jobicy.com/api/v2/remote-jobs?count=200');const jobs=Array.isArray(data?.jobs)?data.jobs:[];
  return jobs.map(job=>{const salary=[job?.salaryMin,job?.salaryMax].filter(v=>Number(v)>0).join('-');const currency=String(job?.salaryCurrency||'').trim();const type=Array.isArray(job?.jobType)?job.jobType.join(' '):String(job?.jobType||'');return{title:String(job?.jobTitle||''),url:String(job?.url||''),score:1,snippet:cleanHtml(`${job?.companyName||''} ${type} ${job?.jobGeo||''} ${salary}${salary&&currency?' '+currency:''} ${job?.jobExcerpt||''} ${job?.jobDescription||''}`).slice(0,6000)};}).filter(validRow);
}
async function loadRemoteOk(){const data=await getJson('https://remoteok.com/api');const jobs=Array.isArray(data)?data.filter(row=>row&&typeof row==='object'&&row.position):[];return jobs.slice(0,250).map(job=>{const salary=Number(job?.salary_min||0)>0?`$${job.salary_min}${Number(job?.salary_max||0)>0?`-$${job.salary_max}`:''}`:'';return{title:String(job?.position||''),url:String(job?.url||job?.apply_url||''),score:1,snippet:cleanHtml(`${job?.company||''} ${job?.location||''} ${salary} ${(job?.tags||[]).join(' ')} ${job?.description||''}`).slice(0,6000)};}).filter(validRow);}
async function loadRemotive(){const data=await getJson('https://remotive.com/api/remote-jobs');const jobs=Array.isArray(data?.jobs)?data.jobs:[];return jobs.slice(0,300).map(job=>({title:String(job?.title||''),url:String(job?.url||''),score:1,snippet:cleanHtml(`${job?.company_name||''} ${job?.candidate_required_location||''} ${job?.job_type||''} ${job?.salary||''} ${job?.description||''}`).slice(0,6000)})).filter(validRow);}
async function loadWwr(){const xml=await getText('https://weworkremotely.com/remote-jobs.rss');const items=[...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(match=>match[0]);return items.slice(0,250).map(item=>({title:xmlValue(item,'title'),url:xmlValue(item,'link'),score:1,snippet:cleanHtml(`${xmlValue(item,'description')} ${xmlValue(item,'category')}`).slice(0,6000)})).filter(validRow);}
async function loadGithubBounties(env={}){
  const queries=['is:issue is:open bounty','is:issue is:open "paid" reward','is:issue is:open USDC bounty','is:issue is:open USDT bounty','is:issue is:open label:"💎 Bounty"'];const out=[],seen=new Set();
  for(const query of queries){const headers={accept:'application/vnd.github+json','user-agent':'AutonomOS-FreeRevenueHunter/1.0'};const token=String(env.GITHUB_TOKEN||'').trim();if(token)headers.authorization=`Bearer ${token}`;const u=new URL('https://api.github.com/search/issues');u.searchParams.set('q',query);u.searchParams.set('sort','updated');u.searchParams.set('order','desc');u.searchParams.set('per_page','30');const r=await fetch(u,{headers,signal:AbortSignal.timeout(20_000)});if(!r.ok)throw new Error(`github_issues_http_${r.status}`);const data=await r.json();for(const issue of Array.isArray(data?.items)?data.items:[]){const url=String(issue?.html_url||'');if(!url||seen.has(url)||issue?.pull_request)continue;seen.add(url);const labels=(issue?.labels||[]).map(x=>typeof x==='string'?x:String(x?.name||'')).join(' ');const body=String(issue?.body||'');const text=`${issue?.title||''} ${labels} ${body}`;if(!/(?:\$\s?\d|\b\d+(?:\.\d+)?\s?(?:USD|USDC|USDT|DAI|ETH|SOL|BTC)\b)/i.test(text))continue;out.push({title:String(issue?.title||'GitHub paid bounty'),url,score:1,snippet:cleanHtml(`GitHub issue bounty ${labels} ${body}`).slice(0,6000)});}}
  return out.slice(0,160).filter(validRow);
}

async function getJson(url){const response=await fetch(url,{headers:{accept:'application/json','user-agent':'AutonomOS-FreeRevenueHunter/1.0 (+https://qonvexa.co)'},signal:AbortSignal.timeout(20_000)});if(!response.ok)throw new Error(`http_${response.status}`);return response.json();}
async function getText(url){const response=await fetch(url,{headers:{accept:'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5','user-agent':'AutonomOS-FreeRevenueHunter/1.0 (+https://qonvexa.co)'},signal:AbortSignal.timeout(20_000)});if(!response.ok)throw new Error(`http_${response.status}`);return response.text();}
async function getHtml(url){const response=await fetch(url,{redirect:'follow',headers:{accept:'text/html,application/xhtml+xml','user-agent':'Mozilla/5.0 (compatible; AutonomOS-FreeRevenueHunter/1.0; +https://qonvexa.co)'},signal:AbortSignal.timeout(20_000)});if(!response.ok)throw new Error(`http_${response.status}`);return String(await response.text()).slice(0,2_000_000);}
function validRow(row){return /^https?:\/\//i.test(String(row?.url||''))&&String(row?.title||'').trim().length>2;}
function xmlValue(item,tag){const match=String(item||'').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,'i'));return decodeXml(String(match?.[1]||'').replace(/^<!\[CDATA\[|\]\]>$/g,''));}
function extractTitle(chunk){const text=String(chunk||'').replace(/\s+/g,' ').trim();const parts=text.split(/(?:Funded|Fixed Price|Hourly|\$\d|€\d|£\d)/i).map(x=>x.trim()).filter(x=>x.length>=8&&x.length<=220);return parts.at(-1)?.slice(-180)||'';}
function cleanHtml(value){return decodeXml(String(value||'').replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ')).trim();}
function decodeXml(value){return String(value||'').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&nbsp;/gi,' ');}
