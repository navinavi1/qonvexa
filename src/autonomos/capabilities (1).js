const RULES = [
  { skill:'web-research', categories:['research','analysis','data'], words:['research','analyze','analysis','compare','website','web','public','api','headers','endpoint','market','data','report'] },
  { skill:'copywriting', categories:['writing','content'], words:['write','rewrite','copy','summary','summarize','description','intro','landing','headline','content'] },
  { skill:'code-analysis', categories:['coding','code','development'], words:['code','bug','javascript','typescript','node','python','api','json','script','review','test'] },
  { skill:'translation', categories:['translation'], words:['translate','translation'] },
  { skill:'data-transform', categories:['data'], words:['csv','json','normalize','extract','transform','parse','structured'] }
];

export function classifyOpportunity(opportunity, { llmEnabled=false } = {}) {
  const hay = `${opportunity.category} ${opportunity.title} ${opportunity.description}`.toLowerCase();
  const safety = safetyCheck(hay);
  const matched = RULES.map(rule=>({ rule, score:rule.categories.includes(opportunity.category)?3:rule.words.reduce((n,w)=>n+(hay.includes(w)?1:0),0) }))
    .sort((a,b)=>b.score-a.score)[0];
  const skill = matched?.score > 0 ? matched.rule.skill : 'unknown';
  const deterministic = canDoDeterministically(opportunity, skill);
  return {
    skill,
    confidence:Math.min(1, (matched?.score || 0)/5),
    safe:safety.safe,
    safetyReason:safety.reason,
    executable:safety.safe && (deterministic || llmEnabled),
    mode:deterministic ? 'deterministic' : llmEnabled ? 'llm' : 'unsupported_without_llm',
    estimatedModelCostUsd:deterministic ? 0 : llmEnabled ? estimateLlmCost(opportunity) : 0
  };
}

function canDoDeterministically(op, skill){
  const hay=`${op.title} ${op.description}`.toLowerCase();
  if (skill==='translation') return translationInDictionary(hay);
  if (skill==='data-transform') return false;
  if (skill==='web-research') return /public\s+(url|endpoint)|headers|robots|sitemap|http|website\s+(check|audit)|security header/i.test(hay);
  return false;
}

// Mirrors the tiny hardcoded dictionary in job-executor.js. A request only counts as
// deterministically executable if the exact phrase is actually in the dictionary —
// matching the request's wording alone previously caused the runtime to claim
// translation jobs it had no real ability to complete, risking a failed delivery
// after the job was already claimed (reputation/marketplace-standing risk).
const TRANSLATION_DICTIONARY = {
  spanish: ['agents hiring agents', 'hello world'],
  ukrainian: ['agents hiring agents', 'hello world'],
  english: ['агенти наймають агентів', 'hola mundo']
};
function translationInDictionary(hay){
  const match = hay.match(/translate\s+["“']?([^"”'\n]{1,100})["”']?\s+(?:to|into)\s+(spanish|ukrainian|english|french|german|italian|polish)/i);
  if (!match) return false;
  const phrase = match[1].trim().toLowerCase().replace(/[“”"']/g,'');
  const language = match[2].toLowerCase();
  return Boolean(TRANSLATION_DICTIONARY[language]?.includes(phrase));
}

function estimateLlmCost(op){
  const chars=(op.title.length+op.description.length);
  const inputTokens=Math.max(500,Math.ceil(chars/4));
  const outputTokens=900;
  // Tool-calling (web_search/web_scrape/run_python) adds extra round-trips whose tool
  // results get fed back into context — budget roughly 2.5x the single-shot estimate
  // so the pre-claim margin check isn't quietly under-provisioned versus real usage.
  const toolOverheadMultiplier = (process.env.FIRECRAWL_API_KEY || process.env.E2B_API_KEY) ? 2.5 : 1;
  const inPerM=Number(process.env.AUTONOMOS_LLM_INPUT_USD_PER_MILLION || 0.25);
  const outPerM=Number(process.env.AUTONOMOS_LLM_OUTPUT_USD_PER_MILLION || 2);
  return Number((((inputTokens*toolOverheadMultiplier)/1e6)*inPerM+((outputTokens*toolOverheadMultiplier)/1e6)*outPerM).toFixed(6));
}


function safetyCheck(hay){
  const blocked=[
    [/password|seed phrase|private key|credential|api key steal|phishing/i,'credential_or_secret_request'],
    [/malware|ransomware|keylogger|credential theft|exploit\s+(?:a|the)\s+server|ddos|botnet/i,'malicious_or_intrusive_work'],
    [/fake review|spam|mass dm|mass message|impersonat|fake metric|astroturf/i,'spam_or_deceptive_work'],
    [/launder|mix(?:er|ing)\s+funds|hide source of funds|evade sanctions/i,'financial_evasion_request']
  ];
  for(const [re,reason] of blocked)if(re.test(hay))return{safe:false,reason};
  return{safe:true,reason:'allowed_digital_service'};
}
