import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyMarketplaceWebhook } from "../src/autonomos/marketplace-webhook.js";
import {
  MarketplaceManager,
  marketplaceSettings,
} from "../src/autonomos/marketplace-manager.js";
import { AutonomOSStore } from "../src/autonomos/store.js";
import {
  TaskBountyConnector,
  normalizeTaskBounty,
} from "../src/autonomos/taskbounty-connector.js";
import { appendUniqueLedgerEntry } from "../src/autonomos/financial-ledger.js";
import { executeExternalOpportunity } from "../src/autonomos/job-executor.js";
import { freeWebSearch } from "../src/autonomos/free-web-tool.js";

const raw = Buffer.from('{"task_id":"one"}');
const secret = "local-test-webhook-secret-32-characters";
const sig =
  "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
assert(verifyMarketplaceWebhook(raw, sig, secret).ok);
assert.equal(
  verifyMarketplaceWebhook(Buffer.from('{"task_id":"two"}'), sig, secret)
    .status,
  401,
);
assert.equal(verifyMarketplaceWebhook(raw, sig, "").status, 503);
console.log(
  "PASS webhook authenticity uses raw bytes and fails closed without a secret",
);

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response('<a class="result__a" href="https://example.org">Research</a>', {status:200,headers:{'content-type':'text/html'}});
  const r = await freeWebSearch('query', { AUTONOMOS_FREE_SEARCH_MIN_GAP_MS:'0' });
  assert(r.ok);
  assert.equal(r.provider,'free_public_web');
  assert.equal(r.results[0].url,'https://example.org/');
  globalThis.fetch = async () => new Response('rate limited',{status:429});
  assert.equal((await freeWebSearch('query-2',{AUTONOMOS_FREE_SEARCH_MIN_GAP_MS:'0'})).ok,false);
} finally {
  globalThis.fetch = originalFetch;
}
console.log('PASS free public web search envelope and HTTP failure handling');

