import { minimumJobPayoutUsd } from './payout-floor.js';
import { GlobalWorkHunter } from './global-work-hunter.js';
import { freeWebSearch } from './free-web-tool.js';
import { classifyOpportunity } from './capabilities.js';

// Keep the per-cycle request count bounded, but rotate through a much wider set of
// executable digital-service niches. The goal is breadth without burning through a
// search provider quota by simply increasing request frequency.
const DIRECT_ROUTE_QUERIES=[
  'worldwide freelance translation project "apply by email" paid',
  'worldwide freelance localization transcreation "send proposal" paid',
  'worldwide freelance proofreading editing "send proposal" paid project',
  'worldwide subtitle caption transcription freelancer "apply by email" paid',
  'worldwide freelance copywriter "send your proposal" paid project',
  'worldwide freelance blog writer article writer "apply by email" contract',
  'worldwide technical writer documentation contractor "email your proposal"',
  'worldwide SOP knowledge base writer freelancer "send proposal"',
  'worldwide resume CV document formatting freelancer "apply by email"',
  'worldwide freelance researcher "send proposal" paid project',
  'worldwide market research competitor research freelancer "apply by email"',
  'worldwide lead generation web research freelancer "send proposal"',
  'worldwide data entry freelancer "apply by email" paid project',
  'worldwide spreadsheet excel google sheets cleanup freelancer "send proposal"',
  'worldwide csv json data cleaning freelancer "apply by email"',
  'worldwide public web scraping data extraction freelancer "send proposal"',
  'worldwide python freelancer bug fix script "email your proposal" contract',
  'worldwide javascript typescript node freelancer "send proposal" project',
  'worldwide react nextjs frontend freelancer "apply by email" project',
  'worldwide backend API integration freelancer "send proposal" contract',
  'worldwide software testing QA bug report freelancer "apply by email"',
  'worldwide github issue bug bounty paid developer apply',
  'worldwide open source paid issue bounty developer',
  'worldwide website developer freelancer "apply by email" project',
  'worldwide wordpress freelancer "send proposal" project',
  'worldwide shopify woocommerce freelancer "send proposal" project',
  'worldwide webflow cms freelancer "apply by email" contract',
  'worldwide landing page implementation freelancer "send proposal"',
  'worldwide automation freelancer n8n zapier make "send proposal"',
  'worldwide API webhook integration automation freelancer "apply by email"',
  'worldwide CRM automation hubspot airtable freelancer "send proposal"',
  'worldwide no code airtable notion bubble freelancer "apply by email"',
  'worldwide AI workflow prompt engineering chatbot freelancer "send proposal"',
  'worldwide RAG LLM automation freelancer "apply by email" project',
  'worldwide SEO audit keyword research freelancer "email proposal" paid project',
  'worldwide on page SEO content optimization freelancer "send proposal"',
  'worldwide email marketing freelancer contractor "apply by email"',
  'worldwide ecommerce product listing catalog freelancer "send proposal"',
  'worldwide shopify product catalog cleanup freelancer "apply by email"',
  'worldwide analytics reporting dashboard freelancer "send proposal"',
  'worldwide data visualization reporting freelancer "apply by email"',
  'worldwide virtual assistant freelancer "apply by email" contract',
  'worldwide operations assistant remote contractor "send proposal"',
  'worldwide customer support email chat contractor "send proposal" remote',
  'worldwide community moderation support contractor "apply by email"',
  'worldwide presentation powerpoint pitch deck content freelancer "send proposal"',
  'worldwide business document proposal formatting freelancer "apply by email"',
  'worldwide product description ecommerce copywriter "send proposal"',
  'worldwide social media copy content calendar freelancer "apply by email"',
  'worldwide research assistant data collection contractor "send proposal"',
  'worldwide website content migration CMS freelancer "apply by email"',
  'worldwide accessibility audit website freelancer "send proposal"',
  'worldwide API documentation developer docs freelancer "apply by email"',
  'worldwide database cleanup SQL freelancer "send proposal"',
  'worldwide data annotation labeling remote freelance paid project',
  'worldwide AI evaluation prompt testing freelance paid project',
  'worldwide remote microtask digital project paid USD EUR freelancer',
  'worldwide remote paid bounty translation writing coding data USDC USDT',
  'worldwide crypto bounty developer writer researcher USDT USDC apply',
  'worldwide autonomous agent paid task API USDC USDT',
  'freelancer wanted remote project paid "contact" "proposal"',
  'contractor wanted remote digital project "send proposal" paid',
  'independent contractor remote project "apply by email" digital',
  'small business needs freelancer remote project "email proposal"'
];

const ACTIVE_APPLICATION_STATUSES=new Set(['PENDING','APPLIED','ACCEPTED','IN_PROGRESS','WORKING','SUBMITTED','PAID_OR_APPROVED']);
const TERMINAL_APPLICATION_STATUSES=new Set(['REJECTED','NOT_ACCEPTING']);

