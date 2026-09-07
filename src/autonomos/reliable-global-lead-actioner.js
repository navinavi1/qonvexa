import { GlobalLeadActioner } from './global-lead-actioner.js';

const FRESH_APPLY_TERMINAL=new Set([
  'application_uncertain','accepted_repair_exhausted','account_or_email_verification_required'
]);

export class ReliableGlobalLeadActioner extends GlobalLeadActioner{
  shouldInspect(lead){
    const status=String(this.state?.actions?.[lead?.id]?.status||'');
    if(FRESH_APPLY_TERMINAL.has(status))return false;
    return super.shouldInspect(lead);
  }

  async openSession(url,host){
    const apiKey=String(this.env.BROWSERBASE_API_KEY||'').trim();
    if(!apiKey)throw new Error('browserbase_not_configured');
    const retries=Math.max(1,Math.min(5,Number(this.env.AUTONOMOS_BROWSER_SESSION_RETRIES||3)));
    const {browserbase,Stagehand}=await import('@browserbasehq/stagehand');
    let lastError;
    for(let attempt=1;attempt<=retries;attempt++){
      let browser;let stagehand;
      try{
        browser=await withTimeout(browserbase.launch({apiKey}),35_000,'browserbase_launch_timeout');
        stagehand=await withTimeout(Stagehand.create({browser,selfHeal:true,cache:{threshold:2}}),75_000,'stagehand_create_timeout');
        try{await browser.context.setDomainPolicy({allowedDomains:[host,...csv(this.env.AUTONOMOS_BROWSER_ALLOWED_DOMAINS)]});}catch{}
        const pages=await browser.context.pages();const page=pages[0]||await browser.context.newPage();
        const secrets=this.read(this.secretFile,{accounts:{}});const cookies=secrets?.accounts?.[host]?.cookies;
        if(Array.isArray(cookies)&&cookies.length){try{await browser.context.addCookies(cookies);}catch{}}
        await withTimeout(page.goto(String(url),{waitUntil:'domcontentloaded'}),35_000,'page_navigation_timeout');
        if(attempt>1)this.event('browser_session_recovered',{host,attempt});
        return{browser,stagehand,page};
      }catch(error){
        lastError=error;
        try{await stagehand?.close();}catch{}
        try{await browser?.close();}catch{}
        if(attempt<retries){
          this.event('browser_session_retry',{host,attempt,error:String(error?.message||error).slice(0,180)});
          await sleep(Math.min(7000,1200*attempt));
        }
      }
    }
    throw new Error(`browser_session_unavailable_after_${retries}_attempts:${String(lastError?.message||lastError||'unknown').slice(0,180)}`);
  }

  async inspectAndAct(lead){
    await super.inspectAndAct(lead);
    const action=this.state?.actions?.[lead?.id];
    if(String(action?.status||'')==='application_uncertain'){
      action.nextCheckAt=action.nextCheckAt||new Date(Date.now()+30*60_000).toISOString();
      delete action.nextRetryAt;
      action.reason='application outcome uncertain; monitor existing session only, never resubmit';
      action.updatedAt=new Date().toISOString();
      this.persist();
    }
  }
}

function csv(v){return String(v||'').split(',').map(x=>x.trim().toLowerCase()).filter(x=>/^[a-z0-9.-]+$/.test(x));}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function withTimeout(promise,ms,label){
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(()=>clearTimeout(timer)),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);timer.unref?.();})
  ]);
}
