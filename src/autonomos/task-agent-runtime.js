import crypto from 'node:crypto';

const DEFAULT_MAX_TASK_AGENTS = 32;
const DEFAULT_TTL_MS = 30 * 60_000;

export class TaskAgentRuntime {
  constructor({env=process.env,onEvent=()=>{}}={}){
    this.env=env;
    this.onEvent=onEvent;
    this.agents=new Map();
  }

  spawnForPlan({jobId,opportunity,plan}){
    this.cleanup();
    const max=Math.max(1,Number(this.env.AUTONOMOS_MAX_TASK_AGENTS||DEFAULT_MAX_TASK_AGENTS));
    const current=[...this.agents.values()].filter(x=>x.status==='active').length;
    const requested=normalizeWorkerSteps(plan?.steps||[]);
    const slots=Math.max(0,max-current);
    const created=requested.slice(0,slots).map((step,index)=>{
      const now=Date.now();
      const agent={
        id:`task_${String(jobId||'job').replace(/[^a-z0-9_-]/gi,'').slice(-18)}_${index}_${crypto.randomBytes(3).toString('hex')}`,
        jobId:String(jobId||''),
        role:String(step.role||'general-worker'),
        specialization:String(step.action||step.doneWhen||opportunity?.capability?.skill||opportunity?.category||'general-digital').slice(0,240),
        stepId:String(step.id||`step-${index+1}`),
        status:'active',
        phase:'ready',
        createdAt:new Date(now).toISOString(),
        lastActiveAt:new Date(now).toISOString(),
        expiresAt:new Date(now+Math.max(60_000,Number(this.env.AUTONOMOS_TASK_AGENT_TTL_MS||DEFAULT_TTL_MS))).toISOString(),
        tasksCompleted:0,
        errors:0,
        costUsd:0,
        revenueUsd:0
      };
      this.agents.set(agent.id,agent);
      this.onEvent('task_agent_spawned',{jobId:agent.jobId,taskAgentId:agent.id,role:agent.role,stepId:agent.stepId});
      return {...agent};
    });
    return created;
  }

  markJobPhase(jobId,phase){
    const now=new Date().toISOString();
    for(const agent of this.agents.values()){
      if(agent.jobId!==String(jobId)||agent.status!=='active')continue;
      agent.phase=String(phase||'working');
      agent.lastActiveAt=now;
    }
  }

  retireJob(jobId,{ok=true,error=''}={}){
    const now=new Date().toISOString();
    const retired=[];
    for(const agent of this.agents.values()){
      if(agent.jobId!==String(jobId)||agent.status!=='active')continue;
      agent.status=ok?'completed':'failed';
      agent.phase='closed';
      agent.lastActiveAt=now;
      agent.closedAt=now;
      agent.tasksCompleted+=ok?1:0;
      agent.errors+=ok?0:1;
      if(error)agent.lastError=String(error).slice(0,300);
      retired.push({...agent});
      this.onEvent('task_agent_retired',{jobId:agent.jobId,taskAgentId:agent.id,role:agent.role,status:agent.status});
    }
    this.prune();
    return retired;
  }

  snapshot(){
    this.cleanup();
    return [...this.agents.values()].sort((a,b)=>Date.parse(b.lastActiveAt||0)-Date.parse(a.lastActiveAt||0)).slice(0,200).map(x=>({...x}));
  }

  summary(){
    const rows=this.snapshot();
    return{
      active:rows.filter(x=>x.status==='active').length,
      completed:rows.filter(x=>x.status==='completed').length,
      failed:rows.filter(x=>x.status==='failed').length,
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
    this.prune();
  }

  prune(){
    const rows=[...this.agents.values()];
    const active=rows.filter(r=>r.status==='active');
    const inactive=rows.filter(r=>r.status!=='active').sort((a,b)=>Date.parse(b.lastActiveAt||0)-Date.parse(a.lastActiveAt||0));
    const keepInactive=Math.max(0,200-active.length);
    for(const row of inactive.slice(keepInactive))this.agents.delete(row.id);
  }
}

export function normalizeWorkerSteps(steps=[]){
  const nonWorkers=new Set(['planner','qa-evaluator','job-router','policy-agent','economics-agent']);
  const out=[];
  for(const step of Array.isArray(steps)?steps:[]){
    const role=String(step?.role||'').trim()||'general-worker';
    if(nonWorkers.has(role))continue;
    out.push({
      id:String(step?.id||`step-${out.length+1}`),
      role:normalizeRole(role),
      action:String(step?.action||''),
      doneWhen:String(step?.doneWhen||'step completed with verifiable evidence')
    });
  }
  if(!out.length)out.push({id:'execute',role:'general-worker',action:'execute the accepted job using available tools',doneWhen:'deliverable produced with evidence'});
  return out;
}

function normalizeRole(role){
  const value=String(role||'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'');
  return value||'general-worker';
}