export class RevenueGlobalWorkHunter extends GlobalWorkHunter{
  async searchWorldwide(){
    const broad=await super.searchWorldwide();
    const perCycle=Math.max(1,Math.min(8,Number(this.env.AUTONOMOS_DIRECT_QUERIES_PER_CYCLE||4)));
    let cursor=Number(this.state.directQueryCursor||0)%DIRECT_ROUTE_QUERIES.length,directNewLeads=0;
    for(let i=0;i<perCycle;i++){
      const query=DIRECT_ROUTE_QUERIES[(cursor+i)%DIRECT_ROUTE_QUERIES.length];
      const result=await freeWebSearch(query,this.env);
      if(!result.ok){this.event('direct_route_search_failed',{query,error:result.error||''});continue;}
      for(const row of result.results||[]){
        const url=String(row?.url||'').trim();if(!/^https?:\/\//i.test(url))continue;
        const lead=this.classifyWebLead(row,query);if(!lead)continue;
        if(this.state.ignored?.[lead.id])continue;
        if(lead.terminal){this.archiveLead(lead.id,'listing_terminal',lead);continue;}
        if(lead.humanGate){this.archiveLead(lead.id,'protected_registration_or_identity_step_required',lead);continue;}
        const prev=this.state.leads?.[lead.id];
        if(!prev)directNewLeads++;
        this.state.leads[lead.id]={...prev,...lead,directRouteHint:true,firstSeenAt:prev?.firstSeenAt||new Date().toISOString(),lastSeenAt:new Date().toISOString()};
      }
    }
    this.state.directQueryCursor=(cursor+perCycle)%DIRECT_ROUTE_QUERIES.length;
    this.persist();
    if(directNewLeads)this.event('direct_route_leads_found',{newLeads:directNewLeads,perCycle,queryPool:DIRECT_ROUTE_QUERIES.length});
    return{...broad,newLeads:Number(broad?.newLeads||0)+directNewLeads,directNewLeads,directQueryPool:DIRECT_ROUTE_QUERIES.length};
  }

  async pollTaskForce(credential){
    const headers={accept:'application/json','x-api-key':credential.apiKey,authorization:credential.apiKey,'user-agent':'AutonomOS-RevenueHunter/3.0'};
    const stats={open:0,applied:0,eligible:0,alreadyApplied:0,blockedCapability:0,belowFloor:0,retryDeferred:0,applyFailed:0,notAccepting:0};
    try{
      const r=await fetch('https://task-force.app/api/agent/tasks?status=ACTIVE&limit=100',{headers,signal:AbortSignal.timeout(15000)});
      const data=await safeJson(r);
      if(!r.ok){this.event('taskforce_tasks_failed',{status:r.status,error:publicError(data)});return stats;}
      const rows=arrayFrom(data,['tasks','items','data']);
      const maxApply=Math.max(1,Math.min(50,Number(this.env.AUTONOMOS_TASKFORCE_MAX_APPLY_PER_CYCLE||12)));
      const minPayout=minimumJobPayoutUsd(this.env);
      const retryMs=Math.max(60_000,Number(this.env.AUTONOMOS_TASKFORCE_APPLY_RETRY_MS||15*60_000));
      for(const raw of rows){
        const task=this.normalizeTaskForceTask(raw);if(!task)continue;stats.open++;
        const capability=classifyTaskForRevenue(task,this.capabilityContext());
        const key=task.externalId;
        this.state.taskforce.tasks[key]={...task,capability:{skill:capability.skill,executable:capability.executable,missingTools:capability.missingTools||[]},observedAt:new Date().toISOString()};
        if(!credential.verified||!capability.executable){stats.blockedCapability++;continue;}
        if(Number(task.budgetUsd||0)<minPayout){stats.belowFloor++;continue;}
        stats.eligible++;
        if(stats.applied>=maxApply)continue;
        const prior=this.state.taskforce.applications[key];
        if(prior){
          const status=String(prior.status||'').toUpperCase();
          if(ACTIVE_APPLICATION_STATUSES.has(status)||TERMINAL_APPLICATION_STATUSES.has(status)){stats.alreadyApplied++;continue;}
          if(status==='APPLY_FAILED'){
            const due=Date.parse(String(prior.nextRetryAt||''))||((Date.parse(String(prior.at||prior.updatedAt||0))||Date.now())+retryMs);
            if(due>Date.now()){stats.retryDeferred++;continue;}
          }else{stats.alreadyApplied++;continue;}
        }
        const result=await this.applyTaskForce(task,capability,credential);
        if(result.ok){stats.applied++;continue;}
        const failed=this.state.taskforce.applications[key];
        if(failed&&/task is not accepting applications|not accepting applications/i.test(String(failed.error||''))){
          failed.status='not_accepting';failed.archivedAt=new Date().toISOString();delete failed.nextRetryAt;stats.notAccepting++;
          this.event('taskforce_listing_not_accepting',{taskId:key});continue;
        }
        stats.applyFailed++;
        if(failed&&String(failed.status||'').toLowerCase()==='apply_failed')failed.nextRetryAt=new Date(Date.now()+retryMs).toISOString();
      }
      this.persist();
      this.event('taskforce_apply_diagnostics',stats);
      return stats;
    }catch(error){this.event('taskforce_tasks_failed',{error:String(error?.message||error).slice(0,220)});return stats;}
  }
}

function classifyTaskForRevenue(task,context){
  const first=classifyOpportunity(task,context);
  const missing=Array.isArray(first?.missingTools)?first.missingTools.map(String):[];
  if(first.executable||missing.length!==1||missing[0]!=='design_media_tool'||looksLikeRealMediaTask(task))return first;
  return classifyOpportunity({...task,description:`${String(task?.title||'')} ${String(task?.category||'')}`},context);
}
function looksLikeRealMediaTask(task){
  const scope=`${String(task?.category||'')} ${String(task?.title||'')}`.toLowerCase();
  return /\b(graphic[- ]design|logo|illustration|figma|canva|video edit|motion graphics|3d render|podcast cover|cover art|ui\/?ux|website design)\b/i.test(scope);
}
function arrayFrom(value,keys=[]){if(Array.isArray(value))return value;for(const key of keys){const v=value?.[key];if(Array.isArray(v))return v;if(v&&typeof v==='object'){for(const inner of ['items','tasks','data'])if(Array.isArray(v?.[inner]))return v[inner];}}return[];}
async function safeJson(response){try{return await response.json();}catch{return{};}}
function publicError(data){return String(data?.error?.message||data?.error||data?.message||data?.detail||'').slice(0,220);}
