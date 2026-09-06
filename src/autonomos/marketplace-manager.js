import crypto from "node:crypto";
import { TaskBountyConnector } from "./taskbounty-connector.js";
import { AgentHansaConnector } from "./agenthansa-connector.js";
import { isDemoOrTestOpportunity } from "./policy-engine.js";
import { solanaAddress } from "./marketplace-http.js";

const SOURCES = ["agenthansa", "taskbounty"];
const TERMINAL = new Set(["paid", "rejected", "closed"]);
const ACTIVE = new Set([
  "claiming",
  "claimed",
  "executing",
  "qa",
  "delivery_ready",
  "submitting",
  "uncertain",
]);
const hash = (x) =>
  crypto.createHash("sha256").update(String(x)).digest("hex").slice(0, 24);
const number = (v, f, min, max) =>
  Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : f;
const stamp = () => new Date().toISOString();

export function marketplaceSettings(source, env = {}, saved = {}) {
  const prefix = source.toUpperCase();
  const address = String(
    source === "taskbounty"
      ? env.TASKBOUNTY_PAYOUT_ADDRESS || ""
      : env.AGENTHANSA_PAYOUT_ADDRESS || "",
  );
  const network =
    source === "taskbounty"
      ? "solana"
      : String(env.AGENTHANSA_PAYOUT_NETWORK || "");
  return {
    enabled:
      env[`${prefix}_ENABLED`] === "false" ? false : saved.enabled !== false,
    mode: ["read_only", "canary", "live"].includes(saved.mode)
      ? saved.mode
      : "read_only",
    minPayoutUsd: number(
      saved.minPayoutUsd ?? env[`${prefix}_MIN_PAYOUT_USD`],
      5,
      5,
      100000,
    ),
    maxSpendUsd: number(
      saved.maxSpendUsd ?? env[`${prefix}_MAX_SPEND_USD`],
      2,
      0,
      100,
    ),
    maxSpendPercent: number(saved.maxSpendPercent, 25, 1, 50),
    concurrency: number(
      saved.concurrency,
      1,
      1,
      source === "taskbounty" ? 2 : 4,
    ),
    competitiveAllowed: saved.competitiveAllowed === true,
    affiliateAllowed: false,
    pollSeconds: number(saved.pollSeconds, 120, 60, 3600),
    dynamicFloor: saved.dynamicFloor === true,
    walletConfirmed:
      saved.walletConfirmed === true &&
      (!saved.walletAddress || saved.walletAddress === address) &&
      (!saved.network || saved.network === network),
    network:
      source === "taskbounty"
        ? "solana"
        : String(env.AGENTHANSA_PAYOUT_NETWORK || ""),
    walletAddress: String(
      source === "taskbounty"
        ? env.TASKBOUNTY_PAYOUT_ADDRESS || ""
        : env.AGENTHANSA_PAYOUT_ADDRESS || "",
    ),
    productionVerified: false,
  };
}

