// One isolated filesystem per execution, shared by its tool calls and specialists.
// Never reconnect an expired sandbox as an empty replacement: replaying earlier
// commands could repeat external effects. The owning execution must handle recovery.
export class SandboxSession {
  constructor({env=process.env, create=null}={}) {
    this.env=env; this.create=create; this.pending=null; this.closed=false;
  }
  async get(signal) {
    signal?.throwIfAborted();
    if(this.closed)throw new Error('sandbox_session_closed');
    if(!this.pending) this.pending=(async()=>{
      const create=this.create || (async options=>{
        const {Sandbox}=await import('@e2b/code-interpreter');
        return Sandbox.create(options);
      });
      const timeoutMs=Math.max(60000,Math.min(1800000,Number(this.env.AUTONOMOS_E2B_SESSION_TIMEOUT_MS||900000)));
      const sbx=await create({apiKey:this.env.E2B_API_KEY,timeoutMs});
      if(this.closed || signal?.aborted){await sbx.kill().catch(()=>{});throw new Error('sandbox_session_closed');}
      return sbx;
    })();
    return this.pending;
  }
  async close() {
    this.closed=true;
    if(this.pending)await this.pending.then(s=>s.kill()).catch(()=>{});
  }
}

export async function abortable(promise,signal) {
  if(!signal)return promise;
  signal.throwIfAborted();
  let onAbort;
  const aborted=new Promise((_,reject)=>{onAbort=()=>reject(new Error('aborted_by_emergency_stop'));signal.addEventListener('abort',onAbort,{once:true});});
  try{return await Promise.race([promise,aborted]);}
  finally{signal.removeEventListener('abort',onAbort);}
}
