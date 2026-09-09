import { isRetiredMarket } from './retired-markets.js';
import { RevenueLeadActioner } from './revenue-lead-actioner.js';
import { freeCapabilityContext } from './free-capability-layer.js';

const TRUSTED_PAID_TASK_SOURCES=new Set(['freelancer-public-api','issuehunt-funded','boss-open-bounties','github-bounties','open-web-paid-tasks']);

export class FreeRevenueLeadActioner extends RevenueLeadActioner{
  capabilityContext(){return freeCapabilityContext(this.env);}

  shouldBrowserlessInspect(lead){
    if(isRetiredMarket(lead))return false;
    const action=this.state?.actions?.[lead?.id];
    const source=normalizedSource(lead);
    if(TRUSTED_PAID_TASK_SOURCES.has(source)&&String(action?.status||'')==='archived'&&/not a specific paid work listing|not_specific_work_listing/i.test(String(action?.reason||'')))return true;
    if(TRUSTED_PAID_TASK_SOURCES.has(source)&&String(action?.status||'')==='no_direct_route'){
      const next=Date.parse(String(action?.nextRetryAt||0));
      return !Number.isFinite(next)||next<=Date.now();
    }
    return super.shouldBrowserlessInspect(lead);
  }

  async inspectAndActBrowserless(lead){
    if(isRetiredMarket(lead))return {ok:false,reason:'marketplace_retired'};
    const source=normalizedSource(lead);
    if(source==='issuehunt-funded'){
      const github=issueHuntToGithub(lead?.url);
      if(github){
        return super.inspectAndActBrowserless({...lead,url:github,sourceUrl:String(lead?.url||''),directRouteHint:true});
      }
    }
    return super.inspectAndActBrowserless(lead);
  }

  async sendApplicationEmailOnce(args){
    const lead=args?.lead||{};
    if(isRetiredMarket(lead))return {ok:false,reason:'marketplace_retired'};
    const source=normalizedSource(lead);
    if(TRUSTED_PAID_TASK_SOURCES.has(source)){
      const enriched={
        ...lead,
        title:/\b(?:needed|required|wanted|bounty|project|task|contractor|freelance)\b/i.test(String(lead.title||''))?String(lead.title||''):`Freelance project needed: ${String(lead.title||'Paid digital task')}`,
        snippet:`Paid freelance task/project. Apply or submit a proposal for the stated payout. ${String(lead.snippet||'')}`
      };
      return super.sendApplicationEmailOnce({...args,lead:enriched});
    }
    return super.sendApplicationEmailOnce(args);
  }
}

function normalizedSource(lead){return String(lead?.freeSource||'').replace(/^free:/,'').replace(/^dynamic:/,'');}
function issueHuntToGithub(value){
  try{
    const u=new URL(String(value||''));
    if(!/(^|\.)issuehunt\.io$/i.test(u.hostname))return '';
    const m=u.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
    return m?`https://github.com/${m[1]}/${m[2]}/issues/${m[3]}`:'';
  }catch{return '';}
}

