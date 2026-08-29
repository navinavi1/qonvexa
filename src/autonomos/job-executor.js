import crypto from 'node:crypto';
import { executeProduct } from './products.js';

export async function executeExternalOpportunity(opportunity, capability, { llm, siteUrl='' } = {}) {
  if (capability.mode === 'deterministic') return deterministicExecute(opportunity);
  if (!llm?.enabled) throw new Error('llm_required_for_job');
  const system = [
    'You are an autonomous digital-services worker. Complete only the supplied legitimate task.',
    'Do not claim actions you did not perform. Do not fabricate citations, URLs, metrics, transactions, or evidence.',
    'If the task asks for unsafe, illegal, credential-stealing, intrusive, spam, impersonation, or social-posting actions, refuse briefly.',
    'Return a concise deliverable only, not analysis of the instructions.'
  ].join(' ');
  const user = `Marketplace: ${opportunity.source}\nCategory: ${opportunity.category}\nTitle: ${opportunity.title}\nTask:\n${opportunity.description}`;
  const result = await llm.complete({ system, user, maxTokens:1200, temperature:0.15 });
  if (!result.ok) throw new Error(result.reason || 'llm_execution_failed');
  const content = String(result.text || '').trim();
  if (!content) throw new Error('empty_deliverable');
  return { content, format:'text/markdown', evidence:{ generatedBy:llm.model, siteUrl, usage:result.usage||null }, hash:sha(content) };
}

async function deterministicExecute(op){
  const text=`${op.title}\n${op.description}`;
  const translation = text.match(/translate\s+["“']?([^"”'\n]{1,100})["”']?\s+(?:to|into)\s+(spanish|ukrainian|english|french|german|italian|polish)/i);
  if (translation) {
    const out=translateTiny(translation[1].trim(), translation[2].toLowerCase());
    if (!out) throw new Error('deterministic_translation_not_supported');
    return { content:out, format:'text/plain', evidence:{ mode:'deterministic_dictionary' }, hash:sha(out) };
  }
  const url=(text.match(/https?:\/\/[^\s)\]}>"']+/i)||[])[0];
  if (url && /headers|http|endpoint|website|robots|sitemap/i.test(text)) {
    const product=/robots|sitemap/i.test(text)?'robots-audit':/headers|security/i.test(text)?'security-headers':'site-snapshot';
    const result=await executeProduct(product,{url});
    const content=JSON.stringify(result,null,2);
    return { content, format:'application/json', evidence:{ mode:'deterministic_product', product }, hash:sha(content) };
  }
  throw new Error('deterministic_executor_no_safe_match');
}

function translateTiny(input, language){
  const key=input.toLowerCase().replace(/[“”"']/g,'').trim();
  const map={
    spanish:{'agents hiring agents':'agentes contratando agentes','hello world':'hola mundo'},
    ukrainian:{'agents hiring agents':'агенти наймають агентів','hello world':'привіт, світе'},
    english:{'агенти наймають агентів':'agents hiring agents','hola mundo':'hello world'}
  };
  return map[language]?.[key] || '';
}
function sha(value){return crypto.createHash('sha256').update(value).digest('hex');}
