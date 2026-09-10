import fs from 'node:fs';
import { isRetiredMarket } from './retired-markets.js';
import { isRetiredResource } from './retired-resources.js';
import path from 'node:path';
import { FREE_SKILL_MATRIX } from './free-capability-layer.js';
import { readJson, writeJson } from './util.js';

const SUCCESS=/^(paid|settled|client_accepted)$/i;
const FAILURE=/^(rejected|archived|failed|qa_failed|repair_exhausted|accepted_repair_exhausted|submission_failed|submit_failed)$/i;

export class SkillLibraryWorker{
  constructor({env=process.env,storageDir='',logger=console}={}){this.env=env;this.logger=logger;this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');fs.mkdirSync(this.root,{recursive:true});this.file=path.join(this.root,'adaptive-skill-library.json');this.timer=null;}
  start(){if(this.timer)return;const every=Math.max(5*60_000,Number(this.env.AUTONOMOS_SKILL_LIBRARY_MS||30*60_000));this.refresh();this.timer=setInterval(()=>this.refresh(),every);this.timer.unref?.();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  refresh(){try{
    const hunter=readJson(path.join(this.root,'global-work-hunter.json'),{});const actioner=readJson(path.join(this.root,'global-lead-actioner.json'),{});const agrenting=readJson(path.join(this.root,'agrenting-worker.json'),readJson(path.join(this.root,'agrenting-live-worker.json'),{}));const taskforce=readJson(path.join(this.root,'taskforce-worker.json'),{});
    const stats={};const observe=(skill,status,source='unknown',error='')=>{if(isRetiredMarket(source)||isRetiredResource(skill,'skills'))return;const key=String(skill||'general-digital');const row=stats[key]||={skill:key,attempts:0,successes:0,failures:0,sources:{},lastError:''};row.attempts++;if(SUCCESS.test(String(status||'')))row.successes++;if(FAILURE.test(String(status||''))){row.failures++;if(error)row.lastError=String(error).slice(0,240);}row.sources[source]=(row.sources[source]||0)+1;};
    for(const [id,a] of Object.entries(actioner?.actions||{})){const lead=hunter?.leads?.[id]||{};observe(a?.skill||lead?.category,a?.status,lead?.freeSource||lead?.source||'global-web',a?.reason||a?.error);}
    for(const row of Object.values(agrenting?.hirings||{}))observe(row?.skill||row?.capability,row?.status,'agrenting',row?.error||row?.failureReason);
    for(const row of Object.values(taskforce?.tasks||{}))observe(row?.skill||row?.category,row?.status,'taskforce',row?.submitError||row?.error);
    const previous=readJson(this.file,{skills:{},history:[]});const skills={};for(const [skill,row] of Object.entries(stats)){const prior=previous.skills?.[skill]||{};const successRate=row.attempts?row.successes/row.attempts:0;skills[skill]={...prior,...row,successRate:Number(successRate.toFixed(4)),tools:[...(FREE_SKILL_MATRIX[skill]||FREE_SKILL_MATRIX['general-digital']||[])],priority:successRate>=0.7?'promote':row.failures>=3&&successRate<0.25?'deprioritize':'learn',updatedAt:new Date().toISOString()};}
    for(const [skill,tools] of Object.entries(FREE_SKILL_MATRIX))if(!isRetiredResource(skill,'skills')&&!skills[skill])skills[skill]={...(previous.skills?.[skill]||{}),skill,attempts:0,successes:0,failures:0,successRate:0,tools:[...tools],priority:'learn',updatedAt:new Date().toISOString()};
    const top=Object.values(skills).sort((a,b)=>Number(b.successRate)-Number(a.successRate)||Number(b.successes)-Number(a.successes)).slice(0,12).map(x=>({skill:x.skill,successRate:x.successRate,successes:x.successes,failures:x.failures,tools:x.tools}));
    const payload={...previous,generatedAt:new Date().toISOString(),mode:'adaptive_free_first',skills,topWorkflows:top,policy:{paidToolAutoload:false,freeFallbackFirst:true,retainSuccessfulProcedures:true,demoteRepeatedFailures:true},history:[{at:new Date().toISOString(),skillsObserved:Object.keys(stats).length},...(previous.history||[])].slice(0,100)};writeJson(this.file,payload);try{this.logger.info?.('[SkillLibrary] '+JSON.stringify({generatedAt:payload.generatedAt,skills:Object.keys(skills).length,observed:Object.keys(stats).length}));}catch{}
  }catch(error){try{this.logger.warn?.('[SkillLibrary] '+String(error?.message||error).slice(0,180));}catch{}}}
}


