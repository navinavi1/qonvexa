import { safeGet, normalizeURL } from '../scanner.js';
const expiry=()=>Date.now()+3600000;
export class WordPressAdapter {
  constructor({read=safeGet}={}){this.read=read;}
  async discover({url,username,applicationPassword}){
    const base=new URL(normalizeURL(url));
    if(base.protocol!=='https:')throw new Error('HTTPS_REQUIRED');
    const headers={authorization:`Basic ${Buffer.from(`${username}:${applicationPassword}`).toString('base64')}`};
    const read=async pathname=>{
      const r=await this.read(new URL(pathname,base).href,{headers,origin:base.origin});
      if(r.status!==200)return null;try{return JSON.parse(r.body);}catch{return null;}
    };
    const user=await read('/wp-json/wp/v2/users/me?context=edit');
    if(!user?.id)throw new Error('WORDPRESS_AUTH_FAILED');
    // A permission is true only when the provider explicitly reports it.
    return {platform:'wordpress',verified:true,customerOwned:false,expiresAt:expiry(),permissions:{'content.write':user.capabilities?.edit_pages===true},builder:'unknown',theme:'unknown',plugins:'unknown',version:'unknown',backup:false,rollback:false,staging:false,planVerified:false,externalCostsReviewed:false,limitations:['Application Password inherits user permissions; use a dedicated least-privilege user.','Builder, backup, staging and update status need an authorized site-specific probe.']};
  }
}
export class PipedriveAdapter {
  constructor({read=safeGet}={}){this.read=read;}
  async discover({accessToken}){
    const r=await this.read('https://api.pipedrive.com/api/v2/pipelines',{headers:{authorization:`Bearer ${accessToken}`}});
    let body;try{body=JSON.parse(r.body);}catch{throw new Error('INVALID_PROVIDER_RESPONSE');}
    if(r.status!==200||body.success!==true||!Array.isArray(body.data))throw new Error('PIPEDRIVE_AUTH_OR_PERMISSION_FAILED');
    return {platform:'pipedrive',verified:true,customerOwned:false,expiresAt:expiry(),permissions:{'pipelines.read':true},planVerified:false,backup:false,rollback:false,externalCostsReviewed:false,limitations:['Pipeline read access does not imply write/workflow entitlement.','OAuth registration, refresh and production write flows not implemented.']};
  }
}
export class ZohoAdapter {
  constructor({read=safeGet}={}){this.read=read;}
  async discover({accessToken,apiDomain='https://www.zohoapis.com'}){
    if(!['https://www.zohoapis.com','https://www.zohoapis.eu','https://www.zohoapis.in','https://www.zohoapis.com.au','https://www.zohoapis.jp','https://www.zohoapis.ca'].includes(apiDomain))throw new Error('PROVIDER_DOMAIN_NOT_ALLOWED');
    const r=await this.read(`${apiDomain}/crm/v8/org`,{headers:{authorization:`Zoho-oauthtoken ${accessToken}`}});
    let body;try{body=JSON.parse(r.body);}catch{throw new Error('INVALID_PROVIDER_RESPONSE');}
    if(r.status!==200||!Array.isArray(body.org)||!body.org.length)throw new Error('ZOHO_AUTH_OR_PERMISSION_FAILED');
    return {platform:'zoho',verified:true,customerOwned:false,expiresAt:expiry(),permissions:{'org.read':true},planVerified:false,backup:false,rollback:false,externalCostsReviewed:false,limitations:['Org read access does not prove workflow/function permissions or edition.','OAuth registration, refresh and write flows not implemented.']};
  }
}
export const integrationStatus={wordpress:{status:'PARTIAL',authentication:'Application Password',discovery:'Limited read probe',writes:'NOT IMPLEMENTED'},pipedrive:{status:'PARTIAL',authentication:'OAuth lifecycle NOT IMPLEMENTED',discovery:'Pipeline read probe',writes:'NOT IMPLEMENTED'},zoho:{status:'PARTIAL',authentication:'OAuth lifecycle NOT IMPLEMENTED',discovery:'Organization read probe',writes:'NOT IMPLEMENTED'},ga4:{status:'NOT IMPLEMENTED',verification:'Requires correlated test event receipt from an authorized property'},gtm:{status:'NOT IMPLEMENTED',writes:'Plan only; publishing requires approval'},gsc:{status:'NOT IMPLEMENTED',verification:'Requires verified authorized property'},email:{status:'NOT IMPLEMENTED'},sms:{status:'NOT IMPLEMENTED'},whatsapp:{status:'NOT IMPLEMENTED'},booking:{status:'NOT IMPLEMENTED'}};
export function trackingPlan(report){return {status:'PLAN_ONLY',events:['form_submit','booking_click','phone_click','email_click','whatsapp_click','cta_click'].map(name=>({name,status:'UNVERIFIED',requires:['Client-approved trigger','Consent review','Authorized property','Correlated QA event receipt']})),evidenceIds:report.findings.filter(f=>f.category==='analytics').map(f=>f.id)};}
export function verifyTrackingReceipt({testId,eventName,propertyId,receipt}){return !!receipt&&receipt.provider==='ga4'&&receipt.verified===true&&receipt.testId===testId&&receipt.eventName===eventName&&receipt.propertyId===propertyId&&receipt.receivedAt>0;}
