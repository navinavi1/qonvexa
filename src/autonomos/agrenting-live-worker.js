import { AgrentingWorker } from './agrenting-worker.js';

const BASE='https://agrenting.com';

// Agrenting documents status and callback metadata as separate PATCH operations.
// Keep this override small so a profile-field validation change cannot prevent the
// provider from becoming visible/online and receiving funded work.
export class AgrentingLiveWorker extends AgrentingWorker{
  async ensureActive(credential){
    const due=!this.state.lastActiveSyncAt||Date.now()-Date.parse(this.state.lastActiveSyncAt)>30*60_000;
    if(!due)return;
    const token=await this.auth(credential);
    if(!token){this.event('auth_failed');return;}
    const headers={authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json'};
    const endpoint=`${BASE}/api/v1/agents/${encodeURIComponent(credential.agentId)}`;

    const statusResponse=await fetch(endpoint,{method:'PATCH',headers,body:JSON.stringify({agent:{status:'active'}}),signal:AbortSignal.timeout(12_000)});
    const statusBody=await safeJson(statusResponse);
    if(!statusResponse.ok){
      this.event('active_sync_failed',{phase:'status',status:statusResponse.status,error:publicError(statusBody)});
      return;
    }

    const site=String(this.env.SITE_URL||this.env.RENDER_EXTERNAL_URL||'https://qonvexa.co').replace(/\/$/,'');
    const callbackUrl=`${site}/health`;
    const metadataResponse=await fetch(endpoint,{method:'PATCH',headers,body:JSON.stringify({agent:{metadata:{callback_url:callbackUrl}}}),signal:AbortSignal.timeout(12_000)});
    const metadataBody=await safeJson(metadataResponse);
    if(!metadataResponse.ok){
      // Status already succeeded: the agent can still be listed. Retry callback metadata later.
      this.state.lastStatusActiveAt=new Date().toISOString();
      this.event('callback_sync_failed',{status:metadataResponse.status,error:publicError(metadataBody),callbackUrl});
      return;
    }

    this.state.lastActiveSyncAt=new Date().toISOString();
    this.state.lastStatusActiveAt=this.state.lastActiveSyncAt;
    this.state.callbackUrl=callbackUrl;
    this.persist();
    this.event('agent_active',{agentId:credential.agentId,callbackUrl});
  }
}

async function safeJson(response){try{return await response.json();}catch{return{};}}
function publicError(data){
  const errors=Array.isArray(data?.errors)?data.errors:[];
  return String(errors[0]?.detail||errors[0]?.title||data?.error?.message||data?.error||data?.message||data?.detail||'').slice(0,400);
}
