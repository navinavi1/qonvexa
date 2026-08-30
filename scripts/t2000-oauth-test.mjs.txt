import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { AutonomOSStore } from '../src/autonomos/store.js';
import { createT2000OAuth } from '../src/autonomos/t2000-oauth.js';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autonomos-t2000-oauth-'));
const store=new AutonomOSStore(dir);
let clock=1_800_000_000_000;
let tokenCalls=0;
const fetchFn=async(url,options={})=>{
  const u=String(url);
  if(u==='https://mcp.t2000.ai/mcp')return new Response('',{status:401,headers:{'www-authenticate':'Bearer resource_metadata="https://mcp.t2000.ai/.well-known/oauth-protected-resource/mcp", scope="market:read market:write"'}});
  if(u==='https://mcp.t2000.ai/.well-known/oauth-protected-resource/mcp')return json({resource:'https://mcp.t2000.ai/mcp',authorization_servers:['https://auth.t2000.test']});
  if(u==='https://auth.t2000.test/.well-known/oauth-authorization-server')return json({issuer:'https://auth.t2000.test',authorization_endpoint:'https://auth.t2000.test/authorize',token_endpoint:'https://auth.t2000.test/token',client_id_metadata_document_supported:true});
  if(u==='https://auth.t2000.test/token'){
    tokenCalls++;
    const body=new URLSearchParams(String(options.body||''));
    assert.equal(body.get('resource'),'https://mcp.t2000.ai/mcp');
    assert.equal(body.get('client_id'),'https://qonvexa.co/oauth/t2000-client.json');
    if(body.get('grant_type')==='authorization_code'){
      assert.equal(body.get('code'),'code-123');assert.ok(body.get('code_verifier'));
      return json({access_token:'access-1',refresh_token:'refresh-1',token_type:'Bearer',expires_in:3600,scope:'market:read market:write'});
    }
    assert.equal(body.get('grant_type'),'refresh_token');assert.equal(body.get('refresh_token'),'refresh-1');
    return json({access_token:'access-2',token_type:'Bearer',expires_in:3600,scope:'market:read market:write'});
  }
  throw new Error(`unexpected_fetch:${u}`);
};
const oauth=createT2000OAuth({store,siteUrl:'https://qonvexa.co',env:{T2000_MCP_URL:'https://mcp.t2000.ai/mcp',ADMIN_SESSION_SECRET:'test-storage-secret'},fetchFn,now:()=>clock,logger:{warn(){}}});
const begin=await oauth.beginConnect();
const authUrl=new URL(begin.authorizationUrl);
assert.equal(authUrl.origin,'https://auth.t2000.test');
assert.equal(authUrl.searchParams.get('client_id'),'https://qonvexa.co/oauth/t2000-client.json');
assert.equal(authUrl.searchParams.get('redirect_uri'),'https://qonvexa.co/api/admin/autonomos/t2000/callback');
assert.equal(authUrl.searchParams.get('resource'),'https://mcp.t2000.ai/mcp');
assert.equal(authUrl.searchParams.get('code_challenge_method'),'S256');
assert.ok(authUrl.searchParams.get('code_challenge'));
assert.equal(authUrl.searchParams.get('scope'),'market:read market:write');
await oauth.finishConnect({code:'code-123',state:authUrl.searchParams.get('state'),iss:'https://auth.t2000.test'});
assert.equal(oauth.status().connected,true);
assert.equal(await oauth.getAccessToken({required:true}),'access-1');
const envelope=store.readJson('t2000-oauth.private.json',{});
assert.equal(envelope.alg,'A256GCM');assert.equal(JSON.stringify(envelope).includes('access-1'),false);
clock+=3_700_000;
assert.equal(await oauth.getAccessToken({required:true}),'access-2');
assert.equal(tokenCalls,2);
oauth.disconnect();assert.equal(oauth.status().connected,false);
console.log('t2000 OAuth test PASS');

function json(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})}

// Backwards-compatible MCP authorization servers may expose RFC7591 Dynamic Client
// Registration instead of Client ID Metadata Documents. AutonomOS supports that path too,
// so the owner still gets the same one-click browser flow without manually creating a key.
{
  const dir2=fs.mkdtempSync(path.join(os.tmpdir(),'autonomos-t2000-oauth-dcr-'));
  const store2=new AutonomOSStore(dir2);let dcrCalled=false;
  const fetchDcr=async(url,options={})=>{
    const u=String(url);
    if(u==='https://mcp.t2000.ai/mcp')return new Response('',{status:401,headers:{'www-authenticate':'Bearer resource_metadata="https://mcp.t2000.ai/.well-known/oauth-protected-resource/mcp"'}});
    if(u==='https://mcp.t2000.ai/.well-known/oauth-protected-resource/mcp')return json({resource:'https://mcp.t2000.ai/mcp',authorization_servers:['https://legacy-auth.t2000.test']});
    if(u==='https://legacy-auth.t2000.test/.well-known/oauth-authorization-server')return json({issuer:'https://legacy-auth.t2000.test',authorization_endpoint:'https://legacy-auth.t2000.test/authorize',token_endpoint:'https://legacy-auth.t2000.test/token',registration_endpoint:'https://legacy-auth.t2000.test/register'});
    if(u==='https://legacy-auth.t2000.test/register'){
      dcrCalled=true;const body=JSON.parse(String(options.body||'{}'));assert.equal('client_id' in body,false);assert.deepEqual(body.redirect_uris,['https://qonvexa.co/api/admin/autonomos/t2000/callback']);
      return json({client_id:'dynamic-client-1',token_endpoint_auth_method:'none'});
    }
    if(u==='https://legacy-auth.t2000.test/token')return json({access_token:'dcr-access',expires_in:3600});
    throw new Error(`unexpected_dcr_fetch:${u}`);
  };
  const oauth2=createT2000OAuth({store:store2,siteUrl:'https://qonvexa.co',env:{ADMIN_SESSION_SECRET:'test-storage-secret'},fetchFn:fetchDcr,now:()=>clock,logger:{warn(){}}});
  const begin2=await oauth2.beginConnect();const url2=new URL(begin2.authorizationUrl);assert.equal(url2.searchParams.get('client_id'),'dynamic-client-1');assert.equal(dcrCalled,true);
  await oauth2.finishConnect({code:'dcr-code',state:url2.searchParams.get('state'),iss:'https://legacy-auth.t2000.test'});assert.equal(await oauth2.getAccessToken({required:true}),'dcr-access');
}
console.log('t2000 OAuth DCR fallback PASS');
