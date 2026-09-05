import { resolveLlmEndpoint } from './llm-router.js';

export class AgentMemory {
  constructor({env=process.env,logger=console}={}){
    this.env=env;this.logger=logger;this.pool=null;this.ready=false;
    this.dim=Math.max(256,Math.min(3072,Number(env.AUTONOMOS_EMBEDDING_DIMENSIONS||1536)));
  }
  async init(){
    if(!this.env.DATABASE_URL)return{ok:false,reason:'database_url_missing'};
    try{
      const {Pool}=await import('pg');
      const ssl=postgresSslConfig(this.env);
      this.pool=new Pool({connectionString:this.env.DATABASE_URL,...(ssl?{ssl}:{})});
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      await this.pool.query(`CREATE TABLE IF NOT EXISTS autonomos_memory (
        id bigserial primary key,
        memory_key text unique not null,
        tenant_scope text not null default 'global',
        job_scope text not null default '',
        kind text not null,
        content text not null,
        metadata jsonb not null default '{}'::jsonb,
        embedding vector(${this.dim}),
        utility double precision not null default 0.5,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`);
      await this.pool.query(`ALTER TABLE autonomos_memory ADD COLUMN IF NOT EXISTS tenant_scope text NOT NULL DEFAULT 'global'`);
      await this.pool.query(`ALTER TABLE autonomos_memory ADD COLUMN IF NOT EXISTS job_scope text NOT NULL DEFAULT ''`);
      await this.pool.query('CREATE INDEX IF NOT EXISTS autonomos_memory_kind_updated_idx ON autonomos_memory(kind, updated_at DESC)');
      await this.pool.query('CREATE INDEX IF NOT EXISTS autonomos_memory_scope_idx ON autonomos_memory(tenant_scope, job_scope, kind, updated_at DESC)');
      this.ready=true;return{ok:true,dimensions:this.dim};
    }catch(error){this.logger.warn?.('AutonomOS memory init failed',error?.message||error);return{ok:false,reason:String(error?.message||error)}}
  }

