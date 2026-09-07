import { GlobalWorkHunter } from './global-work-hunter.js';
import { tavilySearch } from './tavily-tool.js';

const DIRECT_ROUTE_QUERIES=[
  'worldwide freelance translation project "apply by email" paid',
  'worldwide freelance localization project "send proposal" email paid',
  'worldwide freelance copywriter "send your proposal" paid project',
  'worldwide freelance writer "apply by email" contract project',
  'worldwide technical writer contractor "email your proposal"',
  'worldwide freelance researcher "send proposal" paid project',
  'worldwide data entry freelancer "apply by email" project',
  'worldwide spreadsheet data cleanup freelancer "send proposal"',
  'worldwide python freelancer "email your proposal" contract',
  'worldwide javascript API freelancer "send proposal" project',
  'worldwide website developer freelancer "apply by email" project',
  'worldwide wordpress shopify freelancer "send proposal" project',
  'worldwide automation freelancer n8n zapier make "send proposal"',
  'worldwide QA testing freelancer "apply by email" project',
  'worldwide SEO freelancer "email proposal" paid project',
  'worldwide virtual assistant freelancer "apply by email" contract',
  'worldwide customer support contractor "send proposal" remote',
  'worldwide remote paid bounty translation writing coding data USDC USDT',
  'worldwide crypto bounty developer writer researcher USDT USDC apply',
  'freelancer wanted remote project paid "contact" "proposal"'
];

export class RevenueGlobalWorkHunter extends GlobalWorkHunter{
  async searchWorldwide(){
    const broad=await super.searchWorldwide();
    const perCycle=Math.max(1,Math.min(6,Number(this.env.AUTONOMOS_DIRECT_QUERIES_PER_CYCLE||4)));
    let cursor=Number(this.state.directQueryCursor||0)%DIRECT_ROUTE_QUERIES.length,directNewLeads=0;
    for(let i=0;i<perCycle;i++){
      const query=DIRECT_ROUTE_QUERIES[(cursor+i)%DIRECT_ROUTE_QUERIES.length];
      const result=await tavilySearch(query,this.env);
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
    if(directNewLeads)this.event('direct_route_leads_found',{newLeads:directNewLeads,perCycle});
    return{...broad,newLeads:Number(broad?.newLeads||0)+directNewLeads,directNewLeads};
  }
}
