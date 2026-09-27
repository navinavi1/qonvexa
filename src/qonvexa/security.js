import crypto from 'node:crypto';
export const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const token = () => crypto.randomBytes(32).toString('hex');
export function bearer(req) {const s=req.headers.authorization||'';return /^Bearer [a-f0-9]{64}$/.test(s)?s.slice(7):'';}
export function owned(store,kind,id,owner){const row=store.get(kind,id);if(!row||row.owner!==owner)throw Object.assign(new Error('NOT_FOUND'),{status:404});return row;}
export function seal(value,key,aad) {
  if(!/^[a-f0-9]{64}$/i.test(key||''))throw new Error('ENCRYPTION_KEY_REQUIRED');
  const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return {iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('hex')};
}
export function unseal(value,key,aad) {const d=crypto.createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),Buffer.from(value.iv,'hex'));d.setAAD(Buffer.from(aad));d.setAuthTag(Buffer.from(value.tag,'hex'));return JSON.parse(Buffer.concat([d.update(Buffer.from(value.ciphertext,'hex')),d.final()]).toString());}
export function issueOAuthState(store,owner,provider,redirect,allowlist) {
  if(!allowlist.includes(redirect))throw new Error('REDIRECT_NOT_ALLOWED');
  const state=token();store.put('oauth',hash(state),{owner,provider,redirect,expiresAt:Date.now()+600000},owner);return state;
}
export function consumeOAuthState(store,state,owner,provider) {
  return store.transaction(()=>{const row=store.get('oauth',hash(state));if(!row||row.owner!==owner||row.provider!==provider||row.expiresAt<Date.now())throw new Error('INVALID_OAUTH_STATE');store.remove('oauth',hash(state));return row;});
}
