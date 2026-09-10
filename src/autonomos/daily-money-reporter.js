import { hardenedMoneyRefresh } from './revenue-lifecycle.js';
import fs from 'node:fs';
import path from 'node:path';
import { allocateRevenue } from './profit-engine.js';
import { DEFAULT_AUTONOMOS_CONFIG, normalizeConfig } from './policy-engine.js';
import { readJson, round } from './util.js';

export class DailyMoneyReporter{
  constructor({env=process.env,storageDir='',logger=console}={}){this.env=env;this.logger=logger;this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');fs.mkdirSync(this.root,{recursive:true});this.file=path.join(this.root,'money-report.json');this.publicFile=path.join(process.cwd(),'public','autonomos-money-report.json');this.timer=null;this.lastDaily='';}
  start(){if(this.timer)return;const every=Math.max(5*60_000,Number(this.env.AUTONOMOS_MONEY_REPORT_MS||15*60_000));this.refresh();this.timer=setInterval(()=>this.refresh(),every);this.timer.unref?.();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  refresh(){return hardenedMoneyRefresh.call(this);}

}

function readNdjson(file){try{return fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);}catch{return[];}}
function writeJson(file,value,mode){const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode});fs.renameSync(tmp,file);}

