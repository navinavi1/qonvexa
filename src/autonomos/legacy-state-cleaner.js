import fs from 'node:fs';
import path from 'node:path';

export const OBSOLETE_MARKET_SOURCES=Object.freeze(new Set([
  't2000','superteam','clawjobs','laborx','dework','bountycaster','questbook'
]));

const PERMANENT_NOISE=/\b(?:buyer_funding_unavailable|insufficient_balance|market_job_configuration_invalid|bad_request|job_not_open|status_not_open|expired|closed|source_disabled_by_owner)\b/i;

function sourceOf(row={}){
  return String(row.source||row.market||row.marketplace||row?.raw?.source||'').toLowerCase().replace(/\s+/g,'');
}
function obsolete(row={}){
  const s=sourceOf(row);return OBSOLETE_MARKET_SOURCES.has(s)||s.startsWith('t2000');
}
function readJson(file,fallback={}){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return structuredClone(fallback);}}
function writeJson(file,value){const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);}
function rewriteNdjson(file,predicate){
  if(!fs.existsSync(file))return 0;const raw=fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean);let removed=0;const kept=[];
  for(const line of raw){let row;try{row=JSON.parse(line);}catch{kept.push(line);continue;}if(predicate(row)){removed++;continue;}kept.push(JSON.stringify(row));}
  if(removed){const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,kept.length?kept.join('\n')+'\n':'',{mode:0o600});fs.renameSync(tmp,file);}return removed;
}

export function cleanLegacyAutonomOSState({storageDir='',env=process.env,logger=console}={}){
  const root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');fs.mkdirSync(root,{recursive:true});
  const removed={registry:0,hunter:0,actions:0,credentials:0,ndjson:0,staleFailures:0};

  const registryFile=path.join(root,'job-registry.json');const registry=readJson(registryFile,{});let registryChanged=false;
  for(const [key,row] of Object.entries(registry||{})){
    const legacy=obsolete(row)||[...OBSOLETE_MARKET_SOURCES].some(s=>String(key).toLowerCase().startsWith(`${s}:`));
    const stale=PERMANENT_NOISE.test(String(row?.reason||row?.failureReason||row?.reasonCode||''))&&Date.parse(String(row?.updatedAt||row?.lastSeenAt||row?.at||0))<Date.now()-24*60*60_000;
    if(legacy||stale){delete registry[key];registryChanged=true;removed.registry++;if(stale&&!legacy)removed.staleFailures++;}
  }
  if(registryChanged)writeJson(registryFile,registry);

  const hunterFile=path.join(root,'global-work-hunter.json');const hunter=readJson(hunterFile,{});let hunterChanged=false;
  for(const bucket of ['leads','ignored'])if(hunter?.[bucket]&&typeof hunter[bucket]==='object')for(const [id,row] of Object.entries(hunter[bucket]))if(obsolete(row)){delete hunter[bucket][id];hunterChanged=true;removed.hunter++;}
  if(hunterChanged)writeJson(hunterFile,hunter);

  const actionFile=path.join(root,'global-lead-actioner.json');const actioner=readJson(actionFile,{});let actionChanged=false;
  if(actioner?.actions&&typeof actioner.actions==='object')for(const [id,row] of Object.entries(actioner.actions))if(obsolete(row)){delete actioner.actions[id];actionChanged=true;removed.actions++;}
  if(actionChanged)writeJson(actionFile,actioner);

  const credentialsFile=path.join(root,'credentials.private.json');const credentials=readJson(credentialsFile,{});let credentialChanged=false;
  for(const source of OBSOLETE_MARKET_SOURCES)if(Object.prototype.hasOwnProperty.call(credentials,source)){delete credentials[source];credentialChanged=true;removed.credentials++;}
  if(credentialChanged)writeJson(credentialsFile,credentials);

  const globalSecrets=path.join(root,'global-work-credentials.private.json');const secrets=readJson(globalSecrets,{});let secretsChanged=false;
  for(const source of OBSOLETE_MARKET_SOURCES)if(Object.prototype.hasOwnProperty.call(secrets,source)){delete secrets[source];secretsChanged=true;removed.credentials++;}
  if(secretsChanged)writeJson(globalSecrets,secrets);

  for(const name of ['jobs.ndjson','marketplace-events.ndjson','execution-events.ndjson','job-events.ndjson','opportunities.ndjson']){
    removed.ndjson+=rewriteNdjson(path.join(root,name),row=>obsolete(row)||(PERMANENT_NOISE.test(String(row?.reason||row?.error||row?.reasonCode||''))&&Date.parse(String(row?.at||row?.updatedAt||0))<Date.now()-7*24*60*60_000));
  }

  for(const generated of ['global-work-feed.json','global-work-archive.json']){const file=path.join(root,generated);try{fs.rmSync(file,{force:true});}catch{}}
  try{logger.info?.('[LegacyStateCleaner] '+JSON.stringify({at:new Date().toISOString(),...removed,obsoleteSources:[...OBSOLETE_MARKET_SOURCES]}));}catch{}
  return removed;
}
