import dns from 'node:dns/promises';
import net from 'node:net';

export const MACHINE_PRODUCTS = Object.freeze([
  {
    id:'site-snapshot',
    name:'Site Snapshot',
    path:'/api/autonomos/v1/site-snapshot',
    description:'Fast structured website snapshot: status, metadata, headings, forms, links and basic conversion signals.',
    priceUsd:0.02,
    tags:['website','research','conversion']
  },
  {
    id:'robots-audit',
    name:'Robots & Sitemap Audit',
    path:'/api/autonomos/v1/robots-audit',
    description:'Checks robots.txt and sitemap.xml availability and returns structured crawlability signals.',
    priceUsd:0.01,
    tags:['seo','website','crawl']
  },
  {
    id:'security-headers',
    name:'Security Header Check',
    path:'/api/autonomos/v1/security-headers',
    description:'Checks common HTTP security headers and returns a compact machine-readable score.',
    priceUsd:0.02,
    tags:['security','headers','website']
  },
  {
    id:'conversion-signals',
    name:'Conversion Signals',
    path:'/api/autonomos/v1/conversion-signals',
    description:'Deterministic conversion-readiness scan for viewport, CTAs, forms, contact paths and metadata.',
    priceUsd:0.03,
    tags:['conversion','website','audit']
  },
  {
    id:'technology-fingerprint',
    name:'Technology Fingerprint',
    path:'/api/autonomos/v1/technology-fingerprint',
    description:'Detects common web frameworks, analytics, commerce and CMS signals from public page markup and headers.',
    priceUsd:0.025,
    tags:['technology','website','code']
  },
  {
    id:'copy-clarity-signals',
    name:'Copy Clarity Signals',
    path:'/api/autonomos/v1/copy-clarity-signals',
    description:'Deterministic readability and action-language scan of public landing-page copy with no paid model required.',
    priceUsd:0.025,
    tags:['content','conversion','website']
  }
]);

export function getProduct(id) { return MACHINE_PRODUCTS.find(item => item.id === id) || null; }

export async function executeProduct(productId, query = {}) {
  const product = getProduct(productId);
  if (!product) throw new ProductError('unknown_product', 404);
  const target = await validatePublicUrl(query.url);
  if (productId === 'site-snapshot') return siteSnapshot(target);
  if (productId === 'robots-audit') return robotsAudit(target);
  if (productId === 'security-headers') return securityHeaders(target);
  if (productId === 'conversion-signals') return conversionSignals(target);
  if (productId === 'technology-fingerprint') return technologyFingerprint(target);
  if (productId === 'copy-clarity-signals') return copyClaritySignals(target);
  throw new ProductError('unsupported_product', 400);
}

export async function validatePublicUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new ProductError('invalid_url', 400); }
  if (!['http:','https:'].includes(url.protocol)) throw new ProductError('invalid_protocol', 400);
  if (url.username || url.password) throw new ProductError('credentials_in_url_not_allowed', 400);
  if (!url.hostname || url.hostname.length > 253) throw new ProductError('invalid_hostname', 400);
  await assertPublicHostname(url.hostname);
  return url;
}

