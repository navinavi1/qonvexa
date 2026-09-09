import { ExpandedFreeRevenueGlobalWorkHunter } from './expanded-free-revenue-global-work-hunter.js';
import { freeWebSearch } from './free-web-tool.js';

const EMPLOYMENT_SOURCES=new Set(['jobicy','remoteok','weworkremotely','remotive']);
const CONTRACT_SIGNAL=/\b(freelance|freelancer|contractor|independent contractor|contract project|fixed[- ]price|project budget|project fee|bounty|reward|paid task|gig|rfp|request for proposals|consulting project|one[- ]off|milestone)\b/i;
const EMPLOYMENT_SIGNAL=/\b(full[- ]?time|part[- ]?time|permanent|employee|annual salary|salary range|benefits|401\s*\(?k\)?|health insurance|paid time off|\bpto\b|equity|stock options?)\b/i;
const MONEY_SIGNAL=/(?:\$|€|£)\s?\d|\b\d+(?:\.\d+)?\s?(?:USD|USDC|USDT|DAI|ETH|SOL|BTC|EUR|GBP)\b/i;
const TASK_SIGNAL=/\b(project|task|bounty|reward|fixed[- ]price|milestone|freelance|contractor|rfp|proposal|deliverable|bug|issue|translation|copywriting|design|automation|research|data|website|api|seo|marketing|video|audio|testing|scraping)\b/i;
const SEARCH_QUERIES=[
  'paid freelance project fixed price automation data API bounty',
  'paid translation localization freelance project bounty fixed price',
  'paid copywriting content freelance project fixed price',
  'paid software bug API website freelance bounty project',
  'paid research data entry spreadsheet freelance project',
  'paid SEO advertising PPC marketing freelance project fixed price',
  'paid design video audio editing freelance project fixed price',
  'paid AI prompt evaluation data labeling freelance project bounty',
  'paid no-code CRM ecommerce Shopify WordPress freelance project',
  'paid GitHub bounty issue USDC USD reward open'
];

export class ProfitFirstGlobalWorkHunter extends ExpandedFreeRevenueGlobalWorkHunter{
  async searchWorldwide(){
    const base=await super.searchWorldwide();
    const pruned=this.pruneEmploymentNoise();
    const searched=await this.searchOnePaidTaskQuery();
    this.persist();
    return{...base,newLeads:Number(base.newLeads||0)+Number(searched.newLeads||0),employmentNoiseArchived:pruned,openWebPaidTaskSearch:searched};
  }

  pruneEmploymentNoise(){
    let archived=0;
    for(const [id,lead] of Object.entries(this.state.leads||{})){
      const freeSource=String(lead?.freeSource||'').replace(/^free:/,'');
      if(!EMPLOYMENT_SOURCES.has(freeSource))continue;
      const text=`${lead?.title||''} ${lead?.snippet||''}`;
      if(CONTRACT_SIGNAL.test(text))continue;
      if(!EMPLOYMENT_SIGNAL.test(text)&&!(/\b(?:job|role|position|hiring)\b/i.test(text)&&!TASK_SIGNAL.test(text)))continue;
      this.archiveLead(id,'employment_feed_not_service_contract',lead);archived++;
    }
    if(archived)this.event('employment_noise_archived',{count:archived});
    return archived;
  }

  async searchOnePaidTaskQuery(){
    this.state.openWebPaidTaskSearch=this.state.openWebPaidTaskSearch||{};
    const state=this.state.openWebPaidTaskSearch;
    const last=Date.parse(String(state.lastPollAt||0));
    const interval=Math.max(10*60_000,Number(this.env.AUTONOMOS_OPEN_WEB_PAID_TASK_SEARCH_MS||20*60_000));
    if(Number.isFinite(last)&&Date.now()-last<interval)return{polled:false,newLeads:0};
    const index=Number(state.queryIndex||0)%SEARCH_QUERIES.length;
    const query=SEARCH_QUERIES[index];
    let newLeads=0,rows=0,error='';
    try{
      const result=await freeWebSearch(query,this.env);
      if(!result.ok)throw new Error(String(result.error||'free_search_failed'));
      for(const row of (result.results||[]).slice(0,8)){
        const text=`${row.title||''} ${row.snippet||''}`;
        if(!MONEY_SIGNAL.test(text)||!TASK_SIGNAL.test(text))continue;
        if(EMPLOYMENT_SIGNAL.test(text)&&!CONTRACT_SIGNAL.test(text))continue;
        const lead=this.classifyWebLead(row,'free:open-web-paid-tasks');
        if(!lead||this.state.ignored?.[lead.id]||lead.terminal||lead.humanGate)continue;
        rows++;
        const prev=this.state.leads?.[lead.id];if(!prev)newLeads++;
        this.state.leads[lead.id]={...prev,...lead,directRouteHint:true,freeSource:'open-web-paid-tasks',firstSeenAt:prev?.firstSeenAt||new Date().toISOString(),lastSeenAt:new Date().toISOString()};
      }
      this.event('open_web_paid_task_search',{queryIndex:index,rows,newLeads,provider:String(result.provider||'free')});
    }catch(e){error=String(e?.message||e).slice(0,180);this.event('open_web_paid_task_search_failed',{queryIndex:index,error});}
    this.state.openWebPaidTaskSearch={lastPollAt:new Date().toISOString(),queryIndex:(index+1)%SEARCH_QUERIES.length,lastRows:rows,lastNew:newLeads,error};
    return{polled:true,queryIndex:index,rows,newLeads,error};
  }
}
