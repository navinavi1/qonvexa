const COMPONENTS = [
  {id:'openai_agents',name:'OpenAI Agents SDK',keys:['OPENAI_API_KEY']},
  {id:'langgraph',name:'LangGraph checkpointing',keys:['DATABASE_URL']},
  {id:'memory',name:'Postgres + pgvector',keys:['DATABASE_URL']},
  {id:'redis',name:'Redis cache / locks',keys:['REDIS_URL']},
  {id:'redis_streams',name:'Redis Streams event bus',keys:['REDIS_URL']},
  {id:'triggerdev',name:'Trigger.dev durable jobs',keys:['TRIGGER_SECRET_KEY']},
  {id:'tavily',name:'Tavily web search',keys:['TAVILY_API_KEY']},
  {id:'firecrawl',name:'Firecrawl web extraction',keys:['FIRECRAWL_API_KEY']},
  {id:'stagehand',name:'Stagehand / Browserbase',keys:['BROWSERBASE_API_KEY','BROWSERBASE_PROJECT_ID']},
  {id:'composio',name:'Composio app/tool gateway',keys:['COMPOSIO_API_KEY']},
  {id:'s3',name:'S3-compatible artifacts',keys:['S3_ENDPOINT','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY']},
  {id:'langfuse',name:'Langfuse tracing',keys:['LANGFUSE_PUBLIC_KEY','LANGFUSE_SECRET_KEY','LANGFUSE_BASE_URL']},
  {id:'e2b',name:'E2B code execution',keys:['E2B_API_KEY']},

  // Deliberately deferred/optional infrastructure. These stay visible in diagnostics,
  // but do not make the current Trigger.dev + Redis production stack look broken.
  {id:'temporal',name:'Temporal (optional legacy durable provider)',keys:['TEMPORAL_ADDRESS','TEMPORAL_NAMESPACE'],optional:true},
  {id:'opensearch',name:'OpenSearch (optional)',keys:['OPENSEARCH_URL'],optional:true},
  {id:'coderabbit',name:'CodeRabbit (optional second QA gate)',keys:['CODERABBIT_API_KEY'],optional:true},
  {id:'auth0',name:'Auth0 (optional external API auth)',keys:['AUTH0_DOMAIN','AUTH0_AUDIENCE'],optional:true},
  {id:'litellm',name:'LiteLLM gateway (optional multi-model router)',keys:['LITELLM_BASE_URL'],optional:true},
  {id:'secrets_manager',name:'AWS Secrets Manager (optional)',keys:['AUTONOMOS_AWS_SECRET_ID'],optional:true}
];

export function infrastructureStatus(env=process.env){
  return COMPONENTS.map(component=>{
    const missing=component.keys.filter(k=>!String(env[k]||'').trim());
    const configured=missing.length===0;
    return {
      id:component.id,
      name:component.name,
      configured,
      optional:Boolean(component.optional),
      status:configured?'ready':component.optional?'optional_not_configured':'needs_configuration',
      missing
    };
  });
}

export function infrastructureReady(id,env=process.env){
  return infrastructureStatus(env).find(x=>x.id===id)?.configured||false;
}
