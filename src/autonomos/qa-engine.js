const BAD=/\b(i cannot|i can't|unable to complete|sorry|as an ai|i did not actually|placeholder|todo:|lorem ipsum)\b/i;

// A compact, QA-readable proof record: which tools were actually called and what really
// happened — separate from the deliverable's own prose CLAIMS about what it did. Without
// this, QA had to infer fabrication purely from wording ("I verified with run_python" —
// but was run_python actually called and did it succeed?) instead of just checking a log.
export function buildProofLog(toolCalls){
  if(!Array.isArray(toolCalls)||!toolCalls.length)return 'No tools were called during execution — the deliverable is unsupported prose only.';
  return toolCalls.map((call,i)=>{
    const artifacts=(call.artifacts||[]).filter(a=>a?.ok&&a.url).map(a=>a.url);
    return `${i+1}. tool=${call.tool} success=${call.ok?'true':'false'}${call.ok?'':` error="${String(call.error||'').slice(0,120)}"`}${artifacts.length?` artifacts=[${artifacts.slice(0,3).join(', ')}]`:''}`;
  }).join('\n');
}

export async function evaluateDeliverable(opportunity,deliverable,{llm=null,abortSignal=null,env=process.env}={}){
  const content=String(deliverable?.content||'').trim();
  const deterministic=[];
  if(content.length<20)deterministic.push('too_short');
  if(BAD.test(content.slice(0,800)))deterministic.push('refusal_or_placeholder');
  if(deterministic.length)return{ok:false,score:0,reasons:deterministic,mode:'deterministic'};
  const deterministicOutput=['deterministic_dictionary','deterministic_product'].includes(deliverable?.evidence?.mode);
  if(deterministicOutput)return{ok:true,score:1,reasons:[],mode:'deterministic_verified'};
  const failOpen=/^(1|true|yes)$/i.test(String(env.AUTONOMOS_QA_FAIL_OPEN||'false'));
  if(!llm?.enabled)return failOpen?{ok:true,score:.7,reasons:['llm_qa_unavailable_fail_open'],mode:'policy_fail_open'}:{ok:false,score:0,reasons:['llm_qa_unavailable'],mode:'fail_closed'};
  const proofLog=buildProofLog(deliverable?.evidence?.toolCalls);
  const prompt=`You are an independent QA evaluator. Score 0..1 whether the deliverable fully satisfies the paid marketplace task. Reject fabricated claims, missing requested artifacts, non-working code, unresolved failed tool evidence, and answers that merely restate the task. A failed non-required tool attempt is not by itself fatal if the required result is later proven by successful evidence.\n\nCRITICAL: the DELIVERABLE TEXT is only a CLAIM about what was done. The ACTUAL TOOL LOG below is the PROOF — it is what really happened. If the deliverable text claims a tool was run, checked, verified, or an artifact was created, and that specific action does not appear as a successful entry in the tool log, treat it as a fabricated/unverifiable claim and reject it — regardless of how confidently it is worded.\n\nReturn ONLY JSON: {"score":number,"pass":boolean,"reasons":[string]}.\nTASK: ${String(opportunity?.title||'')}\n${String(opportunity?.description||'').slice(0,5000)}\n\nACTUAL TOOL LOG (proof — ground truth):\n${proofLog}\n\nDELIVERABLE TEXT (claim only — verify against the tool log above):\n${content.slice(0,10000)}`;
  for(let attempt=0;attempt<2;attempt++){
    const result=await llm.complete({messages:[{role:'system',content:'You are a strict independent QA grader. Output valid JSON only.'},{role:'user',content:prompt+(attempt?'\nYour prior response was invalid JSON. Return JSON only.':'')}],maxTokens:Number(env.AUTONOMOS_QA_MAX_TOKENS||900),signal:abortSignal,task:'qa'});
    if(!result?.ok){if(attempt===0)continue;return failOpen?{ok:true,score:.7,reasons:['llm_qa_unavailable_fail_open'],mode:'policy_fail_open'}:{ok:false,score:0,reasons:['llm_qa_unavailable'],mode:'fail_closed'};}
    try{const parsed=JSON.parse(String(result.text||'').replace(/^```json\s*|```$/g,''));const score=Math.max(0,Math.min(1,Number(parsed.score||0)));return{ok:Boolean(parsed.pass)&&score>=0.72,score,reasons:Array.isArray(parsed.reasons)?parsed.reasons.slice(0,8):[],mode:'llm_evaluator'};}catch{if(attempt===1)return failOpen?{ok:true,score:.7,reasons:['llm_qa_parse_failed_fail_open'],mode:'policy_fail_open'}:{ok:false,score:0,reasons:['llm_qa_parse_failed'],mode:'fail_closed'};}
  }
  return{ok:false,score:0,reasons:['qa_unreachable'],mode:'fail_closed'};
}