export function evaluateNewMarketplaceJob(
  job,
  { settings, profile = {}, capability = {}, metrics = {}, config = {} } = {},
) {
  const reasons = [];
  if (!settings.enabled) reasons.push("marketplace_disabled");
  if (config.rejectDemoAndTestJobs !== false && isDemoOrTestOpportunity(job))
    reasons.push("demo_or_test_opportunity");
  if (job.kind === "affiliate") reasons.push("affiliate_not_a_fixed_paid_job");
  if (job.kind === "unsupported") reasons.push("unsupported_lifecycle");
  if (!["open", "available", "in_progress", "active"].includes(job.status))
    reasons.push("job_not_open");
  if (job.deadline && Date.parse(job.deadline) < Date.now())
    reasons.push("deadline_expired");
  if (job.rewardUncertain)
    reasons.push("individual_payout_unknown_shared_pool");
  const paid = Number(metrics.paid || 0);
  const floor = settings.dynamicFloor
    ? Math.max(settings.minPayoutUsd, paid >= 10 ? 20 : paid >= 3 ? 10 : 5)
    : settings.minPayoutUsd;
  if (!(job.netPayoutUsd >= floor)) reasons.push("payout_below_" + floor);
  if (
    ["competitive", "quest", "task"].includes(job.kind) &&
    !settings.competitiveAllowed
  )
    reasons.push("competitive_disabled");
  if (!capability.executable)
    reasons.push(
      "skill_mismatch:" +
        String(
          (capability.missingTools || []).join(",") ||
            capability.mode ||
            "unavailable",
        ),
    );
  if (!settings.walletAddress) reasons.push("payout_wallet_missing");
  if (settings.network === "solana" && !solanaAddress(settings.walletAddress))
    reasons.push("invalid_solana_wallet");
  if (
    settings.network === "base" &&
    !/^0x[a-fA-F0-9]{40}$/.test(settings.walletAddress)
  )
    reasons.push("invalid_base_wallet");
  if (!["solana", "base"].includes(settings.network))
    reasons.push("payout_network_unverified");
  if (job.source === "agenthansa") {
    if (!profile.ok || !profile.authenticated || profile.active === false)
      reasons.push("credentials_unverified");
    if (!["fluxa", "wallet", "external_wallet"].includes(profile.destination))
      reasons.push("payout_destination_unverified");
    if (profile.destination === "prediction_balance")
      reasons.push("payout_routes_to_prediction_balance");
    if (
      !profile.walletAddress ||
      profile.walletAddress !== settings.walletAddress
    )
      reasons.push("registered_wallet_mismatch");
  }
  if (!settings.walletConfirmed)
    reasons.push("owner_payout_route_confirmation_required");
  const probability = number(
    metrics.attempts >= 5
      ? (Number(metrics.won || 0) + 1) / (Number(metrics.attempts) + 2)
      : 0.2,
    0.2,
    0.05,
    0.9,
  );
  const expectedCost = Math.max(
    job.source === "taskbounty" ? 0.6 : 0.05,
    Number(capability.estimatedModelCostUsd || 0),
  );
  const expectedNetUsd = job.netPayoutUsd * probability - expectedCost;
  const spendCeilingUsd = Math.min(
    settings.maxSpendUsd,
    (job.netPayoutUsd * settings.maxSpendPercent) / 100,
  );
  if (expectedNetUsd <= 0) reasons.push("estimated_loss");
  if (expectedCost > spendCeilingUsd)
    reasons.push("execution_budget_too_small");
  if (config.killSwitch) reasons.push("emergency_stop");
  if (config.zeroSpendMode) reasons.push("zero_spend_mode");
  if (
    config.earnedFundsOnly &&
    Number(config.availableSpendUsd || 0) < spendCeilingUsd
  )
    reasons.push("insufficient_execution_budget");
  if (!config.earnedFundsOnly && !config.allowExternalSpending)
    reasons.push("external_spending_disabled");
  const estimatedSeconds = Math.max(
    60,
    Number(
      capability.estimatedDurationSeconds ||
        (job.source === "taskbounty"
          ? 900
          : capability.skill === "browser-ops"
            ? 480
            : capability.skill === "document-generation"
              ? 600
              : 180),
    ),
  );
  return {
    estimatedSeconds,
    expectedNetPerHourUsd: (expectedNetUsd * 3600) / estimatedSeconds,
    scoreBasis: "estimated_profit_per_hour_with_observed_source_win_rate",
    eligible: reasons.length === 0,
    reasons,
    floorUsd: floor,
    expectedCostUsd: expectedCost,
    probability,
    expectedNetUsd,
    spendCeilingUsd,
    lane:
      job.source === "taskbounty"
        ? "coding"
        : capability.skill === "browser-ops"
          ? "browser"
          : capability.skill === "document-generation"
            ? "document"
            : "fast",
    guaranteed: false,
  };
}

// Provider receipts, not wins or ledger balances, establish that a payout reached the
// configured recipient. Unknown provider schemas remain pending instead of fabricating revenue.
export function verifiedPayout(payout, settings) {
  if (
    !payout ||
    !["paid", "confirmed", "completed"].includes(
      String(payout.status).toLowerCase(),
    )
  )
    return null;
  const address = String(
    payout.to_address || payout.wallet_address || payout.recipient || "",
  );
  const tx = String(
    payout.tx_hash || payout.transaction_hash || payout.signature || "",
  );
  const network = String(payout.network || payout.chain || "").toLowerCase();
  const currency = String(payout.currency || payout.token || "").toUpperCase();
  const amount = Number(payout.amount_usd ?? payout.amount);
  if (
    !tx ||
    address !== settings.walletAddress ||
    network !== settings.network ||
    currency !== "USDC" ||
    !(amount > 0)
  )
    return null;
  if (network === "base" && !/^0x[a-fA-F0-9]{64}$/.test(tx)) return null;
  if (network === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(tx))
    return null;
  return {
    transactionId: tx,
    address,
    network,
    currency,
    amountUsd: amount,
    evidence: "authenticated_provider_transfer",
  };
}

