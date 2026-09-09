import fs from 'node:fs';
import path from 'node:path';
import { FreeRevenueGlobalWorkHunter } from './free-revenue-global-work-hunter.js';

export class ExpandedFreeRevenueGlobalWorkHunter extends FreeRevenueGlobalWorkHunter{
  constructor(opts={}){super(opts);this.dynamicFeedFile=path.join(opts.storageDir||opts.env?.STORAGE_DIR||process.env.STORAGE_DIR||'data','autonomos','dynamic-market-feed.json');}
  async searchWorldwide(){
    const base=await super.searchWorldwide();let dynamicNew=0,dynamicSeen=0;
    const feed=readJson(this.dynamicFeedFile,{rows:[]});
    for(const row of (Array.isArray(feed.rows)?feed.rows:[]).slice(0,1000)){
      dynamicSeen++;const lead=this.classifyWebLead(row,`dynamic-market:${row.marketId||row.marketHost||'discovered'}`);if(!lead||this.state.ignored?.[lead.id])continue;
      if(lead.terminal){this.archiveLead(lead.id,'listing_terminal',lead);continue;}
      if(lead.humanGate){this.archiveLead(lead.id,'protected_registration_or_identity_step_required',lead);continue;}
      const prev=this.state.leads?.[lead.id];if(!prev)dynamicNew++;
      this.state.leads[lead.id]={...prev,...lead,externalId:row.externalId,observedAt:row.observedAt,currency:row.currency,directRouteHint:true,freeSource:`dynamic:${row.marketName||row.marketHost||'market'}`,marketId:String(row.marketId||''),marketHost:String(row.marketHost||''),marketRegistered:Boolean(row.registered),firstSeenAt:prev?.firstSeenAt||new Date().toISOString(),lastSeenAt:new Date().toISOString()};
    }
    if(dynamicSeen)this.event('dynamic_market_feed_ingested',{rows:dynamicSeen,newLeads:dynamicNew});
    this.persist();return{...base,newLeads:Number(base.newLeads||0)+dynamicNew,dynamicMarketRows:dynamicSeen,dynamicMarketNewLeads:dynamicNew};
  }
}
function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return structuredClone(fallback);}}
