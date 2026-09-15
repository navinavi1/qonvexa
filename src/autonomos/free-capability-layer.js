import { unifiedCapabilityContext } from './capability-registry.js';
// Free-first capability policy for AutonomOS.
// This module does not buy tools, enable subscriptions, or bypass identity/security gates.
// It expands what agents may attempt using already-connected hard-capped/free resources.


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

export function freeCapabilityContext(env=process.env){return unifiedCapabilityContext(env);}



