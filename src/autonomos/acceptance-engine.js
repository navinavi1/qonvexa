import crypto from 'node:crypto';

const URL_RE = /\bhttps?:\/\/[^\s<>]+/ig;
const FILE_RE = /\b(?:pdf|docx|xlsx|csv|zip|json|md|markdown|html|png|jpg|jpeg|webp|pptx)\b/i;
const CODE_RE = /\b(?:code|repo(?:sitory)?|pull request|api|bug|javascript|typescript|python|sql|docker|mvp|prototype|smart contract|solidity|rust|test(?:s|ing)?)\b/i;
const RESEARCH_RE = /\b(?:research|audit|analy[sz]e|compare|investigate|find|sources?|citations?|current|live data|web search)\b/i;
const ARTIFACT_RE = /\b(?:deliverable|file|artifact|download|upload|attachment|repository|pull request|repo|prototype|mvp|spreadsheet|report|document)\b/i;

export function buildAcceptanceContract(opportunity = {}) {
  const text = `${opportunity.title || ''}\n${opportunity.description || ''}\n${opportunity.__workOrderRaw ? JSON.stringify(opportunity.__workOrderRaw) : ''}`.slice(0, 18000);
  const skill = String(opportunity?.capability?.skill || '').toLowerCase();
  const source = String(opportunity.source || '').toLowerCase();
  const requirements = [];
  const evidence = [];
  const artifacts = [];
  const mustUseTool = CODE_RE.test(text) || RESEARCH_RE.test(text) || /web-research|code-analysis|data-transform/i.test(skill);

  if (CODE_RE.test(text) || /code-analysis/i.test(skill)) {
    requirements.push({id:'implementation', description:'Produce the requested implementation/result, not a plan or proposal.'});
    requirements.push({id:'verification', description:'Run an applicable real verification step and preserve the result.'});
    evidence.push({id:'tool-verification', type:'successful_tool', tools:['run_shell','run_python','coderabbit_review']});
  }
  if (RESEARCH_RE.test(text) || /web-research/i.test(skill)) {
    requirements.push({id:'research-grounded', description:'Base current or externally verifiable claims on actual live sources/tools.'});
    evidence.push({id:'live-source', type:'successful_tool', tools:['web_search','web_scrape','browser_task']});
    if (/source|citation|cite|references?/i.test(text)) requirements.push({id:'sources', description:'Include the requested source/citation information.'});
  }
  if (ARTIFACT_RE.test(text) || Boolean(opportunity?.capability?.requiresArtifact)) {
    requirements.push({id:'artifact', description:'Provide the requested durable artifact or repository/PR output.'});
    artifacts.push({id:'durable-artifact', required:true});
  }
  if (FILE_RE.test(text)) {
    artifacts.push({id:'file-format', required:true});
  }
  if (URL_RE.test(text) || /url|link|website|endpoint/i.test(text)) {
    requirements.push({id:'links', description:'Provide the required stable URL(s) or endpoint(s) when explicitly requested.'});
  }
  if (/test|tests|unit test|integration test|e2e/i.test(text)) {
    requirements.push({id:'tests', description:'Actually run the requested tests and preserve the observed result.'});
    evidence.push({id:'test-run', type:'successful_tool', tools:['run_shell','run_python']});
  }
  if (source === 't2000') requirements.push({id:'marketplace-work-order', description:'Satisfy the authoritative t2000 work order and delivery-body constraints.'});
  if (source === 'superteam') requirements.push({id:'submission-fields', description:'Submit using the listing-specific required fields and evidence.'});
  if (source === 'dealwork') requirements.push({id:'acceptance-criteria', description:'Satisfy the contract acceptance criteria and required deliverable structure.'});

  const unique = xs => [...new Map(xs.map(x => [x.id, x])).values()];
  return {
    version: 1,
    contractId: `ac_${crypto.createHash('sha256').update(text).digest('hex').slice(0,20)}`,
    source,
    requirements: unique(requirements),
    evidence: unique(evidence),
    artifacts: unique(artifacts),
    mustUseTool,
    minimumSuccessfulToolCalls: mustUseTool ? 1 : 0,
    createdAt: new Date().toISOString()
  };
}

export function validateAcceptanceContract(contract = {}, deliverable = {}) {
  const reasons = [];
  const ev = deliverable?.evidence || {};
  const toolCalls = Array.isArray(ev.toolCalls) ? ev.toolCalls : [];
  const successful = toolCalls.filter(x => x?.ok === true);
  const artifactUrls = toolCalls.flatMap(x => Array.isArray(x?.artifacts) ? x.artifacts : []).filter(a => a?.ok && a?.url);
  if (contract.mustUseTool && successful.length < Number(contract.minimumSuccessfulToolCalls || 1)) reasons.push('required_real_tool_evidence_missing');
  if (contract.artifacts?.some(a => a.required) && artifactUrls.length === 0 && !ev?.artifactUrls?.length) reasons.push('required_durable_artifact_missing');
  const content = String(deliverable?.content || '');
  if (/proposal|plan|approach/i.test(content.slice(0,600)) && contract.requirements?.some(r => r.id === 'implementation')) {
    if (!artifactUrls.length && !ev?.artifactUrls?.length) reasons.push('looks_like_plan_not_completed_result');
  }
  return {ok: reasons.length === 0, reasons, successfulToolCalls: successful.length, artifactUrls};
}

export function buildEvidencePack({jobId='', opportunity={}, deliverable={}, plan=null, qa=null}={}) {
  const toolCalls = Array.isArray(deliverable?.evidence?.toolCalls) ? deliverable.evidence.toolCalls : [];
  const artifacts = toolCalls.flatMap(x => Array.isArray(x?.artifacts) ? x.artifacts : []).filter(Boolean);
  return {
    version: 1,
    jobId,
    contractId: opportunity?.acceptanceContract?.contractId || '',
    generatedAt: new Date().toISOString(),
    acceptanceContract: opportunity?.acceptanceContract || null,
    plan: plan || deliverable?.evidence?.plan || null,
    toolCalls,
    artifacts,
    artifactUrls: artifacts.filter(a => a.ok && a.url).map(a => a.url).slice(0,50),
    qa: qa || deliverable?.evidence?.qa || null,
    claims: String(deliverable?.content || '').slice(0,100000),
    contentSha256: crypto.createHash('sha256').update(String(deliverable?.content || ''),'utf8').digest('hex')
  };
}
