// Unwrapping a model's JSON was written three times, three different ways, and two of them
// were wrong in the same manner: they stripped a fence tagged ```json but not a bare ```,
// which models emit constantly. What followed was never an error anybody saw -- the QA
// grader's verdict was discarded and the job fell through to a fallback after a second paid
// completion; the planner silently used a generic plan instead of the tailored one it had
// just paid to generate. A parse that fails quietly is worse than one that fails loudly,
// and three copies of it is three chances to get it wrong.
//
// Models wrap JSON with a tagged fence, a bare fence, a sentence of preamble, or nothing at
// all. Take the outermost balanced object or array rather than trusting the wrapper.
export function parseLlmJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const unfenced = raw.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  for (const candidate of [unfenced, sliceOutermost(unfenced), sliceOutermost(raw)]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

// The first '{' or '[' through its matching close. Cheap and good enough for a model that
// put a sentence in front of its answer; it is not a parser and does not pretend to be.
function sliceOutermost(text) {
  const start = text.search(/[{[]/);
  if (start < 0) return '';
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  const end = text.lastIndexOf(close);
  return end > start ? text.slice(start, end + 1) : '';
}
