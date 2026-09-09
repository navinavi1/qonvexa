import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resourceRoot, reserveResource } from './resource-control.js';

export function localArtifactReady(env=process.env){return Boolean(env.STORAGE_DIR&&(env.SITE_URL||env.RENDER_EXTERNAL_URL||env.PUBLIC_URL));}
export async function putLocalArtifact(key,body,contentType,env=process.env){
  if(!localArtifactReady(env))return{ok:false,reason:'persistent_local_artifact_not_configured'};
  if(!Buffer.isBuffer(body))body=Buffer.from(body);if(body.length>25*1024*1024)return{ok:false,reason:'artifact_too_large'};
  const cap=await reserveResource('local_artifact',body.length,env);if(!cap.ok)return cap;
  const root=path.join(resourceRoot(env),'delivery-artifacts');fs.mkdirSync(root,{recursive:true});
  const stats=fs.statfsSync(root);if(Number(stats.bavail)*Number(stats.bsize)<body.length+128*1024*1024)return{ok:false,reason:'artifact_disk_reserve_reached',replacementRequired:true};
  const id=crypto.randomBytes(24).toString('hex');const name=path.basename(String(key||'artifact')).replace(/[^a-zA-Z0-9._-]/g,'_').slice(-120)||'artifact';
  fs.writeFileSync(path.join(root,id+'.bin'),body,{mode:0o600});fs.writeFileSync(path.join(root,id+'.json'),JSON.stringify({name,contentType:String(contentType||'application/octet-stream'),bytes:body.length,createdAt:new Date().toISOString()}),{mode:0o600});
  const base=String(env.SITE_URL||env.RENDER_EXTERNAL_URL||env.PUBLIC_URL).replace(/\/$/,'');
  return{ok:true,key,bytes:body.length,contentType,url:`${base}/autonomos/artifacts/${id}/${name}`,provider:'persistent_local_artifact'};
}
export function serveLocalArtifact(req,res,env=process.env){
  if(!/^[a-f0-9]{48}$/.test(String(req.params.id||'')))return res.sendStatus(404);
  const root=path.join(resourceRoot(env),'delivery-artifacts'),base=path.join(root,req.params.id);
  try{const meta=JSON.parse(fs.readFileSync(base+'.json','utf8'));if(req.params.name!==meta.name)return res.sendStatus(404);res.set({'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${meta.name}"`,'X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=3600'});return res.sendFile(base+'.bin');}catch{return res.sendStatus(404);}
}
