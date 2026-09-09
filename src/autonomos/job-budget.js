import fs from 'node:fs';
import path from 'node:path';
import { AutonomOSStore } from './store.js';
import { normalizeConfig } from './policy-engine.js';
import { computeEarnedSpendBudgetUsd } from './profit-engine.js';
// Conservative per-job reservations, shared by planning, execution, tools and QA.
// Reservations are persisted before calls. They are estimates, not provider invoices.
export function createJobBudget(
  limitUsd,
  { onCost = () => {}, env = process.env, jobId = '' } = {},
) {
  const storeRoot=path.join(env.STORAGE_DIR||'data','autonomos');
  const recorded=()=>jobId?new AutonomOSStore(storeRoot).readNdjson('ledger.ndjson',-1).filter(r=>r.type==='cost'&&r.jobId===jobId).reduce((n,r)=>n+Number(r.amountUsd||0),0):0;
  let spent = recorded();
  return {
    get remaining() {
      return Math.max(0, Number(limitUsd) - spent);
    },
    get spent() {
      return spent;
    },
    charge(amount) {
      const value = Number(amount);
      if (!Number.isFinite(value) || value < 0 || value > this.remaining + 1e-9)
        throw new Error("job_spend_limit");
      const root=path.join(env.STORAGE_DIR||'data','autonomos');
      const apply=()=>{
        spent=Math.max(spent,recorded());if(value>this.remaining+1e-9)throw new Error('job_spend_limit');
        if(fs.existsSync(path.join(root,'config.json'))){
          const store=new AutonomOSStore(root),config=normalizeConfig(store.readJson('config.json',{}));
          if(!config.enabled||config.killSwitch)throw new Error('job_cancelled_by_emergency_stop');
          const available=computeEarnedSpendBudgetUsd(store.readNdjson('ledger.ndjson',-1),config);
          if(value>available+1e-9)throw new Error('shared_treasury_spend_limit');
        }
        onCost(value);spent+=value;
      };
      // Lock spans the latest treasury read and durable cost reservation across lanes.
      if(fs.existsSync(root))new AutonomOSStore(root).withLock('budget-reservation',apply);
      else apply();
    },
    llm(client) {
      const budget = this;
      return {
        ...client,
        budgeted: true,
        complete: async (args) => {
          const size =
            JSON.stringify(
              args.messages || [args.system || "", args.user || ""],
            ).length + JSON.stringify(args.tools || []).length;
          const amount =
            (size * Number(env.AUTONOMOS_LLM_INPUT_USD_PER_MILLION || 0.25) +
              Number(args.maxTokens || 700) *
                Number(env.AUTONOMOS_LLM_OUTPUT_USD_PER_MILLION || 2)) /
            1e6;
          budget.charge(amount);
          return client.complete({ ...args, maxEmptyRetries: 0 });
        },
      };
    },
  };
}
