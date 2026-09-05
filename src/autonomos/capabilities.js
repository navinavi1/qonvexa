const RULES = [
  { skill:'translation', categories:['translation'], words:['translate','translation'] },
  { skill:'code-analysis', categories:['coding','code','development','software'], words:['code','bug','javascript','typescript','node','python','api','script','review','test','build','repository','github'] },
  { skill:'data-transform', categories:['data','spreadsheet'], words:['csv','json','normalize','extract','transform','parse','structured','excel','xlsx','spreadsheet','dataset'] },
  { skill:'document-generation', categories:['document','presentation','report'], words:['pdf','docx','pptx','presentation','slide deck','document','deliverable file','downloadable file'] },
  { skill:'app-automation', categories:['automation','operations','crm'], words:['gmail','google sheets','google drive','notion','slack','calendar','crm','hubspot','airtable','linear','jira','connected app','workflow'] },
  { skill:'browser-ops', categories:['browser','qa','testing'], words:['browser automation','navigate','dashboard','fill form','screenshot','web app testing','click through'] },
  { skill:'web-research', categories:['research','analysis'], words:['research','analyze','analysis','compare','website','web','public','headers','endpoint','market','report','sources'] },
  { skill:'copywriting', categories:['writing','content','marketing'], words:['write','rewrite','copy','summary','summarize','description','intro','landing','headline','content'] }
];

// Naive substring matching (hay.includes(word)) caused real false positives — e.g. the
// keyword 'test' matches inside 'latest', silently misclassifying a research/writing task
// that merely mentions "the latest developments" as code-analysis work. Word-boundary
// matching only counts an actual whole word/phrase, not a substring of an unrelated word.
function containsWord(hay,phrase){
  const escaped=String(phrase).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`\\b${escaped}\\b`,'i').test(hay);
}

const REQUIRES_SHELL=/\b(docker(file)?|kubernetes|k8s|ci\/cd|shell access|terminal access|npm install|yarn install|pnpm install|pip install|build the (app|project)|run (the )?tests?|compile|package (the )?(app|project))\b/i;
const REQUIRES_BROWSER=/\b(browser automation|headless browser|screenshot of the (site|app|page)|fill (out )?(the )?form|navigate (the )?(site|dashboard)|web app testing|click through|log in to (the )?(site|dashboard))\b/i;
const REQUIRES_DEPLOY=/\b(deploy(ment)?\b|production server|release to production|trigger (a )?deployment)\b/i;
const REQUIRES_GITHUB_PR=/\b(git\s+(clone|push|pull|checkout|commit)|pull request|\bpr\b|open (a |an )?pr\b|merge request|github repo|fix.{0,30}(bug|issue).{0,30}repo)\b/i;
const REQUIRES_ARTIFACT=/\b(downloadable|attach(?:ed|ment)?|deliver (?:a )?(?:file|pdf|docx|xlsx|csv|zip|pptx)|create (?:a )?(?:pdf|docx|xlsx|csv|zip|pptx)|generate (?:a )?(?:pdf|docx|xlsx|csv|zip|pptx)|spreadsheet file|presentation file|(?:build|implement|develop|create)\s+(?:a |an |the )?(?:working\s+|functional\s+)?(?:prototype|dapp|d-app|application|smart\s+contract|api|website|web\s*app|program|bot|script|tool)|submit\s+(?:your|the)\s+(?:project|code|repo|repository|prototype|submission)|working\s+(?:prototype|demo|implementation))\b/i;
const REQUIRES_APP=/\b(send (?:an )?email|create (?:a )?calendar event|update (?:the )?crm|update (?:a )?(?:google )?sheet|post to (?:slack|reddit|x|twitter|linkedin|discord|telegram)|publish (?:on|to) (?:reddit|x|twitter|linkedin|discord|telegram)|x post|post on x|create (?:a )?jira|create (?:a )?linear issue|edit (?:a )?notion|upload to (?:google )?drive|connected app)\b|\bpost\s*[—\-→:]\s*x\b/i;
const REQUIRES_PROCUREMENT=/\b(hire (?:a |an |the )?(?:service|agent|provider|peer)|purchase(?:\s+(?:a|an|the))?\s+[^.\n]{0,80}|buy(?:\s+(?:a|an|the))?\s+[^.\n]{0,80}|post[, ]+hire[, ]+settle|pay (?:a |an |the )?(?:service|agent|provider)|passport connect[^.\n]{0,60}\b(?:buy|purchase|swap|send)|\b(?:buy|purchase|swap|send)[^.\n]{0,60}passport connect)\b/i;
const REQUIRES_PHYSICAL=/\b(visit|go to|travel to|pick up|deliver in person|physical location|in[- ]person|take a photo of (?:a |the )?(?:store|building|receipt|sign|location)|mystery shop|phone call|call (?:the )?(?:customer|business|lead))\b/i;
const REQUIRES_HUMAN_IDENTITY=/\b(kyc|selfie|government id|passport verification|personal account|aged account|account with \d+\+? (?:followers|karma|connections)|use your (?:reddit|x|twitter|linkedin|facebook|instagram) account|human verification|captcha solving|invite (?:a )?new agent|recruit (?:a )?new agent|referral (?:agent|user)|create (?:a )?new external agent identity)\b/i;
const REQUIRES_DESIGN_MEDIA=/\b(logo design|podcast cover|cover art|illustration|brand identity|graphic design|figma design|canva design|video edit|motion graphics|3d render)\b/i;
// This system permanently refuses to hold private keys or sign transactions (see
// policy-engine.js kind:'private_key_access' / 'wallet_export' and the "private-key access
// is permanently rejected" audit check). A job that requires actually broadcasting a signed
// on-chain transaction — deploying a smart contract to a live/test network, minting from a
// funded wallet, etc. — is therefore structurally impossible here, not a missing integration.
// Previously this was only discovered mid-execution when the model, unable to really deploy,
// fabricated a deployment claim that QA then correctly rejected after a full paid round-trip.
const REQUIRES_ONCHAIN_TX=/\b(deploy\w*\b[\s\S]{0,40}?\b(?:mainnet|testnet|sepolia|goerli|mumbai|polygon|base|arbitrum|optimism|devnet|solana)\b|(?:build|develop|create)\b[\s\S]{0,50}?\b(?:dapp|d-app|on-chain program|smart contract)\b[\s\S]{0,50}?\bsolana\b|\bsolana\b[\s\S]{0,50}?\b(?:dapp|d-app|on-chain program|smart contract)\b|\bsign(?:ed|ing)?\s+(?:a\s+|the\s+)?transaction\b|\bbroadcast\s+(?:a\s+|the\s+)?transaction\b|\bmint\w*\b[\s\S]{0,20}?\bfunded\s+wallet\b|\bverify\w*\b[\s\S]{0,40}?\b(?:etherscan|polygonscan|solscan|basescan)\b|\bfunded\s+(?:deployer\s+)?wallet\b)/i;

