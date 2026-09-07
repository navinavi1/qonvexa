import { SearchFirstLeadActioner } from './search-first-lead-actioner.js';
import { composioExecute } from './composio-tool.js';

const EXPLICIT_LISTING_INTENT=/\b(job|jobs|project|projects|hiring|hire|hiring for|looking for|seeking|wanted|needed|required|contract|contractor|bounty|task|tasks|apply|application|opening|vacancy|freelance (?:role|work|job)|paid (?:work|task|project))\b/i;
const GENERIC_OR_CONTENT_TITLE=/\b(how to|guide|tutorial|tips?|template|templates|course|courses|best\s+.+\s+freelancers?|top\s+.+\s+freelancers?|hire\s+.+\s+freelancers?|find\s+.+\s+freelance jobs|freelance jobs and leads|work from home careers|project proposals?|score freelance clients|marketplace for freelancers?|services? for freelancers?)\b/i;
const GENERIC_COUNT_TITLE=/^\s*\d+\s+(?:remote\s+)?(?:jobs|vacancies|openings|freelance jobs)\b/i;
const SPECIFIC_ROLE_OR_REQUEST=/\b(request for proposals|\brfp\b|hiring|seeking|looking for|wanted|needed|required|opening|vacanc(?:y|ies)|contractor|freelance\s+(?:developer|writer|translator|designer|researcher|tester|engineer|assistant|specialist|consultant)|developer|engineer|writer|translator|designer|researcher|tester|quality assurance|\bqa\b|analyst|assistant|specialist|consultant|manager|moderator|copywriter|editor|proofreader|data entry|automation)\b/i;
const JOB_URL_HINT=/\/(?:jobs?|projects?|gigs?|bount(?:y|ies)|careers?|opportunities|openings|vacancies)(?:\/|\?|$)/i;
const DIRECT_APPLICATION_HINT=/apply by email|send (?:your )?proposal|email (?:your )?proposal|freelancer wanted|contractor needed|request for proposals|\brfp\b/i;

export class RevenueLeadActioner extends SearchFirstLeadActioner{
  priority(lead){
    let score=super.priority(lead);
    if(lead?.directRouteHint)score+=120;
    if(DIRECT_APPLICATION_HINT.test(String(lead?.discoveredBy||'')))score+=80;
    return score;
  }

  // Applying for work must never queue behind a paid model call. Execution can use the
  // full LLM/tool stack after acceptance; first contact only needs a truthful job-specific
  // statement of capability.
  async makeProposal(lead,_text,capability,payout){
    const title=clean(String(lead?.title||'the project')).slice(0,180);
    const skill=String(capability?.skill||lead?.category||'digital').toLowerCase();
    const line=proposalLine(skill);
    const payoutText=Number(payout?.amountUsd||0)>0?` The stated ${Number(payout.amountUsd).toLocaleString('en-US')} ${String(payout.currency||'USD')} budget works for us subject to the listed scope.`:'';
    return `Hi — AutonomOS can take on “${title}”. ${line} We use an AI-assisted workflow with real tool execution, verification and a QA pass before delivery.${payoutText} We can start immediately and will deliver only against the stated requirements and acceptance criteria.`.slice(0,1500);
  }

