const definitions=[
 ['conversion','Conversion Fix Pack',['conversion','mobile','trust'],'wordpress',299,699,'MEDIUM',['content.write'],['cta_visible','journey_verified']],
 ['seo','Technical SEO Fix',['seo','links','content'],'wordpress',399,899,'MEDIUM',['content.write'],['metadata_verified','indexability_verified']],
 ['speed','Speed / Core Web Vitals Fix',['performance'],'wordpress',399,999,'HIGH',['optimization.write'],['before_after_measured','no_regression']],
 ['schema','Schema + AI Search Readiness',['schema','ai'],'wordpress',299,699,'MEDIUM',['schema.write'],['jsonld_valid','facts_approved']],
 ['analytics','Analytics + Conversion Tracking',['analytics'],'gtm',299,799,'HIGH',['container.write'],['test_event_received','consent_checked']],
 ['local','Local SEO Foundation',['local','clarity'],'wordpress',399,899,'MEDIUM',['content.write'],['nap_verified','location_verified']],
 ['crm','CRM Setup',['crm'],'crm',750,1500,'MEDIUM',['pipelines.write','fields.write','contacts.write'],['pipeline_exists','test_lead_received']],
 ['followup','Lead Follow-up Automation',['capture'],'crm',500,1200,'HIGH',['workflow.write'],['followup_received','suppression_verified']],
 ['booking','Booking Automation',['booking','forms'],'crm',500,1200,'MEDIUM',['booking.connect'],['booking_verified','notification_received']],
 ['assistant','AI Lead Assistant',['capture','ai'],'crm',750,1500,'HIGH',['assistant.deploy'],['approved_knowledge_only','human_handoff_verified']],
 ['reputation','Review / Reputation Automation',['reputation'],'crm',399,999,'HIGH',['workflow.write'],['consent_checked','review_flow_verified']],
 ['full','Full Lead System',['conversion','capture','crm'],'crm',1500,3500,'HIGH',['pipelines.write','workflow.write','booking.connect'],['test_lead_received','followup_received','booking_verified','test_event_received']]
];
export function catalog(env=process.env){return definitions.map(([id,name,eligibleFindings,platform,base,max,riskLevel,requiredCapabilities,checks])=>{
  const price=Number(env[`QONVEXA_PRICE_${id.toUpperCase()}_CENTS`]??base*100);
  if(!Number.isSafeInteger(price)||price<100)throw new Error('INVALID_SERVICE_PRICE');
  return {id,name,description:`Evidence-led ${name.toLowerCase()} with scoped technical deliverables.`,eligibleFindings,
    supportedPlatforms:platform==='crm'?['pipedrive','zoho']:[platform],requiredCapabilities,
    requiredAccess:requiredCapabilities,requiredExternalServices:platform==='crm'?['Customer-owned CRM',...(['followup','reputation','full'].includes(id)?['Customer-owned messaging provider']:[])]:platform==='gtm'?['Customer-owned GA4/GTM']:['Customer-owned WordPress and backup'],
    riskLevel,automationLevel:'CUSTOM',basePrice:price,currency:'USD',pricingRules:{incrementPerFindingCents:5000,maxPriceCents:Math.max(price,max*100),maxFindings:10},
    estimatedInternalCost:id==='full'?40:15,estimatedCustomerRecurringCost:{amount:null,billingOwner:'CUSTOMER',description:'Plan and usage must be verified before purchase; not included in Qonvexa fees.'},
    qaChecklist:checks,rollbackStrategy:'Restore exact before values; remove only verified Qonvexa-created resources; stop on concurrent edits.',definitionOfDone:checks,
    liveExecutorAvailable:false};});}
export const serviceMatrix = catalog().flatMap(s=>s.supportedPlatforms.map(platform=>({serviceId:s.id,platform,status:'CUSTOM',candidateAutomation:platform==='wordpress'?'Gutenberg only after capability verification':'Capability and plan dependent',reason:'Live write executor has not been released; checkout is blocked.'})));
export function recommendations(findings,services=catalog()) {return services.filter(s=>findings.some(f=>s.eligibleFindings.includes(f.category)&&f.confidence!=='LOW')).map(s=>({serviceId:s.id,findingIds:findings.filter(f=>s.eligibleFindings.includes(f.category)).map(f=>f.id),status:'PREFLIGHT_REQUIRED'}));}
