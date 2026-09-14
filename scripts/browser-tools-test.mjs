// browser-actions.js and browser-reader.js were the only two modules in src/autonomos that no
// test reached, and they are the two that touch other people's websites on the agent's behalf.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browserAction } from '../src/autonomos/browser-actions.js';
import { browserReadPage } from '../src/autonomos/browser-reader.js';
import { ActionJournal } from '../src/autonomos/action-journal.js';

let checks = 0;
const ok = (condition, label) => { assert.ok(condition, label); checks++; };
const eq = (actual, expected, label) => { assert.equal(actual, expected, `${label} (got ${JSON.stringify(actual)})`); checks++; };

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-tools-'));
const env = { STORAGE_DIR: storage, E2B_API_KEY: 'test-key' };

// Reading a page is a public-web capability. Anything that could be used to reach the host's
// own network, a cloud metadata endpoint, or to smuggle credentials in the URL is refused
// before a sandbox is even reserved.
for (const blocked of [
  'http://localhost/admin', 'http://127.0.0.1:3000/', 'http://10.0.0.5/', 'http://192.168.1.1/',
  'http://169.254.169.254/latest/meta-data/', 'http://172.16.0.9/', 'http://0.0.0.0/',
  'http://[::1]/', 'https://user:pass@example.com/', 'file:///etc/passwd', 'not-a-url'
]) {
  const result = await browserReadPage(blocked, env);
  eq(result.ok, false, `reading ${blocked} is refused`);
}

// The same guard, on the acting side, which is stricter still: https only.
for (const [url, why] of [
  ['http://example.com/', 'plain http is refused for actions'],
  ['https://localhost/', 'the host itself is refused'],
  ['https://169.254.169.254/', 'the metadata endpoint is refused'],
  ['https://user:pass@example.com/', 'credentials in the URL are refused'],
  ['https://nodots/', 'a hostname that cannot be public is refused']
]) {
  const result = await browserAction({ url, steps: [{ action: 'screenshot' }], sessionKey: 'k' }, env, undefined, {});
  eq(result.ok, false, why);
}

// Step lists are validated before anything runs.
const session = { get: async () => { throw new Error('should not be reached'); } };
for (const [steps, why] of [
  [[{ action: 'evaluate', selector: 'body' }], 'an action outside the allowed set is refused'],
  [[{ action: 'click' }], 'an action that needs a selector without one is refused'],
  [Array.from({ length: 21 }, () => ({ action: 'screenshot' })), 'an over-long step list is refused'],
  ['not-an-array', 'a steps value that is not a list is refused']
]) {
  const result = await browserAction({ url: 'https://example.com/', steps, sessionKey: 'k' }, env, undefined, session);
  eq(result.ok, false, why);
}
eq((await browserAction({ url: 'https://example.com/', steps: [{ action: 'screenshot' }] }, env, undefined, session)).error,
  'job_sandbox_required', 'an action without a session key is refused');

// The defect this file exists for. Persisting the cookie jar is an optimisation for the next
// run. It used to sit between the successful workflow and the journal confirmation, so a
// failure reading that one file discarded the result and recorded as 'uncertain' an action
// that had already happened on someone else's site -- and left the intent open, so every
// later action against that host refused with browser_action_requires_reconciliation until a
// human intervened. A cache miss must not rewrite what we know about an external effect.
{
  const journalRoot = path.join(storage, 'autonomos');
  fs.mkdirSync(journalRoot, { recursive: true });
  const journal = new ActionJournal(journalRoot);

  const intent = journal.begin('browser:example.com', 'k', 'action-1');
  ok(intent.ok, 'an intent can be opened');
  // browser-actions stores both: the url satisfies the journal's proof requirement, and the
  // result is what a replay hands back instead of performing the action a second time.
  journal.finish(intent.id, 'confirmed', { url: 'https://example.com/done', result: { ok: true, url: 'https://example.com/done' } });

  const replay = journal.begin('browser:example.com', 'k', 'action-1');
  eq(replay.ok, false, 'a confirmed action is not silently repeated');
  eq(replay.status, 'confirmed', 'and the journal reports it as confirmed, not uncertain');
  ok(replay.proof?.result?.url, 'and hands back the result a replay returns instead of acting again');

  // Left open instead, every later action against that host is refused until a human
  // reconciles it -- which is exactly what the cookie-jar read used to cause.
  const other = journal.begin('browser:example.com', 'k', 'action-2');
  journal.finish(other.id, 'uncertain', {});
  const blocked = journal.begin('browser:example.com', 'k', 'action-2');
  eq(blocked.ok, false, 'an action left uncertain blocks its own retry');
  eq(blocked.status, 'uncertain', 'and says so, so the cost of mislabelling one is visible');
}

// Source-level guarantee, because the ordering is the whole fix and it is easy to undo.
{
  const body = fs.readFileSync(new URL('../src/autonomos/browser-actions.js', import.meta.url), 'utf8');
  const confirmAt = body.indexOf("journal.finish(intent.id,'confirmed'");
  const readAt = body.indexOf("files.read('/home/user/browser-session.json')");
  ok(confirmAt > 0 && readAt > 0, 'both steps are present');
  ok(confirmAt < readAt, 'the action is confirmed before the optional cookie-jar read');
  ok(/catch\{\/\* next run starts without the cookie jar/.test(body), 'and that read cannot throw into the failure path');
}

fs.rmSync(storage, { recursive: true, force: true });
console.log(`browser-tools-test OK (${checks} checks, the two modules no test reached)`);
