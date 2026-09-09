import fs from 'node:fs';
const read=p=>fs.readFileSync(p,'utf8');const write=(p,s)=>fs.writeFileSync(p,s);
let s=read('src/autonomos/tools.js');
s=s.replace(/if \(name === 'web_search'\) \{[\s\S]*?\n\s*\}\n\s*else if \(name === 'web_scrape'\)/,"if (name === 'web_search') result = await freeWebSearch(args?.query, env, signal);\n  else if (name === 'web_scrape')");
s=s.replace(/^.*(?:TAVILY|FIRECRAWL|Firecrawl|Tavily).*\n/gm,'');
write('src/autonomos/tools.js',s);

s=read('src/autonomos/runtime.js');
s=s.replace(/\n\s*\)\{\n\s*const status=await t2000OAuth\.finishConnect\(query\);[\s\S]*?\n\s*async refreshTreasury\(\)\{/m,'\n    async refreshTreasury(){');
s=s.replace(/\n\s*archiveLegacyHistory\(\)\{[\s\S]*?\n\s*\},\n\s*(?=async reconcilePayments|async refreshTreasury|refreshTreasury)/m,'\n');
write('src/autonomos/runtime.js',s);

s=read('public/admin.html');
s=s.replace(/^.*(?:Superteam min|t2000 min|t2000 priority|t2000 premium).*\n/gmi,'');
s=s.replace(/\s*<section class="admin-panel autonomos-panel">\s*<div class="admin-panel-head"><div><small>MAINTENANCE<\/small>[\s\S]*?Archive Legacy History \/ Start Clean V7 History[\s\S]*?<\/section>\s*/i,'\n');
write('public/admin.html',s);

s=read('public/admin.js');
const a=s.indexOf("el('#autonomos-archive-legacy')?.addEventListener");
if(a>=0){const b=s.indexOf("el('#autonomos-config-form')?.addEventListener",a);if(b>a)s=s.slice(0,a)+s.slice(b);}
write('public/admin.js',s);

console.log('[cleanup-postfix] remaining paid-search/browser, T2000 runtime, and legacy maintenance controls removed');
