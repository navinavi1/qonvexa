import { SearchFirstLeadActioner } from './search-first-lead-actioner.js';

export class RevenueLeadActioner extends SearchFirstLeadActioner{
  priority(lead){
    let score=super.priority(lead);
    if(lead?.directRouteHint)score+=120;
    if(/apply by email|send (?:your )?proposal|email (?:your )?proposal|freelancer wanted|contractor needed/i.test(String(lead?.discoveredBy||'')))score+=80;
    return score;
  }

  async sendApplicationEmailOnce(args){
    const now=Date.now();
    const events=Array.isArray(this.state?.events)?this.state.events:[];
    const hourCap=Math.max(1,Math.min(100,Number(this.env.AUTONOMOS_EMAIL_APPLICATIONS_PER_HOUR||20)));
    const dayCap=Math.max(hourCap,Math.min(500,Number(this.env.AUTONOMOS_EMAIL_APPLICATIONS_PER_DAY||120)));
    const sentAt=events.filter(row=>String(row?.type||'')==='lead_applied_email').map(row=>Date.parse(String(row?.at||0))).filter(Number.isFinite);
    const hour=sentAt.filter(ts=>now-ts<60*60_000).length;
    const day=sentAt.filter(ts=>now-ts<24*60*60_000).length;
    if(hour>=hourCap||day>=dayCap){
      const id=String(args?.id||'');
      if(id)this.setAction(id,{status:'email_rate_limited',reason:`email application channel protected: ${hour}/${hourCap} last hour, ${day}/${dayCap} last 24h`,nextRetryAt:new Date(now+60*60_000).toISOString()});
      this.event('email_application_rate_limited',{hour,hourCap,day,dayCap});
      return;
    }
    return super.sendApplicationEmailOnce(args);
  }
}
