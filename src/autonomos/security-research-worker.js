import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { AutonomOSStore } from './store.js';
import { independentCodeReview } from './independent-code-review.js';
import { createJobBudget } from './job-budget.js';
import { computeEarnedSpendBudgetUsd } from './profit-engine.js';
import { PROGRAM_FILE, FINDING_FILE, programsFromRegistry, normalizeFinding, findingId, rankFindings, reviewableFiles, queueSummary } from './security-research.js';

const now=()=>new Date().toISOString();
const git=(args,cwd,timeout)=>new Promise(resolve=>execFile('git',args,{cwd,timeout,maxBuffer:16*1024*1024},(error,stdout,stderr)=>resolve({code:error?(error.code??1):0,stdout:String(stdout||''),stderr:String(stderr||'')})));

export class SecurityResearchWorker{
  constructor(actioner,{env=actioner?.env,storageDir=actioner?.root,logger=console,review=independentCodeReview,clone=null}={}){
    this.a=actioner;this.env=env||process.env;this.root=storageDir;this.logger=logger;
    this.store=new AutonomOSStore(this.root);
    this.review=review;this.cloneImpl=clone;
    this.enabled=/^(1|true|yes|on)$/i.test(String(this.env.AUTONOMOS_SECURITY_RESEARCH_ENABLED||'false'));
    this.intervalMs=Math.max(300000,Number(this.env.AUTONOMOS_SECURITY_RESEARCH_INTERVAL_MS||3600000));
    this.filesPerProgram=Math.max(1,Number(this.env.AUTONOMOS_SECURITY_FILES_PER_PROGRAM||12));
    this.running=false;
  }
  start(){
    if(!this.enabled){this.logger?.info?.('[SecurityResearch] '+JSON.stringify({started:false,reason:'AUTONOMOS_SECURITY_RESEARCH_ENABLED is not set'}));return;}
    this.timer=setInterval(()=>this.tick().catch(e=>this.logger?.warn?.('[SecurityResearch] tick_error '+String(e.message).slice(0,200))),this.intervalMs);this.timer.unref?.();
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}

  programs(){return programsFromRegistry(this.store.readJson(PROGRAM_FILE,{programs:[]})).filter(program=>program.enabled);}

  async tick(){
    const config=this.a?.currentConfig?.()||{enabled:true,killSwitch:false};
    if(this.running||!config.enabled||config.killSwitch)return;
    this.running=true;
    try{
      const programs=this.programs();
      if(!programs.length){this.logger?.info?.('[SecurityResearch] '+JSON.stringify({programs:0,reason:'security-programs.json is empty'}));return;}
      const ledger=this.store.readNdjson('ledger.ndjson',-1);
      const limit=Math.min(computeEarnedSpendBudgetUsd(ledger,config),Number(config.maxPaidProcurementUsd||3));
      if(!(limit>0)){this.logger?.info?.('[SecurityResearch] '+JSON.stringify({skipped:true,reason:'no_earned_spend_budget'}));return;}
      for(const program of programs.slice(0,3))await this.scan(program,limit).catch(e=>this.logger?.warn?.('[SecurityResearch] '+program.programId+' '+String(e.message).slice(0,160)));
      this.logger?.info?.('[SecurityResearch] '+JSON.stringify(queueSummary(this.store.readJson(FINDING_FILE,{}))));
    }finally{this.running=false;}
  }

  async checkout(repo){
    if(this.cloneImpl)return this.cloneImpl(repo);
    const dir=path.join(this.root,'security-scopes',repo.replace(/[^a-z0-9._-]+/gi,'_'));
    const timeout=Math.max(60000,Number(this.env.AUTONOMOS_SECURITY_CLONE_TIMEOUT_MS||300000));
    if(fs.existsSync(path.join(dir,'.git'))){
      const pull=await git(['fetch','--depth','1','origin','HEAD'],dir,timeout);
      if(pull.code===0)await git(['reset','--hard','FETCH_HEAD'],dir,timeout);
      return dir;
    }
    fs.mkdirSync(path.dirname(dir),{recursive:true});
    const url=/^https?:\/\//.test(repo)?repo:'https://github.com/'+repo;
    const clone=await git(['clone','--depth','1',url,dir],this.root,timeout);
    if(clone.code!==0)throw Error('clone_failed_'+clone.code+':'+String(clone.stderr).slice(0,160));
    return dir;
  }

