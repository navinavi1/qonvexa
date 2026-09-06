const marketplaceFeedback=new Map();
const marketplaceFilters=new Map();
let latestMarketplaceData;
const queueNames={ready:'Ready',working:'Working',retry:'Retry later',systemBlocked:'Needs repair / tools',policyHold:'Policy / economics',watch:'Watch / referrals',delivered:'Awaiting review / payment',paid:'Paid',graveyard:'Permanently excluded',stale:'Not in current feed'};
document.addEventListener('input',event=>{
  const form=event.target.closest?.('.marketplace-controls,.marketplace-receipt');
  if(form){form.dataset.dirty='true';const feedback=form.closest('[data-market]').querySelector('.marketplace-feedback');if(feedback)feedback.textContent='Unsaved changes';}
});
document.addEventListener('change',event=>{
  if(event.target.matches?.('[data-queue-filter]')){marketplaceFilters.set(event.target.dataset.queueFilter,event.target.value);event.target.blur();window.renderNewMarketplaces(latestMarketplaceData);}
});
// Uses the existing authenticated admin transport; no credentials enter the browser.
window.renderNewMarketplaces = function (data) {
  const root = document.getElementById("new-marketplaces");
  if (!root || !data) return;
  latestMarketplaceData=data;
  if(root.querySelector('[data-dirty="true"],[data-request="true"]'))return;
  if (
    root.contains(document.activeElement) &&
    document.activeElement.matches("input,select")
  )
    return;
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const usd = (v) => "$" + Number(v || 0).toFixed(2);
  root.innerHTML =
    (data.capabilities
      ? '<details class="marketplace-events"><summary>Agent capabilities and missing tools</summary>' +
        data.capabilities
          .map(
            (c) =>
              "<p>" +
              esc(c.name) +
              " · " +
              (c.available
                ? "Available"
                : esc(c.missingTools.join(", ") || c.mode)) +
              "</p>",
          )
          .join("") +
        "</details>"
      : "") +
    data.markets
      .map((m) => {
        const s = m.settings;
        const h = m.health;
        const selectedQueue=marketplaceFilters.get(m.id)||'all';
        const visibleJobs=m.jobs.filter(j=>selectedQueue==='all'||j.queue===selectedQueue);
        const name = m.id === "taskbounty" ? "TaskBounty" : "AgentHansa";
        return `<article class="marketplace-card" data-market="${m.id}">
      <div class="marketplace-heading"><h3>${name}</h3><strong>${m.lifecycle.productionVerified ? "Production Verified" : m.canary?.accepted ? "Canary accepted" : "Awaiting live verification"}</strong></div>
      <p>${h.at ? `${h.ok ? "API available" : "API check failed"} · ${esc(h.count || 0)} listings · ${esc(h.reason || "")}` : "Run a probe to check the API and available work."}</p>
      ${h.warnings?.length?`<p>Coverage checks: ${esc(h.warnings.join('; '))}</p>`:''}
      ${s.mode==='read_only'?'<p><b>Read only:</b> scanning is active; job execution is off. Select One canary to test a qualified job.</p>':''}
      ${s.mode==='canary'&&s.autoCommission?'<p>The next qualified job runs automatically while Mission Control is running. Automatic mode starts after the marketplace accepts that first result. A failed canary stays visible for repair.</p>':''}
      <p>Credentials: ${h.authenticated ? "verified by API" : h.credentialsConfigured ? "configured; verification pending" : "not configured"}</p>
      <p>Wallet: ${s.walletAddress ? esc(s.walletAddress) : "Not configured"} · ${esc(s.network || "network unverified")}<br>Canary: ${esc(m.canary?.status || "not started")}${m.canary?.reason ? " · " + esc(m.canary.reason) : ""}</p>
      <form class="marketplace-controls">
        <label><input name="enabled" type="checkbox" ${s.enabled ? "checked" : ""}> Enabled</label>
        <label>Mode <select name="mode">${["read_only", "canary", "live"].map((v) => `<option value="${v}" ${s.mode === v ? "selected" : ""}>${{ read_only: "Read only", canary: "One canary", live: "Automatic after canary" }[v]}</option>`).join("")}</select></label>
        <label>Minimum net payout ($)<input name="minPayoutUsd" type="number" min="0.5" max="100000" step="0.01" value="${s.minPayoutUsd}" required></label>
        <label>Maximum job spend ($)<input name="maxSpendUsd" type="number" min="0" max="100" step="0.1" value="${s.maxSpendUsd}" required></label>
        <label>Concurrent jobs<input name="concurrency" type="number" min="1" max="${m.id === "taskbounty" ? 2 : 4}" value="${s.concurrency}" required></label>
        <label><input name="competitiveAllowed" type="checkbox" ${s.competitiveAllowed ? "checked" : ""}> Allow competitive work</label>
        <label><input name="dynamicFloor" type="checkbox" ${s.dynamicFloor ? "checked" : ""}> Raise minimum after verified payouts</label>
        <label><input name="autoCommission" type="checkbox" ${s.autoCommission ? "checked" : ""}> Start canary automatically and continue after acceptance</label>
        <label><input name="walletConfirmed" type="checkbox" ${s.walletConfirmed ? "checked" : ""}> I confirmed this payout address in the marketplace</label>
        <button type="submit" class="admin-secondary">Save controls</button>
      </form>
      <div class="marketplace-actions"><button type="button" data-action="probe" class="admin-secondary">Run live probe</button><button type="button" data-action="canary" class="admin-secondary" ${s.mode !== "canary" || !s.enabled ? "disabled" : ""}>Run canary</button><span class="marketplace-feedback" role="status">${esc(marketplaceFeedback.get(m.id)||"")}</span></div>
      <p>Discovered ${m.metrics.discovered || 0} · Eligible ${m.metrics.eligible || 0} · Submitted ${m.metrics.submitted || 0} · Attempts ${m.metrics.attempts} · Won ${m.metrics.won} · Paid ${m.metrics.paid} · Revenue ${usd(m.metrics.revenueUsd)} · Reserved costs ${usd(m.metrics.costUsd)} · Net ${usd(m.metrics.netProfitUsd)} · ROI ${m.metrics.roi == null ? "—" : (m.metrics.roi * 100).toFixed(1) + "%"}</p>
      <label>Job queue <select data-queue-filter="${m.id}">${[['all','All'],...Object.entries(queueNames)].map(([key,label])=>`<option value="${key}" ${selectedQueue===key?'selected':''}>${esc(label)} (${key==='all'?m.jobs.length:m.jobs.filter(j=>j.queue===key).length})</option>`).join('')}</select></label>
      <div class="autonomos-job-table-wrap"><table class="autonomos-job-table"><thead><tr><th>Job</th><th>Type</th><th>Net payout</th><th>Work / payout</th><th>Reason</th></tr></thead><tbody>${visibleJobs.length ? visibleJobs.map((j) => `<tr><td>${esc(j.title)}</td><td>${esc(j.kind)}</td><td>${j.rewardUncertain?"Individual payout unknown":usd(j.netPayoutUsd)}${j.prizePoolUsd ? `<br><small>Shared prize pool ${usd(j.prizePoolUsd)}</small>` : ""}</td><td>${esc(queueNames[j.queue]||j.status)} / ${esc(j.payoutStatus)}</td><td>${esc(j.reason || (j.qualification?.reasons || []).join("; "))}</td></tr>`).join("") : '<tr><td colspan="5">No jobs in this queue.</td></tr>'}</tbody></table></div>
      ${
        m.id === "taskbounty" &&
        m.jobs.some(
          (j) => j.status === "uncertain" || j.status === "submitting",
        )
          ? `<form class="marketplace-receipt"><label>Recover a missing submit receipt <select name="jobId">${m.jobs
              .filter((j) => ["uncertain", "submitting"].includes(j.status))
              .map(
                (j) => `<option value="${esc(j.id)}">${esc(j.title)}</option>`,
              )
              .join(
                "",
              )}</select></label><input name="receiptId" aria-label="Submission ID from TaskBounty" placeholder="Submission ID from TaskBounty" maxlength="160" required><button type="submit" class="admin-secondary">Verify receipt</button></form>`
          : ""
      }
    </article>`;
      })
      .join("") +
    `<details class="marketplace-events"><summary>Marketplace event journal</summary>${data.events.map((e) => `<p>${esc(e.at)} · ${esc(e.source)} · ${esc(e.type)} · ${esc(e.externalId || e.reason || "")}</p>`).join("") || "<p>No events yet.</p>"}</details>`;
};

