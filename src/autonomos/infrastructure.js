import { unifiedCapabilityContext } from './capability-registry.js';
import { resourceAvailability } from './resource-control.js';
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
export function infrastructureStatus(env=process.env){env=new ArtifactStore({env}).env;return COMPONENTS.map(component=>{const missing=component.keys.filter(k=>!String(env[k]||'').trim());const configured=missing.length===0;return{id:component.id,name:component.name,configured,optional:Boolean(component.optional),status:configured?componentStatus(component.id,env):component.optional?'optional_not_configured':'needs_configuration',missing};});}
export function infrastructureReady(id,env=process.env){return infrastructureStatus(env).find(x=>x.id===id)?.configured||false;}

function componentStatus(id,env){const c=unifiedCapabilityContext(env);const provider={openai_agents:'openai',triggerdev:'trigger',composio:'composio',s3:'r2',langfuse:'langfuse',e2b:'e2b'}[id];if(provider&&!resourceAvailability(provider,env).allowed)return id==='s3'&&c.hasArtifactTool?'local_fallback_ready':'resource_limit_or_verification_required';const ready={composio:c.hasAppTool,e2b:c.hasShellTool,s3:c.hasArtifactTool};return Object.hasOwn(ready,id)?ready[id]?'ready':'configured_unverified':'configured';}
