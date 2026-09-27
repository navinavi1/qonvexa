import { JSDOM } from 'jsdom';
import { hash } from './security.js';
import { catalog, recommendations } from './catalog.js';
export const modules=['conversion','mobile','trust','seo','performance','schema','local','ai','analytics','capture','crm','booking','reputation','accessibility','security','ecommerce','content','links','clarity','forms'];
const clean=v=>String(v||'').replace(/\s+/g,' ').trim().slice(0,240);
export function audit(observations,{aiVisibility=true}={}) {
  const findings=[],coverage=Object.fromEntries(modules.map(k=>[k,{status:'OBSERVATION_ONLY',limitations:[]} ]));
  const services=catalog();
  const add=(page,category,title,description,evidence,recommendedFix,severity='MEDIUM',confidence='HIGH')=>{
    if(!evidence||!evidence.source||!evidence.observation)return;
    const service=services.find(s=>s.eligibleFindings.includes(category));
    const id=hash(`${page.url}|${category}|${title}`).slice(0,24);
    if(findings.some(f=>f.id===id))return;
    findings.push({id,category,title,description,url:page.url,evidence:[{...evidence,url:page.url,observedAt:page.observedAt}],severity,technicalSeverity:severity,confidence,businessImpact:{level:category==='conversion'?'HIGH':'MEDIUM',description:'May add friction or reduce clarity for visitors; no revenue effect has been measured.'},recommendedFix,qonvexaCanFix:false,automationLevel:'PREFLIGHT_REQUIRED',serviceId:service?.id||null,requiredAccess:service?.requiredAccess||[],requiredServices:service?.requiredExternalServices||[],estimatedImplementationPrice:service?{fromCents:service.basePrice,currency:'USD',type:'ESTIMATE_NOT_QUOTE'}:null,estimatedRecurringCost:{amount:null,billingOwner:'CUSTOMER'},preflightRequired:true});
  };
  for(const p of observations.pages){
    const evidence=(observation,source='public_page')=>({source,observation,kind:'MEASURED_FACT'});
    if(p.status>=400){add(p,'seo',`HTTP ${p.status} on checked page`,'This URL did not return a successful page.',evidence(`Response status ${p.status}`,'http_header'),'Repair the URL or its inbound links.','HIGH');continue;}
    if(!String(p.headers['content-type']).includes('html'))continue;
    const dom=new JSDOM(p.body),d=dom.window.document;
    const count=s=>d.querySelectorAll(s).length;
    const has=s=>Boolean(d.querySelector(s));
    const text=clean(d.body?.textContent);
    const links=[...d.querySelectorAll('a[href]')];
    if(!clean(d.title))add(p,'seo','Page title is missing','No non-empty title was found in the returned HTML.',evidence('title text length = 0'),'Add a unique descriptive title.');
    if(!clean(d.querySelector('meta[name="description" i]')?.content))add(p,'seo','Meta description is missing','No non-empty meta description in the returned HTML.',evidence('meta[name=description] missing or empty'),'Write a factual page summary.','LOW');
    if(count('h1')!==1)add(p,'content','Primary heading needs review','The HTML does not contain exactly one H1; this is a structure recommendation, not a ranking verdict.',evidence(`H1 count = ${count('h1')}`),'Review the heading hierarchy.','LOW','MEDIUM');
    if(!has('link[rel="canonical" i]'))add(p,'seo','Canonical declaration not found','No canonical link element in sampled HTML.',evidence('link[rel=canonical] count = 0'),'Review whether an explicit canonical is appropriate.','LOW','MEDIUM');
    const robots=d.querySelector('meta[name="robots" i]')?.content||'';
    if(/noindex/i.test(robots)||/noindex/i.test(p.headers['x-robots-tag']||''))add(p,'seo','Noindex directive detected','This can prevent indexing if the page is meant to be public.',evidence(`Robots: ${robots||p.headers['x-robots-tag']}`,'metadata'),'Confirm intent before removing the directive.','HIGH');
    if(!has('meta[name="viewport" i]'))add(p,'mobile','Mobile viewport declaration not found','The sampled HTML lacks a viewport meta tag.',evidence('meta[name=viewport] count = 0'),'Add and visually test a mobile viewport declaration.');
    if(!has('meta[property="og:title"]'))add(p,'content','Social preview title not found','Open Graph title is absent in sampled HTML.',evidence('meta[property=og:title] count = 0'),'Add approved Open Graph metadata.','LOW');
    const images=[...d.querySelectorAll('img')],missing=images.filter(x=>!x.hasAttribute('alt'));
    if(missing.length)add(p,'accessibility','Images lack ALT attributes','Missing ALT attributes require accessibility review; decorative images can use empty ALT.',evidence(`${missing.length} of ${images.length} img elements have no alt attribute`),'Use descriptive ALT for meaningful images and empty ALT for decoration.');
    const noSize=images.filter(x=>!x.hasAttribute('width')||!x.hasAttribute('height'));
    if(noSize.length)add(p,'performance','Image dimensions need layout review','Missing HTML dimensions are observed; CSS may already reserve space. CLS has not been measured.',evidence(`${noSize.length} images lack width or height attributes`),'Check layout reservation in rendered pages.','LOW','MEDIUM');
    const unnamed=[...d.querySelectorAll('button,a[href]')].filter(x=>!clean(x.textContent)&&!x.getAttribute('aria-label')&&!x.getAttribute('aria-labelledby')&&!x.querySelector('img[alt]'));
    if(unnamed.length)add(p,'accessibility','Potential unnamed controls','Controls lack an obvious accessible name in static HTML; computed accessibility tree not measured.',evidence(`${unnamed.length} potentially unnamed links/buttons`),'Verify accessible names using the browser accessibility tree.','MEDIUM','MEDIUM');
    const inputs=[...d.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea')];
    const unlabeled=inputs.filter(x=>!x.getAttribute('aria-label')&&!x.getAttribute('aria-labelledby')&&!x.closest('label')&&![...d.querySelectorAll('label[for]')].some(l=>l.htmlFor&&l.htmlFor===x.id));
    if(unlabeled.length)add(p,'forms','Form controls need labels','Static label associations are missing.',evidence(`${unlabeled.length} input controls lack an associated label`),'Add and test accessible labels.');
    const insecure=[...d.querySelectorAll('form[action]')].filter(x=>/^http:\/\//i.test(x.getAttribute('action')));
    if(insecure.length)add(p,'security','Form posts to HTTP','A form action explicitly uses unencrypted HTTP.',evidence(`${insecure.length} HTTP form actions`),'Use an HTTPS action and verify the authorized submission flow.','HIGH');
    if(p.url.startsWith('https:')&&[...d.querySelectorAll('script[src],img[src],link[href]')].some(x=>/^http:\/\//i.test(x.getAttribute('src')||x.getAttribute('href')||'')))add(p,'security','HTTP resource references on HTTPS page','Static mixed-content references exist; browser blocking was not measured.',evidence('At least one script/image/link resource uses http://'),'Replace affected resources with approved HTTPS URLs.');
    if(p.url.startsWith('http:'))add(p,'security','Page served over HTTP','The fetched page did not upgrade to HTTPS.',evidence(`Final URL protocol: ${new URL(p.url).protocol}`),'Enable HTTPS with a tested redirect.','HIGH');
    for(const header of ['content-security-policy','x-content-type-options'])if(!p.headers[header])add(p,'security',`${header} header not found`,'Baseline header check only, not a penetration test.',evidence(`${header} absent`,'http_header'),'Review a compatible header policy before deployment.','LOW');
    const jsonld=[...d.querySelectorAll('script[type="application/ld+json"]')];
    if(!jsonld.length)add(p,'schema','JSON-LD not detected','No JSON-LD blocks found; other structured-data formats may exist.',evidence('JSON-LD script count = 0','structured_data'),'Assess relevant structured data based on approved business facts.','LOW','MEDIUM');
    for(const node of jsonld){try{const parsed=JSON.parse(node.textContent);if(!parsed||typeof parsed!=='object')throw Error();}catch{add(p,'schema','Invalid JSON-LD syntax','A JSON-LD block cannot be parsed as a JSON object/array.',evidence('JSON.parse failed for a JSON-LD block','structured_data'),'Correct and validate structured data syntax.');}}
    const scripts=[...d.querySelectorAll('script[src]')];
    const ga=/G-[A-Z0-9]{4,}|googletagmanager\.com\/gtag\/js/.test(p.body),gtm=/GTM-[A-Z0-9]+/.test(p.body);
    if(!ga&&!gtm)add(p,'analytics','GA4/GTM markers not detected in source','Consent-loaded, server-side or dynamically injected tracking may not be visible.',evidence('No GA4/GTM marker in sampled HTML'),'Connect analytics and confirm a correlated test event before claiming tracking works.','MEDIUM','MEDIUM');
    if(!links.some(a=>/^(tel:|mailto:)|book|appointment|contact|quote/i.test(a.getAttribute('href')))&&!has('form'))add(p,'conversion','No obvious contact action in sampled HTML','No form or recognized contact link was found on this page; rendered JS may differ.',evidence('form count = 0; recognized contact links = 0'),'Review the rendered customer journey and add a clear approved contact action.','MEDIUM','MEDIUM');
    if(scripts.length>20)add(p,'performance','Many external scripts need review','Script count is measured; execution cost and unused code are not.',evidence(`${scripts.length} script[src] elements`),'Measure usage before removing or deferring scripts.','LOW','MEDIUM');
    if(p.bytes>500000)add(p,'performance','Large HTML response','This is response size, not total page weight.',evidence(`${p.bytes} response bytes`,'measured_metric'),'Profile HTML payload and page composition.');
    if(p.ttfbMs>1500)add(p,'performance','Slow response in this sample','One server-location sample; not field TTFB or a Core Web Vitals result.',evidence(`${p.ttfbMs} ms until response headers`,'measured_metric'),'Repeat measurements and investigate hosting/cache.','MEDIUM','MEDIUM');
    if(aiVisibility&&!text)add(p,'ai','No text in static page body','Search/AI readability requires further rendering checks.',evidence('body text length = 0'),'Publish factual crawlable content.','MEDIUM','MEDIUM');
    const ecommerce=has('[itemtype*="Product"]')||/"@type"\s*:\s*"Product"/.test(p.body)||links.some(a=>/\/cart\b/.test(a.getAttribute('href')));
    if(ecommerce)coverage.ecommerce={status:'MANUAL_REVIEW_REQUIRED',limitations:['Checkout and product journeys were not submitted or purchased.']};
    dom.window.close();
  }
  for(const k of ['crm','capture','booking','reputation','local','clarity','trust'])coverage[k]={status:'CONNECTION_OR_REVIEW_REQUIRED',limitations:['A public HTML scan cannot verify internal workflows, delivery, policies or business facts.']};
  coverage.performance={status:'PARTIAL',limitations:['LCP, INP and CLS NOT MEASURED. No Lighthouse/CrUX integration. TTFB is a single sample. Unused JS/CSS, visual mobile layout, contrast and interactions not measured.']};
  coverage.analytics={status:'PARTIAL',limitations:['Markers only; no conversion event receipt verified.']};
  coverage.ecommerce.status=coverage.ecommerce.status==='OBSERVATION_ONLY'?'NOT_APPLICABLE_OR_UNDETECTED':coverage.ecommerce.status;
  if(!aiVisibility)coverage.ai={status:'DISABLED',limitations:[]};
  const rank={HIGH:3,MEDIUM:2,LOW:1};findings.sort((a,b)=>rank[b.confidence]-rank[a.confidence]||rank[b.severity]-rank[a.severity]);
  return {version:1,title:'QONVEXA GROWTH AUDIT',observedAt:observations.observedAt,expiresAt:new Date(Date.now()+86400000).toISOString(),findings,coverage,recommendations:recommendations(findings),summary:{pagesChecked:observations.pages.length,issues:findings.length,claim:'Observed technical issues and review opportunities; revenue impact is not measured.'},disclaimers:['Automated accessibility checks do not constitute legal certification.','No guaranteed SEO ranking, AI recommendation or revenue increase.'],pageFacts:observations.pages.map(p=>({url:p.url,status:p.status,bytes:p.bytes,ttfbMs:p.ttfbMs,redirects:p.redirects,observedAt:p.observedAt})),ancillaryFacts:observations.ancillary.map(p=>({url:p.url,status:p.status||null,unavailable:!!p.unavailable})),limits:observations.limits};
}
export function preview(report) {const strong=report.findings.filter(f=>f.confidence==='HIGH').slice(0,3);return {title:report.title,observedAt:report.observedAt,expiresAt:report.expiresAt,findings:strong,additionalIssues:report.findings.length-strong.length,summary:{pagesChecked:report.summary.pagesChecked},limitations:report.disclaimers};}