  async embed(text){
    const input=String(text||'').trim().slice(0,20000); if(!input)return null;
    const route=resolveEmbeddingEndpoint(this.env);
    if(!route.baseUrl||!route.apiKey)return null;
    try{
      const response=await fetch(`${route.baseUrl}/embeddings`,{
        method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${route.apiKey}`},
        body:JSON.stringify({model:route.model,input,dimensions:this.dim}),signal:AbortSignal.timeout(30000)
      });
      if(!response.ok)return null;
      const body=await response.json();
      const vector=body?.data?.[0]?.embedding;
      return Array.isArray(vector)&&vector.length===this.dim?vector.map(Number):null;
    }catch{return null;}
  }

  async remember({key,kind='experience',content,metadata={},utility=0.5,embedding=null,tenantScope='global',jobScope=''}){
    if(!this.ready||!this.pool)return{ok:false,reason:'memory_not_ready'};
    const text=String(content).slice(0,50000);
    const vector=embedding||await this.embed(text);
    await this.pool.query(
      `INSERT INTO autonomos_memory(memory_key,tenant_scope,job_scope,kind,content,metadata,utility,embedding)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::vector)
       ON CONFLICT(memory_key) DO UPDATE SET tenant_scope=excluded.tenant_scope,job_scope=excluded.job_scope,content=excluded.content,metadata=excluded.metadata,utility=excluded.utility,
       embedding=COALESCE(excluded.embedding,autonomos_memory.embedding),updated_at=now()`,
      [String(key),String(tenantScope||'global'),String(jobScope||''),String(kind),text,metadata,Number(utility),vector?vectorLiteral(vector):null]
    );
    return{ok:true,embedded:Boolean(vector)};
  }

  async recent(kind='experience',limit=8,{tenantScope='global',jobScope=''}={}){
    if(!this.ready||!this.pool)return[];
    const {rows}=await this.pool.query(`SELECT memory_key,kind,content,metadata,utility,created_at FROM autonomos_memory WHERE kind=$1 AND tenant_scope=$2 AND (job_scope='' OR job_scope=$3) ORDER BY utility DESC, updated_at DESC LIMIT $4`,[kind,String(tenantScope||'global'),String(jobScope||''),limitSafe(limit)]);
    return rows;
  }

  async recall(query,{kind='experience',limit=6,minSimilarity=0.35,tenantScope='global',jobScope=''}={}){
    if(!this.ready||!this.pool)return[];
    const vector=await this.embed(query);
    if(!vector)return this.recent(kind,limit,{tenantScope,jobScope});
    try{
      const {rows}=await this.pool.query(
        `SELECT memory_key,kind,content,metadata,utility,created_at,
                1 - (embedding <=> $1::vector) AS similarity
         FROM autonomos_memory
         WHERE kind=$2 AND tenant_scope=$3 AND (job_scope='' OR job_scope=$4) AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector, utility DESC
         LIMIT $3`,
        [vectorLiteral(vector),kind,String(tenantScope||'global'),String(jobScope||''),limitSafe(limit)]
      );
      return rows.filter(r=>Number(r.similarity||0)>=Number(minSimilarity||0));
    }catch{return this.recent(kind,limit,{tenantScope,jobScope});}
  }

  async contextForOpportunity(opportunity,{limit=5}={}){
    const query=`${opportunity?.source||''} ${opportunity?.category||''} ${opportunity?.title||''}\n${String(opportunity?.description||'').slice(0,6000)}`;
    const tenantScope=String(opportunity?.tenantScope||opportunity?.clientId||'global');
    const jobScope=String(opportunity?.jobId||'');
    const rows=await this.recall(query,{kind:'experience',limit,tenantScope,jobScope}).catch(()=>[]);
    if(!rows.length)return{context:'',hits:[]};
    const hits=rows.map(r=>({key:r.memory_key,similarity:r.similarity??null,utility:r.utility,metadata:r.metadata||{}}));
    const context=rows.map((r,i)=>`[Past experience ${i+1}${r.similarity!=null?`, similarity ${Number(r.similarity).toFixed(2)}`:''}]\n${String(r.content||'').slice(0,1600)}`).join('\n\n');
    return{context,hits};
  }

  async close(){try{await this.pool?.end()}catch{}this.ready=false;}
}

function resolveEmbeddingEndpoint(env){
  const lite=String(env.LITELLM_BASE_URL||'').replace(/\/$/,'');
  const direct=String(env.AUTONOMOS_LLM_BASE_URL||'').replace(/\/$/,'');
  const openai=String(env.OPENAI_API_KEY||'')?String(env.OPENAI_BASE_URL||'https://api.openai.com/v1').replace(/\/$/,''):'';
  return{
    baseUrl:lite||direct||openai,
    apiKey:String(env.LITELLM_API_KEY||env.AUTONOMOS_LLM_API_KEY||env.OPENAI_API_KEY||''),
    model:String(env.AUTONOMOS_EMBEDDING_MODEL||'text-embedding-3-small')
  };
}
function vectorLiteral(v){return `[${v.map(x=>Number(x)||0).join(',')}]`;}
function limitSafe(v){return Math.max(1,Math.min(50,Number(v||6)));}

export function postgresSslConfig(env){
  const url=String(env.DATABASE_URL||'');
  if(/localhost|127\.0\.0\.1/.test(url))return undefined;
  const explicit=String(env.AUTONOMOS_DB_SSL_REJECT_UNAUTHORIZED??'').trim().toLowerCase();
  if(explicit)return{rejectUnauthorized:/^(1|true|yes|on)$/.test(explicit)};
  // Render Postgres is TLS-encrypted but its certificate chain is not trusted by node-postgres
  // unless a CA is supplied. Render's documented Node pattern is rejectUnauthorized:false.
  if(env.RENDER||/render\.com|render\.internal/i.test(url))return{rejectUnauthorized:false};
  return{rejectUnauthorized:true};
}
