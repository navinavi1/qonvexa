import { AgrentingWorker } from './agrenting-worker.js';

const BASE='https://agrenting.com';

// Agrenting documents status and callback metadata on /api/v1/agents/:id. In practice the
// endpoint has returned 422 to PATCH for some self-registered agents, so use a conservative
// PATCH -> PUT -> authenticated GET confirmation flow. Never create a second agent merely
// because a profile update failed.
export class AgrentingLiveWorker extends AgrentingWorker{
  async ensureActive(credential){
    const due=!this.state.lastActiveSyncAt||Date.now()-Date.parse(this.state.lastActiveSyncAt)>30*60_000;
    if(!due)return;
    const token=await this.auth(credential);
    if(!token){this.event('auth_failed');return;}
    const headers={authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json'};
    const endpoint=`${BASE}/api/v1/agents/${encodeURIComponent(credential.agentId)}`;

    const status=await updateAgent(endpoint,headers,{status:'active'});
    if(!status.ok){
      const current=await readAgent(endpoint,headers);
      const currentStatus=String(current?.agent?.status||current?.status||current?.data?.agent?.status||current?.data?.status||'').toLowerCase();
      if(currentStatus!=='active'){
        this.event('active_sync_failed',{phase:'status',status:status.status,error:status.error,currentStatus});
        return;
      }
      this.event('agent_already_active',{agentId:credential.agentId,updateStatus:status.status});
    }

    const site=String(this.env.SITE_URL||this.env.RENDER_EXTERNAL_URL||'https://qonvexa.co').replace(/\/$/,'');
    const callbackUrl=`${site}/health`;
    const metadata=await updateAgent(endpoint,headers,{metadata:{callback_url:callbackUrl}});
    this.state.lastStatusActiveAt=new Date().toISOString();
    if(!metadata.ok){
      // The provider is already active; callback metadata is only a liveness fallback.
      this.state.lastActiveSyncAt=this.state.lastStatusActiveAt;
      this.persist();
      this.event('callback_sync_failed',{status:metadata.status,error:metadata.error,callbackUrl});
      return;
    }

    this.state.lastActiveSyncAt=new Date().toISOString();
    this.state.lastStatusActiveAt=this.state.lastActiveSyncAt;
    this.state.callbackUrl=callbackUrl;
    this.persist();
    this.event('agent_active',{agentId:credential.agentId,callbackUrl,updateMethod:metadata.method});
  }
}

async function updateAgent(endpoint,headers,agentPatch){
  let last={ok:false,status:0,error:'',method:'PATCH'};
  for(const method of ['PATCH','PUT']){
    try{
      const response=await fetch(endpoint,{method,headers,body:JSON.stringify({agent:agentPatch}),signal:AbortSignal.timeout(12_000)});
      const body=await safeJson(response);last={ok:response.ok,status:response.status,error:publicError(body),method};
      if(response.ok)return last;
      // Validation/method drift may differ between PATCH and PUT; authentication failures will not.
      if([401,403,404].includes(response.status))return last;
    }catch(error){last={ok:false,status:0,error:String(error?.message||error).slice(0,300),method};}
  }
  return last;
}
async function readAgent(endpoint,headers){try{const response=await fetch(endpoint,{headers:{authorization:headers.authorization,accept:'application/json'},signal:AbortSignal.timeout(12_000)});return response.ok?await safeJson(response):{};}catch{return{};}}
async function safeJson(response){try{return await response.json();}catch{return{};}}
function publicError(data){
  const errors=Array.isArray(data?.errors)?data.errors:[];
  return String(errors[0]?.detail||errors[0]?.title||data?.error?.message||data?.error||data?.message||data?.detail||'').slice(0,400);
}
