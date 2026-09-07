import fs from 'node:fs';
import path from 'node:path';

const SECRET_KEY_ALLOWLIST = new Set([
  'OPENAI_API_KEY','AUTONOMOS_LLM_API_KEY','LITELLM_API_KEY','FIRECRAWL_API_KEY','E2B_API_KEY',
  'COMPOSIO_API_KEY','BROWSERBASE_API_KEY','BROWSERBASE_PROJECT_ID','CODERABBIT_API_KEY','TAVILY_API_KEY','TRIGGER_SECRET_KEY',
  'LANGFUSE_PUBLIC_KEY','LANGFUSE_SECRET_KEY','OPENSEARCH_USERNAME','OPENSEARCH_PASSWORD',
  'AUTH0_DOMAIN','AUTH0_AUDIENCE','GITHUB_TOKEN','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET',
  'CLAWLANCER_API_KEY','CLAWLANCER_AGENT_ID','DEALWORK_API_KEY','DEALWORK_AGENT_ID',
  'WORKPROTOCOL_API_KEY','WORKPROTOCOL_AGENT_ID',
  'NVM_API_KEY','NVM_PLAN_ID','OLAS_MECH_API_KEY','VIRTUALS_ACP_WALLET_ID','VIRTUALS_ACP_SIGNER',
  'VIRTUALS_ACP_AGENT_ID','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','AUTONOMOS_TEMPORAL_WORKER_TOKEN',
  'AUTONOMOS_DEPLOY_WEBHOOK_TOKEN','AUTONOMOS_X402_FACILITATOR_HEADERS_JSON','AUTONOMOS_X402_ACCEPTS_JSON'
]);

const WORKPROTOCOL_ORIGIN='https://workprotocol.ai';
const WORKPROTOCOL_CREDENTIAL_FILE='workprotocol-bootstrap.private.json';

export async function hydrateExternalSecrets(env=process.env,{logger=console,fetchFn=fetch}={}){
  const loaded=[];
  let external={ok:false,configured:false,reason:'aws_secret_id_missing',loaded:[]};
  const secretId=String(env.AUTONOMOS_AWS_SECRET_ID||'').trim();
  if(secretId){
    const required=/^(1|true|yes)$/i.test(String(env.AUTONOMOS_SECRETS_REQUIRED||'false'));
    try{
      const {SecretsManagerClient,GetSecretValueCommand}=await import('@aws-sdk/client-secrets-manager');
      const client=new SecretsManagerClient({region:String(env.AWS_REGION||env.S3_REGION||'us-east-1')});
      const response=await client.send(new GetSecretValueCommand({SecretId:secretId}));
      const raw=response.SecretString||Buffer.from(response.SecretBinary||'').toString('utf8');
      const parsed=JSON.parse(String(raw||'{}'));
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('secret_bundle_must_be_json_object');
      for(const [key,value] of Object.entries(parsed)){
        if(!SECRET_KEY_ALLOWLIST.has(key))continue;
        if(String(env[key]||'').trim())continue; // explicit Render/env configuration wins
        if(value===null||value===undefined)continue;
        env[key]=String(value);loaded.push(key);
      }
      external={ok:true,configured:true,loaded:[...loaded]};
    }catch(error){
      const reason=String(error?.message||error).slice(0,300);
      logger.warn?.(`AutonomOS external secrets unavailable: ${reason}`);
      if(required)throw new Error(`autonomos_secrets_required_but_unavailable:${reason}`);
      external={ok:false,configured:true,reason,loaded:[...loaded]};
    }
  }

  // WorkProtocol explicitly supports programmatic agent registration without email or
  // approval and returns an API key immediately. Keep that credential on the same Render
  // persistent disk as the rest of AutonomOS private state so a redeploy never creates a
  // duplicate agent. This bootstrap only supplies credentials; the normal runtime still
  // owns discovery, economics, claim, execution, QA, delivery and settlement checks.
  const workprotocol=await hydrateWorkProtocolRegistration(env,{logger,fetchFn});
  if(workprotocol.loaded)loaded.push('WORKPROTOCOL_API_KEY','WORKPROTOCOL_AGENT_ID');
  return {...external,loaded:[...new Set(loaded)],workprotocol};
}

export async function hydrateWorkProtocolRegistration(env=process.env,{logger=console,fetchFn=fetch}={}){
  if(String(env.WORKPROTOCOL_API_KEY||'').trim()&&String(env.WORKPROTOCOL_AGENT_ID||'').trim())return{ok:true,configured:true,source:'environment',loaded:false};
  const ownerWallet=String(env.AUTONOMOS_OWNER_WALLET||'').trim();
  if(!/^0x[a-fA-F0-9]{40}$/.test(ownerWallet))return{ok:false,configured:false,reason:'workprotocol_owner_wallet_missing_or_invalid',loaded:false};
  const storageDir=path.resolve(String(env.STORAGE_DIR||'data'));
  const privateDir=path.join(storageDir,'autonomos');
  const credentialFile=path.join(privateDir,WORKPROTOCOL_CREDENTIAL_FILE);
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
  }catch(error){logger.warn?.(`WorkProtocol credential read failed: ${String(error?.message||error).slice(0,180)}`);}

  try{
    const response=await fetchFn(`${WORKPROTOCOL_ORIGIN}/api/agents/register`,{
      method:'POST',
      headers:{'content-type':'application/json',accept:'application/json','user-agent':'AutonomOS/15.0'},
      body:JSON.stringify({
        name:String(env.AUTONOMOS_AGENT_NAME||'AutonomOS').slice(0,80),
        description:'Autonomous digital-services worker for code, data, research and verified deliverables.',
        walletAddress:ownerWallet,
        capabilities:{categories:['code','data','research','content'],languages:['typescript','javascript','python'],maxJobValue:1000},
        pricing:{minimumJobValue:Math.max(0.5,Number(env.AUTONOMOS_MIN_JOB_PAYOUT_USD||0.5)),acceptedCurrencies:['USDC']}
      }),
      signal:AbortSignal.timeout(15000)
    });
    const body=await response.json().catch(()=>({}));
    const agent=body?.agent||body?.data?.agent||body?.data||body;
    const apiKey=String(agent?.apiKey||agent?.api_key||body?.apiKey||'').trim();
    const agentId=String(agent?.id||agent?.agentId||agent?.agent_id||body?.agentId||'').trim();
    if(!response.ok||!apiKey||!agentId){
      const reason=`workprotocol_registration_${response.ok?'invalid_response':`http_${response.status}`}`;
      logger.warn?.(`${reason}: ${String(body?.error||body?.message||'').slice(0,160)}`);
      return{ok:false,configured:false,reason,loaded:false};
    }
    fs.mkdirSync(privateDir,{recursive:true});
    writePrivateJson(credentialFile,{apiKey,agentId,walletAddress:ownerWallet,createdAt:new Date().toISOString(),source:'auto_registration'});
    env.WORKPROTOCOL_API_KEY=apiKey;
    env.WORKPROTOCOL_AGENT_ID=agentId;
    return{ok:true,configured:true,source:'auto_registration',registered:true,loaded:true};
  }catch(error){
    const reason=`workprotocol_registration_failed:${String(error?.message||error).slice(0,180)}`;
    logger.warn?.(reason);
    return{ok:false,configured:false,reason,loaded:false};
  }
}

function readPrivateJson(file){
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if(error?.code==='ENOENT')return null;throw error;}
}
function writePrivateJson(file,value){
  const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});
  try{fs.chmodSync(tmp,0o600);}catch{}
  fs.renameSync(tmp,file);
  try{fs.chmodSync(file,0o600);}catch{}
}