  async sendApplicationEmailOnce(args){
    const {id,host,lead,route,subject,body,proposal,payout,capability}=args||{};
    const listingText=`${String(lead?.title||'')} ${String(lead?.snippet||'')}`;
    if(!isSpecificWorkListing(lead)||!EXPLICIT_LISTING_INTENT.test(listingText)){
      if(id)this.setAction(id,{status:'archived',reason:'not a specific paid work listing; outbound application suppressed'});
      this.event('lead_application_suppressed',{id,host,reason:'not_specific_work_listing'});
      return;
    }
    const floor=Math.max(0,Number(this.env.AUTONOMOS_GLOBAL_MIN_JOB_PAYOUT_USD||this.env.AUTONOMOS_MIN_JOB_PAYOUT_USD||0.5));
    const allowUnpriced=/^(1|true|yes|on)$/i.test(String(this.env.AUTONOMOS_ALLOW_UNPRICED_PAID_LEADS||'false'));
    if(Number(payout?.amountUsd||0)<floor&&!allowUnpriced){
      if(id)this.setAction(id,{status:'payout_unverified',reason:`priced payout below verification floor (${Number(payout?.amountUsd||0)} < ${floor})`,nextRetryAt:new Date(Date.now()+12*60*60_000).toISOString()});
      this.event('lead_application_suppressed',{id,host,reason:'payout_not_priced_above_floor',amountUsd:Number(payout?.amountUsd||0),floor});
      return;
    }

    const now=Date.now();
    const events=Array.isArray(this.state?.events)?this.state.events:[];
    // This is a provider/reputation pacing guard, not a business cap. Production can use
    // the upper bound so every qualified listing is eventually attempted without blasting
    // hundreds of messages in a single minute.
    const hourCap=Math.max(1,Math.min(100,Number(this.env.AUTONOMOS_EMAIL_APPLICATIONS_PER_HOUR||20)));
    const dayCap=Math.max(hourCap,Math.min(500,Number(this.env.AUTONOMOS_EMAIL_APPLICATIONS_PER_DAY||120)));
    const sentAt=events.filter(row=>String(row?.type||'')==='lead_applied_email').map(row=>Date.parse(String(row?.at||0))).filter(Number.isFinite);
    const hour=sentAt.filter(ts=>now-ts<60*60_000).length;
    const day=sentAt.filter(ts=>now-ts<24*60*60_000).length;
    if(hour>=hourCap||day>=dayCap){
      if(id)this.setAction(id,{status:'email_rate_limited',reason:`qualified application queued by email pacing: ${hour}/${hourCap} last hour, ${day}/${dayCap} last 24h`,nextRetryAt:new Date(now+15*60_000).toISOString()});
      this.event('email_application_rate_limited',{hour,hourCap,day,dayCap});
      return;
    }

    const prior=this.state.actions?.[id]||{};
    if(['email_send_in_progress','applied_email','application_uncertain'].includes(String(prior.status||'')))return;
    this.setAction(id,{status:'email_send_in_progress',recipient:route.email,applicationUrl:lead.url,proposal:String(proposal||'').slice(0,1800),payout,skill:capability.skill,emailStartedAt:new Date().toISOString(),nextRetryAt:''});

    // GMAIL_SEND_EMAIL is Composio's canonical current Gmail action. Calling it directly
    // removes the catalog-search/schema-discovery request from every application and uses
    // the documented recipient_email/subject/body shape.
    const result=await composioExecute({
      toolSlug:'GMAIL_SEND_EMAIL',
      arguments:{recipient_email:String(route.email||''),subject:String(subject||'').slice(0,240),body:String(body||'').slice(0,7000)}
    },this.env);
    if(result.ok){
      this.setAction(id,{status:'applied_email',appliedAt:new Date().toISOString(),emailLogId:String(result.logId||''),recipient:route.email,reason:'targeted application sent to explicit public application contact',nextCheckAt:new Date(Date.now()+30*60_000).toISOString()});
      this.state.stats.applied=Number(this.state.stats.applied||0)+1;
      this.event('lead_applied_email',{id,host,recipient:maskEmail(route.email),title:String(lead.title||'').slice(0,120),amountUsd:payout.amountUsd,currency:payout.currency,skill:capability.skill});return;
    }
    if(result.needsConnectedAccount||/connected.?account|auth|unauthor|forbidden/i.test(`${result.error||''} ${result.detail||''}`)){
      this.setAction(id,{status:'email_channel_unavailable',reason:String(result.detail||result.error||'gmail_not_connected').slice(0,240),nextRetryAt:new Date(Date.now()+60*60_000).toISOString()});
      this.event('email_channel_unavailable',{id,host,error:String(result.error||'gmail_not_connected').slice(0,120)});return;
    }
    // An outbound send is non-idempotent. If Composio/Gmail returns an ambiguous failure,
    // do not blindly resend the same job application.
    this.setAction(id,{status:'application_uncertain',reason:`email send outcome uncertain: ${String(result.detail||result.error||'unknown').slice(0,220)}`,recipient:route.email,nextCheckAt:new Date(Date.now()+60*60_000).toISOString()});
    this.event('lead_email_application_uncertain',{id,host,error:String(result.error||'unknown').slice(0,120)});
  }
}

function isSpecificWorkListing(lead){
  const title=clean(lead?.title).toLowerCase();
  const snippet=clean(lead?.snippet).toLowerCase();
  const discoveredBy=clean(lead?.discoveredBy).toLowerCase();
  const url=String(lead?.url||'');
  if(!title)return false;
  if(GENERIC_OR_CONTENT_TITLE.test(title)||GENERIC_COUNT_TITLE.test(title))return false;
  if(SPECIFIC_ROLE_OR_REQUEST.test(title))return true;
  if(JOB_URL_HINT.test(url)&&EXPLICIT_LISTING_INTENT.test(`${title} ${snippet}`))return true;
  if(DIRECT_APPLICATION_HINT.test(discoveredBy)&&/\b(project|contract|task|bounty|paid work|freelance work)\b/i.test(`${title} ${snippet}`))return true;
  return false;
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
function maskEmail(email){const [local,domain]=String(email||'').split('@');return local&&domain?`${local.slice(0,2)}***@${domain}`:'redacted';}
