import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { executeCodingJob } from "../src/autonomos/coding-job.js";
const exec = promisify(execCallback);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-fixture-"));
const repo = path.join(root, "upstream");
let killed = 0;
try {
  await fs.mkdir(repo);
  await fs.writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      type: "module",
      scripts: { test: "node --test" },
    }),
  );
  await fs.writeFile(
    path.join(repo, ".gitignore"),
    "node_modules\npackage-lock.json\n",
  );
  await fs.writeFile(
    path.join(repo, "add.js"),
    "export const add=(a,b)=>a-b;\n",
  );
  await exec(
    "git init -q && git -c user.name=Fixture -c user.email=fixture@example.invalid add . && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm base",
    { cwd: repo },
  );
  class LocalFixtureSandbox {
    static async create() {
      const home = path.join(root, "sandbox-" + Date.now());
      await fs.mkdir(home);
      const mapped = (p) => p.replace("/home/user", home);
      return {
        files: {
          read: (p) => fs.readFile(mapped(p), "utf8"),
          write: async (p, content) => {
            await fs.mkdir(path.dirname(mapped(p)), { recursive: true });
            await fs.writeFile(mapped(p), content);
          },
        },
        commands: {
          run: async (command) => {
            let cmd = command.replaceAll("/home/user", home);
            if (cmd.startsWith("git -c core.hooksPath="))
              cmd = cmd.replace(
                "'https://github.com/example/repo'",
                `'${repo}'`,
              );
            try {
              const r = await exec(cmd, { maxBuffer: 2000000, timeout: 30000 });
              return { ...r, exitCode: 0 };
            } catch (e) {
              return {
                exitCode: e.code || 1,
                stdout: e.stdout || "",
                stderr: e.stderr || "",
              };
            }
          },
        },
        kill: async () => {
          killed++;
        },
      };
    }
  }
  let round = 0;
  let reserved = 0;
  const call = (name, args) => {
    const c = {
      id: "call" + round,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    };
    return {
      ok: true,
      toolCalls: [c],
      message: { role: "assistant", tool_calls: [c] },
    };
  };
  const llm = {
    enabled: true,
    complete: async ({ messages }) => {
      round++;
      if (round === 1) return call("read_files", { paths: ["add.js"] });
      if (round === 2)
        return call("write_files", {
          files: [
            { path: "add.js", content: "export const add=(a,b)=>a+b;\n" },
            {
              path: "add.test.js",
              content:
                "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {add} from './add.js';\ntest('positive numbers are added',()=>assert.equal(add(2,3),5));\n",
            },
          ],
        });
      if (round === 3)
        return call("verify", { regressionPaths: ["add.test.js"] });
      const response = JSON.parse(messages.at(-1).content);
      assert.equal(response.ok, true, JSON.stringify(response));
      return { ok: true, text: "Fixed addition and verified the regression." };
    },
  };
  const result = await executeCodingJob(
    {
      source: "taskbounty",
      title: "Fix add",
      description: "Fix addition",
      repoUrl: "https://github.com/example/repo",
      raw: {},
    },
    {
      llm,
      env: { E2B_API_KEY: "fixture-only" },
      maxSpendUsd: 2,
      SandboxClass: LocalFixtureSandbox,
      access: async () => ({
        ok: true,
        data: { cloneUrl: "https://github.com/example/repo" },
      }),
      onCost: (v) => (reserved += v),
    },
  );
  assert(result.evidence.repositoryVerification.regressionFailsOnBase);
  assert(result.evidence.repositoryVerification.testsPassOnFix);
  assert.match(result.evidence.repositoryVerification.patch, /a\+b/);
  assert.equal(killed, 1);
  assert(reserved > 0);
  console.log(
    "PASS actual local fixture clone → edit → node --test PASS → original-code regression FAIL → patch → cleanup",
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
