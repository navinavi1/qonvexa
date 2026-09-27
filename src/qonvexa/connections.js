import crypto from 'node:crypto';
import { seal, unseal, owned } from './security.js';
export function publicConnection(c){return {id:c.id,provider:c.provider,status:c.status,permissions:c.capabilities?.permissions||{},connectedAt:c.connectedAt,lastUsed:c.lastUsed||null,capabilities:c.capabilities,remoteRevocation:c.remoteRevocation||'NOT_REQUESTED'};}
export function saveConnection(store,{owner,provider,credentials,capabilities,key}){
  const id=crypto.randomUUID();const c={id,owner,provider,status:'CONNECTED_READ_ONLY',connectedAt:Date.now(),capabilities,secrets:seal(credentials,key,`${owner}:${id}`)};
  store.put('connections',id,c,owner);store.event('connection_added',{connectionId:id});return publicConnection(c);
}
export function getCredentials(store,id,owner,key){const c=owned(store,'connections',id,owner);if(!c.secrets||c.status==='DISCONNECTED')throw new Error('DISCONNECTED');return unseal(c.secrets,key,`${owner}:${id}`);}
export function disconnect(store,id,owner){const c=owned(store,'connections',id,owner);delete c.secrets;c.status='DISCONNECTED';c.capabilities=null;c.disconnectedAt=Date.now();c.remoteRevocation='CUSTOMER_ACTION_REQUIRED';store.put('connections',id,c,owner);store.event('connection_revoked',{connectionId:id,reason:'LOCAL_CREDENTIALS_DELETED'});return publicConnection(c);}
