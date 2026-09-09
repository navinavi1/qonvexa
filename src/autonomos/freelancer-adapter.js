import { NativeMarketAdapter } from './native-market-adapter.js';

// Endpoint and payload contracts follow Freelancer's own freelancer-sdk-python.
// Only provider actions: bid, accept an award, deliver to the project thread, read milestones.
export class FreelancerAdapter extends NativeMarketAdapter {
 async api(path,{method='GET',body,form=false}={}){
  const token=this.env.FREELANCER_OAUTH_TOKEN;
  if(!token)throw Error('freelancer_oauth_account_required');
  const r=await fetch('https://www.freelancer.com/api/'+path,{method,redirect:'error',headers:{'Freelancer-OAuth-V1':token,accept:'application/json',...(body?{'content-type':form?'application/x-www-form-urlencoded':'application/json'}:{})},...(body?{body:form?new URLSearchParams(body).toString():JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  const data=await r.json().catch(()=>({}));return {ok:r.ok&&data.status!=='error',status:r.status,data:data.result||data};
 }
 async prepare(){const r=await this.api('users/0.1/self/');if(!r.ok||!r.data.id)throw Error('freelancer_authenticated_account_required');this.credential={id:String(r.data.id)};return this.credential;}
 async request(operation,{jobId,body}={}){
  if(!this.credential.id)await this.prepare();
  if(operation.path==='details'){
   const r=await this.api(`projects/0.1/projects/${jobId}/?full_description=true`);if(!r.ok)return r;
   const p=r.data,bids=await this.api(`projects/0.1/bids/?projects[]=${jobId}&limit=100`);if(!bids.ok)return bids;
   const own=(bids.data.bids||[]).find(b=>String(b.bidder_id)===this.credential.id);
   const awarded=own&&['awarded','accepted'].includes(own.award_status);
   if(awarded&&own.award_status==='awarded'){
     const intent=this.journal.begin('freelancer',String(own.id),'accept_award');
     if(intent.ok){const accept=await this.api(`projects/0.1/bids/${own.id}/?action=accept`,{method:'PUT'});this.journal.finish(intent.id,accept.ok?'confirmed':[400,401,403,404,422].includes(accept.status)?'definite_failure':'uncertain',accept.ok?{externalId:String(own.id)}:{httpStatus:accept.status});}
     // Never execute before the next authoritative read reflects accepted.
   }
   const milestones=awarded?await this.api(`projects/0.1/milestones/?projects[]=${jobId}&limit=100`):null;
   const rows=(milestones?.data?.milestones||[]).filter(m=>String(m.bidder_id)===this.credential.id);
   const funded=rows.some(m=>['funded','pending','created','released'].includes(m.status)&&Number(m.amount)>0);
   const paid=rows.filter(m=>m.status==='released'&&m.id&&Number(m.amount)>0);
   const currency=p.currency?.code||'UNKNOWN';
   const reward=Number(own?.amount||p.budget?.minimum||p.budget?.maximum||0);
   return {ok:true,status:200,data:{id:String(p.id),title:p.title,description:p.description||p.preview_description,status:p.status==='closed'&&!awarded?'expired':paid.length?'completed':p.status,currency,payout:reward,payoutUsd:currency==='USD'?reward:null,workType:p.type==='hourly'?'EMPLOYMENT':'REAL_MARKET_JOB',competitive:true,assigned_agent_id:own?.award_status==='accepted'&&funded?this.credential.id:'',ownerId:p.owner_id,bidId:own?.id,applicationRoute:'API_BID',observedAt:new Date().toISOString(),payment_status:paid.length&&currency==='USD'?'released':'pending',paid_amount_usd:currency==='USD'?paid.reduce((n,m)=>n+Number(m.amount),0):0,payments:currency==='USD'?paid.map(m=>({id:String(m.id),amountUsd:Number(m.amount),feeUsd:Number(m.fee||0)})):[],payment_transaction_id:paid.length?paid.map(m=>String(m.id)).sort().join(':'):''},url:`https://www.freelancer.com/projects/${p.seo_url||p.id}`};
  }
  if(operation.path==='claim'){
    const r=await this.api('projects/0.1/bids/',{method:'POST',body});return {...r,data:{...r.data,id:r.data.id},url:`https://www.freelancer.com/projects/${jobId}`};
  }
  if(operation.path==='delivery'){
    const project=await this.api(`projects/0.1/projects/${jobId}/`);if(!project.ok)return project;
    const threads=await this.api(`messages/0.1/threads/?context_type=project&context=${jobId}`);if(!threads.ok)return threads;
    const thread=(threads.data.threads||[]).find(t=>String(t.context?.id||t.context)===String(jobId));
    const r=thread?await this.api(`messages/0.1/threads/${thread.id}/messages/`,{method:'POST',form:true,body:{message:body.content}}):await this.api('messages/0.1/threads/',{method:'POST',form:true,body:{'members[]':project.data.owner_id,context_type:'project',context:jobId,message:body.content}});
    return {...r,data:{...r.data,id:r.data.id},url:`https://www.freelancer.com/projects/${jobId}`};
  }
  throw Error('freelancer_operation_not_supported');
 }
 async write(action,job,values){
   if(action==='claim')values={project_id:Number(job.externalId),bidder_id:Number(this.credential.id),description:values.proposal,amount:values.amount,period:Math.max(1,Math.min(30,Number(this.env.AUTONOMOS_FREELANCER_DELIVERY_DAYS||7))),milestone_percentage:100};
   if(action==='delivery')values={...values,content:values.content+'\n\nAutonomOS delivery: '+this.journal.key(this.id,job.id,'delivery:'+Number(job.revision||0))};
   return super.write(action,job,values);
 }
 async reconcile(action,job){
  if(action==='delivery'){
   const threads=await this.api(`messages/0.1/threads/?context_type=project&context=${job.externalId}`);if(!threads.ok)return null;
   const marker='AutonomOS delivery: '+this.journal.key(this.id,job.id,'delivery:'+Number(job.revision||0));
   for(const thread of threads.data.threads||[]){
    if(String(thread.context?.id||thread.context)!==String(job.externalId))continue;
    const messages=await this.api(`messages/0.1/messages/?thread_id=${thread.id}&limit=100`);if(!messages.ok)continue;
    const row=(messages.data.messages||[]).find(m=>String(m.from_user||m.from_user_id||m.sender_id)===this.credential.id&&String(m.message||m.body||'').includes(marker));
    if(row?.id){const key=this.journal.key(this.id,job.id,'delivery:'+Number(job.revision||0));if(this.journal.read()[key])this.journal.finish(key,'confirmed',{externalId:String(row.id)});return row;}
   }return null;
  }
  if(action!=='claim')return null;
  const r=await this.api(`projects/0.1/bids/?projects[]=${job.externalId}&limit=100`);if(!r.ok)return null;
  const row=(r.data.bids||[]).find(b=>String(b.bidder_id)===this.credential.id);
  if(row?.id){const key=this.journal.key(this.id,job.id,'claim:'+Number(job.revision||0));if(this.journal.read()[key])this.journal.finish(key,'confirmed',{externalId:String(row.id)});return row;}return null;
 }
}
const operation=(path,properties)=>({path,method:'POST',requestSchema:{type:'object',properties:Object.fromEntries(Object.entries(properties).map(([k,type])=>[k,{type}])),required:Object.keys(properties)}});
export const freelancerAnalysis={host:'www.freelancer.com',automationPermitted:true,applicationCostUsd:0,details:{path:'details',method:'GET'},claim:operation('claim',{project_id:'integer',bidder_id:'integer',description:'string',amount:'number',period:'integer',milestone_percentage:'integer'}),delivery:operation('delivery',{content:'string'})};
