import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { e2bRunShell } from './tools.js';
import { isRetiredMarket } from './retired-markets.js';
import { ActionJournal } from './action-journal.js';
import { AutonomOSStore } from './store.js';
export async function browserAction(args,env,signal,sandboxSession){
 let u;try{u=new URL(args.url);}catch{return{ok:false,error:'invalid_browser_url'};}
 if(u.protocol!=='https:'||u.username||u.password||!u.hostname.includes('.')||/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)||isRetiredMarket(u.href))return{ok:false,error:'browser_origin_blocked'};
 if(!sandboxSession||!args.sessionKey)return{ok:false,error:'job_sandbox_required'};
 const actions=new Set(['navigate','click','type','select','upload','download','wait','extract','screenshot']);
 if(!Array.isArray(args.steps)||args.steps.length>20||args.steps.some(s=>!actions.has(s.action)||!['screenshot','navigate'].includes(s.action)&&typeof s.selector!=='string'))return{ok:false,error:'invalid_browser_action'};
 const root=path.join(env.STORAGE_DIR||'data','autonomos'),store=new AutonomOSStore(root),journal=new ActionJournal(root);
 const key=crypto.createHash('sha256').update(args.sessionKey+':'+u.origin).digest('hex'),file='browser-session-'+key+'.private.json';
 const effect=args.steps.some(s=>['click','type','select','upload'].includes(s.action));
 const actionId=crypto.createHash('sha256').update(JSON.stringify({url:u.href,steps:args.steps})).digest('hex');
 let intent;
 if(effect){intent=journal.begin('browser:'+u.hostname,args.sessionKey,actionId);if(!intent.ok)return intent.status==='confirmed'?intent.proof.result:{ok:false,error:'browser_action_requires_reconciliation',uncertain:true};}
 const saved=store.readJson(file,null),files=[{path:'autonomos-browser.cjs',content:fs.readFileSync(new URL('./browser-runtime.cjs',import.meta.url),'utf8')},{path:'browser-workflow.cjs',content:fs.readFileSync(new URL('./browser-workflow.cjs',import.meta.url),'utf8')},{path:'browser-action.json',content:JSON.stringify(args)}];
 if(saved?.expiresAt>Date.now())files.push({path:'browser-session.json',content:JSON.stringify(saved.state)});
 const collectPaths=[];if(args.steps.some(s=>s.action==='screenshot'))collectPaths.push('browser-evidence.png');args.steps.filter(s=>s.action==='download').forEach((_,i)=>collectPaths.push('browser-download-'+i));
 try{
  const r=await e2bRunShell({command:'node /home/user/browser-workflow.cjs',files,collectPaths},env,signal,sandboxSession);
  if(!r.ok){if(intent)journal.finish(intent.id,'uncertain');return{...r,uncertain:effect};}
  const result={...JSON.parse(r.stdout.trim().split('\n').at(-1)),artifacts:r.artifacts||[],provider:'current_chromium'};
  // Session state is private runtime data, never an artifact or model tool response.
  const sbx=await sandboxSession.get(signal),state=JSON.parse(await sbx.files.read('/home/user/browser-session.json'));
  store.writeSecretJson(file,{state,expiresAt:Date.now()+7*86400000});
  if(intent)journal.finish(intent.id,'confirmed',{url:result.url,result});
  return result;
 }catch(e){if(intent)journal.finish(intent.id,'uncertain');return{ok:false,error:String(e.message).slice(0,180),uncertain:effect};}
}
