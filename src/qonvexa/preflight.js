import { catalog, serviceMatrix } from './catalog.js';
import { hash } from './security.js';
export function preflight(serviceId,capability,now=Date.now(),services=catalog()) {
  const service=services.find(s=>s.id===serviceId);if(!service)throw new Error('UNKNOWN_SERVICE');
  const reasons=[];
  if(!capability)return {status:'ASSISTED',passed:false,reasons:['CONNECTION_REQUIRED'],serviceId,checkedAt:now};
  if(!service.supportedPlatforms.includes(capability.platform))return {status:'UNSUPPORTED',passed:false,reasons:['UNSUPPORTED_PLATFORM'],serviceId,checkedAt:now};
  if(capability.expiresAt<now||!capability.expiresAt)reasons.push('CAPABILITIES_STALE');
  if(capability.verified!==true)reasons.push('CAPABILITIES_UNVERIFIED');
  if(capability.customerOwned!==true)reasons.push('OWNERSHIP_UNVERIFIED');
  for(const required of service.requiredCapabilities)if(capability.permissions?.[required]!==true)reasons.push(`MISSING:${required}`);
  for(const required of ['backup','rollback','planVerified','externalCostsReviewed'])if(capability[required]!==true)reasons.push(`MISSING:${required}`);
  if(capability.platform==='wordpress'&&!['gutenberg'].includes(capability.builder))reasons.push('BUILDER_CUSTOM_REVIEW');
  const matrix=serviceMatrix.find(m=>m.serviceId===serviceId&&m.platform===capability.platform);
  if(!matrix||!service.liveExecutorAvailable)reasons.push('LIVE_EXECUTOR_NOT_IMPLEMENTED');
  return {serviceId,status:reasons.length?'CUSTOM REVIEW':'AUTOMATED',passed:reasons.length===0,reasons,checkedAt:now,capabilityHash:hash(JSON.stringify(capability)),risk:service.riskLevel};
}
export function quote({owner,serviceId,findingIds,report,capability,cfg,now=Date.now(),env=process.env}){
  const services=catalog(env),service=services.find(s=>s.id===serviceId);
  if(!service)throw new Error('UNKNOWN_SERVICE');
  const selected=[...new Set(findingIds)].map(id=>report.findings.find(f=>f.id===id));
  if(!selected.length||selected.some(f=>!f||!service.eligibleFindings.includes(f.category)))throw new Error('INVALID_SCOPE');
  const check=preflight(serviceId,capability,now,services);
  const amount=Math.min(service.pricingRules.maxPriceCents,service.basePrice+(selected.length-1)*service.pricingRules.incrementPerFindingCents);
  const scope={serviceId,findingIds:selected.map(f=>f.id).sort(),definitionOfDone:service.definitionOfDone};
  return {owner,...scope,scopeHash:hash(JSON.stringify(scope)),status:check.passed?'QUOTE_READY':'REQUIRES_REVIEW',preflight:check,oneTimeCents:amount,currency:'USD',tier:amount<75000?'FIX':amount<150000?'GROW':'AUTOMATE',validUntil:now+cfg.quoteDays*86400000,externalCosts:service.requiredExternalServices.map(provider=>({provider,purpose:service.name,estimatedMonthlyUsd:null,billingOwner:'CUSTOMER',required:true})),customerActions:['Own the required accounts','Connect limited access','Approve scope and business facts','Confirm third-party pricing'],included:service.definitionOfDone,excluded:['Guaranteed ranking/revenue','Unlimited support','Unlisted changes','Third-party subscriptions'],warrantyDays:cfg.warrantyDays,checkoutAllowed:check.passed,steps:['PREPARE','BACKUP','PREFLIGHT','PLAN','APPROVAL','EXECUTE','QA','RETEST','HANDOFF'],disclosure:'Third-party services are owned and billed directly to you. Qonvexa does not add a subscription markup.'};
}
export function acceptQuote(q,now=Date.now()){if(q.validUntil<=now)throw new Error('QUOTE_EXPIRED');if(!q.checkoutAllowed||!q.preflight.passed)throw new Error('PREFLIGHT_REQUIRED');return {...q,status:'ACCEPTED',acceptedAt:now,scopeLocked:true};}
