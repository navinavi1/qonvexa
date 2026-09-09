import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomOSStore } from "../src/autonomos/store.js";
import { appendUniqueLedgerEntry } from "../src/autonomos/financial-ledger.js";
import { executeExternalOpportunity } from "../src/autonomos/job-executor.js";
import { freeWebSearch } from "../src/autonomos/free-web-tool.js";

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
} finally { fs.rmSync(dir, {recursive:true,force:true}); }

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