export class MarketplaceManager {
  constructor({
    store,
    env = process.env,
    getConfig = () => ({}),
    classify = () => ({}),
    execute,
    onEvent = () => {},
    onRevenue = () => {},
    onCost = () => {},
    connectors,
  } = {}) {
    this.store = store;
    this.env = env;
    this.getConfig = getConfig;
    this.classify = classify;
    this.execute = execute;
    this.onEvent = onEvent;
    this.onRevenue = onRevenue;
    this.onCost = onCost;
    this.busy = new Set();
    this.running = new Map();
    this.reserved = new Map();
    this.data = store.readJsonStrict("marketplace-manager.json", {
      version: 1,
      settings: {},
      jobs: {},
      health: {},
      circuits: {},
      metrics: {},
      canaries: {},
    });
    this.data.outbox ||= [];
    this.data.webhookIds ||= [];
    this.connectors =
      connectors ||
      Object.fromEntries(
        SOURCES.map((id) => {
          this.data.circuits[id] ||= {};
          const C =
            id === "taskbounty" ? TaskBountyConnector : AgentHansaConnector;
          return [
            id,
            new C({
              env,
              state: this.data.circuits[id],
              persist: () => this.save(),
            }),
          ];
        }),
      );
    for (const row of Object.values(this.data.jobs)) {
      if (row.status === "executing" || row.status === "qa") {
        row.status = "claimed";
        row.reason = "restart_during_execution";
      }
    }
    this.save();
  }
  save() {
    this.store.writeJson("marketplace-manager.json", this.data);
  }
  settings(id) {
    this.requireSource(id);
    return marketplaceSettings(id, this.env, this.data.settings[id]);
  }
  requireSource(id) {
    if (!SOURCES.includes(id)) throw new Error("unknown_marketplace");
  }
  metrics(id) {
    return (
      this.data.metrics[id] || {
        attempts: 0,
        won: 0,
        paid: 0,
        revenueUsd: 0,
        costUsd: 0,
      }
    );
  }
  log(id, type, detail = {}) {
    const e = { at: stamp(), source: id, type, ...detail };
    this.store.append("marketplace-events.ndjson", e);
    this.onEvent("marketplace_" + type, e);
  }
  set(row, status, detail = {}) {
    row.status = status;
    row.updatedAt = stamp();
    Object.assign(row, detail);
    this.save();
    this.log(row.job.source, status, {
      jobId: row.id,
      externalId: row.job.externalId,
      reason: row.reason || "",
    });
  }
  update(id, patch) {
    const current = this.settings(id);
    const allowed = [
      "enabled",
      "mode",
      "minPayoutUsd",
      "maxSpendUsd",
      "maxSpendPercent",
      "concurrency",
      "competitiveAllowed",
      "dynamicFloor",
      "walletConfirmed",
      "pollSeconds",
    ];
    const clean = Object.fromEntries(
      allowed.filter((k) => Object.hasOwn(patch, k)).map((k) => [k, patch[k]]),
    );
    for (const k of [
      "enabled",
      "competitiveAllowed",
      "dynamicFloor",
      "walletConfirmed",
    ])
      if (k in clean && typeof clean[k] !== "boolean")
        throw new Error("invalid_boolean:" + k);
    if (clean.mode === "live" && !this.data.canaries[id]?.accepted)
      throw new Error("canary_acceptance_required_before_live_mode");
    const settings = marketplaceSettings(id, this.env, {
      ...current,
      ...clean,
    });
    this.data.settings[id] = settings;
    if (!settings.enabled || settings.mode === "read_only")
      for (const [jobId, controller] of this.running)
        if (
          Object.values(this.data.jobs).some(
            (r) => r.id === jobId && r.job.source === id,
          )
        )
          controller.abort();
    this.save();
    this.log(id, "settings_updated", {
      mode: settings.mode,
      enabled: settings.enabled,
    });
    return settings;
  }
  snapshot() {
    return {
      markets: SOURCES.map((id) => {
        const settings = this.settings(id);
        const metrics = this.metrics(id);
        const rows = Object.values(this.data.jobs).filter(
          (x) => x.job.source === id,
        );
        const payoutVerified = rows.some(
          (r) =>
            r.payout &&
            r.payout.address === settings.walletAddress &&
            r.payout.network === settings.network,
        );
        const configured = Boolean(
          this.env[id.toUpperCase() + "_API_KEY"] &&
            (id !== "taskbounty" || this.env.TASKBOUNTY_AGENT_ID),
        );
        const workAutoReady = Boolean(
          settings.enabled &&
            settings.mode === "live" &&
            settings.walletConfirmed &&
            this.data.canaries[id]?.accepted &&
            configured &&
            this.data.health[id]?.ok &&
            (this.data.circuits[id]?.until || 0) < Date.now() &&
            rows.some((r) => this.classify(r.job).executable),
        );
        return {
          id,
          settings,
          health: this.data.health[id] || {},
          metrics: {
            ...metrics,
            discovered: rows.length,
            eligible: rows.filter((r) => r.status === "eligible").length,
            submitted: rows.filter((r) =>
              ["submitted", "won", "paid"].includes(r.status),
            ).length,
            netProfitUsd: metrics.revenueUsd - metrics.costUsd,
            roi:
              metrics.costUsd > 0
                ? (metrics.revenueUsd - metrics.costUsd) / metrics.costUsd
                : null,
          },
          canary: this.data.canaries[id] || null,
          lifecycle: {
            discover: true,
            claim: id === "agenthansa",
            localIntent: id === "taskbounty",
            execute: true,
            deliver: true,
            settle: "provider_polling",
            competitive: true,
            workAutoReady,
            fullAutoReady: workAutoReady && payoutVerified,
            productionVerified: payoutVerified,
          },
          outcomes: rows
            .filter((r) => ["won", "paid", "rejected"].includes(r.status))
            .map((r) => ({
              jobId: r.id,
              kind: r.job.kind,
              category: r.job.category,
              status: r.status,
              reason: r.reason || "",
              reservedCostUsd: Number(r.costUsd || 0),
              revenueUsd: Number(r.payout?.amountUsd || 0),
              executionElapsedMs: Number(r.executionElapsedMs || 0),
              buyerId: String(
                r.job.raw?.merchant_id || r.job.raw?.creator_id || "",
              ),
              at: r.updatedAt,
            }))
            .slice(-100),
          jobs: rows
            .map((r) => ({
              id: r.id,
              externalId: r.job.externalId,
              title: r.job.title,
              status: r.status,
              payoutStatus: r.payoutStatus || "pending",
              netPayoutUsd: r.job.netPayoutUsd,
              prizePoolUsd: r.job.prizePoolUsd || 0,
              kind: r.job.kind,
              qualification: r.qualification,
              reason: r.reason || "",
              updatedAt: r.updatedAt,
            }))
            .slice(-100),
        };
      }),
      events: this.store.readNdjson("marketplace-events.ndjson", 100).reverse(),
    };
  }
  async probe(id) {
    this.requireSource(id);
    if (this.busy.has("probe:" + id))
      return { ok: false, reason: "probe_running" };
    this.busy.add("probe:" + id);
    try {
      const c = this.connectors[id];
      let profile = await c.profile();
      const discovered = await c.discover();
      if (
        id === "taskbounty" &&
        this.env.TASKBOUNTY_API_KEY &&
        discovered.rows?.length
      ) {
        const detail = await c.inspect(discovered.rows[0]);
        profile = {
          ...profile,
          ok: Boolean(detail.ok && detail.authenticated),
          authenticated: Boolean(detail.ok && detail.authenticated),
          reason: detail.ok
            ? detail.authenticated
              ? ""
              : "authenticated_readiness_missing"
            : detail.reason,
        };
      }
      const health = {
        ...this.data.health[id],
        ok: discovered.ok,
        profile,
        reason: discovered.reason || "",
        count: discovered.rows?.length || 0,
        at: stamp(),
        authenticated: profile.authenticated || false,
        credentialsConfigured: Boolean(this.env[id.toUpperCase() + "_API_KEY"]),
      };
      const settings = this.settings(id);
      const metrics = this.metrics(id);
      if (discovered.ok) {
        for (const job of discovered.rows) {
          const key = id + ":" + job.externalId;
          let row = this.data.jobs[key];
          if (!row) this.log(id, "discovered", { externalId: job.externalId });
          if (
            row &&
            (ACTIVE.has(row.status) ||
              TERMINAL.has(row.status) ||
              ["submitted", "won"].includes(row.status))
          )
            continue;
          const qualification = evaluateNewMarketplaceJob(job, {
            settings,
            profile,
            capability: this.classify(job),
            metrics,
            config: this.getConfig(),
          });
          if (!this.env[id.toUpperCase() + "_API_KEY"]) {
            qualification.eligible = false;
            qualification.reasons.push("credentials_missing");
          }
          if (id === "taskbounty" && !this.env.TASKBOUNTY_AGENT_ID) {
            qualification.eligible = false;
            qualification.reasons.push("agent_id_missing");
          }
          row = {
            ...(row || {}),
            id: "mk_" + hash(key),
            job,
            qualification,
            status: qualification.eligible ? "eligible" : "filtered",
            updatedAt: stamp(),
            payoutStatus: "pending",
          };
          this.data.jobs[key] = row;
          this.log(id, qualification.eligible ? "eligible" : "filtered", {
            jobId: row.id,
            externalId: job.externalId,
            reasons: qualification.reasons,
          });
        }
        const observed = new Set(
          discovered.rows.map((j) => id + ":" + j.externalId),
        );
        if (discovered.complete)
          for (const [key, row] of Object.entries(this.data.jobs))
            if (
              row.job.source === id &&
              !observed.has(key) &&
              ["eligible", "filtered"].includes(row.status)
            ) {
              row.status = "stale";
              row.reason = "missing_from_complete_live_feed";
            }
      }
      this.data.health[id] = health;
      this.save();
      this.log(id, "probe", {
        ok: health.ok,
        count: health.count,
        reason: health.reason,
      });
      return health;
    } finally {
      this.busy.delete("probe:" + id);
    }
  }
  async flushOutbox() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.data.outbox.length) {
        const item = this.data.outbox[0];
        if (item.type === "revenue") await this.onRevenue(item.record);
        else await this.onCost(item.record);
        this.data.outbox.shift();
        this.save();
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }
  abortAll() {
    for (const controller of this.running.values()) controller.abort();
  }
  webhookHint(id, eventId) {
    this.requireSource(id);
    if (this.data.webhookIds.includes(eventId))
      return { ok: true, duplicate: true };
    this.data.webhookIds.push(eventId);
    this.data.webhookIds = this.data.webhookIds.slice(-1000);
    this.data.health[id] = { ...this.data.health[id], at: null };
    this.save();
    this.log(id, "webhook_received");
    return { ok: true, queued: true }; // Poll the canonical API; webhook fields never create jobs or revenue.
  }
  canaryCheck(id) {
    this.requireSource(id);
    const s = this.settings(id);
    if (!s.enabled) return { ok: false, reason: "marketplace_disabled" };
    if (s.mode !== "canary")
      return { ok: false, reason: "select_canary_mode_first" };
    if (this.getConfig().killSwitch)
      return { ok: false, reason: "emergency_stop" };
    if (this.busy.has("canary:" + id))
      return { ok: false, reason: "canary_start_in_progress" };
    if (
      this.data.canaries[id] &&
      !["rejected", "failed"].includes(this.data.canaries[id].status)
    )
      return { ok: false, reason: "canary_already_running_or_completed" };
    return { ok: true };
  }
  async recoverReceipt(id, jobId, receiptId) {
    this.requireSource(id);
    const row = Object.values(this.data.jobs).find(
      (r) => r.id === jobId && r.job.source === id,
    );
    if (
      !row ||
      !["uncertain", "submitting", "submitted"].includes(row.status) ||
      !receiptId ||
      String(receiptId).length > 160
    )
      return { ok: false, reason: "receipt_recovery_not_applicable" };
    if (this.running.has(row.id))
      return { ok: false, reason: "job_still_running" };
    const receipt = { id: String(receiptId) };
    const result = await this.connectors[id].status(row.job, receipt);
    if (!result.ok) return result; // Connector verifies task AND authenticated agent identity.
    this.set(row, "submitted", {
      receipt,
      reason: "receipt_recovered_from_provider",
    });
    await this.reconcile(id);
    return { ok: true };
  }
  executionConfig() {
    const config = this.getConfig();
    return {
      ...config,
      availableSpendUsd: Math.max(
        0,
        Number(config.availableSpendUsd || 0) -
          [...this.reserved.values()].reduce((a, b) => a + b, 0),
      ),
    };
  }
  launch(row) {
    void this.run(row, Boolean(row.canary)).catch((error) =>
      this.log(row.job.source, "worker_error", {
        jobId: row.id,
        reason: String(error.message).slice(0, 200),
      }),
    );
  }

  async runCanary(id) {
    const check = this.canaryCheck(id);
    if (!check.ok) return check;
    this.busy.add("canary:" + id);
    try {
      const s = this.settings(id);
      if (!s.enabled) return { ok: false, reason: "marketplace_disabled" };
      if (s.mode !== "canary")
        return { ok: false, reason: "select_canary_mode_first" };
      if (
        this.data.canaries[id] &&
        !["rejected", "failed"].includes(this.data.canaries[id].status)
      )
        return { ok: false, reason: "canary_already_running_or_completed" };
      await this.probe(id);
      const row = this.pick(id, true);
      if (!row) {
        this.data.canaries[id] = {
          status: "failed",
          reason: "no_eligible_job",
          at: stamp(),
        };
        this.save();
        return { ok: false, reason: "no_eligible_job" };
      }
      this.data.canaries[id] = {
        jobId: row.id,
        status: "queued",
        startedAt: stamp(),
      };
      this.save();
      const result = await this.run(row, true);
      if (!result.ok && this.data.canaries[id]?.status === "queued") {
        this.data.canaries[id] = {
          ...this.data.canaries[id],
          status: "failed",
          reason: result.reason,
        };
        this.save();
      }
      return result;
    } finally {
      this.busy.delete("canary:" + id);
    }
  }
  pick(id, canary = false) {
    return Object.values(this.data.jobs)
      .filter(
        (r) =>
          r.job.source === id &&
          r.status === "eligible" &&
          r.qualification?.eligible,
      )
      .sort((a, b) =>
        canary
          ? a.job.netPayoutUsd - b.job.netPayoutUsd
          : (b.qualification.expectedNetPerHourUsd ??
              b.qualification.expectedNetUsd) -
            (a.qualification.expectedNetPerHourUsd ??
              a.qualification.expectedNetUsd),
      )[0];
  }
  async tick() {
    if (this.busy.has("tick")) return;
    this.busy.add("tick");
    try {
      await this.flushOutbox();
      const priority = (id) =>
        Object.values(this.data.jobs).some(
          (r) =>
            r.job.source === id &&
            ["claimed", "delivery_ready"].includes(r.status),
        )
          ? Number.MAX_VALUE
          : Number(this.pick(id)?.qualification?.expectedNetPerHourUsd || 0);
      for (const id of [...SOURCES].sort((a, b) => priority(b) - priority(a))) {
        try {
          const s = this.settings(id);
          if (
            !s.enabled ||
            this.getConfig().killSwitch ||
            !this.env[id.toUpperCase() + "_API_KEY"]
          )
            continue;
          await this.reconcile(id);
          const health = this.data.health[id];
          if (
            !health?.at ||
            Date.now() - Date.parse(health.at) >= s.pollSeconds * 1000
          )
            await this.probe(id);
          const existing = Object.values(this.data.jobs).find(
            (r) =>
              r.job.source === id &&
              ["claimed", "delivery_ready"].includes(r.status),
          );
          if (existing && s.mode !== "read_only") {
            this.launch(existing);
            continue;
          }
          if (s.mode !== "live" || !this.data.canaries[id]?.accepted) continue;
          if (
            Object.values(this.data.jobs).some(
              (r) =>
                r.job.source === id &&
                ACTIVE.has(r.status) &&
                !this.running.has(r.id),
            )
          )
            continue;
          const m = this.metrics(id);
          if (m.attempts >= 5 && m.revenueUsd - m.costUsd < 0) {
            const pause = this.data.health[id].roiPauseUntil;
            if (!pause) {
              this.data.health[id].roiPauseUntil = Date.now() + 86400000;
              this.save();
              this.log(id, "roi_cooldown");
              continue;
            }
            if (pause > Date.now()) continue;
            this.data.health[id].roiPauseUntil = 0;
          }
          const row = this.pick(id);
          if (row) this.launch(row);
        } catch (error) {
          this.data.health[id] = {
            ...this.data.health[id],
            ok: false,
            reason: String(error.message).slice(0, 200),
            at: stamp(),
          };
          this.save();
          this.log(id, "poll_error", {
            reason: String(error.message).slice(0, 200),
          });
        }
      }
    } finally {
      this.busy.delete("tick");
    }
  }
  async run(row, canary = false) {
    const id = row.job.source;
    const settings = this.settings(id);
    const key = id + ":" + row.job.externalId;
    if (
      !["claimed", "delivery_ready"].includes(row.status) &&
      Object.values(this.data.jobs).some(
        (r) =>
          r.id !== row.id &&
          !this.running.has(r.id) &&
          ["claiming", "uncertain", "submitting"].includes(r.status),
      )
    )
      return {
        ok: false,
        reason: "unresolved_prior_job_requires_reconciliation",
      };
    if (this.running.has(row.id) || this.getConfig().killSwitch)
      return { ok: false, reason: "job_running_or_emergency_stop" };
    const globalLimit = number(
      this.env.AUTONOMOS_MARKETPLACE_MAX_CONCURRENT_JOBS,
      1,
      1,
      4,
    );
    const sourceRunning = Object.values(this.data.jobs).filter(
      (r) => r.job.source === id && this.running.has(r.id),
    ).length;
    if (
      this.running.size >= globalLimit ||
      sourceRunning >= settings.concurrency ||
      this.getConfig().activeLegacyJobs > 0
    )
      return { ok: false, reason: "global_job_concurrency_limit" };
    const liveConfig = this.executionConfig();
    if (
      liveConfig.zeroSpendMode ||
      (liveConfig.earnedFundsOnly &&
        liveConfig.availableSpendUsd <
          Number(row.qualification?.spendCeilingUsd || 0)) ||
      (!liveConfig.earnedFundsOnly && !liveConfig.allowExternalSpending)
    )
      return { ok: false, reason: "execution_spending_blocked" };
    if (!settings.enabled || settings.mode === "read_only")
      return { ok: false, reason: "marketplace_read_only" };
    const controller = new AbortController();
    this.running.set(row.id, controller);
    this.reserved.set(row.id, Number(row.qualification?.spendCeilingUsd || 0));
    row.canary = canary;
    let timer;
    const c = this.connectors[id];
    const metrics = (this.data.metrics[id] ||= {
      attempts: 0,
      won: 0,
      paid: 0,
      revenueUsd: 0,
      costUsd: 0,
    });
    try {
      if (!["claimed", "delivery_ready"].includes(row.status)) {
        if (id === "agenthansa") {
          let profile = await c.profile();
          this.data.health[id] = { ...this.data.health[id], profile };
        }
        const inspection = await c.inspect(row.job);
        if (!inspection.ok) throw new Error(inspection.reason);
        row.job = inspection.job;
        row.qualification = evaluateNewMarketplaceJob(row.job, {
          settings,
          profile: this.data.health[id]?.profile,
          capability: this.classify(row.job),
          metrics,
          config: this.getConfig(),
        });
        if (this.getConfig().earnedFundsOnly) {
          const available =
            this.executionConfig().availableSpendUsd +
            (this.reserved.get(row.id) || 0);
          if (available < row.qualification.spendCeilingUsd) {
            row.qualification.eligible = false;
            row.qualification.reasons.push("insufficient_execution_budget");
          }
        }
        this.reserved.set(row.id, row.qualification.spendCeilingUsd);
        if (!row.qualification.eligible) {
          this.set(row, "filtered", {
            reason: row.qualification.reasons.join(";"),
          });
          return { ok: false, reason: row.reason };
        }
        this.set(row, "claiming", { uncertainStage: "claim" });
        const claim = await c.claim(row.job, { signal: controller.signal });
        if (!claim.ok) {
          this.set(row, claim.uncertain ? "uncertain" : "filtered", {
            reason: claim.reason,
          });
          return claim;
        }
        metrics.attempts++;
        this.set(row, "claimed", {
          claim,
          attemptCounted: true,
          uncertainStage: "",
        });
      }
      if (row.status === "claimed") {
        const timeout =
          id === "taskbounty"
            ? Number(this.env.AUTONOMOS_CODING_TIMEOUT_MS || 900000)
            : Number(
                (row.qualification.lane === "browser"
                  ? this.env.AUTONOMOS_BROWSER_JOB_TIMEOUT_MS
                  : row.qualification.lane === "document"
                    ? this.env.AUTONOMOS_DOCUMENT_JOB_TIMEOUT_MS
                    : this.env.AUTONOMOS_RESEARCH_JOB_TIMEOUT_MS) ||
                  this.env.AUTONOMOS_FAST_JOB_TIMEOUT_MS ||
                  300000,
              );
        timer = setTimeout(() => controller.abort(), timeout);
        row.executionAttempts = Number(row.executionAttempts || 0) + 1;
        if (row.executionAttempts > 3) throw new Error("execution_retry_limit");
        const ceiling = row.qualification.spendCeilingUsd;
        if (Number(row.costUsd || 0) >= ceiling)
          throw new Error("job_spend_limit_reached");
        row.executionStartedAt = stamp();
        this.set(row, "executing");
        const deliverable = await this.execute(row.job, {
          jobId: row.id,
          signal: controller.signal,
          maxSpendUsd: ceiling - Number(row.costUsd || 0),
          access: (...a) => c.access(...a),
          onEvent: (type, detail) =>
            this.log(id, type, { jobId: row.id, ...detail }),
          onCost: (amount) => {
            row.costUsd = Number(row.costUsd || 0) + amount;
            metrics.costUsd += amount;
            this.data.outbox.push({
              type: "cost",
              record: {
                id: "reserved_" + crypto.randomUUID(),
                source: id,
                jobId: row.id,
                amountUsd: amount,
              },
            });
            this.save();
          },
        });
        if (!deliverable?.content || deliverable.evidence?.qa?.ok === false)
          throw new Error("qa_failed");
        this.set(row, "delivery_ready", { deliverable });
      }
      // Save exact payload before sending. Uncertain submissions are reconciled, never replayed blindly.
      if (controller.signal.aborted) throw new Error("job_cancelled");
      row.deliveryAttempts = Number(row.deliveryAttempts || 0) + 1;
      if (row.deliveryAttempts > 3) throw new Error("delivery_retry_limit");
      this.set(row, "submitting", { uncertainStage: "submit" });
      const receipt = await c.submit(row.job, row.deliverable, {
        signal: controller.signal,
      });
      if (!receipt.ok) {
        this.set(row, receipt.uncertain ? "uncertain" : "delivery_ready", {
          reason: receipt.reason,
        });
        return receipt;
      }
      this.set(row, "submitted", {
        receipt,
        reason: "",
        uncertainStage: "",
        payoutStatus: "pending",
      });
      if (canary) {
        this.data.canaries[id] = {
          ...this.data.canaries[id],
          status: "submitted",
        };
        this.save();
      }
      return { ok: true, submitted: true, jobId: row.id };
    } catch (error) {
      const reason = String(error.message || error).slice(0, 220);
      this.set(
        row,
        ["executing", "qa"].includes(row.status)
          ? "claimed"
          : row.status === "submitting"
            ? "uncertain"
            : "failed",
        { reason },
      );
      if (canary) {
        this.data.canaries[id] = {
          ...this.data.canaries[id],
          status: row.status,
        };
        this.save();
      }
      return { ok: false, reason, jobId: row.id };
    } finally {
      clearTimeout(timer);
      if (row.executionStartedAt) {
        row.executionElapsedMs =
          Number(row.executionElapsedMs || 0) +
          Math.max(0, Date.now() - Date.parse(row.executionStartedAt));
        delete row.executionStartedAt;
      }
      this.running.delete(row.id);
      this.reserved.delete(row.id);
      this.data.jobs[key] = row;
      this.save();
      await this.flushOutbox();
    }
  }
  async reconcile(id) {
    for (const row of Object.values(this.data.jobs).filter(
      (r) =>
        r.job.source === id &&
        ["submitted", "won", "submitting", "uncertain", "claiming"].includes(
          r.status,
        ),
    )) {
      // A claim interrupted before ACK can be probed using AgentHansa's own participation list.
      if (this.running.has(row.id)) continue;
      if (
        row.status === "claiming" ||
        (row.status === "uncertain" && row.uncertainStage === "claim")
      ) {
        const recovered = await this.connectors[id].claim(row.job, {
          recoverOnly: true,
        });
        if (recovered.ok && !row.attemptCounted) {
          const m = (this.data.metrics[id] ||= {
            attempts: 0,
            won: 0,
            paid: 0,
            revenueUsd: 0,
            costUsd: 0,
          });
          m.attempts++;
          row.attemptCounted = true;
        }
        this.set(row, recovered.ok ? "claimed" : "uncertain", {
          claim: recovered.ok ? recovered : row.claim,
          uncertainStage: recovered.ok ? "" : "claim",
          reason: recovered.ok
            ? ""
            : "claim_ack_missing_reconciliation_required",
        });
        continue;
      }
      const result = await this.connectors[id].status(row.job, row.receipt);
      if (!result.ok) continue;
      const metrics = (this.data.metrics[id] ||= {
        attempts: 0,
        won: 0,
        paid: 0,
        revenueUsd: 0,
        costUsd: 0,
      });
      if (result.status === "won" && !row.wonCounted) {
        metrics.won++;
        row.wonCounted = true;
      }
      const payout = verifiedPayout(result.payout, this.settings(id));
      if (payout && !row.payout) {
        row.payout = payout;
        metrics.paid++;
        metrics.revenueUsd += payout.amountUsd;
        this.data.outbox.push({
          type: "revenue",
          record: {
            ...payout,
            source: id,
            externalId: row.job.externalId,
            jobId: row.id,
          },
        });
        this.save();
        await this.flushOutbox();
      }
      this.set(
        row,
        payout ? "paid" : result.status === "paid" ? "won" : result.status,
        {
          payoutStatus: payout
            ? "paid"
            : result.payoutStatus === "paid"
              ? "verified_receipt_required"
              : result.payoutStatus,
          reason: "",
        },
      );
      if (row.canary) {
        this.data.canaries[id] = {
          ...this.data.canaries[id],
          status: row.status,
          accepted: row.status === "won" || row.status === "paid",
          productionVerified: Boolean(payout),
        };
        this.save();
      }
    }
  }
}