const env = {
  TASKBOUNTY_API_KEY: "fixture",
  TASKBOUNTY_AGENT_ID: "agent",
  TASKBOUNTY_PAYOUT_ADDRESS: "11111111111111111111111111111111",
  AUTONOMOS_MARKETPLACE_MAX_CONCURRENT_JOBS: "2",
};
const job = normalizeTaskBounty({
  id: "one",
  title: "Fix a calculation",
  status: "OPEN",
  bounty_cents: 5000,
  funding_status: "FUNDED",
  github_repo_url: "https://github.com/example/repo",
});
const c = new TaskBountyConnector({
  env,
  fetchImpl: async () => new Response(JSON.stringify({ data: job.raw })),
});
assert.equal(
  (await c.claim(job)).reason,
  "taskbounty_authenticated_readiness_required",
);
console.log(
  "PASS public task detail cannot masquerade as authenticated readiness",
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-hardening-"));
try {
  const ledgerStore = new AutonomOSStore(path.join(dir, "ledger"));
  assert(
    appendUniqueLedgerEntry(ledgerStore, {
      id: "receipt-ledger",
      type: "revenue",
      amountUsd: 10,
    }),
  );
  assert.equal(
    appendUniqueLedgerEntry(new AutonomOSStore(path.join(dir, "ledger")), {
      id: "receipt-ledger",
      type: "revenue",
      amountUsd: 10,
    }),
    false,
  );
  assert.equal(ledgerStore.readNdjson("ledger.ndjson", -1).length, 1);
  console.log(
    "PASS crash replay checks the full ledger and cannot count a payout twice",
  );
  let submitted = 0;
  let release;
  let entered;
  const started = new Promise((resolve) => (entered = resolve));
  const barrier = new Promise((resolve) => (release = resolve));
  const connector = {
    profile: async () => ({ ok: false }),
    discover: async () => ({
      ok: true,
      rows: [job, { ...job, externalId: "two" }],
      complete: true,
    }),
    inspect: async (j) => ({ ok: true, job: j }),
    claim: async () => ({ ok: true }),
    submit: async () => {
      submitted++;
      return { ok: true, id: "receipt" };
    },
    status: async () => ({ ok: true, status: "submitted" }),
  };
  let config = {
    zeroSpendMode: false,
    earnedFundsOnly: true,
    availableSpendUsd: 3,
    allowExternalSpending: false,
  };
  const m = new MarketplaceManager({
    store: new AutonomOSStore(dir),
    env,
    getConfig: () => config,
    classify: () => ({ executable: true }),
    connectors: { taskbounty: connector, agenthansa: connector },
    execute: async () => {
      entered();
      await barrier;
      return { content: "verified" };
    },
  });
  m.update("taskbounty", {
    mode: "canary",
    competitiveAllowed: true,
    walletConfirmed: true,
    concurrency: 2,
  });
  await m.probe("taskbounty");
  const rows = Object.values(m.data.jobs);
  const first = m.run(rows[0], true);
  await started;
  const second = await m.run(rows[1], true);
  assert.equal(second.reason, "execution_spending_blocked");
  release();
  await first;
  assert.equal(submitted, 1);
  console.log(
    "PASS parallel workers cannot reserve the same earned execution funds",
  );

  config = { ...config, zeroSpendMode: true };
  rows[1].status = "claimed";
  assert.equal((await m.run(rows[1])).reason, "execution_spending_blocked");
  console.log("PASS resumed jobs respect zero-spend controls");

  const event = verifyMarketplaceWebhook(raw, sig, secret).eventId;
  assert(m.webhookHint("taskbounty", event).queued);
  assert(m.webhookHint("taskbounty", event).duplicate);
  assert.equal(m.data.health.taskbounty.at, null);
  console.log("PASS duplicate webhook only wakes canonical polling once");

  let callbackCount = 0;
  let unblock;
  const blocked = new Promise((resolve) => (unblock = resolve));
  m.onRevenue = async () => {
    callbackCount++;
    await blocked;
  };
  m.data.outbox.push({ type: "revenue", record: { id: "one" } });
  const flushA = m.flushOutbox();
  const flushB = m.flushOutbox();
  unblock();
  await Promise.all([flushA, flushB]);
  assert.equal(callbackCount, 1);
  assert.equal(m.data.outbox.length, 0);
  console.log(
    "PASS overlapping ledger flushes do not duplicate or skip outbox records",
  );

  rows[1].status = "uncertain";
  rows[1].uncertainStage = "claim";
  await m.reconcile("taskbounty");
  assert.equal(rows[1].status, "claimed");
  assert.equal(submitted, 1);
  console.log(
    "PASS lost claim acknowledgement recovers without another submit",
  );

  rows[1].status = "uncertain";
  rows[1].uncertainStage = "submit";
  connector.status = async (_job, receipt) =>
    receipt.id === "verified-id"
      ? { ok: true, status: "submitted" }
      : { ok: false, reason: "submission_identity_mismatch" };
  assert.equal(
    (await m.recoverReceipt("taskbounty", rows[1].id, "wrong")).ok,
    false,
  );
  assert.equal(
    (await m.recoverReceipt("taskbounty", rows[1].id, "verified-id")).ok,
    true,
  );
  assert.equal(submitted, 1);
  console.log(
    "PASS manual receipt recovery requires provider identity verification and never reposts",
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

let rounds = 0;
const calls = Array.from({ length: 6 }, (_, i) => ({
  id: "call-" + i,
  type: "function",
  function: { name: "forbidden", arguments: "{}" },
}));
await executeExternalOpportunity(
  { title: "Write concise prose" },
  { mode: "llm", skill: "copywriting" },
  {
    env: {},
    toolFilter: [],
    llm: {
      enabled: true,
      complete: async ({ messages }) => {
        if (++rounds === 1)
          return {
            ok: true,
            toolCalls: calls,
            message: { role: "assistant", tool_calls: calls },
          };
        assert.equal(messages.filter((m) => m.role === "tool").length, 6);
        return { ok: true, text: "A complete paragraph." };
      },
    },
  },
);
console.log(
  "PASS every model tool call receives a response even above the execution batch limit",
);

const confirmed = marketplaceSettings("taskbounty", env, {
  walletConfirmed: true,
});
assert(confirmed.walletConfirmed);
assert.equal(
  marketplaceSettings(
    "taskbounty",
    { ...env, TASKBOUNTY_PAYOUT_ADDRESS: "2".repeat(32) },
    confirmed,
  ).walletConfirmed,
  false,
);
console.log(
  "PASS changing payout address invalidates the previous wallet confirmation",
);
