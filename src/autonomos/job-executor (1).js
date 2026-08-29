import crypto from 'node:crypto';
import { executeProduct } from './products.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';

export async function executeExternalOpportunity(opportunity, capability, { llm, siteUrl='', env=process.env } = {}) {
  if (capability.mode === 'deterministic') return deterministicExecute(opportunity);
  if (!llm?.enabled) throw new Error('llm_required_for_job');
  const hasTools = Boolean(env.FIRECRAWL_API_KEY || env.E2B_API_KEY);
  const availableTools = hasTools ? TOOL_SCHEMAS.filter(t =>
    (t.function.name === 'web_search' || t.function.name === 'web_scrape') ? Boolean(env.FIRECRAWL_API_KEY) :
    t.function.name === 'run_python' ? Boolean(env.E2B_API_KEY) : true
  ) : [];
  const system = [
    'You are an autonomous digital-services worker. Complete only the supplied legitimate task.',
    'Do not claim actions you did not perform. Do not fabricate citations, URLs, metrics, transactions, or evidence.',
    availableTools.length ? 'Use the provided tools (web_search, web_scrape, run_python) whenever the task needs current facts, a real source, or verified code — do not guess or fabricate what a search or a program would show. Do not claim to have searched, scraped, or run code unless you actually called that tool.' : '',
    'If the task asks for unsafe, illegal, credential-stealing, intrusive, spam, impersonation, or social-posting actions, refuse briefly.',
    'Return a concise deliverable only, not analysis of the instructions.'
  ].filter(Boolean).join(' ');
  const user = `Marketplace: ${opportunity.source}\nCategory: ${opportunity.category}\nTitle: ${opportunity.title}\nTask:\n${opportunity.description}`;
  const messages = [{ role:'system', content:system }, { role:'user', content:user }];

  let usage = { prompt_tokens:0, completion_tokens:0 };
  const toolLog = [];
  const MAX_TOOL_ROUNDS = 4;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const result = await llm.complete({ messages, tools: round < MAX_TOOL_ROUNDS ? availableTools : undefined, maxTokens:1200, temperature:0.15 });
    if (!result.ok) throw new Error(result.reason || 'llm_execution_failed');
    if (result.usage) { usage.prompt_tokens += Number(result.usage.prompt_tokens||0); usage.completion_tokens += Number(result.usage.completion_tokens||0); }
    if (result.toolCalls?.length) {
      messages.push(result.message);
      for (const call of result.toolCalls.slice(0,3)) {
        let args = {}; try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* malformed args from model */ }
        const toolResult = await runTool(call.function?.name, args, env);
        toolLog.push({ tool:call.function?.name, args, ok:toolResult.ok });
        messages.push({ role:'tool', tool_call_id:call.id, content: JSON.stringify(toolResult).slice(0,6000) });
      }
      continue;
    }
    const content = String(result.text || '').trim();
    if (!content) throw new Error('empty_deliverable');
    return { content, format:'text/markdown', evidence:{ generatedBy:llm.model, siteUrl, usage, toolCalls:toolLog }, hash:sha(content) };
  }
  throw new Error('tool_loop_did_not_converge');
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
