import { githubAvailable, githubRequest } from './github-transport.js';
import crypto from "node:crypto";

// Publishes exactly the files covered by a recorded regression run. Every branch has a
// stable job identity, and an existing PR is recovered before any repeat mutation.
export async function openVerifiedPullRequest(
  proof,
  {
    env = process.env,
    jobId = "",
    issueNumber = null,
    opire = false,
    signal,
    fetchImpl = (...a) => fetch(...a),
  } = {},
) {
  if (
    !proof?.ok ||
    !proof.testsPassOnFix ||
    !proof.regressionFailsOnBase ||
    !Array.isArray(proof.files)
  )
    return { ok: false, reason: "verified_repository_result_required" };
  if (!githubAvailable(env)) return { ok: false, reason: "github_connection_missing" };
  const match = String(proof.repoUrl).match(
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/,
  );
  if (!match) return { ok: false, reason: "invalid_repository" };
  const [, owner, repo] = match;
  const upstream = `/repos/${owner}/${repo}`;
  const branch =
    "autonomos/" +
    crypto.createHash("sha256").update(jobId).digest("hex").slice(0, 24);
  const marker = `AutonomOS verification: ${proof.patchSha256}`;
  const request = async (path, method = "GET", body) => {
    if (signal?.aborted) throw new Error("cancelled");
    return githubRequest(path, { method, body, env, signal, fetchImpl });
  };
  let login = "";
  const find = async () => {
    if (!login) return null;
    const r = await request(
      `${upstream}/pulls?state=all&head=${encodeURIComponent(login + ":" + branch)}`,
    );
    if (!r.ok || !Array.isArray(r.value)) throw new Error("pr_lookup_failed");
    const pr = r.value.find((p) => p.head?.ref === branch);
    if (!pr) return null;
    if (!String(pr.body || "").includes(marker))
      throw new Error("existing_pr_verification_mismatch");
    return {
      ok: true,
      prUrl: pr.html_url,
      prNumber: pr.number,
      recovered: true,
    };
  };
  try {
    const who = await request("/user");
    login = String(who.value?.login || "");
    if (!who.ok || !login)
      return { ok: false, reason: "github_identity_unverified" };
    if (
      env.AUTONOMOS_GITHUB_EXPECTED_LOGIN &&
      login.toLowerCase() !== env.AUTONOMOS_GITHUB_EXPECTED_LOGIN.toLowerCase()
    )
      return { ok: false, reason: "github_identity_mismatch" };
    const existing = await find();
    if (existing) return existing;
    const metadata = await request(upstream);
    if (!metadata.ok) return { ok: false, reason: "repository_unavailable" };
    const base = metadata.value.default_branch;
    const head = await request(
      `${upstream}/git/ref/heads/${encodeURIComponent(base)}`,
    );
    if (head.value?.object?.sha !== proof.baseSha)
      return { ok: false, reason: "upstream_changed_after_verification" };
    let fork = await request(`/repos/${login}/${repo}`);
    if (!fork.ok) {
      if (fork.status !== 404) return { ok: false, reason: "fork_read_failed" };
      fork = await request(upstream + "/forks", "POST", {});
      if (!fork.ok) return { ok: false, reason: "fork_creation_failed" };
    }
    for (let i = 0; i < 5; i++) {
      fork = await request(`/repos/${login}/${repo}`);
      if (fork.ok) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (
      !fork.ok ||
      fork.value.parent?.full_name?.toLowerCase() !==
        `${owner}/${repo}`.toLowerCase()
    )
      return { ok: false, reason: "fork_not_ready_or_wrong_parent" };
    const dest = `/repos/${login}/${repo}`;
    const commit = await request(upstream + "/git/commits/" + proof.baseSha);
    if (!commit.ok) return { ok: false, reason: "base_commit_unavailable" };
    const tree = [];
    for (const f of proof.files) {
      if (
        !f.path ||
        f.path.startsWith("/") ||
        f.path.split("/").some((x) => ["..", ".git"].includes(x))
      )
        return { ok: false, reason: "invalid_change_path" };
      tree.push({
        path: f.path,
        mode: "100644",
        type: "blob",
        content: String(f.content),
      });
    }
    const createdTree = await request(dest + "/git/trees", "POST", {
      base_tree: commit.value.tree.sha,
      tree,
    });
    if (!createdTree.ok) return { ok: false, reason: "tree_creation_failed" };
    const createdCommit = await request(dest + "/git/commits", "POST", {
      message: "AutonomOS: verified marketplace fix",
      tree: createdTree.value.sha,
      parents: [proof.baseSha],
    });
    if (!createdCommit.ok)
      return { ok: false, reason: "commit_creation_failed" };
    const ref = await request(
      dest + "/git/ref/heads/" + encodeURIComponent(branch),
    );
    if (ref.ok) {
      const prior = await request(
        dest + "/git/commits/" + ref.value.object.sha,
      );
      if (prior.value?.tree?.sha !== createdTree.value.sha)
        return {
          ok: false,
          reason: "branch_already_contains_different_change",
        };
    } else {
      if (ref.status !== 404)
        return { ok: false, reason: "branch_read_failed" };
      const created = await request(dest + "/git/refs", "POST", {
        ref: "refs/heads/" + branch,
        sha: createdCommit.value.sha,
      });
      if (!created.ok)
        return { ok: false, reason: "branch_creation_uncertain" };
    }
    const pr = await request(upstream + "/pulls", "POST", {
      title: "Fix: verified marketplace task",
      head: login + ":" + branch,
      base,
      body:
        marker +
        (Number.isInteger(issueNumber) ? `\n\nFixes #${issueNumber}.`+(opire?`\n\n/claim #${issueNumber}`:'') : '') +
        "\n\nExisting test suite passes. The new regression fails on the original code.\n\nNot merged automatically.",
    });
    if (!pr.ok)
      return (
        (await find()) || {
          ok: false,
          uncertain: true,
          reason: "pr_creation_uncertain",
        }
      );
    return { ok: true, prUrl: pr.value.html_url, prNumber: pr.value.number };
  } catch (error) {
    try {
      const existing = await find();
      if (existing) return existing;
    } catch {}
    return {
      ok: false,
      uncertain: true,
      reason: String(error.message).slice(0, 180),
    };
  }
}


export async function updateVerifiedPullRequest(proof, pr, { env=process.env, signal }={}) {
  if(!proof?.ok||!proof.testsPassOnFix||!proof.regressionFailsOnBase||!Array.isArray(proof.files))return {ok:false,reason:'verified_repository_result_required'};
  const dest='/repos/'+pr.head.repo.full_name;
  if(proof.repoUrl!==pr.head.repo.html_url)return {ok:false,reason:'revision_repository_mismatch'};
  const request=(endpoint,method='GET',body)=>githubRequest(endpoint,{method,body,env,signal});
  const who=await request('/user');if(!who.ok||who.value.login!==pr.user.login)return {ok:false,reason:'revision_identity_mismatch'};
  const current=await request(dest+'/git/ref/heads/'+encodeURIComponent(pr.head.ref));
  if(!current.ok)return {ok:false,reason:'revision_branch_unavailable'};
  const base=await request(dest+'/git/commits/'+proof.baseSha);if(!base.ok)return {ok:false,reason:'revision_base_unavailable'};
  const tree=[];for(const f of proof.files){if(!f.path||f.path.startsWith('/')||f.path.split('/').some(x=>['..','.git'].includes(x)))return {ok:false,reason:'invalid_change_path'};tree.push({path:f.path,mode:'100644',type:'blob',content:String(f.content)});}
  const t=await request(dest+'/git/trees','POST',{base_tree:base.value.tree.sha,tree});if(!t.ok)return {ok:false,reason:'revision_tree_failed'};
  if(current.value.object.sha!==proof.baseSha){const observed=await request(dest+'/git/commits/'+current.value.object.sha);if(observed.ok&&observed.value.tree?.sha===t.value.sha&&observed.value.parents?.some(p=>p.sha===proof.baseSha))return {ok:true,recovered:true,prUrl:pr.html_url,prNumber:pr.number,commitSha:current.value.object.sha};return {ok:false,reason:'revision_branch_changed'};}
  const commit=await request(dest+'/git/commits','POST',{message:'AutonomOS: verified client revision',tree:t.value.sha,parents:[proof.baseSha]});if(!commit.ok)return {ok:false,reason:'revision_commit_failed'};
  const r=await request(dest+'/git/refs/heads/'+encodeURIComponent(pr.head.ref),'PATCH',{sha:commit.value.sha,force:false});
  if(!r.ok)return {ok:false,uncertain:true,reason:'revision_push_uncertain'};
  return {ok:true,prUrl:pr.html_url,prNumber:pr.number,commitSha:commit.value.sha};
}
