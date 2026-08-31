const BROWSER_BLOCKED=/\b(bypass|evade|solve)\s+(captcha|2fa|mfa|access control)|credential stuffing|steal session|session cookie|impersonate\b/i;

export async function browserTask({url,instruction}={},env=process.env,signal){
  const apiKey=String(env.BROWSERBASE_API_KEY||'').trim();
  if(!apiKey)return{ok:false,error:'browserbase_not_configured'};
  const target=normalizeHttpUrl(url);
  if(!target)return{ok:false,error:'invalid_url'};
  const task=String(instruction||'Inspect this page and report the result.').trim().slice(0,5000);
  if(BROWSER_BLOCKED.test(task))return{ok:false,error:'browser_task_blocked_by_policy'};
  let browser;let stagehand;
  try{
    const {browserbase,Stagehand}=await import('@browserbasehq/stagehand');
    if(signal?.aborted)return{ok:false,error:'aborted_by_emergency_stop'};
    browser=await browserbase.launch({apiKey});
    stagehand=await Stagehand.create({browser,selfHeal:true,cache:{threshold:2}});
    // Stagehand v4 enforces the policy in-browser before a disallowed request leaves.
    // Keep the task on the requested host plus any explicit owner-approved domains.
    const allowedDomains=[target.hostname,...csv(env.AUTONOMOS_BROWSER_ALLOWED_DOMAINS)].filter(Boolean);
    try{await browser.context.setDomainPolicy({allowedDomains:[...new Set(allowedDomains)]});}catch{}
    const pages=await browser.context.pages();
    const page=pages[0]||await browser.context.newPage();
    await page.goto(target.href,{waitUntil:'domcontentloaded'});
    if(signal?.aborted)return{ok:false,error:'aborted_by_emergency_stop'};
    // v4 intentionally removed the old agent() API. One browser_task call performs one
    // bounded AI action; the outer worker can make multiple calls when a job needs a
    // multi-step flow, keeping every step visible in the tool log and spend controls.
    const action=await stagehand.act(task,{cache:{threshold:1}});
    const currentUrl=await page.url();
    return{
      ok:true,
      completed:true,
      result:safeResult(action),
      url:String(currentUrl||target.href),
      cacheStatus:action?.metadata?.cache?.status||'',
      tokensSaved:Number(action?.metadata?.cache?.tokensSaved||0)
    };
  }catch(error){
    return{ok:false,error:signal?.aborted?'aborted_by_emergency_stop':String(error?.message||error).slice(0,500)};
  }finally{
    try{await stagehand?.close();}catch{}
    try{await browser?.close();}catch{}
  }
}

function normalizeHttpUrl(value){
  try{const u=new URL(String(value||''));return ['http:','https:'].includes(u.protocol)?u:null;}catch{return null;}
}
function csv(v){return String(v||'').split(',').map(x=>x.trim().toLowerCase()).filter(x=>/^[a-z0-9.-]+$/.test(x));}
function safeResult(value){
  try{return JSON.stringify(value?.data??value?.result??value).slice(0,12000);}catch{return String(value||'').slice(0,12000);}
}
