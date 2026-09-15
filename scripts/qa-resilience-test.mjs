import assert from 'node:assert/strict';
import { evaluateDeliverable } from '../src/autonomos/qa-engine.js';

const unavailable={enabled:false};
let qa=await evaluateDeliverable({title:'Translate this paragraph to Spanish',description:'Return the translated text.'},{content:'Este es un texto traducido suficientemente largo para ser una entrega real.',evidence:{toolCalls:[]}},{llm:unavailable,env:{AUTONOMOS_QA_INFRA_FALLBACK:'true'}});
assert.equal(qa.ok,true);assert.equal(qa.mode,'deterministic_evaluator_fallback');

qa=await evaluateDeliverable({title:'Research current competitors',description:'Use current sources and cite them.'},{content:'Here is a long research answer that has no live proof and therefore must not pass.',evidence:{toolCalls:[]}},{llm:unavailable,env:{AUTONOMOS_QA_INFRA_FALLBACK:'true'}});
assert.equal(qa.ok,false);

qa=await evaluateDeliverable({title:'Research current competitors',description:'Use current sources and cite them.'},{content:'Current research summary supported by a successful search call and source evidence.',evidence:{toolCalls:[{tool:'web_search',ok:true}]}},{llm:unavailable,env:{AUTONOMOS_QA_INFRA_FALLBACK:'true'}});
assert.equal(qa.ok,true);

qa=await evaluateDeliverable({title:'Create a CSV file',description:'Deliver the downloadable CSV artifact.'},{content:'The CSV has been created and validated, but there is no durable artifact URL.',evidence:{toolCalls:[{tool:'run_python',ok:true}]}},{llm:unavailable,env:{AUTONOMOS_QA_INFRA_FALLBACK:'true'}});
assert.equal(qa.ok,false);

// The grader's JSON was unwrapped with a strip that only understood a ```json fence. A bare
// ``` fence -- which models emit constantly -- left the backticks in place: JSON.parse threw,
// the grader was called a second time, and the job fell through to the infrastructure
// fallback. Two paid completions spent and the real verdict discarded, over three characters.
// Every wrapper a model actually produces must reach the same verdict.
{
  const task={title:'Summarise this page',description:'Return a short summary.'};
  const delivered={content:'A sufficiently long deliverable body that is clearly a real answer to the task.',evidence:{toolCalls:[]}};
  const verdict='{"score":0.91,"pass":true,"reasons":[]}';
  const wrappers=[
    ['plain json',verdict],
    ['json-tagged fence','```json\n'+verdict+'\n```'],
    ['bare fence','```\n'+verdict+'\n```'],
    ['a sentence first','Here is my assessment:\n```\n'+verdict+'\n```']
  ];
  for(const [label,text] of wrappers){
    let calls=0;
    const grader={enabled:true,async complete(){calls++;return{ok:true,text};}};
    const qa=await evaluateDeliverable(task,delivered,{llm:grader,env:{}});
    assert.equal(qa.mode,'llm_evaluator',`${label}: the grader's own verdict is used`);
    assert.equal(qa.ok,true,`${label}: and it passes`);
    assert.equal(qa.score,0.91,`${label}: with the score the grader gave`);
    assert.equal(calls,1,`${label}: on a single completion, not a retry`);
  }

  // A genuine refusal must still fail, and must not be rescued by the unwrapping.
  const failing={enabled:true,async complete(){return{ok:true,text:'```\n{"score":0.3,"pass":false,"reasons":["fabricated claims"]}\n```'};}};
  const rejected=await evaluateDeliverable(task,delivered,{llm:failing,env:{}});
  assert.equal(rejected.ok,false,'a rejection inside a bare fence is still a rejection');
  assert.deepEqual(rejected.reasons,['fabricated claims'],'and its reasons survive');
}

console.log('QA RESILIENCE: PASS');
