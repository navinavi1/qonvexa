import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { normalizeConfig, DEFAULT_AUTONOMOS_CONFIG } from '../src/autonomos/policy-engine.js';

// The policy form silently stopped submitting: maxChildren carried max="32" while the
// server default is 50, renderAutonomOS() wrote that 50 into the field, the form became
// permanently invalid and the browser refused to submit it with no message anywhere. No
// policy change made in the dashboard could be saved at all. This asserts that every
// numeric input can hold the value the server will actually put in it.

const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const { window } = new JSDOM(html);
const form = window.document.querySelector('#autonomos-config-form');
assert(form, 'the policy form must exist');

delete process.env.npm_lifecycle_event;
const config = normalizeConfig({ ...DEFAULT_AUTONOMOS_CONFIG, updatedAt: new Date().toISOString() });

const numeric = [...form.querySelectorAll('input[type="number"][name]')];
assert(numeric.length > 0, 'the policy form must expose numeric inputs');

for (const input of numeric) {
  const name = input.name;
  const serverValue = config[name];
  assert(serverValue !== undefined, `${name} is not a config key, so the form would discard it`);
  const min = input.min === '' ? -Infinity : Number(input.min);
  const max = input.max === '' ? Infinity : Number(input.max);
  assert(
    Number(serverValue) >= min && Number(serverValue) <= max,
    `${name}: the server value ${serverValue} falls outside the input range ${input.min}..${input.max}, which makes the whole form unsubmittable`
  );
}

// Fields the form submits must also be fields updateConfig() accepts, or the UI reports
// success while the value is dropped.
const runtimeSource = fs.readFileSync(new URL('../src/autonomos/runtime.js', import.meta.url), 'utf8');
const allowed = runtimeSource.slice(runtimeSource.indexOf('const allowed = ['), runtimeSource.indexOf('const next={...config}'));
for (const input of [...form.querySelectorAll('input[name],select[name],textarea[name]')]) {
  assert(allowed.includes(`'${input.name}'`), `${input.name} is submitted by the form but not accepted by updateConfig()`);
}

console.log(`ADMIN FORM CONTRACT: PASS (${numeric.length} numeric inputs checked)`);
window.close();