export function classifyOpportunity(opportunity, { llmEnabled=false, hasGithubPrTool=false, hasShellTool=false, hasBrowserTool=false, hasDeployTool=false, hasArtifactTool=false, hasAppTool=false, connectedApps=[], hasWebSearchTool=false, hasDesignMediaTool=false } = {}) {
  const category=String(opportunity?.category||'').toLowerCase();
  const title=String(opportunity?.title||'');
  const description=String(opportunity?.description||'');
  const hay=`${category} ${title} ${description}`.toLowerCase();
  const safety=safetyCheck(hay);
  const matched=RULES.map(rule=>({rule,score:(rule.categories.includes(category)?4:0)+rule.words.reduce((n,w)=>n+(containsWord(hay,w)?1:0),0)})).sort((a,b)=>b.score-a.score)[0];
  const skill=matched?.score>0?matched.rule.skill:'general-digital';
  const recognized=Boolean(matched?.score>0);
  const deterministic=canDoDeterministically(opportunity,skill);
  const needs={
    github:REQUIRES_GITHUB_PR.test(hay),
    shell:REQUIRES_SHELL.test(hay)||skill==='document-generation',
    browser:REQUIRES_BROWSER.test(hay)||skill==='browser-ops',
    deploy:REQUIRES_DEPLOY.test(hay),
    artifact:REQUIRES_ARTIFACT.test(hay)||skill==='document-generation',
    app:REQUIRES_APP.test(hay)||skill==='app-automation',
    onchainTx:REQUIRES_ONCHAIN_TX.test(hay),
    procurement:REQUIRES_PROCUREMENT.test(hay),
    physical:REQUIRES_PHYSICAL.test(hay),
    humanIdentity:REQUIRES_HUMAN_IDENTITY.test(hay),
    designMedia:REQUIRES_DESIGN_MEDIA.test(hay),
    // web-research jobs that AREN'T handled by the safe, tool-free deterministic path
    // (robots.txt/header checks etc.) rely entirely on the LLM actually calling a real
    // search tool for current facts. Without one, the LLM can still answer — it just
    // answers from its own unverified training data and states it as researched fact.
    liveVerification:skill==='web-research'&&!deterministic
  };
  const requiredApps=inferRequiredApps(hay);
  const connected=new Set((Array.isArray(connectedApps)?connectedApps:[]).map(x=>String(x).toLowerCase().trim()).filter(Boolean));
  const missing=[];
  if(needs.github&&!hasGithubPrTool)missing.push('github_pr');
  if(needs.shell&&!hasShellTool)missing.push('sandbox_shell');
  if(needs.browser&&!hasBrowserTool)missing.push('browser');
  if(needs.deploy&&!hasDeployTool)missing.push('deploy');
  if(needs.artifact&&!hasArtifactTool)missing.push('artifact_storage');
  if(needs.app&&!hasAppTool)missing.push('connected_app_gateway');
  if(needs.app&&hasAppTool&&requiredApps.length){for(const app of requiredApps)if(!connected.has(app))missing.push(`connected_app:${app}`);}
  // Do not let a paid job trick the worker into spending money to hire/buy something else.
  // Procurement can be added later with an explicit price-aware budget contract; until then
  // it is not an autonomous earning capability.
  if(needs.procurement)missing.push('external_procurement');
  if(needs.physical)missing.push('physical_world_action');
  if(needs.humanIdentity)missing.push('human_identity_or_reputation');
  if(needs.designMedia&&!hasDesignMediaTool)missing.push('design_media_tool');
  if(needs.liveVerification&&!hasWebSearchTool)missing.push('web_search');
  // Permanently unavailable: this system never holds a private key or signs a transaction,
  // so no env flag can ever satisfy this one. Always rejected, not just when unconfigured.
  if(needs.onchainTx)missing.push('signed_onchain_transaction');
  const needsUnavailableTooling=missing.length>0;
  const generalDigitalFallback=!recognized&&llmEnabled&&!needsUnavailableTooling&&safety.safe;
  return{
    skill,
    confidence:recognized?Math.min(1,(matched?.score||0)/6):generalDigitalFallback?0.35:0,
    safe:safety.safe,
    safetyReason:safety.reason,
    executable:safety.safe&&!needsUnavailableTooling&&(recognized?(deterministic||llmEnabled):generalDigitalFallback),
    mode:needsUnavailableTooling?'unsupported_missing_tooling':!recognized?(generalDigitalFallback?'llm_general_digital':'unsupported_unrecognized'):needs.github?'llm_with_github_pr':deterministic?'deterministic':llmEnabled?'llm_with_tools':'unsupported_without_llm',
    missingTooling:needsUnavailableTooling,
    missingTools:missing,
    requiresArtifact:needs.artifact,
    requiredCapabilities:[...Object.entries(needs).filter(([,value])=>value).map(([key])=>key),...requiredApps.map(x=>`app:${x}`)],
    requiredApps,
    estimatedModelCostUsd:deterministic?0:llmEnabled?estimateLlmCost(opportunity):0
  };
}

