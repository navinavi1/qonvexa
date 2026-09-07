import { GlobalLeadActioner } from './global-lead-actioner.js';

const FRESH_APPLY_TERMINAL=new Set([
  'application_uncertain','accepted_repair_exhausted','account_or_email_verification_required'
]);

let browserbaseBlockedUntil=0;
let browserbaseBlockReason='';

export class ReliableGlobalLeadActioner extends GlobalLeadActioner{
  shouldInspect(lead){
    const status=String(this.state?.actions?.[lead?.id]?.status||'');
    if(FRESH_APPLY_TERMINAL.has(status))return false;
    return super.shouldInspect(lead);
  }

  async openSession(url,host){
    const apiKey=String(this.env.BROWSERBASE_API_KEY||'').trim();
    if(!apiKey)throw new Error('browserbase_not_configured');
    if(browserbaseBlockedUntil>Date.now()){
      const seconds=Math.max(1,Math.ceil((browserbaseBlockedUntil-Date.now())/1000));
      throw new Error(`browser_session_unavailable:circuit_open:${browserbaseBlockReason||'provider_cooldown'}:${seconds}s`);
    }
    const retries=Math.max(1,Math.min(5,Number(this.env.AUTONOMOS_BROWSER_SESSION_RETRIES||3)));
    const {browserbase,Stagehand}=await import('@browserbasehq/stagehand');
    let lastError;
    for(let attempt=1;attempt<=retries;attempt++){
      let browser;let stagehand;let sessionId='';
      try{
        const created=await createBrowserbaseSession({env:this.env,apiKey});
        sessionId=created.sessionId;
        browser=await withTimeout(browserbase.connect({apiKey,sessionId}),35_000,'browserbase_connect_timeout');
        stagehand=await withTimeout(Stagehand.create({browser,selfHeal:true,cache:{threshold:2}}),75_000,'stagehand_create_timeout');
        try{await browser.context.setDomainPolicy({allowedDomains:[host,...csv(this.env.AUTONOMOS_BROWSER_ALLOWED_DOMAINS)]});}catch{}
        const pages=await browser.context.pages();const page=pages[0]||await browser.context.newPage();
        const secrets=this.read(this.secretFile,{accounts:{}});const cookies=secrets?.accounts?.[host]?.cookies;
        if(Array.isArray(cookies)&&cookies.length){try{await browser.context.addCookies(cookies);}catch{}}
        await withTimeout(page.goto(String(url),{waitUntil:'domcontentloaded'}),35_000,'page_navigation_timeout');
        browserbaseBlockedUntil=0;browserbaseBlockReason='';
        if(attempt>1)this.event('browser_session_recovered',{host,attempt});
        return{browser,stagehand,page,sessionId};
      }catch(error){
        lastError=error;
        const detail=sanitizeBrowserError(error);
        try{await stagehand?.close();}catch{}
        try{await browser?.close();}catch{}
        if(detail.status===402){
          const blockMs=Math.max(60*60_000,Math.min(24*60*60_000,Number(this.env.AUTONOMOS_BROWSERBASE_402_COOLDOWN_MS||12*60*60_000)));
          browserbaseBlockedUntil=Date.now()+blockMs;
          browserbaseBlockReason='browserbase_quota_or_plan_exhausted';
          this.event('browser_provider_circuit_open',{provider:'browserbase',status:402,until:new Date(browserbaseBlockedUntil).toISOString(),reason:browserbaseBlockReason});
          break;
        }
        if(detail.status===429){
          const blockMs=Math.max(60_000,Math.min(15*60_000,(detail.retryAfterSeconds||60)*1000));
          browserbaseBlockedUntil=Math.max(browserbaseBlockedUntil,Date.now()+blockMs);
          browserbaseBlockReason='browserbase_rate_limited';
        }
        if(attempt<retries&&detail.retryable){
          this.event('browser_session_retry',{host,attempt,status:detail.status,retryAfterSeconds:detail.retryAfterSeconds,error:detail.message});
          await sleep(Math.max(1200,Math.min(60_000,(detail.retryAfterSeconds||attempt*2)*1000)));
          continue;
        }
        if(attempt<retries&&!detail.retryable){
          this.event('browser_session_nonretryable',{host,attempt,status:detail.status,error:detail.message});
        }
        break;
      }
    }
    const detail=sanitizeBrowserError(lastError);
    throw new Error(`browser_session_unavailable:${detail.status||'unknown'}:${detail.message}`);
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

async function createBrowserbaseSession({env,apiKey}){
  const projectId=String(env.BROWSERBASE_PROJECT_ID||'').trim();
  const body={timeout:Math.max(60,Math.min(600,Number(env.AUTONOMOS_BROWSER_SESSION_TIMEOUT_SECONDS||180))),keepAlive:false};
  if(projectId)body.projectId=projectId;
  let response;
  try{
    response=await fetch('https://api.browserbase.com/v1/sessions',{
      method:'POST',
      headers:{'content-type':'application/json','x-bb-api-key':apiKey,'user-agent':'AutonomOS/15'},
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(20_000)
    });
  }catch(error){
    const wrapped=new Error(`browserbase_session_network:${String(error?.message||error).slice(0,160)}`);
    wrapped.status=0;wrapped.retryable=true;throw wrapped;
  }
  let payload={};try{payload=await response.json();}catch{}
  if(!response.ok){
    const message=String(payload?.message||payload?.error||payload?.detail||`http_${response.status}`).slice(0,220);
    const error=new Error(`browserbase_session_http_${response.status}:${message}`);
    error.status=response.status;
    error.retryAfterSeconds=Math.max(0,Number(response.headers.get('retry-after')||0));
    error.retryable=response.status===408||response.status===409||response.status===425||response.status===429||response.status>=500;
    throw error;
  }
  const sessionId=String(payload?.id||payload?.sessionId||'').trim();
  if(!sessionId){const error=new Error('browserbase_session_missing_id');error.status=response.status;error.retryable=false;throw error;}
  return{sessionId};
}

function sanitizeBrowserError(error){
  const status=Number(error?.status||0)||0;
  const retryAfterSeconds=Math.max(0,Number(error?.retryAfterSeconds||0));
  const raw=String(error?.message||error||'unknown').replace(/[A-Za-z0-9_-]{32,}/g,'[redacted]').slice(0,240);
  const retryable=typeof error?.retryable==='boolean'?error.retryable:status===0||status===408||status===409||status===425||status===429||status>=500||/timeout|network|econnreset|temporar|failed to fetch/i.test(raw);
  return{status,retryAfterSeconds,retryable,message:raw};
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
