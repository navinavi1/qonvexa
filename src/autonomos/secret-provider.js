const SECRET_KEY_ALLOWLIST = new Set([
  'OPENAI_API_KEY','AUTONOMOS_LLM_API_KEY','LITELLM_API_KEY','FIRECRAWL_API_KEY','E2B_API_KEY',
  'COMPOSIO_API_KEY','BROWSERBASE_API_KEY','BROWSERBASE_PROJECT_ID','CODERABBIT_API_KEY','TAVILY_API_KEY','TRIGGER_SECRET_KEY',
  'LANGFUSE_PUBLIC_KEY','LANGFUSE_SECRET_KEY','OPENSEARCH_USERNAME','OPENSEARCH_PASSWORD',
  'AUTH0_DOMAIN','AUTH0_AUDIENCE','GITHUB_TOKEN','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET',
  'CLAWLANCER_API_KEY','CLAWLANCER_AGENT_ID','DEALWORK_API_KEY','DEALWORK_AGENT_ID',
  'NVM_API_KEY','NVM_PLAN_ID','OLAS_MECH_API_KEY','VIRTUALS_ACP_WALLET_ID','VIRTUALS_ACP_SIGNER',
  'VIRTUALS_ACP_AGENT_ID','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','AUTONOMOS_TEMPORAL_WORKER_TOKEN',
  'AUTONOMOS_DEPLOY_WEBHOOK_TOKEN','AUTONOMOS_X402_FACILITATOR_HEADERS_JSON','AUTONOMOS_X402_ACCEPTS_JSON'
]);

export async function hydrateExternalSecrets(env=process.env,{logger=console}={}){
  const secretId=String(env.AUTONOMOS_AWS_SECRET_ID||'').trim();
  if(!secretId)return{ok:false,configured:false,reason:'aws_secret_id_missing',loaded:[]};
  const required=/^(1|true|yes)$/i.test(String(env.AUTONOMOS_SECRETS_REQUIRED||'false'));
  try{
    const {SecretsManagerClient,GetSecretValueCommand}=await import('@aws-sdk/client-secrets-manager');
    const client=new SecretsManagerClient({region:String(env.AWS_REGION||env.S3_REGION||'us-east-1')});
    const response=await client.send(new GetSecretValueCommand({SecretId:secretId}));
    const raw=response.SecretString||Buffer.from(response.SecretBinary||'').toString('utf8');
    const parsed=JSON.parse(String(raw||'{}'));
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('secret_bundle_must_be_json_object');
    const loaded=[];
    for(const [key,value] of Object.entries(parsed)){
      if(!SECRET_KEY_ALLOWLIST.has(key))continue;
      if(String(env[key]||'').trim())continue; // explicit Render/env configuration wins
      if(value===null||value===undefined)continue;
      env[key]=String(value);loaded.push(key);
    }
    return{ok:true,configured:true,loaded};
  }catch(error){
    const reason=String(error?.message||error).slice(0,300);
    logger.warn?.(`AutonomOS external secrets unavailable: ${reason}`);
    if(required)throw new Error(`autonomos_secrets_required_but_unavailable:${reason}`);
    return{ok:false,configured:true,reason,loaded:[]};
  }
}
