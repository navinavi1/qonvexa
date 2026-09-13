import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const run=(cmd,args,opts)=>new Promise(resolve=>execFile(cmd,args,opts,(error,stdout,stderr)=>resolve({code:error?(error.code??1):0,stdout:String(stdout||''),stderr:String(stderr||'')})));

// Read-only and free worker commands only. Every Taskmarket route that spends USDC
// (task create/accept/rate/bid/update, refund-expired, evaluator verdicts) and every
// route that moves money out (withdraw, set-withdrawal-address) is deliberately absent:
// this client cannot be made to spend or withdraw, whatever a task description asks for.
// 'legal status' reads the policy bundle. 'legal accept' SIGNS it, binding the owner to
// Taskmarket's Terms, Privacy Policy, Risk Disclosure and Acceptable Use Policy. This list
// carried a bare 'legal', which let both through: the agent could have signed on the
// owner's behalf. The worker never called accept, but "it does not today" is not a control.
// Only the read is allowed here; signing is forbidden below and belongs to the owner.
export const ALLOWED_COMMANDS=Object.freeze(['address','legal status','inbox','stats','identity','task list','task get','task claim','task submit','task my-submissions','wallet balance','wallet publish-key']);
// Never reachable from code. The owner runs these by hand; set-withdrawal-address in
// particular is one-shot and irreversible, so an agent must not be able to reach it.
export const FORBIDDEN_COMMANDS=Object.freeze(['legal accept','wallet set-withdrawal-address','withdraw','wallet withdraw-dreams','task create','task accept','task accept-submissions','task rate','task bid','task auction-accept','task update','task cancel','task refund-expired','task evaluate','task appeal','task resolve-dispute','task assign-evaluator','task reject-submission','task reject-all-submissions','task select-worker','task select-winner','task evaluator-timeout','task invite','task uninvite','task pitch','task proof']);

export function commandAllowed(argv){
  const joined=argv.map(part=>String(part)).join(' ');
  for(const forbidden of FORBIDDEN_COMMANDS)if(joined===forbidden||joined.startsWith(forbidden+' '))return{allowed:false,reason:'forbidden_command:'+forbidden};
  for(const allowed of ALLOWED_COMMANDS)if(joined===allowed||joined.startsWith(allowed+' '))return{allowed:true,reason:''};
  return{allowed:false,reason:'command_not_allowlisted'};
}

export function parseCliJson(stdout){
  const text=String(stdout||'').trim();if(!text)return{ok:false,error:'empty_output'};
  try{return JSON.parse(text)}catch{}
  // The CLI prints human lines around its JSON on some commands; take the last balanced object.
  const start=text.indexOf('{'),end=text.lastIndexOf('}');
  if(start>=0&&end>start){try{return JSON.parse(text.slice(start,end+1))}catch{}}
  return{ok:false,error:'unparsable_output',raw:text.slice(0,400)};
}

// The CLI keeps the agent's private key at os.homedir() + '/.taskmarket/keystore.json',
// hardcoded -- unlike its XMTP database and x402 journal, that path takes no environment
// override. On a container host $HOME lives in the ephemeral layer, so every deploy would
// destroy the keystore and `taskmarket init` would mint a brand new wallet. Any USDC already
// settled to the old address would be unrecoverable: no key, no seed, gone.
//
// os.homedir() reads $HOME on POSIX, so pointing HOME at the persistent disk for this child
// process alone keeps the wallet across deploys without moving HOME for the whole service.
// Where the CLI itself lives. Installing it globally during the build looked tidy and does
// not survive: the install is wrapped so a failed native build cannot redden the deploy, so
// when @xmtp/node-sdk fails to compile the lane is simply inert with nothing to show for it
// — which is exactly what happened. Installed onto the mounted disk instead, it is put there
// once, outlives every deploy, and never sits on the build's critical path at all.
export function taskmarketCliRoot(env=process.env){
  const home=taskmarketHome(env);
  return home?path.join(home,'cli'):'';
}
export function taskmarketBinary(env=process.env){
  const explicit=String(env.AUTONOMOS_TASKMARKET_BIN||'').trim();
  if(explicit)return explicit;
  const root=taskmarketCliRoot(env);
  if(root){
    const local=path.join(root,'node_modules','.bin','taskmarket');
    try{if(fs.existsSync(local))return local;}catch{}
  }
  return 'taskmarket';
}

export function taskmarketHome(env=process.env){
  const explicit=String(env.AUTONOMOS_TASKMARKET_HOME||'').trim();
  if(explicit)return explicit;
  const storage=String(env.STORAGE_DIR||'').trim();
  return storage?path.join(storage,'taskmarket-home'):'';
}

