import crypto from 'node:crypto';

// A completed phase is replayed from disk. An interrupted phase is held because its
// external effects may have happened before the completion receipt was persisted.
export function checkpointExecution(store, jobId) {
  if(!store||!jobId)return async (_key,run)=>run();
  const file=`execution-${crypto.createHash('sha256').update(String(jobId)).digest('hex')}.json`;
  return async (key,run,{reconcile}={})=>{
    const read=()=>store.readJsonStrict?store.readJsonStrict(file,{}):store.readJson(file,{});
    const update=fn=>{
      if(store.withLock&&store.writeJsonUnlocked&&store.file)return store.withLock(file,()=>{
        const state=read();const result=fn(state);store.writeJsonUnlocked(store.file(file),state);return result;
      });
      const state=read();const result=fn(state);store.writeJson(file,state);return result;
    };
    const cached=update(state=>{
      if(state[key]?.status==='completed')return {hit:true,result:state[key].result};
      if(state[key]?.status==='started')return {uncertain:true};
      state[key]={status:'started',startedAt:new Date().toISOString()};return {hit:false};
    });
    if(cached.hit)return cached.result;
    if(cached.uncertain){
      const result=reconcile?await reconcile():null;
      if(!result?.ok)throw new Error(`execution_checkpoint_uncertain:${key}`);
      update(state=>{state[key]={status:'completed',result,completedAt:new Date().toISOString(),reconciled:true};});return result;
    }
    // Intentionally retain started on error. Never silently replay possible effects.
    let result;
    try { result=await run(); }
    catch(error) { if(error?.safeToRetry===true)update(state=>{delete state[key];});throw error; }
    update(state=>{state[key]={status:'completed',result,completedAt:new Date().toISOString()};});
    return result;
  };
}
