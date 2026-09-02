const BAD=/\b(i cannot|i can't|unable to complete|sorry|as an ai|i did not actually|placeholder|todo:|lorem ipsum)\b/i;
export async function evaluateDeliverable(opportunity,deliverable,{llm=null,abortSignal=null,env=process.env}={}){
  const content=String(deliverable?.content||'').trim();
  const deterministic=[];
  if(content.length<20)deterministic.push('too_short');
  if(BAD.test(content.slice(0,800)))deterministic.push('refusal_or_placeholder');
  if(deliverable?.evidence?.toolCalls?.some(x=>x.ok===false))deterministic.push('failed_tool_call');
  if(deterministic.length)return{ok:false,score:0,reasons:deterministic,mode:'deterministic'};
  const deterministicOutput=['deterministic_dictionary','deterministic_product'].includes(deliverable?.evidence?.mode);
  if(deterministicOutput)return{ok:true,score:1,reasons:[],mode:'deterministic_verified'};
  const failOpen=/^(1|true|yes)$/i.test(String(env.AUTONOMOS_QA_FAIL_OPEN||'false'));
  if(!llm?.enabled)return failOpen?{ok:true,score:.7,reasons:['llm_qa_unavailable_fail_open'],mode:'policy_fail_open'}:{ok:false,score:0,reasons:['llm_qa_unavailable'],mode:'fail_closed'};
  const prompt=`You are an independent QA evaluator. Score 0..1 whether the deliverable fully satisfies the paid marketplace task. Reject fabricated claims, missing requested artifacts, non-working code, failed tool evidence, and answers that merely restate the task. Return ONLY JSON: {"score":number,"pass":boolean,"reasons":[string]}.\nTASK: ${String(opportunity?.title||'')}\n${String(opportunity?.description||'').slice(0,5000)}\nDELIVERABLE:\n${content.slice(0,10000)}`;
  for(let attempt=0;attempt<2;attempt++){
    const result=await llm.complete({messages:[{role:'system',content:'You are a strict independent QA grader. Output valid JSON only.'},{role:'user',content:prompt+(attempt?'\nYour prior response was invalid JSON. Return JSON only.':'')}],maxTokens:Number(env.AUTONOMOS_QA_MAX_TOKENS||900),signal:abortSignal,task:'qa'});
    if(!result?.ok){if(attempt===0)continue;return failOpen?{ok:true,score:.7,reasons:['llm_qa_unavailable_fail_open'],mode:'policy_fail_open'}:{ok:false,score:0,reasons:['llm_qa_unavailable'],mode:'fail_closed'};}
    try{const parsed=JSON.parse(String(result.text||'').replace(/^```json\s*|```$/g,''));const score=Math.max(0,Math.min(1,Number(parsed.score||0)));return{ok:Boolean(parsed.pass)&&score>=0.72,score,reasons:Array.isArray(parsed.reasons)?parsed.reasons.slice(0,8):[],mode:'llm_evaluator'};}catch{if(attempt===1)return failOpen?{ok:true,score:.7,reasons:['llm_qa_parse_failed_fail_open'],mode:'policy_fail_open'}:{ok:false,score:0,reasons:['llm_qa_parse_failed'],mode:'fail_closed'};}
  }
  return{ok:false,score:0,reasons:['qa_unreachable'],mode:'fail_closed'};
}