  listFiles(dir){
    const out=[];
    const walk=base=>{
      let entries=[];try{entries=fs.readdirSync(base,{withFileTypes:true});}catch{return;}
      for(const entry of entries){
        if(entry.name==='.git')continue;
        const full=path.join(base,entry.name);
        if(entry.isDirectory())walk(full);else out.push(path.relative(dir,full));
      }
    };
    walk(dir);
    return out;
  }

  async scan(program,spendLimitUsd){
    const queue=this.store.readJson(FINDING_FILE,{});
    for(const repo of program.scopeRepos.slice(0,2)){
      const dir=await this.checkout(repo);
      const candidates=reviewableFiles(this.listFiles(dir),{limit:this.filesPerProgram});
      if(!candidates.length)continue;
      const files=candidates.map(file=>{
        let content='';try{content=fs.readFileSync(path.join(dir,file),'utf8').slice(0,60000);}catch{}
        return{path:file,content};
      }).filter(file=>file.content);
      if(!files.length)continue;
      const budget=createJobBudget(Math.min(spendLimitUsd,Number(this.env.AUTONOMOS_SECURITY_SCAN_BUDGET_USD||0.5)),{env:this.env,jobId:'security_'+program.programId,onCost:n=>this.a?.recordCost?.('security_'+program.programId,n)});
      const result=await this.review({files,focus:'exploitable smart contract and protocol security vulnerabilities: access control, arithmetic, reentrancy, oracle manipulation, signature replay, upgrade and initialization safety. Report only issues with a concrete attacker path and loss of funds or protocol control.'},budget.llm(this.a?.llm),null);
      this.record(program,repo,result,queue);
    }
    this.store.writeJson(FINDING_FILE,queue);
  }

  record(program,repo,result,queue){
    const rows=Array.isArray(result?.findings)?result.findings:Array.isArray(result)?result:[];
    for(const raw of rows){
      const finding=normalizeFinding({...raw,repo},program);
      if(finding.severity==='informational'||!finding.summary)continue;
      const id=findingId(finding);
      // A re-scan of the same file must not resurrect a finding the owner already
      // dismissed or already sent to the platform.
      if(queue[id])continue;
      queue[id]={id,...finding,discoveredAt:now(),updatedAt:now()};
    }
    const programsById={[program.programId]:program};
    for(const ranked of rankFindings(Object.values(queue).filter(row=>row.programId===program.programId),programsById))queue[ranked.id]={...queue[ranked.id],expectedValueUsd:ranked.expectedValueUsd};
  }

  // Owner-driven transitions. There is no counterpart that sends a finding anywhere:
  // the owner submits on the platform by hand, then records that here.
  markSubmitted(id,reference){
    const queue=this.store.readJson(FINDING_FILE,{});
    if(!queue[id])return false;
    queue[id]={...queue[id],status:'submitted_by_owner',platformReference:String(reference||''),submittedAt:now(),updatedAt:now()};
    this.store.writeJson(FINDING_FILE,queue);return true;
  }
  dismiss(id,reason){
    const queue=this.store.readJson(FINDING_FILE,{});
    if(!queue[id])return false;
    queue[id]={...queue[id],status:'dismissed',dismissReason:String(reason||'').slice(0,200),updatedAt:now()};
    this.store.writeJson(FINDING_FILE,queue);return true;
  }
  review_queue(){return rankFindings(Object.values(this.store.readJson(FINDING_FILE,{})).filter(row=>row.status==='awaiting_human_review'),Object.fromEntries(this.programs().map(p=>[p.programId,p])));}
}
