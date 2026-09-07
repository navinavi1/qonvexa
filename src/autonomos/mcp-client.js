export class McpHttpClient {
  constructor({ url, token='', timeoutMs=15000, clientName='AutonomOS', clientVersion='2.0.0', protocolVersion='2025-06-18' }={}) {
    this.url=String(url||''); this.token=String(token||''); this.timeoutMs=timeoutMs;
    this.clientName=clientName; this.clientVersion=clientVersion; this.protocolVersion=protocolVersion; this.sessionId=''; this.nextId=1;this.toolAliases=new Map();
  }
  async initialize(){
    if(!/^https?:\/\//.test(this.url)) throw new Error('invalid_mcp_url');
    const result=await this.rpc('initialize',{protocolVersion:this.protocolVersion,capabilities:{},clientInfo:{name:this.clientName,version:this.clientVersion}},{captureSession:true});
    try{await this.notify('notifications/initialized',{})}catch{}
    return result;
  }
  async listTools(){
    const r=await this.rpc('tools/list',{}); const tools=Array.isArray(r?.tools)?r.tools:[];
    this.toolAliases.clear();
    // t2000's current Passport Connect surface can expose public Open-board rows through
    // t2000_jobs(role=buyer) -> openings[] instead of the older t2000_job_board tool. Keep
    // the provider-specific compatibility shim at the MCP boundary so the marketplace
    // connector does not silently report a healthy-but-empty board after that schema drift.
    if(isT2000Endpoint(this.url)&&!tools.some(t=>t?.name==='t2000_job_board')&&tools.some(t=>t?.name==='t2000_jobs')){
      this.toolAliases.set('t2000_job_board',{target:'t2000_jobs',arguments:{role:'buyer'},normalize:'t2000_buyer_openings'});
      tools.push({name:'t2000_job_board',description:'Compatibility alias for t2000_jobs(role=buyer) openings.',inputSchema:{type:'object',properties:{}}});
    }
    return tools;
  }
  async callTool(name,args={}){
    const alias=this.toolAliases.get(name);
    const result=await this.rpc('tools/call',{name:alias?.target||name,arguments:alias?alias.arguments:args});
    return alias?.normalize==='t2000_buyer_openings'?normalizeT2000BuyerOpenings(result):result;
  }
  async rpc(method,params={},opts={}){
    const id=this.nextId++;
    const response=await fetch(this.url,{method:'POST',headers:this.headers(),body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(this.timeoutMs)});
    if(opts.captureSession){const sid=response.headers.get('mcp-session-id');if(sid)this.sessionId=sid;}
    const body=await readRpcBody(response);
    if(!response.ok)throw new Error(`mcp_http_${response.status}:${String(body?.error?.message||'').slice(0,120)}`);
    if(body?.error)throw new Error(`mcp_rpc_${body.error.code||'error'}:${String(body.error.message||'').slice(0,160)}`);
    return body?.result;
  }
  async notify(method,params={}){
    const response=await fetch(this.url,{method:'POST',headers:this.headers(),body:JSON.stringify({jsonrpc:'2.0',method,params}),signal:AbortSignal.timeout(this.timeoutMs)});
    if(!response.ok&&response.status!==202&&response.status!==204)throw new Error(`mcp_notify_${response.status}`);
  }
  headers(){return{'content-type':'application/json','accept':'application/json, text/event-stream','user-agent':`${this.clientName}/${this.clientVersion}`,'mcp-protocol-version':this.protocolVersion,...(this.token?{authorization:`Bearer ${this.token}`}:{}) ,...(this.sessionId?{'mcp-session-id':this.sessionId}:{})};}
}

function isT2000Endpoint(value){
  try{return new URL(String(value||'')).hostname.toLowerCase()==='mcp.t2000.ai';}catch{return false;}
}

function normalizeT2000BuyerOpenings(result){
  if(!result||typeof result!=='object')return result;
  if(result.structuredContent&&Array.isArray(result.structuredContent.openings)){
    return {...result,structuredContent:{...result.structuredContent,jobs:result.structuredContent.openings}};
  }
  if(Array.isArray(result.openings))return {...result,jobs:result.openings};
  if(Array.isArray(result.content)){
    const content=result.content.map(item=>{
      if(item?.type!=='text'||typeof item.text!=='string')return item;
      try{
        const parsed=JSON.parse(item.text);
        if(Array.isArray(parsed?.openings))return {...item,text:JSON.stringify({...parsed,jobs:parsed.openings})};
      }catch{}
      return item;
    });
    return {...result,content};
  }
  return result;
}

async function readRpcBody(response){
  const type=String(response.headers.get('content-type')||'');
  if(type.includes('application/json')){try{return await response.json()}catch{return{}}}
  const text=await response.text();
  if(type.includes('text/event-stream')||text.includes('data:')){
    const chunks=[...text.matchAll(/^data:\s*(.+)$/gm)].map(m=>m[1]);
    for(const chunk of chunks.reverse()){try{return JSON.parse(chunk)}catch{}}
  }
  try{return JSON.parse(text)}catch{return{raw:text.slice(0,4000)}}
}

export function extractMcpToolPayload(result){
  if(!result)return null;
  if(result.structuredContent)return result.structuredContent;
  const content=Array.isArray(result.content)?result.content:[];
  for(const item of content){
    if(item?.type==='text'&&typeof item.text==='string'){
      try{return JSON.parse(item.text)}catch{}
    }
  }
  return result;
}
