import { ArtifactStore } from './artifact-store.js';
const COMPONENTS=[
{id:'openai_agents',name:'OpenAI Agents SDK',keys:['OPENAI_API_KEY']},
{id:'langgraph',name:'LangGraph checkpointing',keys:['DATABASE_URL']},
{id:'memory',name:'Postgres + pgvector',keys:['DATABASE_URL']},
{id:'redis',name:'Redis cache / locks',keys:['REDIS_URL']},
{id:'redis_streams',name:'Redis Streams event bus',keys:['REDIS_URL']},
{id:'triggerdev',name:'Trigger.dev durable jobs',keys:['TRIGGER_SECRET_KEY']},
{id:'composio',name:'Composio app/tool gateway',keys:['COMPOSIO_API_KEY']},
{id:'s3',name:'S3-compatible artifacts',keys:['S3_ENDPOINT','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY']},
{id:'langfuse',name:'Langfuse tracing',keys:['LANGFUSE_PUBLIC_KEY','LANGFUSE_SECRET_KEY','LANGFUSE_BASE_URL'],optional:true},
{id:'e2b',name:'E2B code execution',keys:['E2B_API_KEY']}
];
export function infrastructureStatus(env=process.env){env=new ArtifactStore({env}).env;return COMPONENTS.map(component=>{const missing=component.keys.filter(k=>!String(env[k]||'').trim());const configured=missing.length===0;return{id:component.id,name:component.name,configured,optional:Boolean(component.optional),status:configured?'ready':component.optional?'optional_not_configured':'needs_configuration',missing};});}
export function infrastructureReady(id,env=process.env){return infrastructureStatus(env).find(x=>x.id===id)?.configured||false;}