export function createTaskmarketClient({env=process.env,exec=run,logger=null}={}){
  const enabled=/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_TASKMARKET_ENABLED||'false'));
  const binary=taskmarketBinary(env);
  const apiUrl=String(env.TASKMARKET_API_URL||'https://api.taskmarket.dev').replace(/\/$/,'');
  const timeoutMs=Math.max(5000,Number(env.AUTONOMOS_TASKMARKET_TIMEOUT_MS||60000));
  const home=taskmarketHome(env);

  async function call(argv,{allowFailure=true}={}){
    const gate=commandAllowed(argv);
    if(!gate.allowed){logger?.warn?.('[Taskmarket] blocked '+argv.join(' ')+' ('+gate.reason+')');return{ok:false,error:gate.reason,blocked:true};}
    if(!enabled)return{ok:false,error:'taskmarket_disabled'};
    // Refuse rather than silently mint a throwaway wallet in a directory that will not
    // survive the next deploy. A missing persistent home is a configuration error, not a
    // reason to start earning into a key we are about to lose.
    if(!home)return{ok:false,error:'taskmarket_home_unset',blocked:true};
    try{fs.mkdirSync(home,{recursive:true,mode:0o700});}catch(error){return{ok:false,error:'taskmarket_home_unwritable:'+String(error.code||error.message)};}
    // PATH has to be carried explicitly. This spreads the caller's env, which in production
    // is process.env and happens to contain one -- but any caller passing a narrow env
    // object left the child with no PATH at all, so the binary could not be found on it.
    const childEnv={...env,PATH:env.PATH||process.env.PATH||'',HOME:home,TASKMARKET_API_URL:apiUrl};
    const result=await exec(binary,argv,{timeout:timeoutMs,env:childEnv,maxBuffer:8*1024*1024});
    if(result.code!==0&&!allowFailure)throw Error('taskmarket_'+argv[0]+'_exit_'+result.code);
    if(result.code!==0)return{ok:false,error:'exit_'+result.code,stderr:String(result.stderr||'').slice(0,400)};
    const parsed=parseCliJson(result.stdout);
    return parsed&&typeof parsed==='object'?{ok:parsed.ok!==false,...parsed}:{ok:false,error:'unexpected_output'};
  }

  return{
    enabled,apiUrl,
    status(){return{enabled,apiUrl,binary,home,network:'eip155:8453',allowedCommands:[...ALLOWED_COMMANDS],canWithdraw:false,canSpend:false};},
    call,
    address(){return call(['address']);},
    legalStatus(){return call(['legal','status']);},
    balance(){return call(['wallet','balance']);},
    identityStatus(){return call(['identity','status']);},
    listOpenTasks({mode='claim',limit=20,cursor=''}={}){
      const argv=['task','list','--status','open','--mode',String(mode),'--limit',String(Math.max(1,Math.min(100,Number(limit)||20)))];
      if(cursor)argv.push('--cursor',String(cursor));
      return call(argv);
    },
    getTask(taskId){return call(['task','get',String(taskId)]);},
    claimTask(taskId){return call(['task','claim',String(taskId)]);},
    submitWork(taskId,files){
      const argv=['task','submit',String(taskId)];
      for(const file of (Array.isArray(files)?files:[files]).filter(Boolean))argv.push('--file',String(file));
      if(argv.length===3)return Promise.resolve({ok:false,error:'no_files_to_submit'});
      return call(argv);
    },
    mySubmissions(){return call(['task','my-submissions']);}
  };
}

export function normalizeTask(raw){
  const task=raw&&typeof raw==='object'?raw:{};
  const baseUnits=Number(task.reward??task.rewardBaseUnits??0);
  return{
    taskId:String(task.taskId||task.id||''),
    mode:String(task.mode||'').toLowerCase(),
    status:String(task.status||'').toLowerCase(),
    description:String(task.description||task.title||''),
    rewardUsd:Number.isFinite(baseUnits)?baseUnits/1e6:0,
    deadline:String(task.deadline||task.expiresAt||''),
    claimedBy:String(task.claimedBy||''),
    tags:Array.isArray(task.tags)?task.tags.map(String):[]
  };
}

export function tasksFromListing(payload){
  const rows=Array.isArray(payload?.data?.tasks)?payload.data.tasks:Array.isArray(payload?.tasks)?payload.tasks:Array.isArray(payload?.data)?payload.data:[];
  return rows.map(normalizeTask).filter(task=>task.taskId);
}
