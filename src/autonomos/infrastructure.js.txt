const COMPONENTS = [
  ['langgraph','LangGraph',['DATABASE_URL']],
  ['memory','Postgres + pgvector',['DATABASE_URL']],
  ['temporal','Temporal',['TEMPORAL_ADDRESS','TEMPORAL_NAMESPACE']],
  ['redis','Redis',['REDIS_URL']],
  ['nats','NATS',['NATS_URL']],
  ['s3','S3-compatible artifacts',['S3_ENDPOINT','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY']],
  ['opensearch','OpenSearch',['OPENSEARCH_URL']],
  ['langfuse','Langfuse',['LANGFUSE_PUBLIC_KEY','LANGFUSE_SECRET_KEY']],
  ['stagehand','Stagehand / Browserbase',['BROWSERBASE_API_KEY']],
  ['composio','Composio app/tool gateway',['COMPOSIO_API_KEY']],
  ['coderabbit','CodeRabbit',['CODERABBIT_API_KEY']],
  ['auth0','Auth0',['AUTH0_DOMAIN','AUTH0_AUDIENCE']],
  ['litellm','LiteLLM gateway',['LITELLM_BASE_URL']],
  ['openai_agents','OpenAI Agents SDK',['OPENAI_API_KEY']],
  ['secrets_manager','AWS Secrets Manager',['AUTONOMOS_AWS_SECRET_ID']],
  ['firecrawl','Firecrawl',['FIRECRAWL_API_KEY']],
  ['e2b','E2B',['E2B_API_KEY']]
];

export function infrastructureStatus(env=process.env){
  return COMPONENTS.map(([id,name,keys])=>{
    const missing=keys.filter(k=>!String(env[k]||'').trim());
    return {id,name,configured:missing.length===0,status:missing.length?'needs_configuration':'ready',missing};
  });
}

export function infrastructureReady(id,env=process.env){
  return infrastructureStatus(env).find(x=>x.id===id)?.configured||false;
}
