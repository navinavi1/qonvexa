import { InternetHunter } from './internet-hunter.js';

// LeanInternetHunter deliberately skips generic paid-provider discovery.
// It keeps only known, direct, free-to-probe agent markets. This guarantees that this
// background lane cannot consume a paid search provider or silently fall into PAYG.
export class LeanInternetHunter extends InternetHunter{
  async scan(){
    if(this.running)return{ok:false,reason:'scan_already_running'};
    if(this.env.AUTONOMOS_INTERNET_HUNTER_ENABLED==='false')return{ok:false,reason:'disabled'};
    this.running=true;const started=Date.now();
    try{
      await this.probeAgentLancer().catch(error=>this.event('probe_failed',{source:'agentlancer',error:safeError(error)}));
      await this.probeSkarnfall().catch(error=>this.event('probe_failed',{source:'skarnfall',error:safeError(error)}));
      await this.probeKnownPages().catch(error=>this.event('known_pages_probe_failed',{error:safeError(error)}));
      this.state.lastScanAt=new Date().toISOString();
      this.state.scans=Number(this.state.scans||0)+1;
      this.state.lastScanMs=Date.now()-started;
      this.state.lastDiscovered=0;
      this.persist();
      this.event('scan_completed',{discovered:0,discoveryMode:'direct_free_probes_only',platforms:Object.keys(this.state.platforms||{}).length,jobs:Object.keys(this.state.jobs||{}).length,ms:this.state.lastScanMs});
      return{ok:true,discovered:0,platforms:Object.keys(this.state.platforms||{}).length,jobs:Object.keys(this.state.jobs||{}).length};
    }finally{this.running=false;}
  }
  async probeSkarnfall(){
    if(disabled(this.env).has('skarnfall'))return;
    return super.probeSkarnfall();
  }
  classifyLead(row,query){
    const lead=super.classifyLead(row,query);if(!lead)return null;
    const disabledSet=disabled(this.env);
    const id=String(lead.id||'').toLowerCase();
    const host=String(lead.host||'').toLowerCase();
    if([...disabledSet].some(source=>id.includes(source)||host.includes(source)))return null;
    return lead;
  }
}
function disabled(env){return new Set(String(env.AUTONOMOS_DISABLED_MARKETS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));}
function safeError(error){return String(error?.message||error||'').slice(0,220);}
