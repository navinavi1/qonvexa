import fs from 'node:fs';
import path from 'node:path';

const ORIGIN='https://workprotocol.ai';
const FILE='workprotocol-bootstrap.private.json';

export async function hydrateWorkProtocolRegistration(env=process.env,{logger=console,fetchFn=fetch}={}){
  if(String(env.WORKPROTOCOL_API_KEY||'').trim()&&String(env.WORKPROTOCOL_AGENT_ID||'').trim())return{ok:true,configured:true,source:'environment',loaded:false};
  const ownerWallet=String(env.AUTONOMOS_OWNER_WALLET||'').trim();
  if(!/^0x[a-fA-F0-9]{40}$/.test(ownerWallet))return{ok:false,configured:false,reason:'workprotocol_owner_wallet_missing_or_invalid',loaded:false};
  const storageDir=path.resolve(String(env.STORAGE_DIR||'data'));
  const privateDir=path.join(storageDir,'autonomos');
  const credentialFile=path.join(privateDir,FILE);
  try{
    const saved=readPrivateJson(credentialFile);
    if(saved?.apiKey&&saved?.agentId){
      if(saved.walletAddress&&String(saved.walletAddress).toLowerCase()!==ownerWallet.toLowerCase()){
        logger.warn?.('WorkProtocol saved wallet differs from current owner wallet; credential not activated.');
        return{ok:false,configured:false,reason:'workprotocol_saved_wallet_mismatch',loaded:false};
      }
      env.WORKPROTOCOL_API_KEY=String(saved.apiKey);
      env.WORKPROTOCOL_AGENT_ID=String(saved.agentId);
      return{ok:true,configured:true,source:'persistent_disk',loaded:true};
    }
  }catch(error){logger.warn?.('WorkProtocol credential read failed: '+String(error?.message||error).slice(0,180));}
  try{
    const response=await fetchFn(ORIGIN+'/api/agents/register',{method:'POST',headers:{'content-type':'application/json',accept:'application/json','user-agent':'AutonomOS/15.0'},body:JSON.stringify({name:String(env.AUTONOMOS_AGENT_NAME||'AutonomOS').slice(0,80),description:'Autonomous digital-services worker for code, data, research and verified deliverables.',walletAddress:ownerWallet,capabilities:{categories:['code','data','research','content'],languages:['typescript','javascript','python'],maxJobValue:1000},pricing:{minimumJobValue:Math.max(0.5,Number(env.AUTONOMOS_MIN_JOB_PAYOUT_USD||0.5)),acceptedCurrencies:['USDC']}}),signal:AbortSignal.timeout(15000)});
    const body=await response.json().catch(()=>({}));
    const agent=body?.agent||body?.data?.agent||body?.data||body;
    const apiKey=String(agent?.apiKey||agent?.api_key||body?.apiKey||'').trim();
    const agentId=String(agent?.id||agent?.agentId||agent?.agent_id||body?.agentId||'').trim();
    if(!response.ok||!apiKey||!agentId){const reason='workprotocol_registration_'+(response.ok?'invalid_response':'http_'+response.status);logger.warn?.(reason+': '+String(body?.error||body?.message||'').slice(0,160));return{ok:false,configured:false,reason,loaded:false};}
    fs.mkdirSync(privateDir,{recursive:true});writePrivateJson(credentialFile,{apiKey,agentId,walletAddress:ownerWallet,createdAt:new Date().toISOString(),source:'auto_registration'});
    env.WORKPROTOCOL_API_KEY=apiKey;env.WORKPROTOCOL_AGENT_ID=agentId;
    return{ok:true,configured:true,source:'auto_registration',registered:true,loaded:true};
  }catch(error){const reason='workprotocol_registration_failed:'+String(error?.message||error).slice(0,180);logger.warn?.(reason);return{ok:false,configured:false,reason,loaded:false};}
}
function readPrivateJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error?.code==='ENOENT')return null;throw error;}}
function writePrivateJson(file,value){const tmp=file+'.'+process.pid+'.'+Date.now()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});try{fs.chmodSync(tmp,0o600);}catch{}fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}}