async function siteSnapshot(url) {
  const started = Date.now();
  const fetched = await safeFetch(url, { method:'GET', maxBytes:1_000_000, requireSuccess:true, requireHtml:true });
  const html = fetched.text;
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i)
    || firstMatch(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i);
  const h1 = matches(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi).map(stripTags).slice(0,5);
  const forms = count(html, /<form\b/gi);
  const links = count(html, /<a\b/gi);
  const buttons = count(html, /<(button\b|input[^>]+type=["'](?:submit|button)["'])/gi);
  const images = count(html, /<img\b/gi);
  const missingAlt = matches(html, /<img\b[^>]*>/gi).filter(tag => !/\balt\s*=\s*["'][^"']*["']/i.test(tag)).length;
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const lang = firstMatch(html, /<html[^>]+lang=["']([^"']+)["']/i);
  const canonical = firstMatch(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || firstMatch(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const ctaTerms = ['book','schedule','contact','buy','start','get started','request','quote','call','order','demo','audit'];
  const normalizedText = stripTags(html).toLowerCase();
  const ctaHits = ctaTerms.filter(term => containsWord(normalizedText, term));

  return {
    product:'site-snapshot',
    target:url.toString(),
    finalUrl:fetched.finalUrl,
    httpStatus:fetched.status,
    loadMs:Date.now()-started,
    contentType:fetched.contentType,
    bytes:fetched.bytes,
    title:cleanText(title,240),
    description:cleanText(description,500),
    h1:h1.map(x=>cleanText(x,240)),
    lang:cleanText(lang,30),
    canonical:cleanText(canonical,1000),
    counts:{ forms, links, buttons, images, imagesMissingAlt:missingAlt },
    signals:{ viewport, ctaTerms:ctaHits, hasContactLink:/href=["'](?:mailto:|tel:)/i.test(html) },
    generatedAt:new Date().toISOString()
  };
}

async function robotsAudit(url) {
  const root = new URL(url.origin);
  const robotsUrl = new URL('/robots.txt', root);
  const sitemapUrl = new URL('/sitemap.xml', root);
  const [robots, sitemap] = await Promise.allSettled([
    safeFetch(robotsUrl, { method:'GET', maxBytes:250_000 }),
    safeFetch(sitemapUrl, { method:'GET', maxBytes:500_000 })
  ]);
  const robotsValue = robots.status === 'fulfilled' ? robots.value : null;
  const sitemapValue = sitemap.status === 'fulfilled' ? sitemap.value : null;
  const robotsText = robotsValue?.text || '';
  const sitemapText = sitemapValue?.text || '';
  return {
    product:'robots-audit',
    target:url.origin,
    robots:{
      url:robotsUrl.toString(),
      reachable:Boolean(robotsValue && robotsValue.status >= 200 && robotsValue.status < 400),
      status:robotsValue?.status || 0,
      userAgentBlocks:count(robotsText,/^\s*user-agent\s*:/gim),
      disallowRules:count(robotsText,/^\s*disallow\s*:/gim),
      sitemapReferences:matches(robotsText,/^\s*sitemap\s*:\s*(.+)$/gim).map(x=>x.split(':').slice(1).join(':').trim()).slice(0,20)
    },
    sitemap:{
      url:sitemapUrl.toString(),
      reachable:Boolean(sitemapValue && sitemapValue.status >= 200 && sitemapValue.status < 400),
      status:sitemapValue?.status || 0,
      urlEntries:count(sitemapText,/<url\b/gi),
      sitemapEntries:count(sitemapText,/<sitemap\b/gi)
    },
    generatedAt:new Date().toISOString()
  };
}

async function securityHeaders(url) {
  const fetched = await safeFetch(url, { method:'GET', maxBytes:80_000, requireSuccess:true, requireHtml:true });
  const headers = fetched.headers;
  const checks = {
    strictTransportSecurity:Boolean(headers['strict-transport-security']),
    contentSecurityPolicy:Boolean(headers['content-security-policy']),
    xContentTypeOptions:/nosniff/i.test(headers['x-content-type-options'] || ''),
    frameProtection:Boolean(headers['x-frame-options'] || /frame-ancestors/i.test(headers['content-security-policy'] || '')),
    referrerPolicy:Boolean(headers['referrer-policy']),
    permissionsPolicy:Boolean(headers['permissions-policy'])
  };
  const passed = Object.values(checks).filter(Boolean).length;
  return {
    product:'security-headers',
    target:url.toString(),
    finalUrl:fetched.finalUrl,
    httpStatus:fetched.status,
    score:Math.round(passed / Object.keys(checks).length * 100),
    checks,
    headers:{
      'strict-transport-security':headers['strict-transport-security'] || '',
      'content-security-policy':headers['content-security-policy'] || '',
      'x-content-type-options':headers['x-content-type-options'] || '',
      'x-frame-options':headers['x-frame-options'] || '',
      'referrer-policy':headers['referrer-policy'] || '',
      'permissions-policy':headers['permissions-policy'] || ''
    },
    generatedAt:new Date().toISOString()
  };
}

async function conversionSignals(url) {
  const snapshot = await siteSnapshot(url);
  const signals = [
    { id:'mobile-viewport', label:'Mobile viewport declared', pass:Boolean(snapshot.signals.viewport), weight:15 },
    { id:'primary-headline', label:'At least one H1 exists', pass:snapshot.h1.length > 0, weight:15 },
    { id:'meta-description', label:'Meta description exists', pass:Boolean(snapshot.description), weight:10 },
    { id:'action-controls', label:'Buttons or forms exist', pass:snapshot.counts.buttons + snapshot.counts.forms > 0, weight:20 },
    { id:'contact-path', label:'Direct email/phone path exists', pass:Boolean(snapshot.signals.hasContactLink), weight:15 },
    { id:'cta-language', label:'Action language detected', pass:snapshot.signals.ctaTerms.length > 0, weight:15 },
    { id:'image-alt', label:'Most images have alt text', pass:snapshot.counts.images === 0 || snapshot.counts.imagesMissingAlt / snapshot.counts.images <= .2, weight:10 }
  ];
  const score = signals.reduce((sum,item)=>sum+(item.pass?item.weight:0),0);
  return {
    product:'conversion-signals',
    target:url.toString(),
    score,
    grade:score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F',
    signals,
    summary:{ title:snapshot.title, h1:snapshot.h1[0] || '', ctaTerms:snapshot.signals.ctaTerms, counts:snapshot.counts },
    generatedAt:new Date().toISOString()
  };
}


async function technologyFingerprint(url) {
  const fetched = await safeFetch(url, { method:'GET', maxBytes:1_000_000, requireSuccess:true, requireHtml:true });
  const html = fetched.text.toLowerCase();
  const headerText = JSON.stringify(fetched.headers).toLowerCase();
  const detections = [
    ['wordpress', /wp-content|wp-includes|wordpress/],
    ['shopify', /cdn\.shopify\.com|shopify-section|x-shopid/],
    ['wix', /wixstatic\.com|wix-code-sdk/],
    ['squarespace', /static1\.squarespace\.com|squarespace/],
    ['webflow', /webflow\.com|data-wf-page/],
    ['next.js', /__next_data__|\/_next\//],
    ['react', /data-reactroot|react-dom|__react/],
    ['vue', /data-v-|__vue__|vue\.runtime/],
    ['google analytics', /googletagmanager\.com|google-analytics\.com|gtag\(/],
    ['meta pixel', /connect\.facebook\.net\/.*fbevents|fbq\(/],
    ['stripe', /js\.stripe\.com|stripe-checkout/],
    ['hubspot', /js\.hs-scripts\.com|hubspot/]
  ].filter(([,pattern])=>pattern.test(html) || pattern.test(headerText)).map(([name])=>name);
  return {
    product:'technology-fingerprint',
    target:url.toString(),
    finalUrl:fetched.finalUrl,
    httpStatus:fetched.status,
    technologies:detections,
    server:fetched.headers.server || '',
    poweredBy:fetched.headers['x-powered-by'] || '',
    generatedAt:new Date().toISOString()
  };
}

async function copyClaritySignals(url) {
  const fetched = await safeFetch(url, { method:'GET', maxBytes:1_000_000, requireSuccess:true, requireHtml:true });
  const text = stripTags(fetched.text);
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+/).map(x=>x.trim()).filter(Boolean);
  const avgWordsPerSentence = sentences.length ? words.length / sentences.length : words.length;
  const actionTerms = ['book','schedule','contact','start','buy','order','request','quote','call','demo','try','audit','get started'];
  const lower = text.toLowerCase();
  const actionHits = actionTerms.filter(term=>containsWord(lower,term));
  const first120 = words.slice(0,120).join(' ').toLowerCase();
  const earlyAction = actionTerms.some(term=>containsWord(first120,term));
  const score = Math.max(0, Math.min(100,
    (words.length >= 80 ? 20 : 10) +
    (avgWordsPerSentence > 0 && avgWordsPerSentence <= 24 ? 25 : 10) +
    (actionHits.length ? 25 : 0) +
    (earlyAction ? 20 : 0) +
    (/<h1\b/i.test(fetched.text) ? 10 : 0)
  ));
  return {
    product:'copy-clarity-signals',
    target:url.toString(),
    score,
    metrics:{ wordCount:words.length, sentenceCount:sentences.length, avgWordsPerSentence:Math.round(avgWordsPerSentence*10)/10, earlyAction },
    actionTerms:actionHits,
    generatedAt:new Date().toISOString()
  };
}

async function safeFetch(initialUrl, { method='GET', maxBytes=1_000_000, requireSuccess=true, requireHtml=false } = {}) {
  let current = initialUrl instanceof URL ? new URL(initialUrl) : await validatePublicUrl(initialUrl);
  for (let hop=0; hop<4; hop += 1) {
    await assertPublicHostname(current.hostname);
    const response = await fetch(current, {
      method,
      redirect:'manual',
      headers:{
        'user-agent':'AutonomOS/1.0 (+machine-service; owner=QONVEXA)',
        'accept':'text/html,text/plain,application/xml,application/xhtml+xml;q=0.9,*/*;q=0.2'
      },
      signal:AbortSignal.timeout(12000)
    });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new ProductError('redirect_without_location', 502);
      current = await validatePublicUrl(new URL(location, current).toString());
      continue;
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (requireSuccess && (response.status < 200 || response.status >= 300)) throw new ProductError(`upstream_http_${response.status}`, 502);
    const contentType=String(response.headers.get('content-type')||'').toLowerCase();
    if (requireHtml && contentType && !/(text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType)) throw new ProductError('unexpected_content_type', 502);
    if (declared > maxBytes) throw new ProductError('response_too_large', 413);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new ProductError('response_too_large', 413);
    return {
      status:response.status,
      finalUrl:current.toString(),
      contentType:response.headers.get('content-type') || '',
      bytes:buffer.byteLength,
      text:buffer.toString('utf8'),
      headers:Object.fromEntries(response.headers.entries())
    };
  }
  throw new ProductError('too_many_redirects', 508);
}

async function assertPublicHostname(hostname) {
  const lower = String(hostname || '').toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) throw new ProductError('private_host_blocked', 400);
  if (net.isIP(lower)) {
    if (isPrivateIp(lower)) throw new ProductError('private_ip_blocked', 400);
    return;
  }
  let addresses;
  try { addresses = await dns.lookup(lower, { all:true, verbatim:true }); }
  catch { throw new ProductError('dns_resolution_failed', 400); }
  if (!addresses.length || addresses.some(item => isPrivateIp(item.address))) throw new ProductError('private_or_unroutable_host_blocked', 400);
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a,b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff');
  }
  return true;
}

function firstMatch(text, regex) { const match = String(text || '').match(regex); return match?.[1] || ''; }
function matches(text, regex) { return [...String(text || '').matchAll(regex)].map(item=>item[0]); }
function count(text, regex) { return matches(text, regex).length; }
function stripTags(value) { return String(value || '').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim(); }
function cleanText(value, max) { return stripTags(value).slice(0,max); }
// Naive substring matching let single-word CTA terms match inside unrelated words —
// 'order' inside 'disorder'/'coordinate', 'call' inside 'recall'/'callback' — inflating
// the detected action-language score on ordinary pages that never use a call-to-action.
function containsWord(hay, phrase) {
  const escaped = String(phrase).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`\\b${escaped}\\b`,'i').test(hay);
}

export class ProductError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.code = message; }
}
