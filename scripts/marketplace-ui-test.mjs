import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { marketplaceSettings } from "../src/autonomos/marketplace-manager.js";

const dom = new JSDOM('<div id="new-marketplaces"></div>', {
  url: "https://local.example/admin",
  runScripts: "outside-only",
});
const { window } = dom;
let requests = [];
let result = { ok: true };
window.fetch = async (url, opts) => {
  requests.push({ url, body: JSON.parse(opts.body) });
  return { ok: true, json: async () => result };
};
window.eval(
  fs.readFileSync(
    new URL("../public/marketplaces.js", import.meta.url),
    "utf8",
  ),
);
const market = (id) => ({
  id,
  settings: marketplaceSettings(id),
  health: {},
  metrics: { attempts: 0, won: 0, paid: 0, revenueUsd: 0, costUsd: 0 },
  lifecycle: {},
  jobs: [],
  canary: null,
});
const data = {
  markets: [market("agenthansa"), market("taskbounty")],
  events: [],
};
window.renderNewMarketplaces(data);
assert.equal(window.document.querySelectorAll("[data-market]").length, 2);
assert.equal(
  window.document.querySelector('[data-action="canary"]').disabled,
  true,
);
assert(!window.document.body.textContent.includes("undefined"));
const card = window.document.querySelector('[data-market="taskbounty"]');
const form = card.querySelector("form");
form.elements.mode.value = "canary";
form.elements.competitiveAllowed.checked = true;
form.elements.minPayoutUsd.value = "10";
form.elements.minPayoutUsd.dispatchEvent(new window.Event('input',{bubbles:true}));
window.renderNewMarketplaces(data);
assert.equal(window.document.querySelector('[data-market="taskbounty"] input[name="minPayoutUsd"]').value,'10','polling cannot discard unsaved settings');
form.dispatchEvent(
  new window.Event("submit", { bubbles: true, cancelable: true }),
);
await new Promise((r) => setTimeout(r, 0));
assert.equal(
  requests[0].url,
  "/api/admin/autonomos/marketplaces/taskbounty/config",
);
assert.equal(requests[0].body.minPayoutUsd, 10);
assert.equal(requests[0].body.mode, "canary");
assert.equal(requests[0].body.competitiveAllowed, true);
assert.equal(form.dataset.dirty,undefined,'successful save releases polling lock');
result = { ok: false, reason: "credentials_missing" };
card.querySelector('[data-action="probe"]').click();
await new Promise((r) => setTimeout(r, 0));
assert.equal(
  card.querySelector('[role="status"]').textContent,
  "credentials_missing",
);
assert.equal(card.querySelector('[data-action="canary"]').disabled, true);
data.markets[1].jobs = [
  {
    title: "<img src=x onerror=alert(1)>",
    status: "filtered",
    kind: "competitive",
    netPayoutUsd: 4,
    qualification: { reasons: ["below floor"] },
  },
];
window.renderNewMarketplaces(data);
assert.equal(window.document.querySelector("img"), null);
assert.match(window.document.body.textContent, /below floor/);
const html = fs.readFileSync(
  new URL("../public/admin.html", import.meta.url),
  "utf8",
);
const page = new JSDOM(html);
const ids = [...page.window.document.querySelectorAll("[id]")].map((e) => e.id);
assert.equal(new Set(ids).size, ids.length, "admin IDs must remain unique");
const tabs = [...page.window.document.querySelectorAll("[data-view]")];
for (const tab of tabs)
  assert(
    page.window.document.querySelector(`[data-panel="${tab.dataset.view}"]`),
  );
assert.equal(
  page.window.document
    .getElementById("new-marketplaces")
    .closest(".autonomos-stat-grid"),
  null,
);
console.log(
  "PASS UI controls: both markets, mode gate, save payload, error feedback, XSS escaping, unique IDs and navigation targets",
);
dom.window.close();
page.window.close();
