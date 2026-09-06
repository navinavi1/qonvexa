import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MarketplaceHttp } from "../src/autonomos/marketplace-http.js";
import {
  TaskBountyConnector,
  normalizeTaskBounty,
} from "../src/autonomos/taskbounty-connector.js";
import {
  AgentHansaConnector,
  normalizeAgentHansa,
} from "../src/autonomos/agenthansa-connector.js";
import {
  MarketplaceManager,
  marketplaceSettings,
  evaluateNewMarketplaceJob,
  verifiedPayout,
} from "../src/autonomos/marketplace-manager.js";
import { AutonomOSStore } from "../src/autonomos/store.js";
import { createJobBudget } from "../src/autonomos/job-budget.js";
import { checkpointExecution } from "../src/autonomos/execution-checkpoint.js";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log("PASS " + name);
}
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers });
const wallet = "11111111111111111111111111111111";
const env = {
  TASKBOUNTY_API_KEY: "test-not-a-real-key",
  TASKBOUNTY_AGENT_ID: "agent",
  TASKBOUNTY_PAYOUT_ADDRESS: wallet,
  AGENTHANSA_API_KEY: "test-not-a-real-key",
};
const raw = {
  id: "task",
  title: "Fix addition bug",
  description: "Fix the calculation",
  status: "OPEN",
  funding_status: "FUNDED",
  bounty_cents: 5000,
  github_repo_url: "https://github.com/example/repo",
};
const job = normalizeTaskBounty(raw);
const settings = marketplaceSettings("taskbounty", env, {
  competitiveAllowed: true,
  walletConfirmed: true,
  mode: "canary",
});
const config = {
  zeroSpendMode: false,
  earnedFundsOnly: false,
  allowExternalSpending: true,
};
await test("TaskBounty uses cents and actual solver share", () => {
  assert.equal(job.budgetUsd, 50);
  assert.equal(job.netPayoutUsd, 40);
  assert.equal(job.kind, "competitive");
});
await test("TaskBounty refuses malformed success schema", () =>
  assert.throws(
    () => normalizeTaskBounty({ id: "x", title: "x" }),
    /schema_drift/,
  ));
await test("AgentHansa never treats a shared pool as individual earnings", () => {
  const x = normalizeAgentHansa({
    id: "q",
    title: "Quest",
    type: "quest",
    reward_amount: 5000,
    status: "open",
  });
  assert.equal(x.budgetUsd, 0);
  assert.equal(x.rewardUncertain, true);
});
await test("Affiliate commission cannot enter paid queue", () => {
  const x = normalizeAgentHansa({
    id: "a",
    title: "Offer",
    type: "offer",
    reward_per_agent: 50,
    status: "open",
  });
  assert(
    evaluateNewMarketplaceJob(x, {
      settings,
      config,
      capability: { executable: true },
    }).reasons.includes("affiliate_not_a_fixed_paid_job"),
  );
});
await test("Competitive work requires explicit owner setting", () =>
  assert(
    evaluateNewMarketplaceJob(job, {
      settings: { ...settings, competitiveAllowed: false },
      config,
      capability: { executable: true },
    }).reasons.includes("competitive_disabled"),
  ));
await test("$5 filter uses individual net payout", () =>
  assert(
    evaluateNewMarketplaceJob(
      { ...job, netPayoutUsd: 4.99 },
      { settings, config, capability: { executable: true } },
    ).reasons.includes("payout_below_5"),
  ));
await test("Configured job with supported skills can qualify", () =>
  assert.equal(
    evaluateNewMarketplaceJob(job, {
      settings,
      config,
      capability: { executable: true },
    }).eligible,
    true,
  ));
await test("Zero spend gate precedes execution", () =>
  assert(
    evaluateNewMarketplaceJob(job, {
      settings,
      config: { ...config, zeroSpendMode: true },
      capability: { executable: true },
    }).reasons.includes("zero_spend_mode"),
  ));
await test("Solana and EVM address validation are separate", () =>
  assert(
    evaluateNewMarketplaceJob(job, {
      settings: { ...settings, walletAddress: "0x" + "a".repeat(40) },
      config,
      capability: { executable: true },
    }).reasons.includes("invalid_solana_wallet"),
  ));
