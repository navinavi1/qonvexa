import {
  MarketplaceHttp,
  arrayEnvelope,
  objectEnvelope,
  requireFields,
  publicUrl,
} from "./marketplace-http.js";

// Contracts: task-bounty.com/api/v1/openapi.json and /for-agents, checked 2026-09-06.
export class TaskBountyConnector {
  constructor({ env = process.env, ...options } = {}) {
    this.env = env;
    this.id = "taskbounty";
    this.http = new MarketplaceHttp({
      ...options,
      origin: "https://www.task-bounty.com/api/v1",
      apiKey: env.TASKBOUNTY_API_KEY || "",
    });
  }
  async discover() {
    const response = await this.http.request("/tasks?limit=50&offset=0", {
      authenticated: false,
    });
    if (!response.ok) return response;
    try {
      const rows = arrayEnvelope(response.data, [
        "tasks",
        "data",
        "data.tasks",
      ]);
      return {
        ok: true,
        rows: rows.map(normalizeTaskBounty),
        complete: rows.length < 50,
        authenticated: false,
      };
    } catch {
      return { ok: false, reason: "schema_drift:taskbounty_tasks" };
    }
  }
  async inspect(job) {
    const response = await this.http.request(
      `/tasks/${encodeURIComponent(job.externalId)}`,
    );
    if (!response.ok) return response;
    try {
      const raw = objectEnvelope(response.data);
      const normalized = normalizeTaskBounty(raw);
      return {
        ok: true,
        job: normalized,
        authenticated: Boolean(raw.solver_readiness),
        readiness: raw.solver_readiness || null,
      };
    } catch {
      return { ok: false, reason: "schema_drift:taskbounty_task" };
    }
  }
  async profile() {
    return {
      ok: false,
      reason: "taskbounty_profile_read_not_documented",
      configured: Boolean(
        this.env.TASKBOUNTY_API_KEY && this.env.TASKBOUNTY_AGENT_ID,
      ),
    };
  }
  async access(job, signal) {
    if (!this.env.TASKBOUNTY_AGENT_ID)
      return { ok: false, reason: "taskbounty_agent_id_missing" };
    // This grants read access, not exclusive ownership or a guaranteed payout.
    return this.http.request(
      `/tasks/${encodeURIComponent(job.externalId)}/access`,
      {
        method: "POST",
        body: { agent_id: this.env.TASKBOUNTY_AGENT_ID },
        signal,
      },
    );
  }
  async claim(job) {
    const detail = await this.inspect(job);
    if (!detail.ok) return detail;
    if (!detail.authenticated)
      return {
        ok: false,
        reason: "taskbounty_authenticated_readiness_required",
      };
    if (
      detail.job.status !== "open" ||
      !detail.job.escrowed ||
      detail.readiness?.already_awarded ||
      detail.readiness?.head_start_window?.active ||
      detail.readiness?.submission_saturation?.saturated
    )
      return { ok: false, reason: "taskbounty_not_available" };
    return { ok: true, localIntent: true, job: detail.job };
  }
  async submit(job, deliverable, { signal } = {}) {
    if (!this.env.TASKBOUNTY_AGENT_ID)
      return { ok: false, reason: "taskbounty_agent_id_missing" };
    const proof = deliverable?.evidence?.repositoryVerification;
    if (
      !proof?.ok ||
      !proof.regressionFailsOnBase ||
      !proof.testsPassOnFix ||
      !proof.patch
    )
      return { ok: false, reason: "taskbounty_verified_regression_missing" };
    const pr = publicUrl(deliverable?.evidence?.pullRequestUrl);
    const repo = String(job.repoUrl || "")
      .replace(/\.git$/, "")
      .replace(/\/$/, "");
    const usePr =
      pr &&
      pr.startsWith(repo + "/pull/") &&
      /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr);
    const payload = {
      task_id: job.externalId,
      agent_id: this.env.TASKBOUNTY_AGENT_ID,
      result_text: String(deliverable.content || "").slice(0, 12000),
      ...(usePr
        ? { external_link: pr }
        : {
            patch: proof.patch,
            test_output: proof.testOutput.slice(0, 64000),
          }),
    };
    const result = await this.http.request(
      usePr ? "/submissions" : "/submissions/patch",
      { method: "POST", body: payload, signal },
    );
    if (!result.ok) return result;
    const row = objectEnvelope(result.data);
    const id = String(row.id || row.submission_id || "");
    return id
      ? { ok: true, id, status: "submitted", payoutStatus: "pending" }
      : { ok: false, uncertain: true, reason: "submission_ack_missing_id" };
  }
  async status(job, receipt) {
    if (!receipt?.id)
      return {
        ok: false,
        reason: "submission_id_missing_cannot_safely_resubmit",
      };
    const r = await this.http.request(
      `/submissions/${encodeURIComponent(receipt.id)}`,
    );
    if (!r.ok) return r;
    let row;
    try {
      row = objectEnvelope(r.data);
      requireFields(row, ["task_id", "agent_id", "status"]);
    } catch {
      return { ok: false, reason: "schema_drift:taskbounty_submission" };
    }
    if (
      String(row.task_id || "") !== job.externalId ||
      String(row.agent_id || "") !== String(this.env.TASKBOUNTY_AGENT_ID)
    )
      return { ok: false, reason: "submission_identity_mismatch" };
    const s = String(row.status || "").toLowerCase();
    return {
      ok: true,
      status:
        s === "winner"
          ? "won"
          : ["rejected", "paid"].includes(s)
            ? s
            : "submitted",
      payoutStatus:
        s === "paid" ? "paid" : s === "winner" ? "approved" : "pending",
      payout: row.payout || null,
    };
  }
}
export function normalizeTaskBounty(raw) {
  requireFields(raw, ["id", "title", "bounty_cents", "status"]);
  const cents = Number(raw.bounty_cents);
  if (!Number.isFinite(cents) || cents < 0)
    throw new Error("schema_drift:invalid_reward");
  return {
    source: "taskbounty",
    externalId: String(raw.id),
    title: String(raw.title),
    description: [
      raw.description,
      raw.evaluation_criteria,
      raw.expected_output_format,
      "Implement the fix and add a regression test. Verify that the regression fails before the fix and passes after it.",
    ]
      .filter(Boolean)
      .join("\n"),
    category: "coding",
    repoUrl: publicUrl(raw.github_repo_url),
    budgetUsd: cents / 100,
    feePercent: 20,
    netPayoutUsd: (cents / 100) * 0.8,
    currency: "USDC",
    network: "solana",
    status: String(raw.status).toLowerCase(),
    escrowed: String(raw.funding_status).toLowerCase() === "funded",
    claimMode: "competitive_submission",
    kind: "competitive",
    deadline: raw.submission_deadline || "",
    skills: Array.isArray(raw.tags) ? raw.tags : [],
    raw,
  };
}
