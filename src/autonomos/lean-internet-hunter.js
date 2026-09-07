import { InternetHunter } from './internet-hunter.js';

export class LeanInternetHunter extends InternetHunter{
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
