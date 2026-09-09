// Free-first capability policy for AutonomOS.
// This module does not buy tools, enable subscriptions, or bypass identity/security gates.
// It expands what agents may attempt using already-connected hard-capped/free resources.

export const FREE_CONNECTED_APPS=Object.freeze([
  'gmail','google_drive','google_sheets','google_calendar','github','slack','notion','figma','canva','vercel','netlify'
]);

export const FREE_SKILL_MATRIX=Object.freeze({
  'code-analysis': ['e2b_python','e2b_shell','github_pr'],
  'data-transform': ['e2b_python','e2b_shell','google_sheets'],
  'document-generation': ['e2b_python','e2b_shell','artifact_storage','google_drive'],
  'translation': ['llm','document-generation'],
  'copywriting': ['llm','document-generation'],
  'web-research': ['e2b_public_http','github_public_search','stackexchange_public_api','wikipedia_public_api','public_rss','llm'],
  'browser-ops': ['e2b_shell','playwright_or_puppeteer'],
  'app-automation': ['composio_free_apps'],
  'testing': ['e2b_python','e2b_shell'],
  'seo': ['e2b_public_http','e2b_python','document-generation'],
  'analytics': ['e2b_python','google_sheets','document-generation'],
  'ecommerce': ['composio_free_apps','google_sheets','copywriting'],
  'customer-support': ['gmail','composio_free_apps','copywriting'],
  'social-media': ['copywriting','composio_free_apps'],
  'technical-writing': ['copywriting','document-generation'],
  'presentation': ['e2b_python','document-generation'],
  'image-basic': ['e2b_python','e2b_shell','figma','canva'],
  'audio-video-basic': ['e2b_shell'],
  'deploy': ['composio_free_apps','vercel','netlify'],
  'general-digital': ['llm','e2b_python','e2b_shell','composio_free_apps','document-generation']
});

const CATEGORY_TO_SKILL=Object.freeze({
  coding:'code-analysis', code:'code-analysis', development:'code-analysis', software:'code-analysis',
  data:'data-transform', 'data-entry':'data-transform', spreadsheet:'data-transform', scraping:'data-transform',
  document:'document-generation', presentation:'presentation', 'technical-writing':'technical-writing',
  translation:'translation', transcription:'translation', writing:'copywriting', content:'copywriting', marketing:'copywriting',
  research:'web-research', analysis:'web-research', seo:'seo', analytics:'analytics',
  automation:'app-automation', operations:'app-automation', crm:'app-automation', 'no-code':'app-automation',
  testing:'testing', qa:'testing', ecommerce:'ecommerce', 'customer-support':'customer-support',
  'social-media':'social-media', 'virtual-assistant':'app-automation', 'ai-workflow':'app-automation',
  'graphic-design':'image-basic', 'ui-ux':'image-basic', video:'audio-video-basic', audio:'audio-video-basic',
  browser:'browser-ops', website:'code-analysis', deploy:'deploy'
});

export function freeCapabilityContext(env=process.env){
  const hasE2B=Boolean(env.E2B_API_KEY);
  const hasComposio=Boolean(env.COMPOSIO_API_KEY);
  return {
    llmEnabled:Boolean(env.OPENAI_API_KEY),
    hasGithubPrTool:Boolean(env.GITHUB_TOKEN),
    hasShellTool:hasE2B,
    // Interactive work uses Playwright/Puppeteer inside the isolated E2B sandbox. It is
    // never used to bypass CAPTCHA/KYC/2FA or to impersonate a human identity.
    hasBrowserTool:hasE2B,
    // Vercel/Netlify are already connected through the free Composio app gateway.
    hasDeployTool:Boolean(env.AUTONOMOS_DEPLOY_WEBHOOK_URL)||hasComposio,
    hasArtifactTool:Boolean((env.S3_ENDPOINT||env.R2_ENDPOINT)&&(env.S3_BUCKET||env.R2_BUCKET))||hasComposio,
    hasAppTool:hasComposio,
    connectedApps:[...FREE_CONNECTED_APPS],
    // E2B gives agents a real public-HTTP execution environment. Current-fact work must
    // still cite actual URLs/API responses; this flag does not enable paid search.
    hasWebSearchTool:hasE2B||Boolean(env.GITHUB_TOKEN),
    hasDesignMediaTool:hasE2B
  };
}

export function normalizeOpportunityForFreeSkills(op={}){
  const category=String(op.category||'').toLowerCase().trim();
  const mapped=CATEGORY_TO_SKILL[category]||category||'general-digital';
  const description=String(op.description||'');
  const title=String(op.title||'');
  const hay=`${category} ${title} ${description}`.toLowerCase();
  let normalizedCategory=mapped;
  if(/\b(?:logo|banner|thumbnail|simple graphic|resize image|crop image|image cleanup)\b/i.test(hay))normalizedCategory='document-generation';
  if(/\b(?:video trim|cut video|merge video|audio cleanup|convert audio|convert video|subtitle burn)\b/i.test(hay))normalizedCategory='code-analysis';
  if(/\b(?:seo audit|keyword list|on-page seo|meta description)\b/i.test(hay))normalizedCategory='web-research';
  if(/\b(?:dashboard|reporting|data visualization|chart|analytics report)\b/i.test(hay))normalizedCategory='data-transform';
  if(/\b(?:customer support|email support|reply to customers|inbox triage)\b/i.test(hay))normalizedCategory='app-automation';
  if(/\b(?:browser automation|web app testing|screenshot|navigate (?:the )?(?:site|dashboard))\b/i.test(hay))normalizedCategory='browser-ops';
  if(/\b(?:deploy|deployment|publish (?:the )?(?:site|app)|release to production)\b/i.test(hay))normalizedCategory='deploy';
  return {...op,category:normalizedCategory,skills:[...(Array.isArray(op.skills)?op.skills:[]),mapped]};
}

export function freeSkillPlan(op={}){
  const normalized=normalizeOpportunityForFreeSkills(op);
  const skill=String(normalized.skills?.at(-1)||normalized.category||'general-digital');
  return {skill,tools:FREE_SKILL_MATRIX[skill]||FREE_SKILL_MATRIX['general-digital'],normalized};
}

export function paidToolForbidden(name=''){
  const n=String(name).toLowerCase();
  return /premium|paid_search|paid_browser|purchase|subscription|connects|credits_purchase/.test(n);
}
