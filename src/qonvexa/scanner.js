import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { JSDOM } from 'jsdom';
export function publicIP(ip) {
  if(net.isIP(ip)===4){const [a,b,c]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
  if(net.isIP(ip)===6){const x=ip.toLowerCase();return /^2[0-9a-f]{3}:|^3[0-9a-f]{3}:/.test(x)&&!/^2001:|^2002:|^3fff:/.test(x);}
  return false;
}
export function normalizeURL(value) {
  const u=new URL(value);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port&&!['80','443'].includes(u.port))throw new Error('UNSAFE_URL');
  const h=u.hostname.replace(/^\[|\]$/g,'');
  if(h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||net.isIP(h)&&!publicIP(h))throw new Error('UNSAFE_URL');
  if([...u.searchParams.keys()].some(k=>/^(?:token|access_token|api_key|apikey|password|secret|authorization|code)$/i.test(k)))throw new Error('SENSITIVE_URL');
  u.hash='';return u.href;
}
export async function safeGet(value,{maxBytes=750000,timeoutMs=7000,maxRedirects=3,origin,headers={},resolve=dns.lookup}={}) {
  let current=normalizeURL(value);const redirects=[];
  for(let i=0;i<=maxRedirects;i++){
    const u=new URL(current),host=u.hostname.replace(/^\[|\]$/g,'');
    if(origin&&u.origin!==origin)throw new Error('CROSS_ORIGIN_REDIRECT');
    let dnsTimer;
    const addresses=await Promise.race([resolve(host,{all:true,verbatim:true}),new Promise((_,reject)=>{dnsTimer=setTimeout(()=>reject(new Error('DNS_TIMEOUT')),timeoutMs);})]).finally(()=>clearTimeout(dnsTimer));
    if(!addresses.length||addresses.some(x=>!publicIP(x.address)))throw new Error('UNSAFE_DNS');
    const pinned=addresses[0],start=performance.now();
    const response=await new Promise((resolveResponse,reject)=>{
      // Pin the validated IP to the actual socket; do not re-resolve after validation.
      const req=(u.protocol==='https:'?https:http).get(u,{agent:false,headers:{'user-agent':'QonvexaAudit/1.0','accept':'text/html,application/json,text/plain,application/xml','accept-encoding':'identity',...headers},lookup:(_h,options,cb)=>options.all?cb(null,[pinned]):cb(null,pinned.address,pinned.family)},res=>{
        const chunks=[];let bytes=0;const ttfbMs=Math.round(performance.now()-start);
        if([301,302,303,307,308].includes(res.statusCode)){res.destroy();resolveResponse({status:res.statusCode,headers:res.headers,body:'',bytes:0,ttfbMs});return;}
        if(res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity'){res.destroy();reject(new Error('CONTENT_ENCODING_BLOCKED'));return;}
        const type=String(res.headers['content-type']||'').toLowerCase();
        if(!/text\/|application\/(?:json|ld\+json|xml|xhtml\+xml)/.test(type)){res.destroy();reject(new Error('CONTENT_TYPE_BLOCKED'));return;}
        res.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes){req.destroy(new Error('BYTE_LIMIT'));return;}chunks.push(chunk);});
        res.on('end',()=>resolveResponse({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8'),bytes,ttfbMs}));
        res.on('error',reject);
      });
      const timer=setTimeout(()=>req.destroy(new Error('FETCH_TIMEOUT')),timeoutMs);timer.unref();req.on('close',()=>clearTimeout(timer));req.on('error',reject);
    });
    if([301,302,303,307,308].includes(response.status)){
      if(!response.headers.location)throw new Error('INVALID_REDIRECT');
      const next=normalizeURL(new URL(response.headers.location,current).href);
      // Never forward authentication headers on redirects.
      if(Object.keys(headers).length)throw new Error('AUTH_REDIRECT_BLOCKED');
      redirects.push({from:current,to:next,status:response.status});current=next;continue;
    }
    return {...response,url:current,redirects,observedAt:new Date().toISOString()};
  }
  throw new Error('REDIRECT_LIMIT');
}
export async function crawl(url,cfg,{paid=false,fetchPage=safeGet}={}) {
  const initial=normalizeURL(url),pages=[],queue=[initial],seen=new Set();let origin=new URL(initial).origin;
  const maxPages=paid?cfg.paidPages:cfg.freePages;
  while(queue.length&&pages.length<maxPages){
    const next=queue.shift();if(seen.has(next))continue;seen.add(next);
    const page=await fetchPage(next,{...cfg,origin:pages.length?origin:undefined});
    if(!pages.length)origin=new URL(page.url).origin;
    pages.push(page);
    if(!String(page.headers['content-type']).includes('html'))continue;
    const dom=new JSDOM(page.body);const d=dom.window.document;
    for(const a of d.querySelectorAll('a[href]')){
      try {const u=new URL(a.getAttribute('href'),page.url);u.hash='';if(u.origin===origin&&!u.search&&!/\.(pdf|zip|png|jpg|mp4)$/i.test(u.pathname)&&queue.length<maxPages*3&&!seen.has(u.href))queue.push(u.href);}catch{}
    }dom.window.close();
  }
  const ancillary=[];
  for(const pathname of ['/robots.txt','/sitemap.xml']){
    try{ancillary.push(await fetchPage(origin+pathname,{...cfg,origin,maxBytes:Math.min(cfg.maxBytes,100000)}));}catch{ancillary.push({url:origin+pathname,unavailable:true});}
  }
  return {pages,ancillary,limits:{maxPages,maxBytesPerPage:cfg.maxBytes,concurrency:1},observedAt:new Date().toISOString()};
}
