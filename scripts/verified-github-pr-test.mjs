import assert from "node:assert/strict";
import crypto from "node:crypto";
import { openVerifiedPullRequest } from "../src/autonomos/verified-github-pr.js";
const jobId = "fixture-job";
const branch =
  "autonomos/" +
  crypto.createHash("sha256").update(jobId).digest("hex").slice(0, 24);
const proof = {
  ok: true,
  testsPassOnFix: true,
  regressionFailsOnBase: true,
  repoUrl: "https://github.com/upstream/repo",
  baseSha: "base-sha",
  patchSha256: "verified-hash",
  files: [{ path: "src/a.js", content: "fixed" }],
};
let writes = 0;
let hasPr = false;
let queries = 0;
const request = async (url, opts) => {
  const u = new URL(url),
    p = u.pathname;
  const method = opts.method;
  const body = opts.body ? JSON.parse(opts.body) : {};
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status });
  if (method === "GET" && p === "/user") return json({ login: "bot" });
  if (method === "GET" && p.endsWith("/pulls")) {
    queries++;
    return json(
      hasPr
        ? [
            {
              head: { ref: branch },
              body: "AutonomOS verification: verified-hash",
              html_url: "https://github.com/upstream/repo/pull/1",
              number: 1,
            },
          ]
        : [],
    );
  }
  if (method === "GET" && p === "/repos/upstream/repo")
    return json({ default_branch: "main" });
  if (method === "GET" && p === "/repos/upstream/repo/git/ref/heads/main")
    return json({ object: { sha: "base-sha" } });
  if (method === "GET" && p === "/repos/bot/repo")
    return json({ parent: { full_name: "upstream/repo" } });
  if (method === "GET" && p.endsWith("/git/commits/base-sha"))
    return json({ tree: { sha: "base-tree" } });
  if (method === "GET" && p.includes("/git/ref/heads/")) return json({}, 404);
  if (method === "POST") {
    writes++;
    if (p.endsWith("/git/trees")) {
      assert.equal(body.base_tree, "base-tree");
      assert.equal(body.tree[0].content, "fixed");
      return json({ sha: "tree" });
    }
    if (p.endsWith("/git/commits")) return json({ sha: "commit" });
    if (p.endsWith("/git/refs")) return json({});
    if (p.endsWith("/pulls")) {
      hasPr = true;
      throw new Error("response_lost_after_commit");
    }
  }
  throw new Error("Unexpected API request " + method + " " + p);
};
const opts = {
  env: { GITHUB_TOKEN: "fixture", AUTONOMOS_GITHUB_EXPECTED_LOGIN: "bot" },
  jobId,
  fetchImpl: request,
};
assert.equal((await openVerifiedPullRequest(proof, opts)).ok, true);
assert.equal(writes, 4);
const saved = writes;
assert.equal((await openVerifiedPullRequest(proof, opts)).recovered, true);
assert.equal(writes, saved);
assert(queries >= 3);
console.log(
  "PASS verified PR uses upstream base, atomic tree, stable branch and recovers lost response without duplicate writes",
);
