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

console.log('QA RESILIENCE: PASS');