function inferRequiredApps(hay=''){
  const apps=[];
  const tests=[['reddit',/\breddit\b/i],['x',/\b(?:x\.com|twitter|tweet|post to x|publish on x|post on x|x post)\b|\bpost\s*[—\-→:]\s*x\b/i],['linkedin',/\blinkedin\b/i],['discord',/\bdiscord\b/i],['telegram',/\btelegram\b/i],['gmail',/\b(?:gmail|send (?:an )?email)\b/i],['slack',/\bslack\b/i],['notion',/\bnotion\b/i],['google_sheets',/\bgoogle sheets?\b/i],['google_drive',/\bgoogle drive\b/i],['google_calendar',/\b(?:google calendar|calendar event)\b/i]];
  for(const [id,re] of tests)if(re.test(hay))apps.push(id);
  return [...new Set(apps)];
}

function canDoDeterministically(op,skill){
  const hay=`${op?.title||''} ${op?.description||''}`.toLowerCase();
  if(skill==='translation')return translationInDictionary(hay);
  if(skill==='web-research')return /public\s+(url|endpoint)|headers|robots|sitemap|http|website\s+(check|audit)|security header/i.test(hay);
  return false;
}

const TRANSLATION_DICTIONARY={spanish:['agents hiring agents','hello world'],ukrainian:['agents hiring agents','hello world'],english:['агенти наймають агентів','hola mundo']};
function translationInDictionary(hay){const match=hay.match(/translate\s+["“']?([^"”'\n]{1,100})["”']?\s+(?:to|into)\s+(spanish|ukrainian|english|french|german|italian|polish)/i);if(!match)return false;const phrase=match[1].trim().toLowerCase().replace(/[“”"']/g,'');return Boolean(TRANSLATION_DICTIONARY[match[2].toLowerCase()]?.includes(phrase));}

function estimateLlmCost(op){
  const chars=String(op?.title||'').length+String(op?.description||'').length;
  const inputTokens=Math.max(500,Math.ceil(chars/4));const outputTokens=1200;
  const toolOverheadMultiplier=(process.env.FIRECRAWL_API_KEY||process.env.E2B_API_KEY||process.env.COMPOSIO_API_KEY)?3:1;
  const inPerM=Number(process.env.AUTONOMOS_LLM_INPUT_USD_PER_MILLION||0.25);const outPerM=Number(process.env.AUTONOMOS_LLM_OUTPUT_USD_PER_MILLION||2);
  return Number((((inputTokens*toolOverheadMultiplier)/1e6)*inPerM+((outputTokens*toolOverheadMultiplier)/1e6)*outPerM).toFixed(6));
}

function safetyCheck(hay){
  const blocked=[
    [/password|seed phrase|private key|credential\s*(steal|dump|harvest)|api key steal|phishing/i,'credential_or_secret_request'],
    [/malware|ransomware|keylogger|credential theft|exploit\s+(?:a|the)\s+server|ddos|botnet/i,'malicious_or_intrusive_work'],
    [/fake review|spam|mass dm|mass message|impersonat|fake metric|astroturf/i,'spam_or_deceptive_work'],
    [/launder|mix(?:er|ing)\s+funds|hide source of funds|evade sanctions/i,'financial_evasion_request']
  ];
  for(const [re,reason] of blocked)if(re.test(hay))return{safe:false,reason};
  return{safe:true,reason:'allowed_digital_service'};
}
