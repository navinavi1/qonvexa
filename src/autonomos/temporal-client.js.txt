import crypto from 'node:crypto';

export function temporalEnabled(env=process.env){return Boolean(String(env.TEMPORAL_ADDRESS||'').trim()&&String(env.AUTONOMOS_TEMPORAL_WORKER_TOKEN||'').trim());}

export async function dispatchPaidOpportunity(opportunity,env=process.env){
  if(!temporalEnabled(env))return{ok:false,reason:'temporal_not_configured'};
  let connection;
  try{
    const {Connection,Client}=await import('@temporalio/client');
    connection=await Connection.connect({address:String(env.TEMPORAL_ADDRESS),tls:/^(1|true|yes)$/i.test(String(env.TEMPORAL_TLS||''))?{}:undefined});
    const client=new Client({connection,namespace:String(env.TEMPORAL_NAMESPACE||'default')});
    const raw=`${opportunity?.source||'market'}-${opportunity?.externalId||crypto.randomUUID()}`;
    const workflowId=`autonomos-paid-${raw}`.replace(/[^a-zA-Z0-9._:-]/g,'-').slice(0,240);
    const handle=await client.workflow.start('paidJobWorkflow',{taskQueue:String(env.TEMPORAL_TASK_QUEUE||'autonomos-paid-jobs'),workflowId,args:[{opportunity}],workflowExecutionTimeout:'24 hours'});
    return{ok:true,workflowId:handle.workflowId,runId:handle.firstExecutionRunId||''};
  }catch(error){
    const msg=String(error?.message||error);
    if(/already started|ALREADY_EXISTS|WorkflowExecutionAlreadyStarted/i.test(msg))return{ok:true,duplicate:true,workflowId:`autonomos-paid-${String(opportunity?.source||'market')}-${String(opportunity?.externalId||'')}`};
    return{ok:false,reason:msg.slice(0,300)};
  }finally{try{await connection?.close();}catch{}}
}

export async function temporalStatus(env=process.env){if(!env.TEMPORAL_ADDRESS)return{configured:false,connected:false,reason:'TEMPORAL_ADDRESS missing'};try{const {Connection}=await import('@temporalio/client');const connection=await Connection.connect({address:env.TEMPORAL_ADDRESS,tls:/^(1|true|yes)$/i.test(String(env.TEMPORAL_TLS||''))?{}:undefined});await connection.close();return{configured:true,connected:true,taskQueue:String(env.TEMPORAL_TASK_QUEUE||'autonomos-paid-jobs')};}catch(error){return{configured:true,connected:false,reason:String(error?.message||error).slice(0,240)}}}
