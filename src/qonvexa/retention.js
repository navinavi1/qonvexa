import { disconnect } from './connections.js';
export function pruneTemporary(store,cfg,now=Date.now()) {
 const cutoff=now-cfg.retentionDays*86400000;let removedReports=0,expiredStates=0,closedConnections=0;
 return store.transaction(()=>{
  for(const a of store.list('audits'))if(a.report&&(a.updatedAt||a.createdAt)<cutoff){a.report=null;a.status='EXPIRED';store.put('audits',a.id,a,a.owner);removedReports++;}
  for(const s of store.list('sessions'))if(s.expiresAt<now){store.remove('sessions',s.owner);expiredStates++;}
  for(const row of store.db.prepare("SELECT id,data FROM records WHERE kind='oauth'").all())if(JSON.parse(row.data).expiresAt<now){store.remove('oauth',row.id);expiredStates++;}
  for(const c of store.list('connections'))if(c.secrets&&(c.lastUsed||c.connectedAt)<cutoff){disconnect(store,c.id,c.owner);closedConnections++;}
  return {removedReports,expiredStates,closedConnections};
 });
}
export function closeAccess(store,owner){return store.transaction(()=>{
 for(const c of store.list('connections',owner))if(c.status!=='DISCONNECTED')disconnect(store,c.id,owner);
 for(const a of store.list('audits',owner))store.put('audits',a.id,{...a,report:null,status:'CLOSED'},owner);
 for(const k of store.list('knowledge',owner))store.remove('knowledge',k.id);
 store.db.prepare("UPDATE jobs SET status='CANCELLED',leaseToken=NULL WHERE owner=? AND status IN ('QUEUED','RUNNING')").run(owner);
 store.remove('sessions',owner);return {status:'CLOSED',orderRecordsRetained:true,remoteRevocation:'CUSTOMER_ACTION_REQUIRED'};
});}
