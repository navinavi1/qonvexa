import {
  MarketplaceHttp,
  arrayEnvelope,
  objectEnvelope,
  requireFields,
  publicUrl,
} from "./marketplace-http.js";

// Endpoint contracts from agenthansa.com/openapi.json; no feed-provided URL is executed.
export class AgentHansaConnector {
  constructor({ env = process.env, ...options } = {}) {
    this.env = env;
    this.id = "agenthansa";
    this.http = new MarketplaceHttp({
      ...options,
      origin: "https://www.agenthansa.com/api",
      apiKey: env.AGENTHANSA_API_KEY || "",
    });
  }
  async discover() {
    const r = await this.http.request(
      "/agents/work?page=1&per_page=50&type=all",
    );
    if (!r.ok) return r;
    try {
      const rows = arrayEnvelope(r.data, [
        "items",
        "work",
        "data",
        "data.items",
        "results",
      ]);
      return {
        ok: true,
        rows: rows.map(normalizeAgentHansa),
        complete: r.data?.pagination?.has_more === false,
        authenticated: true,
      };
    } catch {
      return { ok: false, reason: "schema_drift:agenthansa_work" };
    }
  }
  async profile() {
    const r = await this.http.request("/agents/me");
    if (!r.ok) return r;
    const destination = await this.http.request(
      "/agents/me/payout-destination",
    );
    if (!destination.ok) return destination;
    let row, d;
    try {
      row = objectEnvelope(r.data);
      d = objectEnvelope(destination.data);
      requireFields(row, ["id"]);
    } catch {
      return { ok: false, reason: "schema_drift:agenthansa_profile" };
    }
    return {
      ok: true,
      authenticated: true,
      agentId: String(row.id || ""),
      active: row.status !== "disabled",
      walletAddress: String(row.wallet_address || ""),
      fluxaAgentId: String(row.fluxa_agent_id || ""),
      destination: String(d.destination || d.payout_destination || ""),
      reputation: Number(row.reputation || row.reputation_score || 0),
    };
  }
  path(job) {
    return job.kind === "quest"
      ? `/alliance-war/quests/${encodeURIComponent(job.externalId)}`
      : job.kind === "task"
        ? `/collective/bounties/${encodeURIComponent(job.externalId)}`
        : "";
  }
  async inspect(job) {
    const path = this.path(job);
    if (!path) return { ok: false, reason: "unsupported_lifecycle" };
    const r = await this.http.request(path);
    if (!r.ok) return r;
    try {
      const raw = objectEnvelope(r.data);
      return { ok: true, job: normalizeAgentHansa({ ...raw, type: job.kind }) };
    } catch {
      return { ok: false, reason: "schema_drift:agenthansa_detail" };
    }
  }
  async claim(job, { recoverOnly = false, signal } = {}) {
    if (job.kind === "quest") return { ok: true, localIntent: true };
    if (job.kind !== "task")
      return { ok: false, reason: "unsupported_lifecycle" };
    const mine = await this.http.request("/collective/bounties/my");
    if (!mine.ok) return mine;
    let rows;
    try {
      rows = arrayEnvelope(mine.data, ["bounties", "tasks", "data", "items"]);
    } catch {
      return { ok: false, reason: "schema_drift:agenthansa_my_tasks" };
    }
    if (
      rows.some(
        (r) => String(r.bounty_id || r.id || r.bounty?.id) === job.externalId,
      )
    )
      return { ok: true, recovered: true };
    if (recoverOnly)
      return { ok: false, reason: "participation_not_confirmed" };
    const r = await this.http.request(this.path(job) + "/join", {
      method: "POST",
      signal,
    });
    return r.ok ? { ok: true, joined: true } : r;
  }
  async submit(job, deliverable, { signal } = {}) {
    const url = publicUrl(
      deliverable?.evidence?.artifactUrl ||
        deliverable?.evidence?.artifactUrls?.[0],
    );
    if (!url) return { ok: false, reason: "proof_url_missing" };
    const path = this.path(job);
    if (!path) return { ok: false, reason: "unsupported_lifecycle" };
    const body =
      job.kind === "quest"
        ? { content: String(deliverable.content), proof_url: url }
        : { description: String(deliverable.content), url };
    const r = await this.http.request(path + "/submit", {
      method: "POST",
      body,
      signal,
    });
    if (!r.ok) return r;
    const row = objectEnvelope(r.data);
    return {
      ok: true,
      id: String(row.submission_id || row.id || job.externalId),
      status: "submitted",
      payoutStatus: "pending",
    };
  }
  async status(job) {
    const path =
      job.kind === "quest"
        ? "/alliance-war/quests/my"
        : "/collective/bounties/my";
    const r = await this.http.request(path);
    if (!r.ok) return r;
    let rows;
    try {
      rows = arrayEnvelope(r.data, [
        "submissions",
        "quests",
        "bounties",
        "tasks",
        "items",
        "data",
      ]);
    } catch {
      return { ok: false, reason: "schema_drift:agenthansa_submissions" };
    }
    const row = rows.find(
      (r) =>
        String(
          r.quest_id || r.bounty_id || r.quest?.id || r.bounty?.id || r.id,
        ) === job.externalId,
    );
    if (!row) return { ok: false, reason: "submission_not_found" };
    if (
      job.kind === "task" &&
      !row.submission_status &&
      !row.submitted_at &&
      !row.submission &&
      !row.proof_url
    )
      return { ok: false, reason: "submission_not_confirmed" };
    const s = String(row.submission_status || row.status || "").toLowerCase();
    const status = ["rejected", "spam", "disqualified"].includes(s)
      ? "rejected"
      : ["accepted", "winner", "won"].includes(s)
        ? "won"
        : "submitted";
    const transfers = await this.http.request("/agents/transfers");
    let payout = null;
    if (transfers.ok) {
      try {
        payout =
          arrayEnvelope(transfers.data, ["transfers", "data", "items"]).find(
            (t) =>
              String(t.quest_id || t.bounty_id || t.task_id || "") ===
              job.externalId,
          ) || null;
      } catch {
        /* no payout evidence */
      }
    }
    return {
      ok: true,
      status,
      payoutStatus:
        payout?.status === "confirmed"
          ? "paid"
          : status === "won"
            ? "approved"
            : "pending",
      payout,
    };
  }
}
export function normalizeAgentHansa(raw) {
  requireFields(raw, ["id", "title"]);
  const type = String(raw.type || raw.kind || "").toLowerCase();
  const kind = ["offer", "affiliate", "commission"].includes(type)
    ? "affiliate"
    : ["quest", "competitive"].includes(type)
      ? "quest"
      : ["task", "collective"].includes(type)
        ? "task"
        : "unsupported";
  // A shared prize pool is NOT the agent's fee. Only an explicit individual reward can qualify.
  const reward = Number(
    raw.reward_per_agent ??
      raw.reward_per_participant ??
      raw.payout_per_task ??
      raw.flat_pay_usd ??
      0,
  );
  const pool = Number(
    raw.reward_pool ??
      raw.reward_amount ??
      raw.reward_usd ??
      raw.reward ??
      raw.budget ??
      0,
  );
  return {
    source: "agenthansa",
    externalId: String(raw.id),
    title: String(raw.title),
    description: [raw.description, raw.goal, raw.requirements]
      .filter(Boolean)
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      .join("\n"),
    category: String(raw.category || "research"),
    kind,
    claimMode:
      kind === "task"
        ? "shared_reward_submission"
        : kind === "quest"
          ? "competitive_submission"
          : "watchlist_only",
    budgetUsd: Number.isFinite(reward) ? Math.max(0, reward) : 0,
    netPayoutUsd: Number.isFinite(reward) ? Math.max(0, reward) * 0.95 : 0,
    prizePoolUsd: Number.isFinite(pool) ? pool : 0,
    rewardUncertain: !(reward > 0),
    feePercent: 5,
    currency: "USDC",
    network: "unverified",
    escrowed: false,
    status: String(raw.status || "unknown").toLowerCase(),
    deadline: raw.deadline || "",
    skills: Array.isArray(raw.skills) ? raw.skills : [],
    raw,
  };
}