async function marketplaceRequest(card, action, body = {}) {
  card.dataset.request="true";
  const feedback = card.querySelector(".marketplace-feedback");
  const buttons = [...card.querySelectorAll("button")];
  const prior = buttons.map((b) => b.disabled);
  buttons.forEach((b) => (b.disabled = true));
  feedback.textContent = "Working…";
  try {
    const r = await fetch(
      `/api/admin/autonomos/marketplaces/${card.dataset.market}/${action}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const result = await r.json();
    if (!r.ok || result.ok === false)
      throw new Error(result.error || result.reason || "Request failed");
    feedback.textContent =
      action === "canary"
        ? "Canary queued. Its progress appears here as it runs."
        : action === "probe"
          ? `Probe complete: ${result.count || 0} listings.`
          : "Saved.";
    if(action==="config")for(const form of card.querySelectorAll("form"))delete form.dataset.dirty;
    marketplaceFeedback.set(card.dataset.market,feedback.textContent);
  } catch (error) {
    feedback.textContent = error.message;
    marketplaceFeedback.set(card.dataset.market,error.message);
  } finally {
    buttons.forEach((b, i) => (b.disabled = prior[i]));
    delete card.dataset.request;
    document.dispatchEvent(new Event("marketplace-updated"));
  }
}
document.addEventListener("submit", (event) => {
  if (event.target.matches(".marketplace-receipt")) {
    event.preventDefault();
    marketplaceRequest(
      event.target.closest("[data-market]"),
      "receipt",
      Object.fromEntries(new FormData(event.target)),
    );
    return;
  }
  if (!event.target.matches(".marketplace-controls")) return;
  event.preventDefault();
  const form = event.target;
  const card = form.closest("[data-market]");
  const data = Object.fromEntries(new FormData(form));
  for (const key of [
    "enabled",
    "competitiveAllowed",
    "dynamicFloor",
    "walletConfirmed",
    "autoCommission",
  ])
    data[key] = form.elements[key].checked;
  data.minPayoutUsd = Number(data.minPayoutUsd);
  data.maxSpendUsd = Number(data.maxSpendUsd);
  data.concurrency = Number(data.concurrency);
  marketplaceRequest(card, "config", data);
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-market] [data-action]");
  if (button)
    marketplaceRequest(button.closest("[data-market]"), button.dataset.action);
});
