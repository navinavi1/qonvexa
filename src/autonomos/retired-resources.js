import fs from 'node:fs';
const registry=JSON.parse(fs.readFileSync(new URL('./retired-resources.json',import.meta.url),'utf8'));
const key=v=>String(v||'').toLowerCase().replace(/[\s_-]/g,'');
export function retiredResources(){return structuredClone(registry);}
export function isRetiredResource(value,kind='markets'){
  const row=typeof value==='string'?{id:value,url:value}:value||{};
  const names=[row.id,row.source,row.marketplace,row.marketId,row.marketName,row.provider,row.name].filter(Boolean).map(key);
  const urls=[row.url,row.URL,row.sourceUrl,row.homepage,row.host,row.marketHost].filter(Boolean);
  return (registry[kind]||[]).some(r=>{
    const aliases=[r.id,...r.aliases||[]];
    if(aliases.some(a=>names.includes(key(a))))return true;
    return urls.some(v=>{try{const h=new URL(String(v).includes('://')?v:`https://${v}`).hostname.toLowerCase().replace(/\.$/,'');return aliases.filter(a=>a.includes('.')).some(a=>h===a||h.endsWith('.'+a));}catch{return false;}});
  });
}