await test("Prediction balance is not an owner payout route", () => {
  const s = {
    ...settings,
    network: "base",
    walletAddress: "0x" + "a".repeat(40),
  };
  const x = { ...job, source: "agenthansa", kind: "task" };
  assert(
    evaluateNewMarketplaceJob(x, {
      settings: s,
      profile: {
        ok: true,
        authenticated: true,
        walletAddress: s.walletAddress,
        destination: "prediction_balance",
      },
      config,
      capability: { executable: true },
    }).reasons.includes("payout_routes_to_prediction_balance"),
  );
});
await test("Transport retries reads but never uncertain writes", async () => {
  let n = 0;
  const h = new MarketplaceHttp({
    origin: "https://example.com",
    apiKey: "x",
    fetchImpl: async () => {
      n++;
      throw new Error("lost");
    },
  });
  await h.request("/read");
  assert.equal(n, 2);
  h.state.failures = 0;
  const r = await h.request("/write", { method: "POST" });
  assert.equal(n, 3);
  assert.equal(r.uncertain, true);
});
await test("Retry-After creates persistent cooldown without repeated requests", async () => {
  let n = 0;
  const h = new MarketplaceHttp({
    origin: "https://example.com",
    apiKey: "x",
    fetchImpl: async () => {
      n++;
      return json({}, 429, { "retry-after": "90" });
    },
    now: () => 1000,
  });
  const r = await h.request("/read");
  assert.equal(r.retryAt, 91000);
  await h.request("/read");
  assert.equal(n, 1);
});
await test("Circuit recovers after cooldown", async () => {
  let now = 0;
  const state = { until: 100, reason: "network_error" };
  const h = new MarketplaceHttp({
    origin: "https://example.com",
    apiKey: "x",
    state,
    now: () => now,
    fetchImpl: async () => json({ ok: true }),
  });
  assert.equal((await h.request("/x")).ok, false);
  now = 101;
  assert.equal((await h.request("/x")).ok, true);
});
await test("Public feed does not leak API key and supports actual data envelope", async () => {
  const c = new TaskBountyConnector({
    env,
    fetchImpl: async (url, opts) => {
      assert.equal(opts.headers.authorization, undefined);
      return json({ data: [raw] });
    },
  });
  assert.equal((await c.discover()).rows.length, 1);
});
await test("TaskBounty access includes required agent_id", async () => {
  const c = new TaskBountyConnector({
    env,
    fetchImpl: async (url, opts) => {
      assert.equal(JSON.parse(opts.body).agent_id, "agent");
      assert(url.endsWith("/tasks/task/access"));
      return json({ data: { cloneUrl: "https://github.com/example/repo" } });
    },
  });
  assert.equal((await c.access(job)).ok, true);
});
await test("TaskBounty rejects fabricated verification evidence", async () => {
  let n = 0;
  const c = new TaskBountyConnector({
    env,
    fetchImpl: async () => {
      n++;
      return json({});
    },
  });
  assert.equal((await c.submit(job, { content: "done" })).ok, false);
  assert.equal(n, 0);
});
await test("TaskBounty patch delivery preserves required fields", async () => {
  const c = new TaskBountyConnector({
    env,
    fetchImpl: async (url, opts) => {
      assert(url.endsWith("/submissions/patch"));
      const b = JSON.parse(opts.body);
      assert.equal(b.agent_id, "agent");
      assert.equal(b.task_id, "task");
      assert.equal(b.patch, "diff");
      return json({ data: { id: "submission" } });
    },
  });
  const r = await c.submit(job, {
    content: "Fixed",
    evidence: {
      repositoryVerification: {
        ok: true,
        regressionFailsOnBase: true,
        testsPassOnFix: true,
        patch: "diff",
        testOutput: "pass",
      },
    },
  });
  assert.equal(r.id, "submission");
});
await test("A win is not a payment", () =>
  assert.equal(
    verifiedPayout({ status: "winner", amount: 40 }, settings),
    null,
  ));
await test("Payout recipient and network must match", () =>
  assert.equal(
    verifiedPayout(
      {
        status: "paid",
        amount: 40,
        currency: "USDC",
        network: "base",
        recipient: wallet,
        tx_hash: "a".repeat(64),
      },
      settings,
    ),
    null,
  ));
