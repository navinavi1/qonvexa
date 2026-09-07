// One isolated filesystem per execution, shared by its tool calls and specialists.
// Never reconnect an expired sandbox as an empty replacement after execution has begun:
// replaying earlier commands could repeat work or invalidate evidence. A CREATE failure is
// different: no sandbox ever existed and therefore no job-side effect could have occurred.
export class SandboxSession {
  constructor({env=process.env, create=null}={}) {
    this.env=env; this.create=create; this.pending=null; this.closed=false;
  }
  async get(signal) {
    signal?.throwIfAborted();
    if(this.closed)throw new Error('sandbox_session_closed');
    if(!this.pending){
      const attempt=(async()=>{
        const create=this.create || (async options=>{
          const {Sandbox}=await import('@e2b/code-interpreter');
          return Sandbox.create(options);
        });
        const timeoutMs=Math.max(60000,Math.min(1800000,Number(this.env.AUTONOMOS_E2B_SESSION_TIMEOUT_MS||900000)));
        const sbx=await create({apiKey:this.env.E2B_API_KEY,timeoutMs});
        if(this.closed || signal?.aborted){await sbx.kill().catch(()=>{});throw new Error('sandbox_session_closed');}
        return sbx;
      })();
      this.pending=attempt;
      // Do not poison the whole job when E2B sandbox creation has a transient failure.
      // No sandbox existed, so clearing the rejected creation promise is retry-safe. The
      // next explicit tool call may create a fresh sandbox. Once creation SUCCEEDS we keep
      // that exact sandbox for the execution and never silently replace it.
      attempt.catch(()=>{if(!this.closed&&this.pending===attempt)this.pending=null;});
    }
    return this.pending;
  }
  async close() {
    this.closed=true;
    const pending=this.pending;this.pending=null;
    if(pending)await pending.then(s=>s.kill()).catch(()=>{});
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
