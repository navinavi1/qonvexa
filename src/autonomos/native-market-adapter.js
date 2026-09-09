import { isRetiredMarket } from './retired-markets.js';
import { ActionJournal, classifyFailure } from './action-journal.js';

const safeName=/^[A-Za-z_][A-Za-z0-9_]*$/;
export function schemaProperties(schema,depth=0){
 if(depth>12||schema?.$ref)throw Error('request_schema_not_resolved');
 const properties={...schema?.properties};
 for(const part of [...(schema?.allOf||[]),...(schema?.oneOf||schema?.anyOf||[])])Object.assign(properties,schemaProperties(part,depth+1));
 return properties;
}
export function operationBody(operation, values){
 const schema=operation?.requestSchema;if(!schema)throw Error('request_schema_not_verified');
 const body={};
 for(const [key,definition]of Object.entries(schemaProperties(schema))){
  if(!safeName.test(key)||['__proto__','constructor','prototype'].includes(key))throw Error('unsafe_schema_field');
  let value=Object.hasOwn(values,key)?values[key]:undefined;
  if(value===undefined&&definition.const!==undefined)value=definition.const;
  if(value!==undefined)body[key]=value;
 }
 return validateField({...schema,type:schema.type||'object'},body,'body');
}

function validateField(schema,value,key,depth=0){
 if(depth>12)throw Error('schema_depth_limit');
 if(schema.$ref)throw Error('schema_composition_requires_resolution:'+key);
 if(schema.oneOf||schema.anyOf){const successes=[];for(const alternative of schema.oneOf||schema.anyOf){try{successes.push(validateField(alternative,value,key,depth+1));}catch{}}if(!successes.length||schema.oneOf&&successes.length!==1)throw Error('schema_alternative_mismatch:'+key);value=successes[0];}
 if(schema.allOf){for(const part of schema.allOf)value=validateField(part,value,key,depth+1);}
 if(value===null){if(schema.nullable||schema.type==='null'||Array.isArray(schema.type)&&schema.type.includes('null'))return null;throw Error('schema_null_not_allowed:'+key);}
 const type=Array.isArray(schema.type)?schema.type.find(x=>x!=='null'):schema.type||(schema.properties||schema.required?'object':undefined);
 if(type==='integer'||type==='number'){if(typeof value==='boolean'||value==='')throw Error('schema_number_required:'+key);value=Number(value);if(!Number.isFinite(value)||type==='integer'&&!Number.isInteger(value))throw Error('schema_number_required:'+key);if(schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum)throw Error('schema_range:'+key);}
 if(type==='boolean'&&typeof value!=='boolean')throw Error('schema_boolean_required:'+key);
 if(type==='string'){if(!['string','number'].includes(typeof value))throw Error('schema_string_required:'+key);value=String(value);if(schema.minLength!==undefined&&value.length<schema.minLength||schema.maxLength!==undefined&&value.length>schema.maxLength)throw Error('schema_string_length:'+key);}
 if(type==='array'){if(!Array.isArray(value))throw Error('schema_array_required:'+key);if(schema.minItems!==undefined&&value.length<schema.minItems||schema.maxItems!==undefined&&value.length>schema.maxItems)throw Error('schema_array_length:'+key);value=value.map((x,i)=>validateField(schema.items||{},x,key+'.'+i,depth+1));}
 if(type==='object'){if(typeof value!=='object'||Array.isArray(value))throw Error('schema_object_required:'+key);const out={};for(const [k,v]of Object.entries(value)){if(!safeName.test(k)||['__proto__','constructor','prototype'].includes(k))throw Error('unsafe_schema_field');if(schema.properties?.[k])out[k]=validateField(schema.properties[k],v,key+'.'+k,depth+1);else if(schema.additionalProperties===false)throw Error('schema_unknown_field:'+key+'.'+k);else out[k]=validateField(typeof schema.additionalProperties==='object'?schema.additionalProperties:{},v,key+'.'+k,depth+1);}for(const k of schema.required||[])if(out[k]===undefined||out[k]==='')throw Error('required_field_unavailable:'+key+'.'+k);value=out;}
 if(schema.const!==undefined&&JSON.stringify(schema.const)!==JSON.stringify(value))throw Error('schema_const_mismatch:'+key);
 if(schema.enum&&!schema.enum.some(x=>JSON.stringify(x)===JSON.stringify(value)))throw Error('schema_enum_mismatch:'+key);
 return value;
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
