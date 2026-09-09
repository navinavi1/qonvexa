const BAD=/\b(i cannot|i can't|unable to complete|as an ai|i did not actually|lorem ipsum)\b/i;
const SIMPLE_TEXT=/\b(translate|translation|locali[sz]ation|proofread|proofreading|rewrite|rewriting|copywriting|copywriter|article|blog post|product description|email copy|headline)\b/i;
const CODE_OR_RESEARCH=/\b(code|coding|implement|implementation|bug fix|python|javascript|typescript|api|script|research|current data|live data|sources?|citations?|scrap(?:e|ing)|automation|test(?:s|ing)?)\b/i;
const ARTIFACT_REQUIRED=/\b(pdf|docx|xlsx|csv|zip|pptx|downloadable|attachment|deliver (?:a )?file|create (?:a )?file|spreadsheet|presentation)\b/i;

// A compact, QA-readable proof record: which tools were actually called and what really
// happened — separate from the deliverable's own prose CLAIMS about what it did.
export function buildProofLog(toolCalls){
  if(!Array.isArray(toolCalls)||!toolCalls.length)return 'No tools were called during execution — the deliverable is unsupported prose only.';
  return toolCalls.map((call,i)=>{
    const artifacts=(call.artifacts||[]).filter(a=>a?.ok&&a.url).map(a=>a.url);
    return `${i+1}. tool=${call.tool} success=${call.ok?'true':'false'}${call.ok?'':` error="${String(call.error||'').slice(0,120)}"`}${call.exitCode!==undefined?` exitCode=${call.exitCode}`:''}${call.stdout?` observed_output=${JSON.stringify(String(call.stdout).slice(-2000))}`:''}${call.stderr?` stderr=${JSON.stringify(String(call.stderr).slice(-800))}`:''}${artifacts.length?` artifacts=[${artifacts.slice(0,3).join(', ')}]`:''}`;
  }).join('\n');
}

export async function evaluateDeliverable(opportunity,deliverable,{llm=null,abortSignal=null,env=process.env}={}){
  if(opportunity?.executionKind==='repository'){const p=deliverable?.evidence?.repositoryVerification;const ok=Boolean(p?.ok&&p.testsPassOnFix&&p.regressionFailsOnBase&&p.patchSha256&&Array.isArray(p.files)&&p.files.length);return {ok,score:ok?1:0,reasons:ok?[]:['repository_verification_required'],mode:'verified_repository'};}
  const content=String(deliverable?.content||'').trim();
  const deterministic=[];
  if(content.length<(['deterministic_dictionary','deterministic_product'].includes(deliverable?.evidence?.mode)?1:20))deterministic.push('too_short');
  if(BAD.test(content.slice(0,800)))deterministic.push('refusal_or_placeholder');
  if(deterministic.length)return{ok:false,score:0,reasons:deterministic,mode:'deterministic'};
  const deterministicOutput=['deterministic_dictionary','deterministic_product'].includes(deliverable?.evidence?.mode);
  if(deterministicOutput)return{ok:true,score:1,reasons:[],mode:'deterministic_verified'};

  const failOpen=/^(1|true|yes)$/i.test(String(env.AUTONOMOS_QA_FAIL_OPEN||'false'));
  const infraFallback=/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_QA_INFRA_FALLBACK||'true'));
  if(!llm?.enabled){
    const fallback=infraFallback?deterministicInfrastructureFallback(opportunity,deliverable):null;
    if(fallback)return fallback;
    return failOpen?{ok:true,score:.7,reasons:['llm_qa_unavailable_fail_open'],mode:'policy_fail_open'}:{ok:false,score:0,reasons:['llm_qa_unavailable'],mode:'fail_closed'};
  }

  const proofLog=buildProofLog(deliverable?.evidence?.toolCalls);
  const prompt=`You are an independent QA evaluator. Score 0..1 whether the deliverable fully satisfies the paid marketplace task. Reject fabricated claims, missing requested artifacts, non-working code, unresolved failed tool evidence, and answers that merely restate the task. A failed non-required tool attempt is not by itself fatal if the required result is later proven by successful evidence.\n\nCRITICAL: the DELIVERABLE TEXT is only a CLAIM about what was done. The ACTUAL TOOL LOG below is the PROOF — it is what really happened. If the deliverable text claims a tool was run, checked, verified, or an artifact was created, and that specific action does not appear as a successful entry in the tool log, treat it as a fabricated/unverifiable claim and reject it — regardless of how confidently it is worded.\n\nReturn ONLY JSON: {"score":number,"pass":boolean,"reasons":[string]}.\nTASK: ${String(opportunity?.title||'')}\n${String(opportunity?.description||'').slice(0,5000)}\n\nACTUAL TOOL LOG (proof — ground truth):\n${proofLog}\n\nDELIVERABLE TEXT (claim only — verify against the tool log above):\n${content.slice(0,10000)}`;

  for(let attempt=0;attempt<2;attempt++){
    const result=await llm.complete({messages:[{role:'system',content:'You are a strict independent QA grader. Output valid JSON only.'},{role:'user',content:prompt+(attempt?'\nYour prior response was invalid JSON. Return JSON only.':'')}],maxTokens:Number(env.AUTONOMOS_QA_MAX_TOKENS||900),signal:abortSignal,task:'qa'});
    if(!result?.ok){
      if(attempt===0)continue;
      const fallback=infraFallback?deterministicInfrastructureFallback(opportunity,deliverable):null;
      if(fallback)return fallback;
      return failOpen?{ok:true,score:.7,reasons:['llm_qa_unavailable_fail_open'],mode:'policy_fail_open'}:{ok:false,score:0,reasons:['llm_qa_unavailable'],mode:'fail_closed'};
    }
    try{
      const parsed=JSON.parse(String(result.text||'').replace(/^```json\s*|```$/g,''));
      const score=Math.max(0,Math.min(1,Number(parsed.score||0)));
      return{ok:parsed.pass===true&&Number.isFinite(score)&&score>=0.72,score,reasons:Array.isArray(parsed.reasons)?parsed.reasons.slice(0,8):[],mode:'llm_evaluator'};
    }catch{
      if(attempt===1){
        const fallback=infraFallback?deterministicInfrastructureFallback(opportunity,deliverable):null;
        if(fallback)return fallback;
        return failOpen?{ok:true,score:.7,reasons:['llm_qa_parse_failed_fail_open'],mode:'policy_fail_open'}:{ok:false,score:0,reasons:['llm_qa_parse_failed'],mode:'fail_closed'};
      }
    }
  }
  const fallback=infraFallback?deterministicInfrastructureFallback(opportunity,deliverable):null;
  return fallback||{ok:false,score:0,reasons:['qa_unreachable'],mode:'fail_closed'};
}

