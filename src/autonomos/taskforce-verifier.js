import fs from 'node:fs';
import path from 'node:path';
import { createLlmClient } from './llm.js';

export class TaskForceVerifier {
  constructor({env=process.env,storageDir='',logger=console}={}){
    this.env=env;
    this.logger=logger;
    this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');
    this.secretFile=path.join(this.root,'global-work-credentials.private.json');
    this.llm=createLlmClient(env);
    this.timer=null;
    this.running=false;
  }

  start(){
    if(this.timer)return;
    const every=Math.max(30_000,Number(this.env.AUTONOMOS_TASKFORCE_VERIFY_INTERVAL_MS||30_000));
    setTimeout(()=>this.tick().catch(()=>{}),2500).unref?.();
    this.timer=setInterval(()=>this.tick().catch(()=>{}),every);
    this.timer.unref?.();
    this.log('verifier_started',{intervalMs:every});
  }

  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}

  async tick(){
    if(this.running)return;
    this.running=true;
    try{
      const secrets=this.readSecrets();
      const credential=secrets.taskforce;
      if(!credential?.apiKey)return;
      if(credential.verified){this.logOnce('already_verified',{agentId:String(credential.agentId||'')});return;}
      await this.verify(credential,secrets);
    }finally{this.running=false;}
  }

  async verify(credential,secrets){
    if(!this.llm.enabled){this.log('verification_waiting',{reason:'llm_not_configured'});return false;}
    const key=String(credential.apiKey||'').trim();
    if(!key)return false;
    const headers={accept:'application/json',authorization:key,'x-api-key':key,'user-agent':'AutonomOS-TaskForceVerifier/1.0'};
    try{
      const challengeRes=await fetch('https://task-force.app/api/agent/verify/challenge',{method:'POST',headers,signal:AbortSignal.timeout(15000)});
      const challenge=await safeJson(challengeRes);
      if(!challengeRes.ok){
        const message=publicError(challenge);
        if(challengeRes.status===409||/already verified|verified_capability/i.test(message)){
          credential.verified=true;credential.status='VERIFIED_CAPABILITY';credential.verifiedAt=new Date().toISOString();this.save(secrets);this.log('verified',{agentId:String(credential.agentId||''),source:'server_already_verified'});return true;
        }
        this.log('challenge_failed',{status:challengeRes.status,error:message});return false;
      }
      const challengeId=String(challenge?.challengeId||challenge?.challenge_id||challenge?.id||'').trim();
      const prompt=String(challenge?.prompt||challenge?.question||challenge?.challenge||'').trim();
      if(!challengeId||!prompt){this.log('challenge_failed',{status:challengeRes.status,error:'unexpected_challenge_shape',hasId:Boolean(challengeId),hasPrompt:Boolean(prompt)});return false;}

      const solved=await this.llm.complete({
        system:'You are completing an official AI-agent capability verification challenge. Solve it accurately. Return only the final answer requested, no markdown or commentary.',
        user:prompt,
        maxTokens:600,
        task:'general',
        maxEmptyRetries:1
      });
      if(!solved.ok||!String(solved.text||'').trim()){this.log('solve_failed',{error:String(solved.reason||'empty_answer').slice(0,200)});return false;}

      const answer=String(solved.text).trim().slice(0,3000);
      const submitRes=await fetch('https://task-force.app/api/agent/verify/submit',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({challengeId,answer}),signal:AbortSignal.timeout(15000)});
      const submitted=await safeJson(submitRes);
      if(!submitRes.ok){this.log('submit_failed',{status:submitRes.status,error:publicError(submitted)});return false;}
      credential.verified=true;
      credential.status='VERIFIED_CAPABILITY';
      credential.verifiedAt=new Date().toISOString();
      this.save(secrets);
      this.log('verified',{agentId:String(credential.agentId||''),status:credential.status});
      return true;
    }catch(error){this.log('verification_failed',{error:String(error?.message||error).slice(0,220)});return false;}
  }

  readSecrets(){try{return JSON.parse(fs.readFileSync(this.secretFile,'utf8'));}catch{return{};}}
  save(value){const tmp=`${this.secretFile}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});try{fs.chmodSync(tmp,0o600);}catch{}fs.renameSync(tmp,this.secretFile);try{fs.chmodSync(this.secretFile,0o600);}catch{}}
  log(type,detail={}){try{this.logger.info?.('[TaskForceVerifier] '+JSON.stringify({at:new Date().toISOString(),type,...detail}));}catch{}}
  logOnce(type,detail={}){if(this._loggedVerified)return;this._loggedVerified=true;this.log(type,detail);}
}

async function safeJson(response){const raw=await response.text().catch(()=>'');try{return JSON.parse(raw);}catch{return{message:raw.slice(0,500)}}}
function publicError(value){if(typeof value==='string')return value.slice(0,240);return String(value?.error?.message||value?.error||value?.message||'').slice(0,240);}
