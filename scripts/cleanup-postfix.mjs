import fs from 'node:fs';
const read=p=>fs.readFileSync(p,'utf8');const write=(p,s)=>fs.writeFileSync(p,s);
let s=read('src/autonomos/tools.js');
s=s.replace(/if \(name === 'web_search'\) \{[\s\S]*?\n\s*\}\n\s*else if \(name === 'web_scrape'\)/,"if (name === 'web_search') result = await freeWebSearch(args?.query, env, signal);\n  else if (name === 'web_scrape')");
s=s.replace(/^.*(?:TAVILY|FIRECRAWL|Firecrawl|Tavily).*\n/gm,'');
write('src/autonomos/tools.js',s);

s=read('public/admin.html');
s=s.replace(/^.*(?:Superteam min|t2000 min|t2000 priority|t2000 premium).*\n/gmi,'');
write('public/admin.html',s);

console.log('[cleanup-postfix] remaining paid-search/browser and obsolete dashboard controls removed');
// audit-alignment-2
