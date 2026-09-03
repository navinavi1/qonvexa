import crypto from 'node:crypto';

const DEFAULT_MAX_TASK_AGENTS = 12;
const DEFAULT_MAX_PER_JOB = 4;
const DEFAULT_TTL_MS = 20 * 60_000;

/**
 * Ephemeral workforce registry.
 *
 * A task agent is a lease for a specialist role on ONE accepted job. It is not a
 * permanent employee and it is never spawned merely because the dashboard is open.
 * Plans with many steps are collapsed by role so ten code steps do not create ten
 * indistinguishable Code Workers. The registry is intentionally in-memory: durable
 * job state lives in in-flight-jobs.json/Trigger/Temporal, while workers are recreated
 * from the recovered plan when a job resumes.
 */
export class TaskAgentRuntime {
  constructor({env=process.env,onEvent=()=>{}}={}){
    this.env=env;
    this.onEvent=onEvent;
    this.agents=new Map();
    this.jobAgents=new Map();
  }

  spawnForPlan({jobId,opportunity,plan,maxAgents=null}={}){
    this.cleanup();
    const key=String(jobId||'');
    if(!key)throw new Error('task_agent_job_id_required');

    // Idempotent by job. LangGraph/checkpoint retries must not duplicate a workforce.
    const existing=this.forJob(key).filter(x=>x.status==='active');
    if(existing.length)return existing;

    const configuredGlobal=Math.max(1,Number(maxAgents ?? this.env.AUTONOMOS_MAX_TASK_AGENTS ?? DEFAULT_MAX_TASK_AGENTS));
    const perJob=Math.max(1,Math.min(configuredGlobal,Number(this.env.AUTONOMOS_MAX_TASK_AGENTS_PER_JOB||DEFAULT_MAX_PER_JOB)));
    const activeGlobal=[...this.agents.values()].filter(x=>x.status==='active').length;
    const slots=Math.max(0,Math.min(perJob,configuredGlobal-activeGlobal));
    if(!slots){
      this.onEvent('task_team_deferred',{jobId:key,reason:'workforce_capacity_reached',activeGlobal,configuredGlobal});
      return [];
    }

    const requested=collapseWorkerSteps(plan?.steps||[],opportunity).slice(0,slots);
    const created=requested.map((group,index)=>{
      const now=Date.now();
      const agent={
        id:`task_${sanitize(key).slice(-16)}_${sanitize(group.role).slice(0,18)}_${crypto.randomBytes(3).toString('hex')}`,
        jobId:key,
        role:group.role,
        specialization:group.specialization,
        stepIds:group.stepIds,
        status:'active',
        phase:'ready',
        createdAt:new Date(now).toISOString(),
        lastActiveAt:new Date(now).toISOString(),
        expiresAt:new Date(now+Math.max(60_000,Number(this.env.AUTONOMOS_TASK_AGENT_TTL_MS||DEFAULT_TTL_MS))).toISOString(),
        tasksCompleted:0,
        errors:0,
        costUsd:0,
        revenueUsd:0,
        ordinal:index+1
      };
      this.agents.set(agent.id,agent);
      this.onEvent('task_agent_spawned',{jobId:key,taskAgentId:agent.id,role:agent.role,stepIds:agent.stepIds});
      return {...agent};
    });
    this.jobAgents.set(key,created.map(x=>x.id));
    this.onEvent('task_team_created',{jobId:key,count:created.length,roles:created.map(x=>x.role)});
    return created;
  }

  forJob(jobId){
    const ids=this.jobAgents.get(String(jobId||''))||[];
    return ids.map(id=>this.agents.get(id)).filter(Boolean).map(x=>({...x}));
  }

  markJobPhase(jobId,phase){
    const now=new Date().toISOString();
    for(const agent of this.mutableForJob(jobId)){
      if(agent.status!=='active')continue;
      agent.phase=String(phase||'working');
      agent.lastActiveAt=now;
      // Extend a lease while the owning job is demonstrably alive.
      agent.expiresAt=new Date(Date.now()+Math.max(60_000,Number(this.env.AUTONOMOS_TASK_AGENT_TTL_MS||DEFAULT_TTL_MS))).toISOString();
    }
  }

  recordJobUsage(jobId,{costUsd=0,revenueUsd=0}={}){
    const rows=this.mutableForJob(jobId).filter(x=>x.status==='active');
    if(!rows.length)return;
    const cost=Number(costUsd||0)/rows.length;
    const revenue=Number(revenueUsd||0)/rows.length;
    for(const agent of rows){agent.costUsd+=cost;agent.revenueUsd+=revenue;}
  }

  retireJob(jobId,{ok=true,error=''}={}){
    const key=String(jobId||'');
    const now=new Date().toISOString();
    const retired=[];
    for(const agent of this.mutableForJob(key)){
      if(agent.status!=='active')continue;
      agent.status=ok?'completed':'failed';
      agent.phase='closed';
      agent.lastActiveAt=now;
      agent.closedAt=now;
      agent.tasksCompleted+=ok?1:0;
      agent.errors+=ok?0:1;
      if(error)agent.lastError=String(error).slice(0,300);
      retired.push({...agent});
      this.onEvent('task_agent_retired',{jobId:key,taskAgentId:agent.id,role:agent.role,status:agent.status});
    }
    this.jobAgents.delete(key);
    this.prune();
    return retired;
  }