await test("Explicit provider transfer evidence qualifies", () =>
  assert.equal(
    verifiedPayout(
      {
        status: "confirmed",
        amount: 40,
        currency: "USDC",
        network: "solana",
        recipient: wallet,
        signature: "2".repeat(88),
      },
      settings,
    ).amountUsd,
    40,
  ));
await test("Budget is reserved before provider and across tools", async () => {
  let calls = 0;
  const b = createJobBudget(0.001, {
    env: {
      AUTONOMOS_LLM_INPUT_USD_PER_MILLION: 1,
      AUTONOMOS_LLM_OUTPUT_USD_PER_MILLION: 1,
    },
  });
  b.charge(0.0008);
  await assert.rejects(
    () =>
      b
        .llm({
          complete: async () => {
            calls++;
          },
        })
        .complete({ user: "x", maxTokens: 500 }),
    /spend_limit/,
  );
  assert.equal(calls, 0);
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "new-markets-"));
try {
  await test("Uncertain delivery checkpoint can reconcile without replay", async () => {
    const store = new AutonomOSStore(path.join(tmp, "checkpoint"));
    let writes = 0;
    const c = checkpointExecution(store, "job");
    await assert.rejects(
      c("submit", async () => {
        writes++;
        throw new Error("lost");
      }),
    );
    const result = await c(
      "submit",
      async () => {
        writes++;
      },
      { reconcile: async () => ({ ok: true, id: "remote" }) },
    );
    assert.equal(result.id, "remote");
    assert.equal(writes, 1);
  });
  await test("Manager canary, restart and paid reconciliation do not duplicate submit", async () => {
    const store = new AutonomOSStore(path.join(tmp, "manager"));
    let submissions = 0,
      executions = 0,
      revenue = 0;
    let status = "submitted";
    const connector = {
      profile: async () => ({ ok: false }),
      discover: async () => ({ ok: true, rows: [job], complete: true }),
      inspect: async () => ({ ok: true, job }),
      claim: async () => ({ ok: true, localIntent: true }),
      submit: async () => {
        submissions++;
        return { ok: true, id: "s" };
      },
      status: async () => ({
        ok: true,
        status,
        payoutStatus: "pending",
        payout:
          status === "paid"
            ? {
                status: "confirmed",
                amount: 40,
                currency: "USDC",
                network: "solana",
                recipient: wallet,
                signature: "2".repeat(88),
              }
            : null,
      }),
    };
    const opts = {
      store,
      env,
      getConfig: () => config,
      classify: () => ({ executable: true }),
      execute: async () => {
        executions++;
        return { content: "done", evidence: { qa: { ok: true } } };
      },
      connectors: { taskbounty: connector, agenthansa: connector },
      onRevenue: () => {
        revenue++;
      },
    };
    let m = new MarketplaceManager(opts);
    m.update("taskbounty", {
      mode: "canary",
      walletConfirmed: true,
      competitiveAllowed: true,
    });
    assert.throws(() => m.update("taskbounty", { mode: "live" }), /canary/);
    assert.equal((await m.runCanary("taskbounty")).ok, true);
    assert.equal(submissions, 1);
    m = new MarketplaceManager(opts);
    await m.reconcile("taskbounty");
    assert.equal(executions, 1);
    assert.equal(submissions, 1);
    assert.equal(m.snapshot().markets[1].lifecycle.productionVerified, false);
    status = "paid";
    await m.reconcile("taskbounty");
    await m.reconcile("taskbounty");
    assert.equal(revenue, 1);
    m.update("taskbounty", { mode: "live" });
    assert.equal(m.snapshot().markets[1].lifecycle.fullAutoReady, true);
    const key = env.TASKBOUNTY_API_KEY;
    delete env.TASKBOUNTY_API_KEY;
    assert.equal(m.snapshot().markets[1].lifecycle.fullAutoReady, false);
    env.TASKBOUNTY_API_KEY = key;
    assert.equal(m.snapshot().markets[1].lifecycle.productionVerified, true);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`New marketplaces: ${passed}/${passed} PASS`);
