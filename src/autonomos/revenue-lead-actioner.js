import { SearchFirstLeadActioner } from './search-first-lead-actioner.js';

export class RevenueLeadActioner extends SearchFirstLeadActioner{
  priority(lead){
    let score=super.priority(lead);
    if(lead?.directRouteHint)score+=120;
    if(/apply by email|send (?:your )?proposal|email (?:your )?proposal|freelancer wanted|contractor needed/i.test(String(lead?.discoveredBy||'')))score+=80;
    return score;
  }

  // Applying for work must never queue behind a paid model call. Execution can use the
  // full LLM/tool stack after acceptance; the first contact only needs a truthful,
  // job-specific statement of capability. This keeps the application funnel fast and
  // deterministic while still avoiding fake experience/identity claims.
  async makeProposal(lead,_text,capability,payout){
    const title=clean(String(lead?.title||'the project')).slice(0,180);
    const skill=String(capability?.skill||lead?.category||'digital').toLowerCase();
    const line=proposalLine(skill);
    const payoutText=Number(payout?.amountUsd||0)>0?` The stated ${Number(payout.amountUsd).toLocaleString('en-US')} ${String(payout.currency||'USD')} budget works for us subject to the listed scope.`:'';
    return `Hi — AutonomOS can take on “${title}”. ${line} We use an AI-assisted workflow with real tool execution, verification and a QA pass before delivery.${payoutText} We can start immediately and will deliver only against the stated requirements and acceptance criteria.`.slice(0,1500);
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

function proposalLine(skill){
  if(skill==='translation')return 'We can translate/localize the supplied material, preserve meaning and terminology, then run a consistency and completeness check';
  if(skill==='copywriting')return 'We can produce the requested copy to the supplied brief, structure it for the target audience, and perform a final clarity/accuracy edit';
  if(skill==='web-research')return 'We can research the requested facts from public sources, cross-check key points and return a structured result with source evidence';
  if(skill==='data-transform')return 'We can clean, normalize, deduplicate and transform the supplied data, then verify the output programmatically';
  if(skill==='code-analysis')return 'We can inspect or implement the code in an isolated environment, run the relevant tests/checks and return verifiable changes/results';
  if(skill==='app-automation')return 'We can build the requested API/workflow automation using the available integrations and verify the end-to-end behavior';
  if(skill==='document-generation')return 'We can create the requested structured document or deliverable and verify the final file/content before handoff';
  return 'We can complete the digital deliverable with the appropriate research, code, data, content and automation tools available to the agent team';
}
function clean(value){return String(value||'').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim();}