  retireOrphans(activeJobIds=[]){
    const active=new Set((activeJobIds||[]).map(String));
    const jobs=[...this.jobAgents.keys()];
    let retired=0;
    for(const jobId of jobs){
      if(active.has(jobId))continue;
      retired+=this.retireJob(jobId,{ok:false,error:'orphaned_worker_lease'}).length;
    }
    return retired;
  }

  snapshot(){
    this.cleanup();
    return [...this.agents.values()]
      .sort((a,b)=>Date.parse(b.lastActiveAt||0)-Date.parse(a.lastActiveAt||0))
      .slice(0,120)
      .map(x=>({...x}));
  }

  summary(){
    const rows=this.snapshot();
    return{
      active:rows.filter(x=>x.status==='active').length,
      completed:rows.filter(x=>x.status==='completed').length,
      failed:rows.filter(x=>x.status==='failed').length,
      expired:rows.filter(x=>x.status==='expired').length,
      activeJobs:new Set(rows.filter(x=>x.status==='active').map(x=>x.jobId)).size,
      byRole:Object.fromEntries(Object.entries(rows.filter(x=>x.status==='active').reduce((acc,x)=>(acc[x.role]=(acc[x.role]||0)+1,acc),{})).sort((a,b)=>b[1]-a[1]))
    };
  }

  cleanup(){
    const now=Date.now();
    for(const agent of this.agents.values()){
      if(agent.status==='active'&&Date.parse(agent.expiresAt||0)<=now){
        agent.status='expired';agent.phase='closed';agent.closedAt=new Date(now).toISOString();
        this.onEvent('task_agent_expired',{jobId:agent.jobId,taskAgentId:agent.id,role:agent.role});
      }
    }
    for(const [jobId,ids] of this.jobAgents){
      if(!ids.some(id=>this.agents.get(id)?.status==='active'))this.jobAgents.delete(jobId);
    }
    this.prune();
  }

  prune(){
    const rows=[...this.agents.values()];
    const active=rows.filter(r=>r.status==='active');
    const inactive=rows.filter(r=>r.status!=='active').sort((a,b)=>Date.parse(b.lastActiveAt||0)-Date.parse(a.lastActiveAt||0));
    const keepInactive=Math.max(0,120-active.length);
    for(const row of inactive.slice(keepInactive))this.agents.delete(row.id);
  }

  mutableForJob(jobId){
    const ids=this.jobAgents.get(String(jobId||''))||[];
    return ids.map(id=>this.agents.get(id)).filter(Boolean);
  }
}

export function normalizeWorkerSteps(steps=[]){
  return collapseWorkerSteps(steps,{}).map((group,index)=>({
    id:group.stepIds[0]||`step-${index+1}`,
    role:group.role,
    action:group.specialization,
    doneWhen:'all assigned role steps completed with verifiable evidence'
  }));
}

export function collapseWorkerSteps(steps=[],opportunity={}){
  const nonWorkers=new Set(['planner','qa-evaluator','job-router','policy-agent','economics-agent','prime-governor']);
  const grouped=new Map();
  for(const step of Array.isArray(steps)?steps:[]){
    const role=normalizeRole(String(step?.role||roleForOpportunity(opportunity)||'general-worker'));
    if(nonWorkers.has(role))continue;
    const prev=grouped.get(role)||{role,stepIds:[],actions:[]};
    prev.stepIds.push(String(step?.id||`step-${prev.stepIds.length+1}`));
    const action=String(step?.action||step?.doneWhen||'').trim();
    if(action)prev.actions.push(action);
    grouped.set(role,prev);
  }
  if(!grouped.size){
    const role=roleForOpportunity(opportunity);
    grouped.set(role,{role,stepIds:['execute'],actions:['execute the accepted job using available tools and return verifiable evidence']});
  }
  return [...grouped.values()].map(group=>({
    role:group.role,
    stepIds:group.stepIds,
    specialization:(group.actions.join(' → ')||String(opportunity?.capability?.skill||opportunity?.category||'general-digital')).slice(0,420)
  }));
}

function roleForOpportunity(op={}){
  const hint=`${op?.capability?.skill||''} ${op?.category||''} ${op?.title||''}`.toLowerCase();
  if(/\b(code|repo|repository|bug|api|javascript|typescript|python|solidity|rust)\b/.test(hint))return'code-worker';
  if(/\b(research|analysis|web|data|market)\b/.test(hint))return'research-worker';
  if(/\b(write|content|translate|copy)\b/.test(hint))return'content-worker';
  return'automation-worker';
}
function normalizeRole(role){const value=String(role||'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'');return value||'general-worker';}
function sanitize(value){return String(value||'').replace(/[^a-z0-9_-]/gi,'')||'job';}
