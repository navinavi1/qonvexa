const APPLIED_FINAL = new Set(['REJECTED','PAID_OR_APPROVED','COMPLETED','PAID']);

function taskIdFromNotification(n={}){
  const direct=String(n?.taskId||n?.task_id||'').trim();
  if(direct)return direct;
  const link=String(n?.link||'');
  const m=link.match(/\/tasks\/([^/?#]+)/i);
  return m?decodeURIComponent(m[1]):'';
}

function headers(apiKey){
  return {accept:'application/json','x-api-key':String(apiKey||''),authorization:`Bearer ${String(apiKey||'')}`,'user-agent':'AutonomOS-TaskForceRecovery/1.0'};
}

async function safeJson(r){try{return await r.json();}catch{return{};}}
function arrayFrom(data,keys){if(Array.isArray(data))return data;for(const k of keys){if(Array.isArray(data?.[k]))return data[k];}return[];}

// The previous TaskForce integration only read unread notifications. If another session,
// dashboard or restart consumed the acceptance notification first, the local application
// stayed PENDING forever and TaskForceWorker never started. Re-scan the recent notification
// history idempotently on every hunter cycle so ACCEPTED/SUBMISSION_* state is recoverable.
export async function pollTaskForceNotificationsRecovered(credential){
  const h=headers(credential?.apiKey);
  const r=await fetch('https://www.task-force.app/api/agent/notifications?unreadOnly=false&limit=100',{headers:h,signal:AbortSignal.timeout(12000)});
  const data=await safeJson(r);if(!r.ok)return;
  const notifications=arrayFrom(data,['notifications','items','data']);
  const processed=new Set((this.state?.taskforce?.events||[]).map(x=>String(x?.id||'')).filter(Boolean));
  const toMark=[];
  for(const n of [...notifications].sort((a,b)=>Date.parse(a.createdAt||a.created_at||0)-Date.parse(b.createdAt||b.created_at||0))){
    const id=String(n?.id||'').trim();
    const type=String(n?.type||'').toUpperCase();
    const taskId=taskIdFromNotification(n);
    if(id&&!n?.read)toMark.push(id);
    if(id&&processed.has(id))continue;
    if(taskId&&this.state?.taskforce?.applications?.[taskId]){
      const app=this.state.taskforce.applications[taskId];
      if(APPLIED_FINAL.has(String(app.status||'').toUpperCase()))continue;
      if(type==='APPLICATION_ACCEPTED')app.status='ACCEPTED';
      else if(type==='APPLICATION_REJECTED')app.status='REJECTED';
      else if(type==='SUBMISSION_APPROVED')app.status='PAID_OR_APPROVED';
      else if(type==='SUBMISSION_REJECTED')app.status='SUBMISSION_REJECTED';
      app.updatedAt=new Date().toISOString();
    }
    if(!id||!processed.has(id)){
      this.state.taskforce.events.unshift({at:new Date().toISOString(),id,type,taskId,message:String(n?.message||'').slice(0,400)});
      this.event('taskforce_notification_reconciled',{type,taskId,wasRead:Boolean(n?.read)});
    }
  }
  if(this.state.taskforce.events.length>500)this.state.taskforce.events.length=500;
  this.persist();
  if(toMark.length){
    await fetch('https://www.task-force.app/api/agent/notifications/read',{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({notificationIds:toMark}),signal:AbortSignal.timeout(12000)}).catch(()=>{});
  }
};

