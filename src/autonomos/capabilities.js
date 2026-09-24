const RULES=[
  {skill:'translation',categories:['translation','transcription'],words:['translate','translation','localization','localisation','transcription','transcribe','subtitles','captions']},
  // graphic-design, ui-ux, video and audio used to sit in code-analysis's category list, so a
  // logo brief and a TikTok edit were labelled as code work. The skill is not cosmetic: it
  // picks the QA verification tools, it routes to the high-value code-review path, and it
  // keys the workflow memory that feeds previously-QA-passed procedures back into the next
  // job. Design jobs were teaching the code-analysis lane, and the code lane was answering
  // design briefs. The free-capability layer already mapped these categories to image and
  // audio/video tooling from the category directly; only this table disagreed.
  {skill:'design-media',categories:['graphic-design','ui-ux','video','audio'],words:['logo','brand identity','branding','illustration','cover art','thumbnail','banner','mockup','wireframe','figma','canva','video edit','video editing','short-form','reel','motion graphics','colour grade','color grade','podcast','audio edit','noise removal','mixing','mastering','subtitles burn','image resize','photo retouch']},
  {skill:'code-analysis',categories:['coding','code','development','software','website','ai-workflow'],words:['code','bug','javascript','typescript','node','python','api','script','review','test','build','repository','github','website','html','css','svg','image','video','audio','ffmpeg']},
  {skill:'data-transform',categories:['data','spreadsheet','data-entry','scraping','analytics'],words:['csv','json','normalize','extract','transform','parse','structured','excel','xlsx','spreadsheet','dataset','deduplicate','chart','analytics','dashboard','reporting']},
  {skill:'document-generation',categories:['document','presentation','technical-writing'],words:['pdf','docx','pptx','presentation','slide deck','document','deliverable file','downloadable file','manual','sop','knowledge base','technical writing']},
  {skill:'app-automation',categories:['automation','operations','crm','no-code','virtual-assistant','customer-support','ecommerce','social-media'],words:['gmail','google sheets','google drive','notion','slack','calendar','crm','hubspot','airtable','linear','jira','connected app','workflow','customer support','inbox','ecommerce','shopify','product listing','social media']},
  {skill:'browser-ops',categories:['browser'],words:['browser automation','navigate','dashboard','fill form','screenshot','web app testing','click through']},
  {skill:'web-research',categories:['research','analysis','seo'],words:['research','analyze','analysis','compare','website','web','public','headers','endpoint','market','report','sources','seo','keyword','competitor']},
  {skill:'copywriting',categories:['writing','content','marketing'],words:['write','rewrite','copy','summary','summarize','description','intro','landing','headline','content','blog','article','email marketing','product description']}
];
// Every word in RULES is a fixed string written above, and this used to compile a fresh
// RegExp for each one on every call -- nine rules, about a hundred and thirty words, so a
// hundred and thirty compilations to classify one opportunity. The owner's dashboard
// classifies every discovered lead on every poll, which at five thousand leads is 650,000
// RegExp compilations per request: 388ms of the 530ms the request took, spent rebuilding
// byte-identical patterns. They are constants, so compile them once at load.
//
// A pattern with the i flag and no g or y carries no lastIndex, so a shared instance is
// safe to .test() from anywhere, repeatedly.
const MATCHERS=RULES.map(rule=>({rule,categories:new Set(rule.categories),
  patterns:rule.words.map(word=>new RegExp(`\\b${String(word).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'i'))}));
const REQUIRES_SHELL=/\b(docker(file)?|kubernetes|k8s|ci\/cd|shell access|terminal access|npm install|yarn install|pnpm install|pip install|build the (app|project)|run (the )?tests?|compile|package (the )?(app|project)|ffmpeg|imagemagick|image conversion|audio conversion|video conversion)\b/i;
const REQUIRES_BROWSER=/\b(browser automation|headless browser|screenshot of the (site|app|page)|fill (out )?(the )?form|navigate (the )?(site|dashboard)|web app testing|click through|log in to (the )?(site|dashboard))\b/i;
const REQUIRES_DEPLOY=/\b(?:deploy\s+(?:the |this |a )?(?:app|application|site|service|project|contract)|release to production|trigger (?:a )?deployment|access (?:the )?production server)\b/i;
const REQUIRES_GITHUB_PR=/\b(?:open|create|submit|deliver|publish|merge)\s+(?:a |an |the )?(?:github )?(?:pull request|pr|merge request)\b|\bgit\s+push\b|\bdeliver.{0,30}\bpull request\b/i;
const REQUIRES_ARTIFACT=/\b(downloadable|attach(?:ed|ment)?|deliver (?:a )?(?:file|pdf|docx|xlsx|csv|zip|pptx|png|jpe?g|svg|mp3|wav|mp4)|create (?:a )?(?:pdf|docx|xlsx|csv|zip|pptx|png|jpe?g|svg|mp3|wav|mp4)|generate (?:a )?(?:pdf|docx|xlsx|csv|zip|pptx|png|jpe?g|svg|mp3|wav|mp4)|spreadsheet file|presentation file|(?:build|implement|develop|create)\s+(?:a |an |the )?(?:working\s+|functional\s+)?(?:prototype|dapp|d-app|application|smart\s+contract|api|website|web\s*app|program|bot|script|tool)|submit\s+(?:your|the)\s+(?:project|code|repo|repository|prototype|submission)|working\s+(?:prototype|demo|implementation))\b/i;
const REQUIRES_APP=/\b(send (?:an )?email|create (?:a )?calendar event|update (?:the )?crm|update (?:a )?(?:google )?sheet|post to (?:slack|reddit|x|twitter|linkedin|discord|telegram)|publish (?:on|to) (?:reddit|x|twitter|linkedin|discord|telegram)|x post|post on x|create (?:a )?jira|create (?:a )?linear issue|edit (?:a )?notion|upload to (?:google )?drive|connected app|reply to (?:a )?customer|triage (?:the )?inbox|update product listing)\b|\bpost\s*[—\-→:]\s*x\b/i;
const REQUIRES_PROCUREMENT=/\b(?:(?:buy|purchase)\s+(?:a|an|the)\s+(?:service|agent|provider|peer)|(?:must|need(?:s|ed)?\s+to|required\s+to|please|task\s+requires?|you\s+will)\s+(?:[^.\n]{0,45}\s)?(?:buy|purchase|hire|pay\s+for)\s+(?:a |an |the )?(?:paid\s+)?(?:license|subscription|dataset|api\s+credits?|tool|software|service|provider|agent|stock\s+(?:media|images?|video)|domain|hosting)|(?:buy|purchase)\s+(?:a |an |the )?(?:paid\s+)?(?:license|subscription|dataset|api\s+credits?|tool|software|stock\s+(?:media|images?|video)|domain|hosting)\s+(?:for|to\s+complete)\s+(?:this|the)\s+(?:task|job|project)|hire\s+(?:a |an |the )?(?:service|agent|provider|peer)\s+(?:to|for)\s+(?:complete|perform|finish|deliver)|post[, ]+hire[, ]+settle|passport connect[^.\n]{0,60}\b(?:buy|purchase|swap|send)|\b(?:buy|purchase|swap|send)[^.\n]{0,60}passport connect)\b/i;
const REQUIRES_PHYSICAL=/\b((?:visit|go to)\s+(?:a |the )?(?:store|office|shop|building|physical location)|travel to|pick up|deliver in person|physical location|in[- ]person|take a photo of (?:a |the )?(?:store|building|receipt|sign|location)|mystery shop|phone call|call (?:the )?(?:customer|business|lead))\b/i;
const REQUIRES_HUMAN_IDENTITY=/\b(kyc|selfie|government id|passport verification|personal account|aged account|account with \d+\+? (?:followers|karma|connections)|use your (?:reddit|x|twitter|linkedin|facebook|instagram) account|human verification|captcha solving|invite (?:a )?new agent|recruit (?:a )?new agent|referral (?:agent|user)|create (?:a )?new external agent identity)\b/i;
const REQUIRES_DESIGN_MEDIA=/\b(logo design|podcast cover|cover art|illustration|brand identity|graphic design|figma design|canva design|video edit|motion graphics|3d render)\b/i;
const REQUIRES_ONCHAIN_TX=/\b(?:deploy\w*\b[\s\S]{0,40}?\b(?:mainnet|testnet|sepolia|goerli|mumbai|polygon|base|arbitrum|optimism|devnet|solana)\b|sign(?:ed|ing)?\s+(?:a\s+|the\s+)?transaction|broadcast\s+(?:a\s+|the\s+)?transaction|mint\w*\b[\s\S]{0,20}?\bfunded\s+wallet|funded\s+(?:deployer\s+)?wallet)\b/i;

// classifyOpportunity reads exactly four fields of the opportunity -- category, title,
// description and skills -- and nothing else about it. Two opportunities that agree on those
// four classify identically, forever. The owner's dashboard re-classifies every discovered
// lead on every poll, and a lead's text does not change between polls even though its
// lastSeenAt does, so the same answer was recomputed from scratch thousands of times per
// request. Key a memo on precisely the inputs the function reads, and every poll after the
// first costs a map lookup.
//
// The tool context and the two env vars estimateLlmCost reads are part of the key: they are
// stable within a process, but a caller that changes them must not be served a stale answer.
const CLASSIFY_MEMO=new Map();
const CLASSIFY_MEMO_LIMIT=50000;

// Fifteen of the key's parts describe the tool context and the environment, not the job, so
// they are the same for every lead in one dashboard request. Building them per lead cost more
// than the memo saved. A caller hands the identical context object to all five thousand
// classifications, so the fingerprint is cached against that object and computed once.
const CONTEXT_KEYS=new WeakMap();
function contextKey(context){
  const cached=CONTEXT_KEYS.get(context);
  if(cached!==undefined)return cached;
  const key=[context.llmEnabled,context.hasGithubPrTool,context.hasShellTool,context.hasBrowserTool,
    context.hasDeployTool,context.hasArtifactTool,context.hasAppTool,context.hasWebSearchTool,
    context.hasDesignMediaTool,context.strictCapabilityProof,
    Array.isArray(context.connectedApps)?context.connectedApps.join(','):'',
    process.env.E2B_API_KEY?1:0,process.env.COMPOSIO_API_KEY?1:0,
    process.env.AUTONOMOS_LLM_INPUT_USD_PER_MILLION,process.env.AUTONOMOS_LLM_OUTPUT_USD_PER_MILLION
  ].join('\u0000');
  CONTEXT_KEYS.set(context,key);
  return key;
}

export function classifyOpportunity(opportunity,context={}){
  const skills=Array.isArray(opportunity?.skills)?opportunity.skills.join(','):'';
  const key=`${contextKey(context)}\u0000${opportunity?.category}\u0000${opportunity?.title}\u0000${opportunity?.description}\u0000${skills}`;
  const hit=CLASSIFY_MEMO.get(key);
  if(hit)return copyVerdict(hit);
  const result=classifyOpportunityUncached(opportunity,context);
  // A plain cap rather than a real LRU: the entries are cheap and a fleet that has seen fifty
  // thousand distinct briefs in one process is better served starting over than growing without
  // bound on a 512MB box.
  if(CLASSIFY_MEMO.size>=CLASSIFY_MEMO_LIMIT)CLASSIFY_MEMO.clear();
  CLASSIFY_MEMO.set(key,result);
  return copyVerdict(result);
}

// Callers get their own copy, so the cache cannot be seen from outside it. Nothing mutates a
// verdict today, but the hunter stores capability.missingTools straight into persisted state,
// and the day someone pushes onto that array a cached entry would be quietly poisoned for
// every later lead. A copy costs about a microsecond against the twenty-seven the classification
// costs, which is not a trade worth thinking about twice.
function copyVerdict(v){
  return {...v,missingTools:[...v.missingTools],requiredCapabilities:[...v.requiredCapabilities],
    requiredApps:[...v.requiredApps],freeFallbacks:{...v.freeFallbacks}};
}

function classifyOpportunityUncached(opportunity,{llmEnabled=false,hasGithubPrTool=false,hasShellTool=false,hasBrowserTool=false,hasDeployTool=false,hasArtifactTool=false,hasAppTool=false,connectedApps=[],hasWebSearchTool=false,hasDesignMediaTool=false,strictCapabilityProof=false}={}){
  const category=String(opportunity?.category||'').toLowerCase(),title=String(opportunity?.title||''),description=String(opportunity?.description||'');
  const hay=`${category} ${title} ${description} ${(Array.isArray(opportunity.skills)?opportunity.skills:[]).join(' ')}`.toLowerCase();
  const safety=safetyCheck(hay);
  let matched=null,bestScore=-1;
  for(const entry of MATCHERS){
    let score=entry.categories.has(category)?4:0;
    for(const pattern of entry.patterns)if(pattern.test(hay))score++;
    if(score>bestScore){bestScore=score;matched={rule:entry.rule,score};}
  }
  const skill=matched?.score>0?matched.rule.skill:'general-digital',recognized=Boolean(matched?.score>0),deterministic=canDoDeterministically(opportunity,skill);
  const connected=new Set((Array.isArray(connectedApps)?connectedApps:[]).map(x=>String(x).toLowerCase().trim()).filter(Boolean));
  // Free-first bridge: an E2B shell can run Playwright/Puppeteer, public HTTP/API clients,
  // ffmpeg/Pillow and open-source converters. Composio can deploy through already connected
  // Vercel/Netlify accounts. These are capabilities, not permission to bypass identity gates.
  const effectiveBrowser=Boolean(hasBrowserTool||(!strictCapabilityProof&&hasShellTool));
  const effectiveWebResearch=Boolean(hasWebSearchTool||hasShellTool||hasGithubPrTool);
  const effectiveDesignMedia=Boolean(hasDesignMediaTool||(!strictCapabilityProof&&hasShellTool));
  const effectiveDeploy=Boolean(hasDeployTool||(!strictCapabilityProof&&hasAppTool&&(connected.has('vercel')||connected.has('netlify'))));
  const needs={github:REQUIRES_GITHUB_PR.test(hay),shell:REQUIRES_SHELL.test(hay)||skill==='document-generation'||(skill==='code-analysis'&&!/\b(?:explain|summarize|document|describe)\b/i.test(title)),browser:REQUIRES_BROWSER.test(hay)||skill==='browser-ops',deploy:REQUIRES_DEPLOY.test(hay),artifact:REQUIRES_ARTIFACT.test(hay)||skill==='document-generation',app:REQUIRES_APP.test(hay),onchainTx:REQUIRES_ONCHAIN_TX.test(hay)||/\b(?:solana|ethereum|polygon|arbitrum|sepolia|devnet|mainnet|testnet)\b[\s\S]{0,100}\bsubmit\s+(?:the |your )?deployed\s+(?:application|dapp|contract)\b/i.test(hay)||/\b(?:swap|send|transfer)\s+(?:[0-9.]+\s+|a |the |your )?(?:usdc|usdt|sui|sol|eth|btc|tokens?|crypto|funds)\b/i.test(hay),procurement:REQUIRES_PROCUREMENT.test(hay),physical:REQUIRES_PHYSICAL.test(hay),humanIdentity:REQUIRES_HUMAN_IDENTITY.test(hay)||/\b(?:join (?:the |our |a )?(?:community|discord|telegram)|referral|invite (?:your )?friends)\b/i.test(hay),designMedia:REQUIRES_DESIGN_MEDIA.test(hay)||skill==='design-media',liveVerification:skill==='web-research'&&!deterministic};
  const requiredApps=inferRequiredApps(hay),missing=[];
  if(needs.github&&!hasGithubPrTool)missing.push('github_pr');if(needs.shell&&!hasShellTool)missing.push('sandbox_shell');if(needs.browser&&!effectiveBrowser)missing.push('browser');if(needs.deploy&&!effectiveDeploy)missing.push('deploy');if(needs.artifact&&!hasArtifactTool&&!(needs.github&&hasGithubPrTool)&&(!hasAppTool||(strictCapabilityProof&&!connected.has('google_drive'))))missing.push('artifact_storage');if(needs.app&&!hasAppTool)missing.push('connected_app_gateway');
  if(needs.app&&hasAppTool&&requiredApps.length)for(const app of requiredApps)if(!connected.has(app))missing.push(`connected_app:${app}`);
  if(needs.procurement)missing.push('external_procurement');if(needs.physical)missing.push('physical_world_action');if(needs.humanIdentity)missing.push('human_identity_or_reputation');if(needs.designMedia&&!effectiveDesignMedia)missing.push('design_media_tool');if(needs.liveVerification&&!effectiveWebResearch)missing.push('web_search');if(needs.onchainTx)missing.push('signed_onchain_transaction');
  const needsUnavailableTooling=missing.length>0,generalDigitalFallback=!recognized&&llmEnabled&&!needsUnavailableTooling&&safety.safe;
  return{skill,confidence:recognized?Math.min(1,(matched?.score||0)/6):generalDigitalFallback?0.35:0,safe:safety.safe,permanentlyUnsupported:needs.physical||needs.onchainTx,safetyReason:safety.reason,executable:safety.safe&&!needsUnavailableTooling&&(recognized?(deterministic||llmEnabled):generalDigitalFallback),mode:needsUnavailableTooling?'unsupported_missing_tooling':!recognized?(generalDigitalFallback?'llm_general_digital':'unsupported_unrecognized'):needs.github?'llm_with_github_pr':deterministic?'deterministic':llmEnabled?'llm_with_tools':'unsupported_without_llm',missingTooling:needsUnavailableTooling,missingTools:missing,requiresArtifact:needs.artifact,requiredCapabilities:[...Object.entries(needs).filter(([,value])=>value).map(([key])=>key),...requiredApps.map(x=>`app:${x}`)],requiredApps,estimatedModelCostUsd:deterministic?0:llmEnabled?estimateLlmCost(opportunity):0,freeFallbacks:{browser:effectiveBrowser&&!hasBrowserTool,webResearch:effectiveWebResearch&&!hasWebSearchTool,designMedia:effectiveDesignMedia&&!hasDesignMediaTool,deploy:effectiveDeploy&&!hasDeployTool}};
}
const APP_TESTS=[['reddit',/\breddit\b/i],['x',/\b(?:x\.com|twitter|tweet|post to x|publish on x|post on x|x post)\b|\bpost\s*[—\-→:]\s*x\b/i],['linkedin',/\blinkedin\b/i],['discord',/\bdiscord\b/i],['telegram',/\btelegram\b/i],['gmail',/\b(?:gmail|send (?:an )?email|customer support|email support|reply to (?:a )?customer|inbox triage)\b/i],['slack',/\bslack\b/i],['notion',/\bnotion\b/i],['google_sheets',/\bgoogle sheets?\b/i],['google_drive',/\bgoogle drive\b/i],['google_calendar',/\b(?:google calendar|calendar event)\b/i]];
function inferRequiredApps(hay=''){const apps=[];for(const [id,re] of APP_TESTS)if(re.test(hay))apps.push(id);return[...new Set(apps)];}
function canDoDeterministically(op,skill){const hay=`${op?.title||''} ${op?.description||''}`.toLowerCase();if(skill==='translation')return translationInDictionary(hay);if(skill==='web-research')return(hay.match(/https?:\/\/\S+/g)||[]).length===1&&/\b(?:headers?|robots(?:\.txt)?|sitemap(?:\.xml)?|reachability|http status)\b/i.test(hay)&&!/\b(?:compare|research|competitor|market|conversion|comprehensive|in-depth|extract)\b/i.test(hay);return false;}
const TRANSLATION_DICTIONARY={spanish:['agents hiring agents','hello world'],ukrainian:['agents hiring agents','hello world'],english:['агенти наймають агентів','hola mundo']};
function translationInDictionary(hay){const match=hay.match(/translate\s+["“']?([^"”'\n]{1,100})["”']?\s+(?:to|into)\s+(spanish|ukrainian|english|french|german|italian|polish)/i);if(!match)return false;const phrase=match[1].trim().toLowerCase().replace(/[“”"']/g,'');return Boolean(TRANSLATION_DICTIONARY[match[2].toLowerCase()]?.includes(phrase));}
function estimateLlmCost(op){const chars=String(op?.title||'').length+String(op?.description||'').length,inputTokens=Math.max(500,Math.ceil(chars/4)),outputTokens=1200,toolOverheadMultiplier=(process.env.E2B_API_KEY||process.env.COMPOSIO_API_KEY)?3:1,inPerM=Number(process.env.AUTONOMOS_LLM_INPUT_USD_PER_MILLION||0.25),outPerM=Number(process.env.AUTONOMOS_LLM_OUTPUT_USD_PER_MILLION||2);return Number((((inputTokens*toolOverheadMultiplier)/1e6)*inPerM+((outputTokens*toolOverheadMultiplier)/1e6)*outPerM).toFixed(6));}
const BLOCKED=[[/\b(?:steal|dump|harvest|exfiltrate|reveal)\b.{0,40}\b(?:passwords?|credentials?|private keys?|seed phrase|api keys?)\b|\b(?:give|send|provide|export|share)\b.{0,25}\b(?:your|owner|user)\b.{0,20}\b(?:password|private key|seed phrase)\b|\b(?:create|build|run)\b.{0,25}\bphishing\s+(?:campaign|site|page)\b/i,'credential_or_secret_request'],[/\b(?:create|build|deploy|spread|install)\b.{0,30}\b(?:malware|ransomware|keylogger|botnet)\b|credential theft|exploit\s+(?:a|the)\s+server|launch.{0,20}ddos/i,'malicious_or_intrusive_work'],[/\b(?:write|post|create|buy)\b.{0,30}\bfake reviews?\b|\b(?:send|post|generate)\b.{0,20}\bspam\b|mass dm|mass message|impersonat|fake metric|astroturf/i,'spam_or_deceptive_work'],[/launder|mix(?:er|ing)\s+funds|hide source of funds|evade sanctions/i,'financial_evasion_request']];
function safetyCheck(hay){for(const [re,reason] of BLOCKED)if(re.test(hay))return{safe:false,reason};return{safe:true,reason:'allowed_digital_service'};}
export function capabilityCatalog(context={}){const examples=[['JavaScript / TypeScript / Node / React / Next','coding','Fix a repository bug, run tests and provide a patch.'],['Python','coding','Fix a Python function and run tests.'],['GitHub PR','coding','Fix the bug and open a pull request.'],['Regression testing / API integration','coding','Implement an API integration and run regression tests.'],['Scraping / technical research','research','Research current public sources and extract findings.'],['CSV / JSON / spreadsheets','data','Transform a CSV dataset and deliver a spreadsheet file.'],['PDF / document processing','document','Extract a PDF and create a downloadable document.'],['Translation / localization','translation','Translate and localize the provided text.'],['SEO / analytics','seo','Audit supplied URLs/data and produce a structured report.'],['Customer support / inbox','customer-support','Reply to customer emails using connected Gmail.'],['Presentation / reports','presentation','Create a presentation/report artifact.'],['Basic image/media processing','graphic-design','Resize/compose simple assets or process media with open-source tools.'],['Browser QA / automation','browser','Navigate the dashboard and perform web app testing.']];return examples.map(([name,category,description])=>{const cap=classifyOpportunity({title:name,category,description},context);return{name,available:cap.executable,skill:cap.skill,missingTools:cap.missingTools,mode:cap.mode};});}

