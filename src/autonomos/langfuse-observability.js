let setupPromise=null;
let tracingModule=null;

async function setup(env=process.env){
  if(!env.LANGFUSE_PUBLIC_KEY||!env.LANGFUSE_SECRET_KEY)return false;
  if(setupPromise)return setupPromise;
  setupPromise=(async()=>{
    try{
      const [{NodeSDK},{LangfuseSpanProcessor},tracing]=await Promise.all([
        import('@opentelemetry/sdk-node'),import('@langfuse/otel'),import('@langfuse/tracing')
      ]);
      const sdk=new NodeSDK({spanProcessors:[new LangfuseSpanProcessor({exportMode:'immediate'})]});
      sdk.start(); tracingModule=tracing; return true;
    }catch{return false;}
  })();
  return setupPromise;
}

export async function withAgentTrace(name,metadata,fn,{env=process.env}={}){
  const ready=await setup(env);
  if(!ready||!tracingModule?.startActiveObservation)return fn();
  return tracingModule.startActiveObservation(String(name||'autonomos-operation'),async span=>{
    try{span.update({metadata});}catch{}
    try{const output=await fn();try{span.update({output:safeOutput(output)});}catch{}return output;}
    catch(error){try{span.update({level:'ERROR',statusMessage:String(error?.message||error).slice(0,300)});}catch{}throw error;}
  });
}
function safeOutput(value){try{return JSON.parse(JSON.stringify(value).slice(0,8000));}catch{return String(value).slice(0,8000)}}