// Used ONLY when the QA evaluator itself is unavailable/invalid. This is not a general
// quality bypass. Simple text jobs can be verified from the requested text result itself;
// tool-dependent jobs need successful evidence, and requested artifacts need a durable URL.
export function deterministicInfrastructureFallback(opportunity,deliverable){
  const title=String(opportunity?.title||'');
  const description=String(opportunity?.description||'');
  const task=`${title}\n${description}`;
  const content=String(deliverable?.content||'').trim();
  const calls=Array.isArray(deliverable?.evidence?.toolCalls)?deliverable.evidence.toolCalls:[];
  const successful=calls.filter(x=>x?.ok===true);
  const artifactUrls=[
    ...(Array.isArray(deliverable?.evidence?.artifactUrls)?deliverable.evidence.artifactUrls:[]),
    ...successful.flatMap(x=>Array.isArray(x?.artifacts)?x.artifacts.filter(a=>a?.ok&&a?.url).map(a=>a.url):[])
  ].filter(Boolean);

  if(BAD.test(content.slice(0,800))||content.length<20)return null;
  if(ARTIFACT_REQUIRED.test(task)&&artifactUrls.length===0)return null;
  if(CODE_OR_RESEARCH.test(task)){
    const relevant=successful.some(x=>['run_shell','run_python','coderabbit_review','web_search','web_scrape','browser_task','open_pull_request','store_artifact','app_action'].includes(String(x?.tool||'')));
    if(!relevant)return null;
    return{ok:true,score:.76,reasons:['qa_evaluator_unavailable_but_required_tool_evidence_passed'],mode:'deterministic_evaluator_fallback'};
  }
  if(SIMPLE_TEXT.test(task)){
    return{ok:true,score:.78,reasons:['qa_evaluator_unavailable_simple_text_result_verified'],mode:'deterministic_evaluator_fallback'};
  }
  // General digital fallback requires at least one successful real tool; unsupported prose alone never passes.
  if(successful.length>0)return{ok:true,score:.74,reasons:['qa_evaluator_unavailable_but_real_tool_evidence_passed'],mode:'deterministic_evaluator_fallback'};
  return null;
}
