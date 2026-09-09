import { isRetiredMarket } from './retired-markets.js';
import { ActionJournal, classifyFailure } from './action-journal.js';

const safeName=/^[A-Za-z_][A-Za-z0-9_]*$/;
export function operationBody(operation, values){
  const schema=operation?.requestSchema||{},body={};
  for(const [key,definition]of Object.entries(schema.properties||{})){
    if(!safeName.test(key))throw Error('unsafe_schema_field');
    let value=values[key];
    if(value===undefined&&definition.const!==undefined)value=definition.const;
    if(value===undefined)continue;
    if(definition.enum&&!definition.enum.includes(value))throw Error('schema_enum_mismatch:'+key);
    if(definition.type==='number'||definition.type==='integer'){value=Number(value);if(!Number.isFinite(value)||definition.type==='integer'&&!Number.isInteger(value))throw Error('schema_number_required:'+key);}
    if(definition.type==='string')value=String(value);
    body[key]=value;
  }
  for(const key of schema.required||[])if(body[key]===undefined||body[key]==='')throw Error('required_field_unavailable:'+key);
  if(!Object.keys(body).length&&(schema.required?.length||!operation.requestSchema))throw Error('request_schema_not_verified');
  return body;
}
export function responseObject(value){return value?.data?.application||value?.data?.submission||value?.application||value?.submission||value?.data?.job||value?.job||value?.data||value;}
export function responseRows(value){if(Array.isArray(value))return value;for(const key of ['jobs','tasks','applications','submissions','payments','items','results','data']){const v=value?.[key];if(Array.isArray(v))return v;if(v&&typeof v==='object'){const rows=responseRows(v);if(rows.length)return rows;}}return [];}
export class NativeMarketAdapter{
 constructor({id,analysis,credential,root,env=process.env}){this.id=id;this.analysis=analysis;this.credential=credential||{};this.journal=new ActionJournal(root);this.env=env;}
 async request(operation,{jobId='',applicationId='',body,method}={}){
  if(isRetiredMarket(this.id)||isRetiredMarket(this.analysis.host))throw Error('DO_NOT_RESTORE');
  if(!operation?.path)throw Error('verified_operation_missing');
  const ids={id:jobId,job_id:jobId,jobId,task_id:jobId,taskId:jobId,application_id:applicationId,applicationId};
  let unresolved=false;
  const pathname=operation.path.replace(/\{([^}]+)\}/g,(_,key)=>{if(!ids[key]){unresolved=true;return '';}return encodeURIComponent(ids[key]);});
  if(unresolved)throw Error('operation_path_identity_unavailable');
  const url=new URL(pathname,this.analysis.baseUrl||'https://'+this.analysis.host);
  if(url.protocol!=='https:'||url.hostname!==this.analysis.host||url.username||url.password)throw Error('native_origin_blocked');
  const headers={accept:'application/json','content-type':'application/json'};
  let authorized=!(operation.security||[]).length;
  for(const requirement of operation.security||[]){
    const candidateHeaders={};let complete=true;
    for(const name of Object.keys(requirement)){
      const scheme=this.analysis.securitySchemes?.[name],token=this.credential[name]||this.credential.apiKey||this.credential.api_key||this.credential.token||this.credential.access_token||this.credential.accessToken;
      if(!token){complete=false;break;}
      if(scheme?.type==='http'&&scheme.scheme==='bearer')candidateHeaders.authorization='Bearer '+token;
      else if(scheme?.type==='apiKey'&&scheme.in==='header'&&safeName.test(String(scheme.name).replaceAll('-','_')))candidateHeaders[scheme.name]=token;
      else {complete=false;break;}
    }
    if(complete){Object.assign(headers,candidateHeaders);authorized=true;break;}
  }
  if(!authorized)throw Error('native_authenticated_account_required');
  const r=await fetch(url,{method:method||operation.method,headers,redirect:'error',...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  return {ok:r.ok,status:r.status,data:await r.json().catch(()=>null),url:url.href};
 }
 async write(action,job,values){
  if(this.analysis.automationPermitted!==true)throw Error('automation_permission_unverified');
  const op=this.analysis[action];
  const body=operationBody(op,{...values,client_reference:this.journal.key(this.id,job.id,action+':'+Number(job.revision||0)),revision:Number(job.revision||0)}); // Validate before intent; schema errors cause no write.
  const intent=this.journal.begin(this.id,job.id,action+':'+Number(job.revision||0));
  if(!intent.ok)return {ok:intent.status==='confirmed',uncertain:intent.status!=='confirmed',proof:intent.proof,intentId:intent.id};
  try{
    const r=await this.request(op,{jobId:job.externalId,applicationId:job.applicationId,body}),row=responseObject(r.data);
    const externalId=row?.application_id||row?.submission_id||row?.claim_id||row?.id;
    if(r.ok&&externalId){const proof={externalId:String(externalId),url:r.url};this.journal.finish(intent.id,'confirmed',proof);return {...r,ok:true,proof,intentId:intent.id,row};}
    const definite=[400,401,403,404,410,422,429].includes(r.status);
    this.journal.finish(intent.id,definite?'definite_failure':'uncertain',{httpStatus:r.status});
    return {...r,ok:false,uncertain:!definite,intentId:intent.id,failure:classifyFailure(r.status,JSON.stringify(r.data))};
  }catch(e){this.journal.finish(intent.id,'uncertain');return {ok:false,uncertain:true,intentId:intent.id,error:String(e.message)};}
 }
 async reconcile(action,job){
  const operation=this.analysis[action==='claim'?'applications':'submissions'];
  if(!operation)return null;
  const r=await this.request(operation,{jobId:job.externalId,applicationId:job.applicationId});if(!r.ok)return null;
  const agentId=String(this.credential.agentId||this.credential.agent_id||this.credential.id||'');
  if(!agentId)return null;
  const row=responseRows(r.data).find(x=>String(x.job_id||x.jobId||x.task_id||x.taskId||'')===String(job.externalId)&&String(x.agent_id||x.agentId||x.provider_id||'')===agentId&&x.id&&(action!=='delivery'||!Number(job.revision||0)||Number(x.revision)===Number(job.revision)||x.client_reference===this.journal.key(this.id,job.id,'delivery:'+Number(job.revision))));
  if(!row)return null;
  const intentId=this.journal.key(this.id,job.id,action+':'+Number(job.revision||0));
  if(this.journal.read()[intentId])this.journal.finish(intentId,'confirmed',{externalId:String(row.id),url:r.url});
  return row;
 }
}
