import crypto from 'node:crypto';
let jwksCache={at:0,keys:[]};

export async function verifyAuth0Bearer(token,env=process.env){
  const domain=String(env.AUTH0_DOMAIN||'').replace(/^https?:\/\//,'').replace(/\/$/,'');
  const audience=String(env.AUTH0_AUDIENCE||'');
  if(!domain||!audience||!token)return{ok:false,reason:'auth0_not_configured_or_token_missing'};
  try{
    const parts=String(token).split('.'); if(parts.length!==3)return{ok:false,reason:'invalid_jwt'};
    const header=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
    const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
    if(header.alg!=='RS256'||!header.kid)return{ok:false,reason:'unsupported_jwt_algorithm'};
    const iss=`https://${domain}/`; const now=Math.floor(Date.now()/1000);
    if(payload.iss!==iss)return{ok:false,reason:'issuer_mismatch'};
    const aud=Array.isArray(payload.aud)?payload.aud:[payload.aud]; if(!aud.includes(audience))return{ok:false,reason:'audience_mismatch'};
    if(Number(payload.exp||0)<=now||Number(payload.nbf||0)>now+30)return{ok:false,reason:'jwt_expired_or_not_yet_valid'};
    const keys=await getJwks(domain); const jwk=keys.find(k=>k.kid===header.kid); if(!jwk)return{ok:false,reason:'jwt_kid_not_found'};
    const key=crypto.createPublicKey({key:jwk,format:'jwk'});
    const ok=crypto.verify('RSA-SHA256',Buffer.from(`${parts[0]}.${parts[1]}`),key,Buffer.from(parts[2],'base64url'));
    return ok?{ok:true,sub:String(payload.sub||''),scope:String(payload.scope||''),permissions:Array.isArray(payload.permissions)?payload.permissions:[]}:{ok:false,reason:'invalid_jwt_signature'};
  }catch(error){return{ok:false,reason:String(error?.message||error).slice(0,200)}}
}
async function getJwks(domain){
  if(Date.now()-jwksCache.at<60*60_000&&jwksCache.keys.length)return jwksCache.keys;
  const r=await fetch(`https://${domain}/.well-known/jwks.json`,{signal:AbortSignal.timeout(10000)}); if(!r.ok)throw new Error(`auth0_jwks_http_${r.status}`);
  const body=await r.json(); jwksCache={at:Date.now(),keys:Array.isArray(body?.keys)?body.keys:[]}; return jwksCache.keys;
}
